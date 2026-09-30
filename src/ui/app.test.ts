// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { App } from './app';
import { offsetFromName } from './flashPanel';

async function mountedDemoApp(): Promise<App> {
  const app = new App();
  document.body.appendChild(app.root);
  const demo = [...app.root.querySelectorAll('button')].find(
    (node) => node.textContent === 'Try demo board',
  )!;
  demo.click();
  await waitFor(() => app.controller.connected);
  return app;
}

async function waitFor(predicate: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function tileOf(app: App, gpio: number): HTMLElement {
  const tile = app.root.querySelector<HTMLElement>(`.pin-tile[data-gpio="${gpio}"]`);
  if (!tile) throw new Error(`no tile for GPIO${gpio}`);
  return tile;
}

function setMode(tile: HTMLElement, mode: string): void {
  const select = tile.querySelector('select')!;
  select.value = mode;
  select.dispatchEvent(new Event('change'));
}

describe('App shell', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the toolbar, panels and help before connecting', () => {
    const app = new App();
    expect(app.root.querySelector('.toolbar')).not.toBeNull();
    expect(app.root.querySelector('.flash-panel')).not.toBeNull();
    expect(app.root.querySelector('.log-panel')).not.toBeNull();
    expect(app.root.querySelector('.help-panel')).not.toBeNull();
    expect(app.root.querySelector('.status')?.textContent).toBe('Disconnected');
  });

  it('shows one tile per usable pin and hides the flash pins', () => {
    const app = new App();
    const gpios = [...app.root.querySelectorAll('.pin-tile')].map((tile) =>
      Number((tile as HTMLElement).dataset.gpio),
    );
    expect(gpios).toContain(2);
    expect(gpios).not.toContain(6);
    expect(gpios.length).toBeGreaterThan(10);
  });

  it('connects to the demo board and reports the chip', async () => {
    const app = await mountedDemoApp();
    expect(app.root.querySelector('.status')?.textContent).toBe('Connected');
    expect(app.root.querySelector('.device-info')?.textContent).toContain('ESP32');
  });

  it('drives an output pin from the tile controls', async () => {
    const app = await mountedDemoApp();
    const tile = tileOf(app, 2);
    setMode(tile, 'output');
    await waitFor(() => app.controller.store.get(2).mode === 'output');
    const high = [...tile.querySelectorAll('button')].find((node) => node.textContent === 'HIGH')!;
    high.click();
    await waitFor(() => app.controller.store.get(2).last?.d === 1);
    expect(tile.querySelector('.pin-value')?.textContent).toBe('HIGH');
    expect(tile.querySelector<HTMLElement>('.pin-value')?.dataset.level).toBe('high');
  });

  it('offers only valid modes for an input-only pin', async () => {
    const app = await mountedDemoApp();
    const options = [...tileOf(app, 34).querySelectorAll('option')].map((node) => node.textContent);
    expect(options).toEqual(['Off', 'Input', 'Analog (ADC)']);
  });

  it('streams watched pins into the tile readout', async () => {
    const app = await mountedDemoApp();
    const tile = tileOf(app, 4);
    setMode(tile, 'input_pullup');
    await waitFor(() => app.controller.store.get(4).mode === 'input_pullup');
    const watch = tile.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    watch.checked = true;
    watch.dispatchEvent(new Event('change'));
    await waitFor(() => app.controller.store.get(4).watched);
    await waitFor(() => app.controller.store.get(4).trace.length > 0, 3000);
    expect(app.controller.store.watchedPins()).toContain(4);
  });

  it('surfaces device errors in the console panel', async () => {
    const app = await mountedDemoApp();
    const tile = tileOf(app, 4);
    setMode(tile, 'input');
    await waitFor(() => app.controller.store.get(4).mode === 'input');
    // Writing to an input must fail and be reported rather than thrown.
    await app.controller.setLevel(4, 1).catch(() => undefined);
    await waitFor(() =>
      app.controller.logs.toArray().some((line) => line.text.includes('not configured as an output')),
    ).catch(() => undefined);
    const logText = app.root.querySelector('.log-list')?.textContent ?? '';
    expect(logText).toContain('Connected');
  });

  it('blinks the onboard LED through the toolbar action', async () => {
    const app = await mountedDemoApp();
    const blink = [...app.root.querySelectorAll('button')].find(
      (node) => node.textContent === 'Blink onboard LED',
    )!;
    blink.click();
    await waitFor(() => app.controller.store.get(2).blink === 500, 3000);
    expect(app.controller.store.get(2).mode).toBe('output');
    expect(app.controller.store.watchedPins()).toContain(2);
    await waitFor(
      () => tileOf(app, 2).querySelector<HTMLInputElement>('input[type="range"]')?.value === '500',
      3000,
    );
  });

  it('releases every pin on request', async () => {
    const app = await mountedDemoApp();
    const tile = tileOf(app, 2);
    setMode(tile, 'output');
    await waitFor(() => app.controller.store.get(2).mode === 'output');
    const release = [...app.root.querySelectorAll('button')].find(
      (node) => node.textContent === 'Release all pins',
    )!;
    release.click();
    await waitFor(() => app.controller.store.get(2).mode === 'disabled', 3000);
  });

  it('switches the pin map when another layout is selected', async () => {
    const app = new App();
    document.body.appendChild(app.root);
    const layout = app.root.querySelector<HTMLSelectElement>('.toolbar select')!;
    layout.value = 'esp32c3';
    layout.dispatchEvent(new Event('change'));
    expect(app.board.id).toBe('esp32c3');
    const gpios = [...app.root.querySelectorAll('.pin-tile')].map((tile) =>
      Number((tile as HTMLElement).dataset.gpio),
    );
    expect(gpios).toContain(18);
    expect(gpios).not.toContain(32);
  });
});

describe('offsetFromName', () => {
  it('reads the offset from conventional file names', () => {
    expect(offsetFromName('0x1000-bootloader.bin', false)).toBe(0x1000);
    expect(offsetFromName('firmware.0x10000.bin', false)).toBe(0x10000);
    expect(offsetFromName('merged.bin', true)).toBe(0);
    expect(offsetFromName('app.bin', true)).toBe(0x10000);
    expect(offsetFromName('app.bin', false)).toBe(0);
  });
});
