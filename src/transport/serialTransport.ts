import { DEFAULT_BAUD_RATE } from '../protocol/types';
import { LineFramer } from './lineFramer';
import { Emitter, type Transport } from './types';

export interface SerialTransportOptions {
  baudRate?: number;
  /** Pulse DTR/RTS after opening so the board restarts into a known state. */
  resetOnOpen?: boolean;
}

/** True when the current browser exposes the Web Serial API. */
export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/**
 * Prompt the user for a serial port. Must be called from a user gesture.
 */
export async function requestSerialPort(): Promise<SerialPort> {
  if (!isWebSerialSupported()) {
    throw new Error(
      'Web Serial is not available. Use Chrome, Edge or Opera 89+ on desktop over HTTPS or localhost.',
    );
  }
  return navigator.serial.requestPort();
}

/** Ports the user already granted access to in a previous session. */
export async function listAuthorizedPorts(): Promise<SerialPort[]> {
  if (!isWebSerialSupported()) return [];
  return navigator.serial.getPorts();
}

/** Human readable label for a port, based on its USB identifiers. */
export function describePort(port: SerialPort): string {
  const info = port.getInfo();
  const vid = info.usbVendorId;
  const pid = info.usbProductId;
  if (vid === undefined || pid === undefined) return 'Serial port';
  const vendor = KNOWN_USB_VENDORS[vid];
  const hex = (value: number) => value.toString(16).padStart(4, '0');
  return `${vendor ? `${vendor} ` : ''}USB ${hex(vid)}:${hex(pid)}`;
}

const KNOWN_USB_VENDORS: Record<number, string> = {
  0x10c4: 'Silicon Labs CP210x',
  0x1a86: 'WCH CH34x',
  0x0403: 'FTDI',
  0x303a: 'Espressif',
};

/**
 * Line oriented Web Serial transport.
 *
 * Reading runs in a detached loop that frames incoming bytes and dispatches
 * complete lines; writing is serialised through a promise chain so overlapping
 * `send` calls cannot interleave partial lines on the wire.
 */
export class SerialTransport implements Transport {
  readonly name: string;

  private readonly port: SerialPort;
  private readonly baudRate: number;
  private readonly resetOnOpen: boolean;
  private readonly framer = new LineFramer();
  private readonly lineEmitter = new Emitter<string>();
  private readonly closeEmitter = new Emitter<Error | null>();
  private readonly encoder = new TextEncoder();

  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private open_ = false;
  private closing = false;
  private readLoop: Promise<void> | null = null;

  constructor(port: SerialPort, options: SerialTransportOptions = {}) {
    this.port = port;
    this.baudRate = options.baudRate ?? DEFAULT_BAUD_RATE;
    this.resetOnOpen = options.resetOnOpen ?? true;
    this.name = describePort(port);
  }

  get isOpen(): boolean {
    return this.open_;
  }

  async open(): Promise<void> {
    if (this.open_) return;
    await this.port.open({ baudRate: this.baudRate, bufferSize: 4096 });
    this.open_ = true;
    this.closing = false;
    this.framer.reset();
    if (!this.port.readable || !this.port.writable) {
      this.open_ = false;
      await this.port.close().catch(() => undefined);
      throw new Error('Serial port opened without readable/writable streams');
    }
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    if (this.resetOnOpen) await this.reset();
    this.readLoop = this.pump();
  }

  private async pump(): Promise<void> {
    const reader = this.reader;
    if (!reader) return;
    let failure: Error | null = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (const line of this.framer.push(value)) this.lineEmitter.emit(line);
      }
    } catch (error) {
      if (!this.closing) failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      const tail = this.framer.flush();
      if (tail) this.lineEmitter.emit(tail);
      if (!this.closing) {
        this.open_ = false;
        this.closeEmitter.emit(failure);
      }
    }
  }

  async send(line: string): Promise<void> {
    if (!this.open_ || !this.writer) throw new Error('Serial port is not open');
    const payload = this.encoder.encode(line.endsWith('\n') ? line : `${line}\n`);
    const writer = this.writer;
    this.writeChain = this.writeChain.then(() => writer.write(payload));
    return this.writeChain;
  }

  /** Toggle DTR/RTS in the sequence that reboots an ESP32 into its firmware. */
  async reset(): Promise<void> {
    if (!this.open_) return;
    try {
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: true });
      await delay(120);
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
      await delay(120);
    } catch {
      // Adapters without modem control lines simply cannot be reset this way.
    }
  }

  async close(): Promise<void> {
    if (!this.open_ && !this.closing) return;
    this.closing = true;
    this.open_ = false;
    try {
      await this.writeChain.catch(() => undefined);
      await this.reader?.cancel().catch(() => undefined);
      this.reader?.releaseLock();
      await this.writer?.close().catch(() => undefined);
      this.writer?.releaseLock();
      await this.readLoop?.catch(() => undefined);
      await this.port.close();
    } finally {
      this.reader = null;
      this.writer = null;
      this.readLoop = null;
      this.closeEmitter.emit(null);
    }
  }

  onLine(handler: (line: string) => void): () => void {
    return this.lineEmitter.on(handler);
  }

  onClose(handler: (reason: Error | null) => void): () => void {
    return this.closeEmitter.on(handler);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
