import {
  DEFAULT_BAUD_RATE,
  PROTOCOL_VERSION,
  type DeviceInfo,
  type PinMode,
  type PinSample,
  type Request,
} from '../protocol/types';
import { validateRequest } from '../protocol/codec';
import { Emitter, type Transport } from './types';

/** Deterministic xorshift so simulated noise is reproducible in tests. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x2545f491;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

interface SimPin {
  mode: PinMode;
  value: 0 | 1;
  pwm: { freq: number; duty: number } | null;
  blink: number;
  /** Externally applied level: `null` means floating. */
  stimulus: 0 | 1 | null;
  touched: boolean;
  pulseUntil: number;
  pulseRestore: 0 | 1;
}

export interface SimulatorOptions {
  chip?: string;
  pins?: number[];
  adcPins?: number[];
  touchPins?: number[];
  seed?: number;
  /** Injected clock, in milliseconds; defaults to `Date.now`. */
  now?: () => number;
  /** Injected scheduler so tests can drive sampling manually. */
  scheduler?: {
    setInterval(handler: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
}

const DEFAULT_PINS = [
  0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39,
];
const DEFAULT_ADC_PINS = [32, 33, 34, 35, 36, 39, 25, 26, 27, 14, 12, 13, 4, 2, 15];
const DEFAULT_TOUCH_PINS = [4, 2, 15, 13, 12, 14, 27, 33, 32];
const INPUT_ONLY_PINS = new Set([34, 35, 36, 39]);

/**
 * In-memory ESP32 that speaks the same protocol as the real firmware.
 *
 * It lets the whole UI (and the test-suite) run without hardware, and doubles
 * as the executable reference for firmware behaviour.
 */
export class SimulatedBoard implements Transport {
  readonly name: string;

  private readonly lineEmitter = new Emitter<string>();
  private readonly closeEmitter = new Emitter<Error | null>();
  private readonly pins = new Map<number, SimPin>();
  private readonly adcPins: Set<number>;
  private readonly touchPins: Set<number>;
  private readonly pinList: number[];
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly scheduler: NonNullable<SimulatorOptions['scheduler']>;
  private readonly chip: string;
  private readonly startedAt: number;

  private watchPins: number[] = [];
  private watchHandle: unknown = null;
  private open_ = false;

  constructor(options: SimulatorOptions = {}) {
    this.chip = options.chip ?? 'ESP32-D0WD-V3 (simulated)';
    this.name = 'Simulated ESP32';
    this.pinList = options.pins ?? DEFAULT_PINS;
    this.adcPins = new Set(options.adcPins ?? DEFAULT_ADC_PINS);
    this.touchPins = new Set(options.touchPins ?? DEFAULT_TOUCH_PINS);
    this.random = makeRandom(options.seed ?? 0x1234abcd);
    this.now = options.now ?? (() => Date.now());
    this.scheduler = options.scheduler ?? {
      setInterval: (handler, ms) => setInterval(handler, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    };
    this.startedAt = this.now();
    for (const pin of this.pinList) {
      this.pins.set(pin, {
        mode: 'disabled',
        value: 0,
        pwm: null,
        blink: 0,
        stimulus: null,
        touched: false,
        pulseUntil: 0,
        pulseRestore: 0,
      });
    }
  }

  get isOpen(): boolean {
    return this.open_;
  }

  get baudRate(): number {
    return DEFAULT_BAUD_RATE;
  }

  async open(): Promise<void> {
    this.open_ = true;
    this.emit({ ev: 'log', level: 'info', message: 'simulated board booted' });
    this.emit({ ev: 'ready', info: this.info() });
  }

  async close(): Promise<void> {
    if (!this.open_) return;
    this.open_ = false;
    this.stopWatch();
    this.closeEmitter.emit(null);
  }

  onLine(handler: (line: string) => void): () => void {
    return this.lineEmitter.on(handler);
  }

  onClose(handler: (reason: Error | null) => void): () => void {
    return this.closeEmitter.on(handler);
  }

  async send(line: string): Promise<void> {
    if (!this.open_) throw new Error('Simulated board is not open');
    let request: Request;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || typeof (parsed as Request).cmd !== 'string') {
        throw new Error('not a request');
      }
      request = parsed as Request;
    } catch {
      this.emit({ ev: 'error', error: { code: 'bad_json', message: 'could not parse request' } });
      return;
    }
    this.handle(request);
  }

  // ---------------------------------------------------------------- stimulus

  /** Simulate a wire/finger applying a level to a pin (`null` = floating). */
  applyStimulus(pin: number, level: 0 | 1 | null): void {
    const state = this.pins.get(pin);
    if (state) state.stimulus = level;
  }

  /** Simulate a finger on a capacitive touch pad. */
  applyTouch(pin: number, touched: boolean): void {
    const state = this.pins.get(pin);
    if (state) state.touched = touched;
  }

  /** Current mode of a pin; used by the demo UI and tests. */
  modeOf(pin: number): PinMode | undefined {
    return this.pins.get(pin)?.mode;
  }

  /** Emit one sampling batch immediately (tests drive this directly). */
  tick(): void {
    if (this.watchPins.length === 0) return;
    const pins: Record<string, PinSample> = {};
    for (const pin of this.watchPins) pins[String(pin)] = this.sample(pin);
    this.emit({ ev: 'sample', t: this.uptime(), pins });
  }

  // ----------------------------------------------------------------- command

  private handle(request: Request): void {
    const problem = validateRequest(request);
    if (problem) {
      this.respondError(request.id, 'bad_request', problem);
      return;
    }
    switch (request.cmd) {
      case 'hello':
      case 'sys.info':
        this.respond(request.id, this.info());
        return;
      case 'sys.reset':
        this.resetAll();
        this.respond(request.id, { rebooted: true });
        this.emit({ ev: 'ready', info: this.info() });
        return;
      case 'pin.mode': {
        const state = this.requirePin(request.id, request.pin);
        if (!state) return;
        if (
          INPUT_ONLY_PINS.has(request.pin) &&
          (request.mode === 'output' || request.mode === 'output_open_drain' || request.mode === 'pwm')
        ) {
          this.respondError(request.id, 'input_only', `GPIO${request.pin} is input only`);
          return;
        }
        if (request.mode === 'analog' && !this.adcPins.has(request.pin)) {
          this.respondError(request.id, 'no_adc', `GPIO${request.pin} has no ADC channel`);
          return;
        }
        if (request.mode === 'touch' && !this.touchPins.has(request.pin)) {
          this.respondError(request.id, 'no_touch', `GPIO${request.pin} has no touch channel`);
          return;
        }
        state.mode = request.mode;
        state.pwm = null;
        state.blink = 0;
        this.respond(request.id, { pin: request.pin, mode: request.mode });
        return;
      }
      case 'pin.read': {
        const state = this.requirePin(request.id, request.pin);
        if (!state) return;
        this.respond(request.id, { pin: request.pin, ...this.sample(request.pin) });
        return;
      }
      case 'pin.write': {
        const state = this.requireOutput(request.id, request.pin);
        if (!state) return;
        state.value = request.value;
        state.pwm = null;
        state.blink = 0;
        this.respond(request.id, { pin: request.pin, value: request.value });
        return;
      }
      case 'pin.toggle': {
        const state = this.requireOutput(request.id, request.pin);
        if (!state) return;
        state.value = state.value === 1 ? 0 : 1;
        this.respond(request.id, { pin: request.pin, value: state.value });
        return;
      }
      case 'pin.pulse': {
        const state = this.requireOutput(request.id, request.pin);
        if (!state) return;
        state.pulseRestore = request.value === 1 ? 0 : 1;
        state.value = request.value;
        state.pulseUntil = this.now() + request.ms;
        this.respond(request.id, { pin: request.pin, value: request.value, ms: request.ms });
        return;
      }
      case 'pin.pwm': {
        const state = this.requireOutput(request.id, request.pin);
        if (!state) return;
        state.mode = 'pwm';
        state.blink = 0;
        state.pwm = { freq: request.freq, duty: request.duty };
        this.respond(request.id, { pin: request.pin, freq: request.freq, duty: request.duty });
        return;
      }
      case 'pin.blink': {
        const state = this.requireOutput(request.id, request.pin);
        if (!state) return;
        state.blink = request.period;
        state.pwm = null;
        this.respond(request.id, { pin: request.pin, period: request.period });
        return;
      }
      case 'pin.reset': {
        if (request.pin === undefined) {
          this.resetAll();
          this.respond(request.id, { reset: 'all' });
          return;
        }
        const state = this.requirePin(request.id, request.pin);
        if (!state) return;
        Object.assign(state, {
          mode: 'disabled',
          value: 0,
          pwm: null,
          blink: 0,
          pulseUntil: 0,
        } satisfies Partial<SimPin>);
        this.respond(request.id, { pin: request.pin, reset: true });
        return;
      }
      case 'watch.set': {
        const unknownPin = request.pins.find((pin) => !this.pins.has(pin));
        if (unknownPin !== undefined) {
          this.respondError(request.id, 'bad_pin', `GPIO${unknownPin} is not available`);
          return;
        }
        this.watchPins = [...new Set(request.pins)];
        this.startWatch(request.interval);
        this.respond(request.id, { pins: this.watchPins, interval: request.interval });
        return;
      }
      case 'watch.clear':
        this.stopWatch();
        this.watchPins = [];
        this.respond(request.id, { pins: [] });
        return;
      case 'scan.i2c': {
        const devices = request.sda === 21 && request.scl === 22 ? [0x3c, 0x76] : [];
        this.respond(request.id, { sda: request.sda, scl: request.scl, devices });
        return;
      }
      case 'scan.pins': {
        const pins = request.pins ?? this.pinList;
        const found = pins
          .filter((pin) => this.pins.has(pin))
          .map((pin) => ({ pin, ...this.sample(pin) }));
        this.respond(request.id, { pins: found });
        return;
      }
      default:
        this.respondError(request.id, 'unknown_command', `unsupported command`);
    }
  }

  private resetAll(): void {
    for (const state of this.pins.values()) {
      state.mode = 'disabled';
      state.value = 0;
      state.pwm = null;
      state.blink = 0;
      state.pulseUntil = 0;
    }
    this.stopWatch();
    this.watchPins = [];
  }

  private requirePin(id: number, pin: number): SimPin | null {
    const state = this.pins.get(pin);
    if (!state) {
      this.respondError(id, 'bad_pin', `GPIO${pin} is not available on this board`);
      return null;
    }
    return state;
  }

  private requireOutput(id: number, pin: number): SimPin | null {
    const state = this.requirePin(id, pin);
    if (!state) return null;
    if (INPUT_ONLY_PINS.has(pin)) {
      this.respondError(id, 'input_only', `GPIO${pin} is input only`);
      return null;
    }
    if (state.mode !== 'output' && state.mode !== 'output_open_drain' && state.mode !== 'pwm') {
      this.respondError(id, 'bad_mode', `GPIO${pin} is not configured as an output`);
      return null;
    }
    return state;
  }

  // ------------------------------------------------------------------ sample

  private sample(pin: number): PinSample {
    const state = this.pins.get(pin);
    if (!state) return {};
    const t = this.uptime();
    if (state.pulseUntil && this.now() >= state.pulseUntil) {
      state.value = state.pulseRestore;
      state.pulseUntil = 0;
    }
    switch (state.mode) {
      case 'output':
      case 'output_open_drain': {
        const level = state.blink > 0 ? (Math.floor(t / (state.blink / 2)) % 2 === 0 ? 1 : 0) : state.value;
        return { d: level as 0 | 1 };
      }
      case 'pwm': {
        const pwm = state.pwm ?? { freq: 1000, duty: 0 };
        const phase = ((t / 1000) * pwm.freq) % 1;
        const level: 0 | 1 = phase < pwm.duty ? 1 : 0;
        return { d: level, a: Math.round(pwm.duty * 4095), mv: Math.round(pwm.duty * 3300) };
      }
      case 'analog': {
        const mv = this.analogMillivolts(state);
        return { a: Math.round((mv / 3300) * 4095), mv };
      }
      case 'touch': {
        const base = 70 + Math.round(this.random() * 4);
        return { t: state.touched ? Math.max(4, base - 55) : base, d: state.touched ? 1 : 0 };
      }
      case 'input_pullup':
        return { d: state.stimulus === 0 ? 0 : 1 };
      case 'input_pulldown':
        return { d: state.stimulus === 1 ? 1 : 0 };
      case 'input':
        if (state.stimulus !== null) return { d: state.stimulus };
        // Floating input: noisy, which is exactly what the tool should show.
        return { d: this.random() > 0.5 ? 1 : 0 };
      default:
        return {};
    }
  }

  private analogMillivolts(state: SimPin): number {
    if (state.stimulus === 1) return 3280 + Math.round(this.random() * 20);
    if (state.stimulus === 0) return Math.round(this.random() * 25);
    const phase = (this.uptime() / 1000) * 0.5;
    const wave = (Math.sin(phase * Math.PI * 2) + 1) / 2;
    return Math.round(wave * 2400 + 300 + this.random() * 40);
  }

  private startWatch(interval: number): void {
    this.stopWatch();
    this.watchHandle = this.scheduler.setInterval(() => this.tick(), interval);
  }

  private stopWatch(): void {
    if (this.watchHandle !== null) {
      this.scheduler.clearInterval(this.watchHandle);
      this.watchHandle = null;
    }
  }

  private uptime(): number {
    return Math.max(0, this.now() - this.startedAt);
  }

  private info(): DeviceInfo {
    return {
      protocol: PROTOCOL_VERSION,
      firmware: 'esp-diag-sim 1.0.0',
      chip: this.chip,
      cores: 2,
      revision: 3,
      mac: '24:6f:28:00:00:01',
      flashSize: 4 * 1024 * 1024,
      freeHeap: 210_000,
      pins: this.pinList,
      maxWatch: 16,
      adcMax: 4095,
    };
  }

  private respond(id: number, result: unknown): void {
    this.emitRaw(JSON.stringify({ id, ok: true, result }));
  }

  private respondError(id: number, code: string, message: string): void {
    this.emitRaw(JSON.stringify({ id, ok: false, error: { code, message } }));
  }

  private emit(event: Record<string, unknown>): void {
    this.emitRaw(JSON.stringify(event));
  }

  private emitRaw(line: string): void {
    // Mimic the asynchronous arrival of serial data.
    queueMicrotask(() => this.lineEmitter.emit(line));
  }
}
