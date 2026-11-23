export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Set text only when it changed (avoids needless layout/paint work in hot loops). */
export function setText(e: Element, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

export function setWidth(e: HTMLElement, fraction: number): void {
  const w = `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(1)}%`;
  if (e.style.width !== w) e.style.width = w;
}
