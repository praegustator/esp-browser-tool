import { DeviceSession, type SessionStatus } from './session';
import { PinStateStore } from './pinStateStore';
import {
  boardForChip,
  canOutput,
  DEFAULT_BOARD,
  hasCapability,
  isExactBoardMatch,
  pinDefinition,
  type BoardDefinition,
  type PinDefinition,
} from './boards';
import {
  PREFERRED_BAUD_RATE,
  type CaptureTrigger,
  type DeviceEvent,
  type DeviceInfo,
  type PinMode,
} from '../protocol/types';
import { Emitter, type Transport } from '../transport/types';
import { decodeSamples } from '../util/base64';
import { RingBuffer } from '../util/ringBuffer';

export interface LogLine {
  time: number;
  level: 'debug' | 'info' | 'warn' | 'error' | 'tx' | 'rx';
  text: string;
}

export type ControllerEvent =
  | { type: 'status'; status: SessionStatus }
  | { type: 'pins'; pins: number[] }
  | { type: 'pin'; pin: number }
  | { type: 'log'; line: LogLine }
  | { type: 'board' };

export interface ControllerOptions {
  watchInterval?: number;
  traceCapacity?: number;
  logCapacity?: number;
  /** Try to renegotiate the link to a faster baud rate after connecting. */
  upgradeBaud?: boolean;
}

/** Options for a burst capture. */
export interface CaptureOptions {
  rate: number;
  samples: number;
  pretrigger?: number;
  trigger?: CaptureTrigger;
}

/** An assembled burst capture ready for display or export. */
export interface AdcCapture {
  pin: number;
  /** Actual sampling rate in Hz. */
  rate: number;
  /** Host-clock time of the first sample, in milliseconds. */
  t0: number;
  /** Raw ADC counts. */
  samples: Uint16Array;
  adcMax: number;
  triggered: boolean;
}

/**
 * Application level orchestration: owns the session, the pin store and the
 * board layout, and exposes the operations the UI offers. Keeping this free of
 * DOM access makes the whole interaction model testable headlessly.
 */
export class DiagnosticsController {
  readonly logs: RingBuffer<LogLine>;
  readonly events = new Emitter<ControllerEvent>();

  private session_: DeviceSession | null = null;
  private store_: PinStateStore;
  private board_: BoardDefinition = DEFAULT_BOARD;
  private boardPinnedByUser = false;
  private watchInterval_: number;
  private readonly traceCapacity: number;
  private readonly upgradeBaud: boolean;
  private status_: SessionStatus = 'closed';
  private unsubscribe: Array<() => void> = [];
  private clockOffset: number | null = null;

  constructor(options: ControllerOptions = {}) {
    this.watchInterval_ = options.watchInterval ?? 50;
    this.traceCapacity = options.traceCapacity ?? 600;
    this.upgradeBaud = options.upgradeBaud ?? true;
    this.store_ = new PinStateStore({ capacity: this.traceCapacity });
    this.logs = new RingBuffer<LogLine>(options.logCapacity ?? 500);
  }

  get store(): PinStateStore {
    return this.store_;
  }

  get board(): BoardDefinition {
    return this.board_;
  }

  get status(): SessionStatus {
    return this.status_;
  }

  get info(): DeviceInfo | null {
    return this.session_?.info ?? null;
  }

  get watchInterval(): number {
    return this.watchInterval_;
  }

  get connected(): boolean {
    return this.status_ === 'connected';
  }

  /** Pin definitions the UI should render, reserved pins excluded. */
  visiblePins(): PinDefinition[] {
    const advertised = this.info?.pins;
    return this.board_.pins.filter((pin) => {
      if (pin.reserved) return false;
      return advertised === undefined || advertised.includes(pin.gpio);
    });
  }

  // -------------------------------------------------------------- lifecycle

