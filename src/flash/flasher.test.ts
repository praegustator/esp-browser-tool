import { describe, expect, it, vi, beforeEach } from 'vitest';

const state = {
  chip: 'ESP32-C3',
  writeFlash: vi.fn(),
  disconnect: vi.fn(),
  waitForUnlock: vi.fn(),
};

vi.mock('esptool-js', () => ({
  Transport: class {
    disconnect = state.disconnect;
    waitForUnlock = state.waitForUnlock;
  },
  ESPLoader: class {
    main = async () => state.chip;
    writeFlash = state.writeFlash;
    after = async () => undefined;
  },
}));

const { flashFirmware, FlashError } = await import('./flasher');

const port = {} as SerialPort;
const part = (name: string, address: number) => ({
  name,
  address,
  data: new Uint8Array(16),
});

describe('flashFirmware', () => {
  beforeEach(() => {
    state.chip = 'ESP32-C3';
    state.writeFlash.mockReset();
    state.writeFlash.mockResolvedValue(undefined);
    state.disconnect.mockReset().mockResolvedValue(undefined);
    state.waitForUnlock.mockReset().mockResolvedValue(undefined);
  });

  it('writes a fixed list of parts and releases the port', async () => {
    const chip = await flashFirmware({ port, parts: [part('firmware.bin', 0x10000)] });
    expect(chip).toBe('ESP32-C3');
    expect(state.writeFlash).toHaveBeenCalledTimes(1);
    expect(state.writeFlash.mock.calls[0]![0].fileArray).toEqual([
      { data: expect.any(Uint8Array), address: 0x10000 },
    ]);
    expect(state.disconnect).toHaveBeenCalled();
  });

  it('asks the factory for parts once the chip is known', async () => {
    const factory = vi.fn(async (chip: string) => [part(`${chip}.bin`, 0)]);
    await flashFirmware({ port, parts: factory });
    expect(factory).toHaveBeenCalledWith('ESP32-C3');
    expect(state.writeFlash.mock.calls[0]![0].fileArray[0].address).toBe(0);
  });

  it('reports progress across every part', async () => {
    state.writeFlash.mockImplementation(async (options: { reportProgress: (i: number, w: number) => void }) => {
      options.reportProgress(0, 16);
      options.reportProgress(1, 16);
    });
    const seen: number[] = [];
    await flashFirmware({
      port,
      parts: [part('bootloader.bin', 0), part('firmware.bin', 0x10000)],
      onProgress: (progress) => {
        if (progress.phase === 'writing') seen.push(progress.fraction);
      },
    });
    expect(seen).toEqual([0, 0.5, 1]);
  });

  it('rejects an empty part list, eagerly and from the factory', async () => {
    await expect(flashFirmware({ port, parts: [] })).rejects.toBeInstanceOf(FlashError);
    await expect(flashFirmware({ port, parts: async () => [] })).rejects.toBeInstanceOf(FlashError);
  });

  it('reports failures and still releases the port', async () => {
    state.writeFlash.mockRejectedValue(new Error('timed out'));
    const phases: string[] = [];
    await expect(
      flashFirmware({
        port,
        parts: [part('firmware.bin', 0x10000)],
        onProgress: (progress) => phases.push(progress.phase),
      }),
    ).rejects.toThrow('timed out');
    expect(phases).toContain('failed');
    expect(state.disconnect).toHaveBeenCalled();
  });
});
