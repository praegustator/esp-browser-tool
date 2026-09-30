import { describe, expect, it, vi } from 'vitest';
import { DeviceError, DeviceSession } from './session';
import { SimulatedBoard } from '../transport/simulatedBoard';
import { Emitter, type Transport } from '../transport/types';
import type { SampleEvent } from '../protocol/types';

function connected(): Promise<{ session: DeviceSession; board: SimulatedBoard }> {
  const board = new SimulatedBoard({ seed: 1 });
  const session = new DeviceSession(board, { timeout: 500 });
  return session.connect().then(() => ({ session, board }));
}

describe('DeviceSession against the simulated board', () => {
  it('handshakes and reports device info', async () => {
    const { session } = await connected();
    expect(session.status).toBe('connected');
    expect(session.info?.chip).toContain('ESP32');
    expect(session.info?.protocol).toBe(1);
    await session.disconnect();
    expect(session.status).toBe('closed');
  });

  it('drives an output pin and reads it back', async () => {
    const { session } = await connected();
    await session.setMode(2, 'output');
    await session.write(2, 1);
    await expect(session.read(2)).resolves.toMatchObject({ pin: 2, d: 1 });
    await expect(session.toggle(2)).resolves.toMatchObject({ value: 0 });
    await session.disconnect();
  });

  it('rejects driving an input-only pin', async () => {
    const { session } = await connected();
    await expect(session.setMode(34, 'output')).rejects.toBeInstanceOf(DeviceError);
    await expect(session.setMode(34, 'output')).rejects.toMatchObject({ code: 'input_only' });
    await session.disconnect();
  });

  it('rejects writing to a pin that is not an output', async () => {
    const { session } = await connected();
    await session.setMode(4, 'input_pullup');
    await expect(session.write(4, 1)).rejects.toMatchObject({ code: 'bad_mode' });
    await session.disconnect();
  });

  it('reflects the applied stimulus on input pins', async () => {
    const { session, board } = await connected();
    await session.setMode(4, 'input_pullup');
    await expect(session.read(4)).resolves.toMatchObject({ d: 1 });
    board.applyStimulus(4, 0);
    await expect(session.read(4)).resolves.toMatchObject({ d: 0 });
    await session.disconnect();
  });

  it('reads millivolts on analog pins', async () => {
    const { session, board } = await connected();
    await session.setMode(34, 'analog');
    board.applyStimulus(34, 1);
    const sample = await session.read(34);
    expect(sample.mv).toBeGreaterThan(3000);
    expect(sample.a).toBeGreaterThan(3800);
    await session.disconnect();
  });

  it('reports touch pads as pressed', async () => {
    const { session, board } = await connected();
    await session.setMode(4, 'touch');
    const idle = await session.read(4);
    board.applyTouch(4, true);
    const pressed = await session.read(4);
    expect(pressed.t ?? 0).toBeLessThan(idle.t ?? 0);
    await session.disconnect();
  });

  it('streams sample events for watched pins', async () => {
    const { session, board } = await connected();
    const samples: SampleEvent[] = [];
    session.onEvent((event) => {
      if (event.ev === 'sample') samples.push(event);
    });
    await session.setMode(2, 'output');
    await session.write(2, 1);
    await session.watch([2], 10);
    board.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0]?.pins['2']).toEqual({ d: 1 });
    await session.watch([], 10);
    await session.disconnect();
  });

  it('scans the I2C bus', async () => {
    const { session } = await connected();
    await expect(session.scanI2c(21, 22)).resolves.toEqual({ sda: 21, scl: 22, devices: [0x3c, 0x76] });
    await expect(session.scanI2c(16, 17)).resolves.toMatchObject({ devices: [] });
    await session.disconnect();
  });

  it('releases pins on reset', async () => {
    const { session, board } = await connected();
    await session.setMode(2, 'output');
    await session.resetPin(2);
    expect(board.modeOf(2)).toBe('disabled');
    await session.disconnect();
  });
});

/** Transport that swallows everything, to exercise error paths. */
class SilentTransport implements Transport {
  readonly name = 'silent';
  isOpen = false;
  private lines = new Emitter<string>();
  private closes = new Emitter<Error | null>();

  async open(): Promise<void> {
    this.isOpen = true;
  }

  async close(): Promise<void> {
    this.isOpen = false;
  }

  async send(): Promise<void> {
    /* intentionally never answers */
  }

  emitLine(line: string): void {
    this.lines.emit(line);
  }

  fail(error: Error): void {
    this.closes.emit(error);
  }

  onLine(handler: (line: string) => void): () => void {
    return this.lines.on(handler);
  }

  onClose(handler: (reason: Error | null) => void): () => void {
    return this.closes.on(handler);
  }
}

describe('DeviceSession error handling', () => {
  it('times out and reports a helpful handshake failure', async () => {
    vi.useFakeTimers();
    const session = new DeviceSession(new SilentTransport(), { timeout: 10 });
    const promise = session.connect();
    const assertion = expect(promise).rejects.toMatchObject({ code: 'handshake_failed' });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    vi.useRealTimers();
  });

  it('forwards non protocol lines as raw output', async () => {
    const transport = new SilentTransport();
    const session = new DeviceSession(transport, { timeout: 10 });
    const raw: string[] = [];
    session.onRaw((line) => raw.push(line));
    void session.connect().catch(() => undefined);
    transport.emitLine('rst:0x1 (POWERON_RESET)');
    expect(raw).toContain('rst:0x1 (POWERON_RESET)');
  });

  it('rejects pending commands when the transport drops', async () => {
    const transport = new SilentTransport();
    const session = new DeviceSession(transport, { timeout: 5000 });
    void session.connect().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = session.call({ cmd: 'sys.info' });
    transport.fail(new Error('device unplugged'));
    await expect(pending).rejects.toThrow(/unplugged/);
  });
});
