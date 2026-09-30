import { DiagnosticsController } from '../device/diagnosticsController';
import { BOARDS, type BoardDefinition } from '../device/boards';
import { SimulatedBoard } from '../transport/simulatedBoard';
import {
  isWebSerialSupported,
  requestSerialPort,
  SerialTransport,
} from '../transport/serialTransport';
import { button, clear, el, select } from './dom';
import { FlashPanel } from './flashPanel';
import { LogView } from './logView';
import { PinTile } from './pinTile';
import { ScopePanel } from './scopePanel';
import type { PinDefinition } from '../device/boards';

export interface AppOptions {
  manifestUrl?: string;
  /** Start in demo mode without asking for a port (used by the demo button). */
  autoDemo?: boolean;
}

const INTERVALS = [5, 10, 20, 50, 100, 250, 500] as const;

/** Highest waveform frequency a given sampling interval can show faithfully. */
function nyquistText(intervalMs: number): string {
  const nyquistHz = 1000 / intervalMs / 2;
  return `≤ ${nyquistHz >= 10 ? Math.round(nyquistHz) : nyquistHz.toFixed(1)} Hz waves`;
}

/**
 * Top level view: toolbar, flashing panel, pin matrix and console.
 *
 * Rendering is intentionally incremental — the pin matrix is built once per
 * board change, and sample events only patch the affected tiles, so a 50 ms
 * sampling rate over twenty pins stays cheap.
 */
export class App {
  readonly root: HTMLElement;
  readonly controller: DiagnosticsController;

  private readonly tiles = new Map<number, PinTile>();
  private readonly grid: HTMLElement;
  private readonly statusNode: HTMLElement;
  private readonly infoNode: HTMLElement;
  private readonly connectButton: HTMLButtonElement;
  private readonly demoButton: HTMLButtonElement;
  private readonly actionsNode: HTMLElement;
  private frameRequested = false;
  private dirtyPins = new Set<number>();
  private scopePanel: ScopePanel | null = null;

  constructor(options: AppOptions = {}) {
    this.controller = new DiagnosticsController();
    this.statusNode = el('span', { class: 'status status-closed', text: 'Disconnected' });
    this.infoNode = el('span', { class: 'device-info' });
    this.grid = el('div', { class: 'pin-grid' });
    this.actionsNode = el('div', { class: 'toolbar-actions' });

    this.connectButton = button('Connect board', () => this.connectSerial(), {
      class: 'btn-primary',
    });
    this.demoButton = button('Try demo board', () => this.connectSimulated(), { class: 'btn-ghost' });

    const flashPanel = new FlashPanel(this.controller, {
      manifestUrl: options.manifestUrl ?? 'firmware/manifest.json',
    });
    const logView = new LogView(this.controller);

    this.root = el(
      'div',
      { class: 'app' },
      this.buildToolbar(),
      el(
        'main',
        { class: 'layout' },
        el(
          'div',
          { class: 'column column-main' },
          el(
            'section',
            { class: 'panel pins-panel' },
            el(
              'header',
              { class: 'panel-head' },
              el('h2', { text: '2 · Live pins' }),
              this.actionsNode,
            ),
            this.grid,
          ),
        ),
        el('div', { class: 'column column-side' }, flashPanel.root, logView.root, helpPanel()),
      ),
    );

    this.controller.events.on((event) => {
      switch (event.type) {
        case 'status':
          this.renderStatus();
          break;
        case 'board':
          this.renderGrid();
          break;
        case 'pin':
          this.markDirty([event.pin]);
          break;
        case 'pins':
          this.markDirty(event.pins);
          break;
        default:
          break;
      }
    });

    this.renderStatus();
    this.renderGrid();
    this.renderActions();
    if (options.autoDemo) void this.connectSimulated();
  }

  private buildToolbar(): HTMLElement {
    const boardSelect = select<string>(
      BOARDS.map((board) => board.id),
      this.controller.board.id,
      (id) => {
        const board = BOARDS.find((item) => item.id === id);
        if (board) this.controller.selectBoard(board);
      },
      (id) => BOARDS.find((board) => board.id === id)?.name ?? id,
    );
    boardSelect.setAttribute('aria-label', 'Board layout');

    const bandwidthNote = el('span', {
      class: 'bandwidth-note muted',
      text: nyquistText(this.controller.watchInterval),
      title: 'Signals faster than this alias on the live trace — use a burst capture instead.',
    });
    const intervalSelect = select<string>(
      INTERVALS.map(String),
      String(this.controller.watchInterval),
      (value) => {
        bandwidthNote.textContent = nyquistText(Number(value));
        return this.controller.setWatchInterval(Number(value));
      },
      (value) => `${value} ms`,
    );
    intervalSelect.setAttribute('aria-label', 'Sampling interval');

    return el(
      'header',
      { class: 'toolbar' },
      el(
        'div',
        { class: 'brand' },
        el('span', { class: 'brand-mark', text: '⚡' }),
        el('h1', { text: 'ESP Browser Tool' }),
      ),
      el(
        'div',
        { class: 'toolbar-group' },
        this.connectButton,
        this.demoButton,
        button('Disconnect', () => this.disconnect(), { class: 'btn-ghost' }),
      ),
      el(
        'div',
        { class: 'toolbar-group' },
        el('label', { class: 'field' }, el('span', { text: 'Layout' }), boardSelect),
        el('label', { class: 'field' }, el('span', { text: 'Sample every' }), intervalSelect),
        bandwidthNote,
      ),
      el('div', { class: 'toolbar-group toolbar-status' }, this.statusNode, this.infoNode),
    );
  }