  async connect(transport: Transport): Promise<DeviceInfo> {
    if (this.session_) await this.disconnect();
    const session = new DeviceSession(transport);
    this.session_ = session;
    this.unsubscribe.push(session.onEvent((event) => this.onDeviceEvent(event)));
    this.unsubscribe.push(
      session.onRaw((line) => this.log('rx', line)),
    );
    this.unsubscribe.push(
      session.onStatus((status) => {
        this.status_ = status;
        this.events.emit({ type: 'status', status });
      }),
    );
    this.log('info', `Connecting to ${transport.name}…`);
    const info = await session.connect();
    this.applyDeviceInfo(info);
    this.log('info', `Connected: ${info.chip} · ${info.firmware} · protocol v${info.protocol}`);
    if (this.upgradeBaud) await this.tryUpgradeBaud(session, transport, info);
    return info;
  }

  /**
   * Best-effort link upgrade to {@link PREFERRED_BAUD_RATE} for ~8× streaming
   * throughput. Any failure falls back to the original speed; a failure of the
   * fallback itself surfaces as a normal disconnect.
   */
  private async tryUpgradeBaud(
    session: DeviceSession,
    transport: Transport,
    info: DeviceInfo,
  ): Promise<void> {
    if (!transport.setBaudRate || transport.baudRate === undefined) return;
    const previous = transport.baudRate;
    if (previous >= PREFERRED_BAUD_RATE) return;
    if (info.bauds !== undefined && !info.bauds.includes(PREFERRED_BAUD_RATE)) return;
    try {
      await session.setBaud(PREFERRED_BAUD_RATE);
      await transport.setBaudRate(PREFERRED_BAUD_RATE);
      await session.sysInfo();
      this.log('info', `Link upgraded to ${PREFERRED_BAUD_RATE} baud`);
    } catch {
      this.log('warn', `Could not upgrade the link speed; staying at ${previous} baud`);
      try {
        // Ask the device to come back down in case it already switched, then
        // follow with the host side and verify the link still works.
        await session.call({ cmd: 'sys.baud', baud: previous }, { timeout: 800 }).catch(() => undefined);
        await transport.setBaudRate(previous);
        await session.sysInfo();
      } catch {
        // The transport already emitted a close event; nothing more to do.
      }
    }
  }

  async disconnect(): Promise<void> {
    const session = this.session_;
    this.session_ = null;
    for (const off of this.unsubscribe.splice(0)) off();
    if (session) {
      try {
        await session.call({ cmd: 'watch.clear' }).catch(() => undefined);
        await session.disconnect();
      } finally {
        this.log('info', 'Disconnected');
      }
    }
    this.status_ = 'closed';
    this.events.emit({ type: 'status', status: 'closed' });
  }

  private applyDeviceInfo(info: DeviceInfo): void {
    this.clockOffset = null;
    this.store_ = new PinStateStore({
      capacity: this.traceCapacity,
      adcMax: info.adcMax ?? 4095,
    });
    if (!this.boardPinnedByUser) {
      this.board_ = boardForChip(info.chip);
      if (!isExactBoardMatch(info.chip)) {
        this.log(
          'warn',
          `No pin map for ${info.chip}; showing the generic ESP32 layout. Pick a board manually if the labels look wrong.`,
        );
      }
      this.events.emit({ type: 'board' });
    }
  }

  /** Explicitly choose a layout; disables automatic detection afterwards. */
  selectBoard(board: BoardDefinition): void {
    this.board_ = board;
    this.boardPinnedByUser = true;
    this.events.emit({ type: 'board' });
  }

  // ---------------------------------------------------------------- actions

  private require(): DeviceSession {
    if (!this.session_ || this.status_ !== 'connected') {
      throw new Error('Not connected to a board');
    }
    return this.session_;
  }

  /** Modes that make sense for a pin on the current board. */
  availableModes(gpio: number): PinMode[] {
    const definition = pinDefinition(this.board_, gpio);
    const modes: PinMode[] = ['disabled', 'input'];
    if (!definition) return [...modes, 'output'];
    if (canOutput(definition)) {
      modes.push('input_pullup', 'input_pulldown', 'output', 'output_open_drain', 'pwm');
    }
    if (hasCapability(definition, 'adc')) modes.push('analog');
    if (hasCapability(definition, 'touch')) modes.push('touch');
    return modes;
  }

