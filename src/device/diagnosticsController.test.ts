import { describe, expect, it } from 'vitest';
import { DiagnosticsController } from './diagnosticsController';
import { SimulatedBoard } from '../transport/simulatedBoard';
import { boardById } from './boards';

async function connected(): Promise<{ controller: DiagnosticsController; board: SimulatedBoard }> {
  const board = new SimulatedBoard({ seed: 7 });
  const controller = new DiagnosticsController({ watchInterval: 20 });
  await controller.connect(board);
  return { controller, board };
}

describe('DiagnosticsController', () => {
  it('connects, detects the board layout and exposes usable pins', async () => {
    const { controller } = await connected();
    expect(controller.connected).toBe(true);
    expect(controller.board.id).toBe('esp32');
    const gpios = controller.visiblePins().map((pin) => pin.gpio);
    expect(gpios).toContain(2);
    // Flash pins are reserved, console pins are reserved, GPIO16/17 are not
    // advertised by the simulator and therefore hidden too.
    expect(gpios).not.toContain(6);
    expect(gpios).not.toContain(1);
    await controller.disconnect();
    expect(controller.connected).toBe(false);
  });

  it('offers only the modes a pin supports', async () => {
    const { controller } = await connected();
    expect(controller.availableModes(2)).toEqual([
      'disabled',
      'input',
      'input_pullup',
      'input_pulldown',
      'output',
      'output_open_drain',
      'pwm',
      'analog',
      'touch',
    ]);
    expect(controller.availableModes(34)).toEqual(['disabled', 'input', 'analog']);
    expect(controller.availableModes(16)).toEqual([
      'disabled',
      'input',
      'input_pullup',
      'input_pulldown',
      'output',
      'output_open_drain',
      'pwm',
    ]);
    await controller.disconnect();
  });

  it('drives a pin and records the resulting state', async () => {
    const { controller } = await connected();
    await controller.setMode(2, 'output');
    await controller.setLevel(2, 1);
    expect(controller.store.get(2).output).toBe(1);
    expect(controller.store.get(2).last?.d).toBe(1);
    await expect(controller.toggle(2)).resolves.toBe(0);
    await controller.disconnect();
  });

  it('streams watched pins into the trace store', async () => {
    const { controller, board } = await connected();
    await controller.setMode(4, 'input_pullup');
    await controller.setWatched(4, true);
    board.applyStimulus(4, 0);
    board.tick();
    board.applyStimulus(4, 1);
    board.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const state = controller.store.get(4);
    expect(state.trace.length).toBeGreaterThanOrEqual(2);
    expect(state.stats.transitions).toBeGreaterThanOrEqual(1);
    await controller.disconnect();
  });

  it('stops watching and clears the trace', async () => {
    const { controller, board } = await connected();
    await controller.setMode(4, 'input');
    await controller.setWatched(4, true);
    board.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await controller.setWatched(4, false);
    expect(controller.store.watchedPins()).toEqual([]);
    expect(controller.store.get(4).trace.length).toBe(0);
    await controller.disconnect();
  });

  it('maps device uptime onto a monotonic host timeline', async () => {
    const { controller, board } = await connected();
    await controller.setMode(2, 'output');
    await controller.setWatched(2, true);
    await controller.setLevel(2, 1);
    board.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const points = controller.store.get(2).trace.toArray();
    expect(points.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < points.length; index++) {
      expect(points[index]!.t).toBeGreaterThanOrEqual(points[index - 1]!.t - 1);
    }
    await controller.disconnect();
  });

  it('configures pwm and blink exclusively', async () => {
    const { controller } = await connected();
    await controller.setMode(2, 'output');
    await controller.setPwm(2, 2000, 0.3);
    expect(controller.store.get(2).pwm).toEqual({ freq: 2000, duty: 0.3 });
    await controller.setMode(2, 'output');
    await controller.setBlink(2, 400);
    expect(controller.store.get(2).blink).toBe(400);
    expect(controller.store.get(2).pwm).toBeUndefined();
    await controller.disconnect();
  });

  it('releases pins individually and globally', async () => {
    const { controller, board } = await connected();
    await controller.setMode(2, 'output');
    await controller.setWatched(2, true);
    await controller.releasePin(2);
    expect(board.modeOf(2)).toBe('disabled');
    expect(controller.store.watchedPins()).toEqual([]);

    await controller.setMode(4, 'output');
    await controller.releaseAll();
    expect(board.modeOf(4)).toBe('disabled');
    await controller.disconnect();
  });

  it('scans the I2C bus using the board defaults', async () => {
    const { controller } = await connected();
    await expect(controller.scanI2c()).resolves.toEqual([0x3c, 0x76]);
    expect(controller.logs.toArray().some((line) => line.text.includes('0x3c'))).toBe(true);
    await controller.disconnect();
  });

  it('refuses to act while disconnected', async () => {
    const controller = new DiagnosticsController();
    await expect(controller.setMode(2, 'output')).rejects.toThrow(/Not connected/);
  });

  it('honours a manually selected board layout', async () => {
    const { controller } = await connected();
    controller.selectBoard(boardById('esp32c3')!);
    expect(controller.board.id).toBe('esp32c3');
    await controller.disconnect();
  });

  it('records log lines with a bounded history', async () => {
    const controller = new DiagnosticsController({ logCapacity: 3 });
    for (let index = 0; index < 5; index++) controller.log('info', `line ${index}`);
    expect(controller.logs.length).toBe(3);
    expect(controller.logs.at(0)?.text).toBe('line 2');
  });
});
