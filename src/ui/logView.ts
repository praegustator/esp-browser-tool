import type { DiagnosticsController, LogLine } from '../device/diagnosticsController';
import { clear, el, formatTime } from './dom';

const MAX_RENDERED_LINES = 300;

/** Scrolling firmware/tool console with level based colouring. */
export class LogView {
  readonly root: HTMLElement;

  private readonly list: HTMLElement;
  private pinned = true;

  constructor(controller: DiagnosticsController) {
    this.list = el('div', { class: 'log-list', attrs: { role: 'log', 'aria-live': 'polite' } });
    this.list.addEventListener('scroll', () => {
      const distance = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight;
      this.pinned = distance < 24;
    });
    this.root = el(
      'section',
      { class: 'panel log-panel' },
      el(
        'header',
        { class: 'panel-head' },
        el('h2', { text: 'Console' }),
        el('button', {
          class: 'btn btn-ghost',
          text: 'Clear',
          attrs: { type: 'button' },
          on: {
            click: () => {
              controller.logs.clear();
              clear(this.list);
            },
          },
        }),
      ),
      this.list,
    );
    for (const line of controller.logs) this.append(line);
    controller.events.on((event) => {
      if (event.type === 'log') this.append(event.line);
    });
  }

  append(line: LogLine): void {
    const node = el(
      'div',
      { class: `log-line log-${line.level}` },
      el('span', { class: 'log-time', text: formatTime(line.time) }),
      el('span', { class: 'log-text', text: line.text }),
    );
    this.list.appendChild(node);
    while (this.list.childElementCount > MAX_RENDERED_LINES) {
      this.list.removeChild(this.list.firstChild!);
    }
    if (this.pinned) this.list.scrollTop = this.list.scrollHeight;
  }
}