  async setMode(gpio: number, mode: PinMode): Promise<void> {
    const session = this.require();
    await session.setMode(gpio, mode);
    this.store_.setMode(gpio, mode);
    this.log('info', `GPIO${gpio} → ${mode}`);
    this.events.emit({ type: 'pin', pin: gpio });
    if (this.store_.get(gpio).watched) await this.pushWatch();
  }

  async setLevel(gpio: number, value: 0 | 1): Promise<void> {
    await this.require().write(gpio, value);
    this.store_.setOutput(gpio, value);
    this.store_.record(gpio, this.uptime(), { d: value });
    this.events.emit({ type: 'pin', pin: gpio });
  }

  async toggle(gpio: number): Promise<0 | 1> {
    const result = await this.require().toggle(gpio);
    this.store_.setOutput(gpio, result.value);
    this.store_.record(gpio, this.uptime(), { d: result.value });
    this.events.emit({ type: 'pin', pin: gpio });
    return result.value;
  }

  async pulse(gpio: number, value: 0 | 1, ms: number): Promise<void> {
    await this.require().pulse(gpio, value, ms);
    this.log('info', `GPIO${gpio} pulsed ${value === 1 ? 'HIGH' : 'LOW'} for ${ms} ms`);
  }

  async setPwm(gpio: number, freq: number, duty: number): Promise<void> {
    await this.require().pwm(gpio, freq, duty);
    this.store_.setMode(gpio, 'pwm');
    this.store_.setPwm(gpio, freq, duty);
    this.events.emit({ type: 'pin', pin: gpio });
  }

  async setBlink(gpio: number, period: number): Promise<void> {
    await this.require().blink(gpio, period);
    this.store_.setBlink(gpio, period);
    this.events.emit({ type: 'pin', pin: gpio });
  }

  async readOnce(gpio: number): Promise<void> {
    const sample = await this.require().read(gpio);
    this.store_.record(gpio, this.uptime(), sample);
    this.events.emit({ type: 'pin', pin: gpio });
  }

  async releasePin(gpio: number): Promise<void> {
    await this.require().resetPin(gpio);
    this.store_.setMode(gpio, 'disabled');
    this.store_.setWatched(gpio, false);
    await this.pushWatch();
    this.events.emit({ type: 'pin', pin: gpio });
  }

  async releaseAll(): Promise<void> {
    await this.require().resetPin();
    for (const state of this.store_.all()) {
      this.store_.setMode(state.gpio, 'disabled');
      this.store_.setWatched(state.gpio, false);
    }
    this.store_.clearAllTraces();
    this.events.emit({ type: 'pins', pins: [] });
  }

  async setWatched(gpio: number, watched: boolean): Promise<void> {
    this.store_.setWatched(gpio, watched);
    if (!watched) this.store_.clearTrace(gpio);
    await this.pushWatch();
    this.events.emit({ type: 'pin', pin: gpio });
  }

  async setWatchInterval(interval: number): Promise<void> {
    this.watchInterval_ = interval;
    await this.pushWatch();
  }

  /** Re-send the current watch list, e.g. after a mode or interval change. */
  async pushWatch(): Promise<void> {
    if (!this.session_ || this.status_ !== 'connected') return;
    const pins = this.store_.watchedPins();
    await this.session_.watch(pins, this.watchInterval_);
  }

