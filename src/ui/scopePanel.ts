import type { AdcCapture, DiagnosticsController } from '../device/diagnosticsController';
import type { TracePoint } from '../device/pinStateStore';
import { pinLabel, type PinDefinition } from '../device/boards';
import { button, clear, el, select } from './dom';
import { drawScope, prepareCanvas } from './scope';
import { downloadTextFile, traceToCsv } from '../util/traceCsv';

const SCOPE_WIDTH = 720;
const SCOPE_HEIGHT = 300;

const WINDOW_CHOICES = [1000, 2000, 5000, 10000, 30000] as const;
const CAPTURE_RATES = [1000, 2000, 5000, 10000, 20000, 50000, 100000] as const;
const CAPTURE_SIZES = [512, 1024, 2048, 4096] as const;

/** Convert an assembled burst capture into displayable trace points. */
export function captureToTrace(capture: AdcCapture): TracePoint[] {
  const points: TracePoint[] = [];
  const stepMs = 1000 / capture.rate;
  for (let index = 0; index < capture.samples.length; index++) {
    const raw = capture.samples[index]!;
    points.push({
      t: capture.t0 + index * stepMs,
      v: Math.min(1, Math.max(0, raw / capture.adcMax)),
      mv: Math.round((raw / capture.adcMax) * 3300),
    });
  }
  return points;
}

/** The trace point closest in time to `t`, or undefined for an empty trace. */
export function nearestPoint(
  points: readonly TracePoint[],
  t: number,
): TracePoint | undefined {
  let best: TracePoint | undefined;
  let bestDistance = Infinity;
  for (const point of points) {
    const distance = Math.abs(point.t - t);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  return best;
}

/** Human readable cursor readout: Δt, the equivalent frequency and both levels. */
export function describeCursors(
  points: readonly TracePoint[],
  cursorA: number,
  cursorB: number,
): string {
  const deltaMs = Math.abs(cursorB - cursorA);
  const parts = [`Δt ${formatMs(deltaMs)}`];
  if (deltaMs > 0) parts.push(`(${formatHz(1000 / deltaMs)})`);
  const a = nearestPoint(points, cursorA);
  const b = nearestPoint(points, cursorB);
  const level = (point: TracePoint | undefined) =>
    point === undefined
      ? '—'
      : point.mv !== undefined
        ? `${(point.mv / 1000).toFixed(3)} V`
        : point.d !== undefined
          ? point.d === 1
            ? 'HIGH'
            : 'LOW'
          : point.v.toFixed(2);
  parts.push(`A ${level(a)}`, `B ${level(b)}`);
  return parts.join(' · ');
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 1) return `${ms.toFixed(1)} ms`;
  return `${(ms * 1000).toFixed(0)} µs`;
}

