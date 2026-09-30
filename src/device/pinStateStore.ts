import type { PinMode, PinSample, SampleEvent } from '../protocol/types';
import { RingBuffer } from '../util/ringBuffer';

export interface TracePoint {
  /** Device uptime in milliseconds. */
  t: number;
  /** Digital level, when the pin reports one. */
  d?: 0 | 1;
  /** Normalised value 0..1 used for plotting (digital or analog). */
  v: number;
  /** Millivolts, when known. */
  mv?: number;
  /** Raw touch reading, when known. */
  touch?: number;
}

export interface PinStats {
  /** Number of digital transitions observed since the trace was cleared. */
  transitions: number;
  /** Minimum and maximum millivolts seen (analog pins). */
  minMv?: number;
  maxMv?: number;
  /** Estimated frequency in Hz from the edges inside the retained trace. */
  frequencyHz?: number;
  /** Fraction of retained samples that read high, 0..1. */
  dutyCycle?: number;
}

export interface PinRuntimeState {
  gpio: number;
  mode: PinMode;
  watched: boolean;
  /** Last commanded output level. */
  output: 0 | 1;
  pwm?: { freq: number; duty: number };
  blink?: number;
  last?: TracePoint;
  trace: RingBuffer<TracePoint>;
  stats: PinStats;
}

export const DEFAULT_TRACE_CAPACITY = 600;

/**
 * Aggregates the sample stream into per-pin traces and derived statistics.
 *
 * Statistics are computed incrementally so that a fast sampling rate does not
 * force a full re-scan of the trace on every batch.
 */
export class PinStateStore {
  private readonly states = new Map<number, PinRuntimeState>();
  /** Running counters over the retained trace, backing the derived statistics. */
  private readonly windows = new Map<number, { high: number; total: number; edges: number }>();
  private readonly capacity: number;
  private readonly adcMax: number;

  constructor(options: { capacity?: number; adcMax?: number } = {}) {
    this.capacity = options.capacity ?? DEFAULT_TRACE_CAPACITY;
    this.adcMax = options.adcMax ?? 4095;
  }

  get(gpio: number): PinRuntimeState {
    let state = this.states.get(gpio);
    if (!state) {
      state = {
        gpio,
        mode: 'disabled',
        watched: false,
        output: 0,
        trace: new RingBuffer<TracePoint>(this.capacity),
        stats: { transitions: 0 },
      };
      this.states.set(gpio, state);
    }
    return state;
  }

  all(): PinRuntimeState[] {
    return [...this.states.values()].sort((a, b) => a.gpio - b.gpio);
  }

  watchedPins(): number[] {
    return this.all()
      .filter((state) => state.watched)
      .map((state) => state.gpio);
  }

  setMode(gpio: number, mode: PinMode): void {
    const state = this.get(gpio);
    if (state.mode !== mode) {
      state.mode = mode;
      this.clearTrace(gpio);
    }
    if (mode !== 'pwm') state.pwm = undefined;
    if (mode !== 'output' && mode !== 'output_open_drain') state.blink = undefined;
  }

  setWatched(gpio: number, watched: boolean): void {
    this.get(gpio).watched = watched;
  }

  setOutput(gpio: number, value: 0 | 1): void {
    this.get(gpio).output = value;
  }

  setPwm(gpio: number, freq: number, duty: number): void {
    const state = this.get(gpio);
    state.pwm = { freq, duty };
    state.blink = undefined;
  }

  setBlink(gpio: number, period: number): void {
    const state = this.get(gpio);
    state.blink = period > 0 ? period : undefined;
    if (period > 0) state.pwm = undefined;
  }

  clearTrace(gpio: number): void {
    const state = this.get(gpio);
    state.trace.clear();
    state.stats = { transitions: 0 };
    state.last = undefined;
    this.windows.delete(gpio);
  }

  clearAllTraces(): void {
    for (const gpio of this.states.keys()) this.clearTrace(gpio);
  }

