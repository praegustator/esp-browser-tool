import type { DiagnosticsController } from '../device/diagnosticsController';
import { formatValue, type PinRuntimeState } from '../device/pinStateStore';
import { pinLabel, type PinDefinition } from '../device/boards';
import type { PinMode } from '../protocol/types';
import { button, clear, el, select } from './dom';
import { drawScope, prepareCanvas } from './scope';

const MODE_LABELS: Record<PinMode, string> = {
  disabled: 'Off',
  input: 'Input',
  input_pullup: 'Input ↑ pull-up',
  input_pulldown: 'Input ↓ pull-down',
  output: 'Output',
  output_open_drain: 'Output (open drain)',
  analog: 'Analog (ADC)',
  touch: 'Touch',
  pwm: 'PWM',
};

const SPARK_WIDTH = 220;
const SPARK_HEIGHT = 46;

/**
 * One card per GPIO: mode selector, live value, controls appropriate to the
 * current mode, and a rolling mini-scope of the recent trace.
 */
export class PinTile {
  readonly root: HTMLElement;

  private readonly controller: DiagnosticsController;
  private readonly definition: PinDefinition;
  private readonly valueNode: HTMLElement;
  private readonly statsNode: HTMLElement;
  private readonly controlsNode: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly watchToggle: HTMLInputElement;
  private renderedMode: PinMode | null = null;
  /** Live controls of the current mode, kept so `update()` can resync them. */
  private syncControls: (() => void) | null = null;

  constructor(controller: DiagnosticsController, definition: PinDefinition) {
    this.controller = controller;
    this.definition = definition;

    this.valueNode = el('span', { class: 'pin-value', text: '—' });
    this.statsNode = el('div', { class: 'pin-stats' });
    this.controlsNode = el('div', { class: 'pin-controls' });
    this.canvas = el('canvas', { class: 'pin-scope' });
    this.watchToggle = el('input', {
      attrs: { type: 'checkbox', 'aria-label': `Watch GPIO${definition.gpio}` },
      on: {
        change: () => {
          void this.run(() => controller.setWatched(definition.gpio, this.watchToggle.checked));
        },
      },
    });

    const modeSelect = select<PinMode>(
      controller.availableModes(definition.gpio),
      'disabled',
      (mode) => this.run(() => controller.setMode(definition.gpio, mode)),
      (mode) => MODE_LABELS[mode],
    );
    modeSelect.setAttribute('aria-label', `Mode of GPIO${definition.gpio}`);

    this.root = el(
      'article',
      {
        class: 'pin-tile',
        attrs: { 'data-gpio': definition.gpio },
      },
      el(
        'header',
        { class: 'pin-head' },
        el('span', { class: 'pin-name', text: pinLabel(definition) }),
        this.valueNode,
      ),
      definition.warning
        ? el('p', { class: 'pin-warning', text: `⚠ ${definition.warning}` })
        : definition.note
          ? el('p', { class: 'pin-note', text: definition.note })
          : null,
      el(
        'div',
        { class: 'pin-row' },
        modeSelect,
        el('label', { class: 'pin-watch' }, this.watchToggle, el('span', { text: 'Watch' })),
      ),
      this.controlsNode,
      this.canvas,
      this.statsNode,
      el(
        'footer',
        { class: 'pin-foot' },
        el('span', { class: 'pin-caps', text: this.capabilityText() }),
        button('Read', () => this.run(() => controller.readOnce(definition.gpio)), {
          class: 'btn-ghost',
        }),
        button('Release', () => this.run(() => controller.releasePin(definition.gpio)), {
          class: 'btn-ghost',
        }),
      ),
    );
  }

  private capabilityText(): string {
    const parts: string[] = [];
    if (this.definition.adc) parts.push(this.definition.adc);
    if (this.definition.touch) parts.push(`touch ${this.definition.touch}`);
    if (this.definition.capabilities.includes('input-only')) parts.push('input only');
    return parts.join(' · ');
  }

