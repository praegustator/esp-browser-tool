/** Tiny DOM helpers — enough structure to build the UI without a framework. */

type Child = Node | string | number | null | undefined | false;

export interface ElementOptions {
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  /** Applied via `setAttribute`, so `data-*` and ARIA attributes work. */
  attrs?: Record<string, string | number | boolean | undefined>;
  style?: Partial<CSSStyleDeclaration>;
  on?: Partial<{
    [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void;
  }>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.html !== undefined) node.innerHTML = options.html;
  if (options.title) node.title = options.title;
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? '' : String(value));
  }
  Object.assign(node.style, options.style ?? {});
  for (const [name, handler] of Object.entries(options.on ?? {})) {
    node.addEventListener(name, handler as EventListener);
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function button(
  label: string,
  onClick: () => void | Promise<void>,
  options: ElementOptions = {},
): HTMLButtonElement {
  return el('button', {
    ...options,
    class: `btn ${options.class ?? ''}`.trim(),
    text: label,
    attrs: { type: 'button', ...options.attrs },
    on: {
      click: () => {
        void onClick();
      },
      ...options.on,
    },
  });
}

export function select<T extends string>(
  values: readonly T[],
  current: T,
  onChange: (value: T) => void | Promise<void>,
  labels: (value: T) => string = (value) => value,
): HTMLSelectElement {
  const node = el('select', { class: 'select' });
  for (const value of values) {
    const option = el('option', { text: labels(value) });
    option.value = value;
    if (value === current) option.selected = true;
    node.appendChild(option);
  }
  node.addEventListener('change', () => {
    void onChange(node.value as T);
  });
  return node;
}

/** Format a millisecond timestamp as `hh:mm:ss.mmm`. */
export function formatTime(time: number): string {
  const date = new Date(time);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}