  /** Ingest one `sample` event; returns the GPIOs it touched. */
  ingest(event: SampleEvent): number[] {
    const touched: number[] = [];
    for (const [key, sample] of Object.entries(event.pins)) {
      const gpio = Number(key);
      if (!Number.isFinite(gpio)) continue;
      this.record(gpio, event.t, sample);
      touched.push(gpio);
    }
    return touched;
  }

  /** Ingest a single measurement (e.g. the result of `pin.read`). */
  record(gpio: number, t: number, sample: PinSample): TracePoint {
    const state = this.get(gpio);
    const point = this.toPoint(t, sample);
    const previous = state.last;
    if (previous?.d !== undefined && point.d !== undefined && previous.d !== point.d) {
      state.stats.transitions += 1;
    }
    const evicted = state.trace.push(point);
    state.last = point;
    this.updateStats(state, point, previous, evicted);
    return point;
  }

  private toPoint(t: number, sample: PinSample): TracePoint {
    const point: TracePoint = { t, v: 0 };
    if (sample.d === 0 || sample.d === 1) point.d = sample.d;
    if (sample.mv !== undefined) point.mv = sample.mv;
    if (sample.t !== undefined) point.touch = sample.t;
    if (sample.a !== undefined) {
      point.v = clamp(sample.a / this.adcMax, 0, 1);
      if (point.mv === undefined) point.mv = Math.round((sample.a / this.adcMax) * 3300);
    } else if (sample.mv !== undefined) {
      point.v = clamp(sample.mv / 3300, 0, 1);
    } else if (sample.t !== undefined) {
      // Touch readings fall when a pad is touched; invert for display.
      point.v = clamp(1 - sample.t / 100, 0, 1);
    } else if (point.d !== undefined) {
      point.v = point.d;
    }
    return point;
  }

  private updateStats(
    state: PinRuntimeState,
    point: TracePoint,
    previous: TracePoint | undefined,
    evicted: TracePoint | undefined,
  ): void {
    const stats = state.stats;
    const window = this.window(state.gpio);
    if (point.d !== undefined) {
      window.total += 1;
      window.high += point.d;
      if (previous?.d !== undefined && previous.d !== point.d) window.edges += 1;
    }
    if (evicted?.d !== undefined) {
      window.total -= 1;
      window.high -= evicted.d;
      // The edge between the evicted point and the new oldest one leaves the window too.
      const oldest = state.trace.at(0);
      if (oldest?.d !== undefined && oldest.d !== evicted.d) window.edges -= 1;
    }
    stats.dutyCycle = window.total > 0 ? window.high / window.total : undefined;
    if (point.mv !== undefined) {
      stats.minMv = stats.minMv === undefined ? point.mv : Math.min(stats.minMv, point.mv);
      stats.maxMv = stats.maxMv === undefined ? point.mv : Math.max(stats.maxMv, point.mv);
    }
    const first = state.trace.at(0);
    const last = state.trace.last();
    if (first && last && last.t > first.t && window.edges > 0) {
      const seconds = (last.t - first.t) / 1000;
      stats.frequencyHz = window.edges / 2 / seconds;
    } else {
      stats.frequencyHz = undefined;
    }
  }

  private window(gpio: number): { high: number; total: number; edges: number } {
    let window = this.windows.get(gpio);
    if (!window) {
      window = { high: 0, total: 0, edges: 0 };
      this.windows.set(gpio, window);
    }
    return window;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Format a trace point for the pin tile, taking the pin mode into account. */
export function formatValue(state: PinRuntimeState): string {
  const point = state.last;
  if (!point) return '—';
  switch (state.mode) {
    case 'analog':
      return point.mv !== undefined ? `${(point.mv / 1000).toFixed(3)} V` : `${Math.round(point.v * 100)} %`;
    case 'touch':
      return point.touch !== undefined ? `${point.touch}` : '—';
    case 'pwm':
      return state.pwm ? `${Math.round(state.pwm.duty * 100)} % @ ${state.pwm.freq} Hz` : 'PWM';
    default:
      return point.d === undefined ? '—' : point.d === 1 ? 'HIGH' : 'LOW';
  }
}