  private state(): PinRuntimeState {
    return this.controller.store.get(this.definition.gpio);
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.controller.log('error', error instanceof Error ? error.message : String(error));
    }
    this.update();
  }

  /** Refresh every dynamic part of the tile. */
  update(): void {
    const state = this.state();
    this.watchToggle.checked = state.watched;
    this.valueNode.textContent = formatValue(state);
    this.valueNode.dataset.level =
      state.last?.d === undefined ? 'none' : state.last.d === 1 ? 'high' : 'low';
    this.root.dataset.mode = state.mode;
    this.root.dataset.active = String(state.mode !== 'disabled');
    if (this.renderedMode !== state.mode) {
      this.renderedMode = state.mode;
      this.renderControls(state);
    } else {
      this.syncControls?.();
    }
    this.renderStats(state);
    this.renderScope(state);
  }

  private renderControls(state: PinRuntimeState): void {
    clear(this.controlsNode);
    this.syncControls = null;
    const gpio = this.definition.gpio;
    const controller = this.controller;
    switch (state.mode) {
      case 'output':
      case 'output_open_drain': {
        const high = button('HIGH', () => this.run(() => controller.setLevel(gpio, 1)), {
          class: 'btn-high',
        });
        const low = button('LOW', () => this.run(() => controller.setLevel(gpio, 0)), {
          class: 'btn-low',
        });
        const toggle = button('Toggle', () => this.run(() => controller.toggle(gpio)));
        const pulse = button('Pulse 250 ms', () =>
          this.run(() => controller.pulse(gpio, state.output === 1 ? 0 : 1, 250)),
        );
        const blink = el('input', {
          class: 'slider',
          attrs: {
            type: 'range',
            min: '0',
            max: '2000',
            step: '50',
            value: String(state.blink ?? 0),
            'aria-label': `Blink period of GPIO${gpio}`,
          },
        });
        const blinkLabel = el('span', { class: 'slider-value', text: blinkText(state.blink ?? 0) });
        blink.addEventListener('change', () => {
          const period = Number(blink.value);
          blinkLabel.textContent = blinkText(period);
          void this.run(() => controller.setBlink(gpio, period));
        });
        blink.addEventListener('input', () => {
          blinkLabel.textContent = blinkText(Number(blink.value));
        });
        this.controlsNode.append(
          el('div', { class: 'btn-row' }, high, low, toggle, pulse),
          el('label', { class: 'slider-row' }, el('span', { text: 'Blink' }), blink, blinkLabel),
        );
        this.syncControls = () => {
          if (document.activeElement === blink) return;
          const period = this.state().blink ?? 0;
          blink.value = String(period);
          blinkLabel.textContent = blinkText(period);
        };
        return;
      }
      case 'pwm': {
        const duty = el('input', {
          class: 'slider',
          attrs: {
            type: 'range',
            min: '0',
            max: '100',
            value: String(Math.round((state.pwm?.duty ?? 0) * 100)),
            'aria-label': `PWM duty of GPIO${gpio}`,
          },
        });
        const freq = el('input', {
          class: 'number',
          attrs: {
            type: 'number',
            min: '1',
            max: '40000',
            value: String(state.pwm?.freq ?? 1000),
            'aria-label': `PWM frequency of GPIO${gpio}`,
          },
        });
        const dutyLabel = el('span', { class: 'slider-value', text: `${duty.value} %` });
        const apply = () => {
          dutyLabel.textContent = `${duty.value} %`;
          void this.run(() => controller.setPwm(gpio, Number(freq.value), Number(duty.value) / 100));
        };
        duty.addEventListener('input', () => {
          dutyLabel.textContent = `${duty.value} %`;
        });
        duty.addEventListener('change', apply);
        freq.addEventListener('change', apply);
        this.controlsNode.append(
          el('label', { class: 'slider-row' }, el('span', { text: 'Duty' }), duty, dutyLabel),
          el('label', { class: 'slider-row' }, el('span', { text: 'Hz' }), freq),
        );
        this.syncControls = () => {
          const pwm = this.state().pwm;
          if (!pwm) return;
          if (document.activeElement !== duty) {
            duty.value = String(Math.round(pwm.duty * 100));
            dutyLabel.textContent = `${duty.value} %`;
          }
          if (document.activeElement !== freq) freq.value = String(pwm.freq);
        };
        return;
      }
      case 'analog':
      case 'touch':
      case 'input':
      case 'input_pullup':
      case 'input_pulldown':
        this.controlsNode.append(
          el('p', {
            class: 'pin-hint',
            text:
              state.mode === 'touch'
                ? 'Touch the pad with a finger — the reading drops sharply.'
                : state.mode === 'analog'
                  ? 'Feed 0–3.3 V into the pin and watch the curve.'
                  : 'Tie the pin to 3.3 V or GND to see the level flip.',
          }),
        );
        return;
      default:
        this.controlsNode.append(
          el('p', { class: 'pin-hint', text: 'Pick a mode to start using this pin.' }),
        );
    }
  }

  private renderStats(state: PinRuntimeState): void {
    const stats = state.stats;
    const parts: string[] = [];
    if (stats.transitions > 0) parts.push(`${stats.transitions} edges`);
    if (stats.frequencyHz !== undefined && Number.isFinite(stats.frequencyHz)) {
      parts.push(`${stats.frequencyHz.toFixed(1)} Hz`);
    }
    if (stats.dutyCycle !== undefined) parts.push(`${Math.round(stats.dutyCycle * 100)} % high`);
    if (stats.minMv !== undefined && stats.maxMv !== undefined && state.mode === 'analog') {
      parts.push(`${(stats.minMv / 1000).toFixed(2)}–${(stats.maxMv / 1000).toFixed(2)} V`);
    }
    this.statsNode.textContent = parts.join(' · ');
  }

  private renderScope(state: PinRuntimeState): void {
    const ctx = prepareCanvas(this.canvas, SPARK_WIDTH, SPARK_HEIGHT);
    if (!ctx) return;
    const digital = state.mode !== 'analog' && state.mode !== 'touch';
    drawScope(
      ctx,
      state.trace.toArray(),
      { width: SPARK_WIDTH, height: SPARK_HEIGHT, windowMs: 5000, padding: 4 },
      {
        background: 'rgba(8, 15, 26, 0.85)',
        grid: 'rgba(120, 150, 190, 0.18)',
        stroke: digital ? '#4ade80' : '#38bdf8',
        fill: digital ? 'rgba(74, 222, 128, 0.14)' : 'rgba(56, 189, 248, 0.16)',
        digital,
      },
    );
  }
}

function blinkText(period: number): string {
  return period === 0 ? 'off' : `${period} ms`;
}
