import { decodeMessage, encodeRequest, isDeviceEvent, ProtocolParseError } from '../protocol/codec';
import {
  PROTOCOL_VERSION,
  type DeviceEvent,
  type DeviceInfo,
  type PinMode,
  type PinSample,
  type Request,
  type RequestBody,
  type Response,
} from '../protocol/types';
import { Emitter, type Transport } from '../transport/types';

export class DeviceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DeviceError';
    this.code = code;
  }
}

export interface PendingCall {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  cmd: string;
}

export interface SessionOptions {
  /** Milliseconds before an unanswered command is rejected. */
  timeout?: number;
}

export type SessionStatus = 'closed' | 'connecting' | 'connected';

/**
 * Turns a byte-level {@link Transport} into a typed, promise based device API.
 *
 * Responsibilities:
 *  - correlate responses with requests via the `id` field;
 *  - time out commands so a wedged board cannot hang the UI;
 *  - surface asynchronous events (samples, logs, ready) to subscribers;
 *  - forward non protocol lines as raw firmware console output.
 */
export class DeviceSession {
  readonly transport: Transport;

  private readonly pending = new Map<number, PendingCall>();
  private readonly eventEmitter = new Emitter<DeviceEvent>();
  private readonly rawEmitter = new Emitter<string>();
  private readonly statusEmitter = new Emitter<SessionStatus>();
  private readonly timeout: number;
  private readonly unsubscribe: Array<() => void> = [];

  private nextId = 1;
  private status_: SessionStatus = 'closed';
  private info_: DeviceInfo | null = null;

  constructor(transport: Transport, options: SessionOptions = {}) {
    this.transport = transport;
    this.timeout = options.timeout ?? 4000;
  }

  get status(): SessionStatus {
    return this.status_;
  }

  get info(): DeviceInfo | null {
    return this.info_;
  }

  onEvent(handler: (event: DeviceEvent) => void): () => void {
    return this.eventEmitter.on(handler);
  }

  /** Lines that are not valid protocol JSON (firmware `Serial.print` output). */
  onRaw(handler: (line: string) => void): () => void {
    return this.rawEmitter.on(handler);
  }

  onStatus(handler: (status: SessionStatus) => void): () => void {
    return this.statusEmitter.on(handler);
  }

  async connect(): Promise<DeviceInfo> {
    this.setStatus('connecting');
    this.unsubscribe.push(this.transport.onLine((line) => this.handleLine(line)));
    this.unsubscribe.push(
      this.transport.onClose((reason) => {
        this.failAllPending(reason ?? new Error('connection closed'));
        this.setStatus('closed');
      }),
    );
    try {
      await this.transport.open();
      const info = await this.handshake();
      this.info_ = info;
      this.setStatus('connected');
      return info;
    } catch (error) {
      await this.disconnect().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Say hello, retrying a few times: a freshly reset ESP32 spends the first
   * moments printing its bootloader banner and ignores input.
   */
  private async handshake(attempts = 4): Promise<DeviceInfo> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.call<DeviceInfo>({ cmd: 'hello', protocol: PROTOCOL_VERSION });
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new DeviceError(
      'handshake_failed',
      `The board did not answer the diagnostic handshake. Is the ESP Browser Tool firmware flashed? (${
        lastError instanceof Error ? lastError.message : String(lastError)
      })`,
    );
  }

  async disconnect(): Promise<void> {
    this.failAllPending(new Error('disconnected'));
    for (const off of this.unsubscribe.splice(0)) off();
    try {
      await this.transport.close();
    } finally {
      this.info_ = null;
      this.setStatus('closed');
    }
  }

  /** Send a command and await its response. */
  call<T = unknown>(request: RequestBody): Promise<T> {
    const id = this.nextId++;
    const full = { ...request, id } as Request;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DeviceError('timeout', `command "${full.cmd}" timed out after ${this.timeout} ms`));
      }, this.timeout);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        cmd: full.cmd,
      });
      this.transport.send(encodeRequest(full)).catch((error: unknown) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  // --------------------------------------------------------------- commands

  info$(): Promise<DeviceInfo> {
    return this.call<DeviceInfo>({ cmd: 'sys.info' });
  }

  setMode(pin: number, mode: PinMode): Promise<unknown> {
    return this.call({ cmd: 'pin.mode', pin, mode });
  }

  read(pin: number): Promise<PinSample & { pin: number }> {
    return this.call({ cmd: 'pin.read', pin });
  }

  write(pin: number, value: 0 | 1): Promise<unknown> {
    return this.call({ cmd: 'pin.write', pin, value });
  }

  toggle(pin: number): Promise<{ pin: number; value: 0 | 1 }> {
    return this.call({ cmd: 'pin.toggle', pin });
  }

  pulse(pin: number, value: 0 | 1, ms: number): Promise<unknown> {
    return this.call({ cmd: 'pin.pulse', pin, value, ms });
  }

  pwm(pin: number, freq: number, duty: number): Promise<unknown> {
    return this.call({ cmd: 'pin.pwm', pin, freq, duty });
  }

  blink(pin: number, period: number): Promise<unknown> {
    return this.call({ cmd: 'pin.blink', pin, period });
  }

  resetPin(pin?: number): Promise<unknown> {
    return this.call(pin === undefined ? { cmd: 'pin.reset' } : { cmd: 'pin.reset', pin });
  }

  watch(pins: number[], interval: number): Promise<unknown> {
    return pins.length === 0
      ? this.call({ cmd: 'watch.clear' })
      : this.call({ cmd: 'watch.set', pins, interval });
  }

  scanI2c(sda: number, scl: number): Promise<{ devices: number[] }> {
    return this.call({ cmd: 'scan.i2c', sda, scl });
  }

  reboot(): Promise<unknown> {
    return this.call({ cmd: 'sys.reset' });
  }

  // ----------------------------------------------------------------- plumbing

  private handleLine(line: string): void {
    let message;
    try {
      message = decodeMessage(line);
    } catch (error) {
      if (error instanceof ProtocolParseError) {
        this.rawEmitter.emit(line);
        return;
      }
      throw error;
    }
    if (isDeviceEvent(message)) {
      if (message.ev === 'ready') this.info_ = message.info;
      this.eventEmitter.emit(message);
      return;
    }
    this.settle(message);
  }

  private settle(response: Response): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      this.rawEmitter.emit(`[unmatched response] ${JSON.stringify(response)}`);
      return;
    }
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(new DeviceError(response.error.code, response.error.message));
    }
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private setStatus(status: SessionStatus): void {
    if (this.status_ === status) return;
    this.status_ = status;
    this.statusEmitter.emit(status);
  }
}