  /**
   * Run a burst capture on an ADC pin and assemble the chunked result.
   *
   * The command blocks the firmware while it samples, so the watch stream
   * pauses for the duration; the response timeout accounts for the capture
   * span plus any trigger wait.
   */
  async captureAdc(gpio: number, options: CaptureOptions): Promise<AdcCapture> {
    const session = this.require();
    const chunks = new Map<number, Uint16Array>();
    let expected: number | null = null;
    let resolveChunks!: () => void;
    let rejectChunks!: (error: Error) => void;
    const allChunks = new Promise<void>((resolve, reject) => {
      resolveChunks = resolve;
      rejectChunks = reject;
    });
    // Chunks can fail before the await below attaches; keep rejections handled.
    allChunks.catch(() => undefined);
    const settleIfComplete = () => {
      if (expected !== null && chunks.size === expected) resolveChunks();
    };
    const off = session.onEvent((event) => {
      if (event.ev !== 'capture' || event.pin !== gpio) return;
      try {
        chunks.set(event.seq, decodeSamples(event.data));
      } catch (error) {
        rejectChunks(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      expected = event.chunks;
      settleIfComplete();
    });
    try {
      const captureMs = (options.samples / options.rate) * 1000;
      const timeout = captureMs + (options.trigger?.timeoutMs ?? 1000) + 4000;
      const meta = await session.captureAdc(
        {
          cmd: 'adc.capture',
          pin: gpio,
          rate: options.rate,
          samples: options.samples,
          ...(options.pretrigger !== undefined ? { pretrigger: options.pretrigger } : {}),
          ...(options.trigger !== undefined ? { trigger: options.trigger } : {}),
        },
        { timeout },
      );
      expected = meta.chunks;
      settleIfComplete();
      const chunkTimer = setTimeout(
        () => rejectChunks(new Error('timed out waiting for capture data')),
        timeout,
      );
      try {
        await allChunks;
      } finally {
        clearTimeout(chunkTimer);
      }
      const samples = new Uint16Array(meta.samples);
      let position = 0;
      for (let seq = 0; seq < meta.chunks; seq++) {
        const chunk = chunks.get(seq);
        if (!chunk) throw new Error(`capture chunk ${seq} missing`);
        samples.set(chunk.subarray(0, Math.min(chunk.length, samples.length - position)), position);
        position += chunk.length;
      }
      this.log(
        'info',
        `Captured ${meta.samples} samples on GPIO${gpio} at ${meta.rate} Hz${
          meta.triggered ? ' (triggered)' : ''
        }`,
      );
      return {
        pin: gpio,
        rate: meta.rate,
        t0: this.toHostTime(meta.t0),
        samples,
        adcMax: this.info?.adcMax ?? 4095,
        triggered: meta.triggered === true,
      };
    } finally {
      off();
    }
  }

  async scanI2c(sda?: number, scl?: number): Promise<number[]> {
    const defaults = this.board_.defaultI2c ?? { sda: 21, scl: 22 };
    const result = await this.require().scanI2c(sda ?? defaults.sda, scl ?? defaults.scl);
    const devices = result.devices ?? [];
    this.log(
      'info',
      devices.length > 0
        ? `I²C devices found: ${devices.map((address) => `0x${address.toString(16).padStart(2, '0')}`).join(', ')}`
        : 'No I²C devices responded',
    );
    return devices;
  }

  async reboot(): Promise<void> {
    await this.require().reboot();
    this.store_.clearAllTraces();
    this.log('info', 'Board rebooted');
  }

  log(level: LogLine['level'], text: string): void {
    const line: LogLine = { time: Date.now(), level, text };
    this.logs.push(line);
    this.events.emit({ type: 'log', line });
  }

  private onDeviceEvent(event: DeviceEvent): void {
    switch (event.ev) {
      case 'sample': {
        // Device timestamps are uptime based; map them onto the host clock so
        // traces stay aligned with locally recorded points across reboots.
        const pins = this.store_.ingest({
          ...event,
          t: this.toHostTime(event.t),
        });
        this.events.emit({ type: 'pins', pins });
        return;
      }
      case 'pin':
        this.store_.record(event.pin, this.toHostTime(event.t), { d: event.value });
        this.events.emit({ type: 'pin', pin: event.pin });
        return;
      case 'log':
        this.log(event.level, event.message);
        return;
      case 'ready':
        this.clockOffset = null;
        this.log('info', `Board ready: ${event.info.chip}`);
        this.applyDeviceInfo(event.info);
        return;
      case 'error':
        this.log('error', `${event.error.code}: ${event.error.message}`);
        return;
      default:
        return;
    }
  }

  /** Monotonic host clock in milliseconds. */
  private uptime(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /** Translate a device uptime into the host timeline. */
  private toHostTime(deviceTime: number): number {
    if (this.clockOffset === null) this.clockOffset = this.uptime() - deviceTime;
    return deviceTime + this.clockOffset;
  }
}