  private renderActions(): void {
    clear(this.actionsNode);
    this.actionsNode.append(
      button('Watch all inputs', () => this.watchAllInputs()),
      button('Scan I²C', () => this.scanI2c()),
      button('Blink onboard LED', () => this.blinkLed()),
      button('Release all pins', () => this.releaseAll(), { class: 'btn-ghost' }),
    );
  }

  // ------------------------------------------------------------- connection

  private async connectSerial(): Promise<void> {
    if (!isWebSerialSupported()) {
      this.controller.log(
        'error',
        'Web Serial is unavailable. Use desktop Chrome, Edge or Opera over HTTPS or localhost.',
      );
      return;
    }
    try {
      const port = await requestSerialPort();
      await this.controller.connect(new SerialTransport(port));
    } catch (error) {
      this.reportError(error);
    }
  }

  private async connectSimulated(): Promise<void> {
    try {
      await this.controller.connect(new SimulatedBoard());
      this.controller.log(
        'info',
        'Demo board connected — no hardware involved. Values are synthesised.',
      );
    } catch (error) {
      this.reportError(error);
    }
  }

  private async disconnect(): Promise<void> {
    try {
      await this.controller.disconnect();
    } catch (error) {
      this.reportError(error);
    }
  }

  // ---------------------------------------------------------- bulk actions

  private async watchAllInputs(): Promise<void> {
    try {
      for (const pin of this.controller.visiblePins()) {
        const state = this.controller.store.get(pin.gpio);
        if (state.mode === 'disabled') continue;
        await this.controller.setWatched(pin.gpio, true);
      }
      if (this.controller.store.watchedPins().length === 0) {
        this.controller.log('warn', 'No pin is configured yet — set a mode first.');
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private async scanI2c(): Promise<void> {
    try {
      await this.controller.scanI2c();
    } catch (error) {
      this.reportError(error);
    }
  }

  private async blinkLed(): Promise<void> {
    const led = this.controller.board.ledPin;
    if (led === undefined) {
      this.controller.log('warn', 'This layout has no onboard LED.');
      return;
    }
    try {
      await this.controller.setMode(led, 'output');
      await this.controller.setBlink(led, 500);
      await this.controller.setWatched(led, true);
    } catch (error) {
      this.reportError(error);
    }
  }

  private async releaseAll(): Promise<void> {
    try {
      await this.controller.releaseAll();
      this.renderGrid();
    } catch (error) {
      this.reportError(error);
    }
  }

  // ---------------------------------------------------------------- render

  private renderStatus(): void {
    const status = this.controller.status;
    this.statusNode.className = `status status-${status}`;
    this.statusNode.textContent =
      status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Disconnected';
    const info = this.controller.info;
    this.infoNode.textContent = info
      ? `${info.chip} · ${info.firmware}${info.mac ? ` · ${info.mac}` : ''}`
      : '';
    this.connectButton.disabled = status === 'connecting';
    this.demoButton.disabled = status !== 'closed';
  }

  private renderGrid(): void {
    this.closeScope();
    clear(this.grid);
    this.tiles.clear();
    for (const definition of this.controller.visiblePins()) {
      const tile = new PinTile(this.controller, definition, {
        onExpand: () => this.openScope(definition),
      });
      this.tiles.set(definition.gpio, tile);
      this.grid.appendChild(tile.root);
      tile.update();
    }
  }

  /** Open the expanded oscilloscope view for one pin (one panel at a time). */
  private openScope(definition: PinDefinition): void {
    this.closeScope();
    this.scopePanel = new ScopePanel(this.controller, definition, () => {
      this.scopePanel = null;
    });
    this.root.appendChild(this.scopePanel.root);
  }

  private closeScope(): void {
    this.scopePanel?.destroy();
    this.scopePanel = null;
  }

  /** Coalesce updates into one animation frame to keep fast streams smooth. */
  private markDirty(pins: number[]): void {
    for (const pin of pins) this.dirtyPins.add(pin);
    if (this.frameRequested) return;
    this.frameRequested = true;
    const flush = () => {
      this.frameRequested = false;
      const pending = [...this.dirtyPins];
      this.dirtyPins.clear();
      for (const pin of pending) this.tiles.get(pin)?.update();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (/No port selected|cancelled/i.test(message)) return;
    this.controller.log('error', message);
  }

  /** Currently rendered board, exposed for tests. */
  get board(): BoardDefinition {
    return this.controller.board;
  }
}

function helpPanel(): HTMLElement {
  return el(
    'section',
    { class: 'panel help-panel' },
    el('header', { class: 'panel-head' }, el('h2', { text: 'How to use it' })),
    el(
      'ol',
      { class: 'help-list' },
      el('li', {
        text: 'Plug the board in over USB and flash the diagnostic firmware (step 1). You only need to do this once.',
      }),
      el('li', { text: 'Press “Connect board” and pick the serial port of the ESP32.' }),
      el('li', {
        text: 'Give a pin a mode: “Input ↑ pull-up” to probe with a jumper, “Analog” to plot a voltage, “Output” to drive an LED.',
      }),
      el('li', {
        text: 'Tick “Watch” to stream that pin. Touch the pin with a 3.3 V wire and watch the trace flip — that is how you identify an unlabelled header.',
      }),
      el('li', {
        text: 'Use “Release all pins” before unplugging, then move on to ESPHome or your own firmware.',
      }),
    ),
    el('p', {
      class: 'muted',
      text: 'Safety: never feed more than 3.3 V into a GPIO, always share ground, and keep a resistor in series with LEDs.',
    }),
  );
}