function formatHz(hz: number): string {
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`;
  return `${hz.toFixed(1)} Hz`;
}

type ViewMode = 'live' | 'paused' | 'capture';

/**
 * Full size oscilloscope view for one pin: adjustable time window, pause/run,
 * cursors, statistics readout, CSV export and — on ADC pins — a triggered
 * high-rate burst capture.
 */
export class ScopePanel {
  readonly root: HTMLElement;

  private readonly controller: DiagnosticsController;
  private readonly definition: PinDefinition;
  private readonly canvas: HTMLCanvasElement;
  private readonly readoutNode: HTMLElement;
  private readonly cursorNode: HTMLElement;
  private readonly runButton: HTMLButtonElement;
  private readonly captureStatus: HTMLElement;
  private readonly onClose: () => void;
  private readonly unsubscribe: Array<() => void> = [];

  private scopeCtx: CanvasRenderingContext2D | null | undefined;
  private windowMs = 5000;
  private mode: ViewMode = 'live';
  /** Snapshot shown while paused or after a capture. */
  private frozen: TracePoint[] | null = null;
  private capture: AdcCapture | null = null;
  private cursorA: number | null = null;
  private cursorB: number | null = null;
  private nextCursor: 'a' | 'b' = 'a';

  constructor(controller: DiagnosticsController, definition: PinDefinition, onClose: () => void) {
    this.controller = controller;
    this.definition = definition;
    this.onClose = onClose;

    this.canvas = el('canvas', { class: 'scope-canvas', attrs: { tabindex: 0 } });
    this.canvas.addEventListener('click', (event) => this.placeCursor(event));
    this.readoutNode = el('div', { class: 'scope-readouts' });
    this.cursorNode = el('div', { class: 'scope-cursors muted' });
    this.captureStatus = el('span', { class: 'capture-status muted' });

    this.runButton = button('Pause', () => this.toggleRun());

    const windowSelect = select<string>(
      WINDOW_CHOICES.map(String),
      String(this.windowMs),
      (value) => {
        this.windowMs = Number(value);
        this.render();
      },
      (value) => `${Number(value) / 1000} s (${Number(value) / 10000} s/div)`,
    );
    windowSelect.setAttribute('aria-label', 'Scope time window');

    this.root = el(
      'div',
      { class: 'scope-overlay', on: { click: (event) => this.onOverlayClick(event) } },
      el(
        'section',
        { class: 'panel scope-panel', attrs: { role: 'dialog', 'aria-label': `Scope of GPIO${definition.gpio}` } },
        el(
          'header',
          { class: 'panel-head' },
          el('h2', { text: `${pinLabel(definition)} — scope` }),
          button('✕', () => this.close(), { class: 'btn-ghost scope-close', attrs: { 'aria-label': 'Close scope' } }),
        ),
        this.canvas,
        el(
          'div',
          { class: 'scope-controls' },
          el('label', { class: 'field' }, el('span', { text: 'Window' }), windowSelect),
          this.runButton,
          button('Clear cursors', () => this.clearCursors(), { class: 'btn-ghost' }),
          button('Export CSV', () => this.exportCsv(), { class: 'btn-ghost' }),
        ),
        this.readoutNode,
        this.cursorNode,
        this.definition.capabilities.includes('adc') ? this.buildCaptureRow() : null,
      ),
    );

    this.unsubscribe.push(
      controller.events.on((event) => {
        if (event.type === 'pin' && event.pin === definition.gpio) this.render();
        else if (event.type === 'pins' && event.pins.includes(definition.gpio)) this.render();
      }),
    );
    this.render();
  }

  destroy(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    this.root.remove();
  }

  private close(): void {
    this.destroy();
    this.onClose();
  }

  private onOverlayClick(event: MouseEvent): void {
    if (event.target === this.root) this.close();
  }

  // ---------------------------------------------------------------- controls

  private toggleRun(): void {
    if (this.mode === 'live') {
      this.mode = 'paused';
      this.frozen = this.livePoints();
    } else {
      this.mode = 'live';
      this.frozen = null;
      this.capture = null;
    }
    this.render();
  }

  private clearCursors(): void {
    this.cursorA = null;
    this.cursorB = null;
    this.nextCursor = 'a';
    this.render();
  }

  private placeCursor(event: MouseEvent): void {
    const points = this.points();
    if (points.length === 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
    const { end, windowMs } = this.viewport(points);
    const time = end - windowMs + fraction * windowMs;
    if (this.nextCursor === 'a') {
      this.cursorA = time;
      this.nextCursor = 'b';
    } else {
      this.cursorB = time;
      this.nextCursor = 'a';
    }
    this.render();
  }

  private exportCsv(): void {
    const points = this.points();
    if (points.length === 0) {
      this.controller.log('warn', 'Nothing to export yet — the trace is empty.');
      return;
    }
    const suffix = this.mode === 'capture' ? 'capture' : 'trace';
    downloadTextFile(`gpio${this.definition.gpio}-${suffix}.csv`, traceToCsv(points));
    this.controller.log('info', `Exported ${points.length} points from GPIO${this.definition.gpio}`);
  }

  // ----------------------------------------------------------------- capture

  private buildCaptureRow(): HTMLElement {
    let rate = 20000;
    let samples = 2048;
    let edge: 'free' | 'rising' | 'falling' = 'free';

    const rateSelect = select<string>(
      CAPTURE_RATES.map(String),
      String(rate),
      (value) => {
        rate = Number(value);
      },
      (value) => formatHz(Number(value)),
    );
    rateSelect.setAttribute('aria-label', 'Capture sample rate');
    const sizeSelect = select<string>(
      CAPTURE_SIZES.map(String),
      String(samples),
      (value) => {
        samples = Number(value);
      },
      (value) => `${value} samples`,
    );
    sizeSelect.setAttribute('aria-label', 'Capture length');
    const triggerSelect = select<'free' | 'rising' | 'falling'>(
      ['free', 'rising', 'falling'],
      edge,
      (value) => {
        edge = value;
        level.disabled = value === 'free';
      },
      (value) => (value === 'free' ? 'Free run' : value === 'rising' ? 'Rising edge' : 'Falling edge'),
    );
    triggerSelect.setAttribute('aria-label', 'Capture trigger');
    const level = el('input', {
      class: 'number',
      attrs: { type: 'number', min: '0', max: '3300', step: '50', value: '1650', 'aria-label': 'Trigger level (mV)' },
    });
    level.disabled = true;

    const run = button('Capture', () => {
      void this.runCapture(rate, samples, edge, Number(level.value));
    }, { class: 'btn-primary' });

    return el(
      'div',
      { class: 'capture-row' },
      el('span', { class: 'capture-title', text: 'Burst capture' }),
      el('label', { class: 'field' }, el('span', { text: 'Rate' }), rateSelect),
      el('label', { class: 'field' }, el('span', { text: 'Length' }), sizeSelect),
      el('label', { class: 'field' }, el('span', { text: 'Trigger' }), triggerSelect),
      el('label', { class: 'field' }, el('span', { text: 'mV' }), level),
      run,
      this.captureStatus,
    );
  }

  private async runCapture(
    rate: number,
    samples: number,
    edge: 'free' | 'rising' | 'falling',
    levelMv: number,
  ): Promise<void> {
    this.captureStatus.textContent = 'Capturing…';
    try {
      const capture = await this.controller.captureAdc(this.definition.gpio, {
        rate,
        samples,
        ...(edge === 'free'
          ? {}
          : { pretrigger: 0.25, trigger: { edge, mv: levelMv, timeoutMs: 2000 } }),
      });
      this.capture = capture;
      this.frozen = captureToTrace(capture);
      this.mode = 'capture';
      this.clearCursors();
      this.captureStatus.textContent = `${samples} samples @ ${formatHz(capture.rate)}${
        capture.triggered ? ' · triggered' : ''
      }`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.captureStatus.textContent = 'Capture failed';
      this.controller.log('error', `Capture on GPIO${this.definition.gpio} failed: ${message}`);
    }
    this.render();
  }

  // ------------------------------------------------------------------ render

  private livePoints(): TracePoint[] {
    return this.controller.store.get(this.definition.gpio).trace.toArray();
  }

  private points(): TracePoint[] {
    return this.frozen ?? this.livePoints();
  }

  /** Time span shown right now: the capture's own span, or the live window. */
  private viewport(points: readonly TracePoint[]): { end: number; windowMs: number } {
    const end = points.length > 0 ? points[points.length - 1]!.t : 0;
    if (this.mode === 'capture' && this.capture) {
      const span = (this.capture.samples.length / this.capture.rate) * 1000;
      return { end, windowMs: Math.max(1, span) };
    }
    return { end, windowMs: this.windowMs };
  }

  private render(): void {
    if (this.mode === 'live') this.renderScope(this.livePoints());
    else this.renderScope(this.frozen ?? []);
    this.renderReadouts();
    this.runButton.textContent = this.mode === 'live' ? 'Pause' : 'Run';
  }

  private renderScope(points: TracePoint[]): void {
    if (this.scopeCtx === undefined) {
      this.scopeCtx = prepareCanvas(this.canvas, SCOPE_WIDTH, SCOPE_HEIGHT);
    }
    const ctx = this.scopeCtx;
    if (!ctx) return;
    const state = this.controller.store.get(this.definition.gpio);
    const digital =
      this.mode !== 'capture' && state.mode !== 'analog' && state.mode !== 'touch';
    const { windowMs } = this.viewport(points);
    drawScope(
      ctx,
      points,
      { width: SCOPE_WIDTH, height: SCOPE_HEIGHT, windowMs, padding: 6 },
      {
        background: 'rgba(8, 15, 26, 0.95)',
        grid: 'rgba(120, 150, 190, 0.25)',
        stroke: digital ? '#4ade80' : '#38bdf8',
        fill: digital ? 'rgba(74, 222, 128, 0.12)' : 'rgba(56, 189, 248, 0.14)',
        digital,
      },
    );
    this.drawCursors(ctx, points);
  }

  private drawCursors(ctx: CanvasRenderingContext2D, points: readonly TracePoint[]): void {
    if (points.length === 0) return;
    const { end, windowMs } = this.viewport(points);
    const start = end - windowMs;
    for (const [time, color] of [
      [this.cursorA, '#facc15'],
      [this.cursorB, '#fb923c'],
    ] as const) {
      if (time === null || time < start || time > end) continue;
      const x = ((time - start) / windowMs) * SCOPE_WIDTH;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, SCOPE_HEIGHT);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private renderReadouts(): void {
    const state = this.controller.store.get(this.definition.gpio);
    const parts: string[] = [];
    if (this.mode === 'capture' && this.capture) {
      const raw = this.capture.samples;
      let min = Infinity;
      let max = -Infinity;
      for (const value of raw) {
        if (value < min) min = value;
        if (value > max) max = value;
      }
      if (raw.length > 0) {
        const toVolts = (value: number) => ((value / this.capture!.adcMax) * 3.3).toFixed(3);
        parts.push(`min ${toVolts(min)} V`, `max ${toVolts(max)} V`);
      }
    } else {
      const stats = state.stats;
      if (stats.minMv !== undefined && stats.maxMv !== undefined) {
        parts.push(`min ${(stats.minMv / 1000).toFixed(3)} V`, `max ${(stats.maxMv / 1000).toFixed(3)} V`);
      }
      if (stats.frequencyHz !== undefined && Number.isFinite(stats.frequencyHz)) {
        parts.push(`≈${formatHz(stats.frequencyHz)}`);
      }
      if (stats.dutyCycle !== undefined) parts.push(`${Math.round(stats.dutyCycle * 100)} % high`);
      if (stats.transitions > 0) parts.push(`${stats.transitions} edges`);
    }
    this.readoutNode.textContent = parts.join(' · ');

    clear(this.cursorNode);
    if (this.cursorA !== null && this.cursorB !== null) {
      this.cursorNode.textContent = describeCursors(this.points(), this.cursorA, this.cursorB);
    } else {
      this.cursorNode.textContent =
        this.cursorA !== null
          ? 'Click the trace again to place cursor B.'
          : 'Click the trace to place measurement cursors.';
    }
  }
}
