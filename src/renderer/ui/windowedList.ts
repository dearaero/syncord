/** Variable-height row offsets. Two numeric arrays, no message or DOM references. */
export class RowHeights {
  private values: Float64Array;
  private tree: Float64Array;
  constructor(readonly length: number, readonly estimate = 96) {
    this.values = new Float64Array(length);
    this.tree = new Float64Array(length + 1);
    this.reset();
  }
  reset(): void {
    this.values.fill(this.estimate);
    for (let i = 1; i <= this.length; i++) this.tree[i] = this.estimate * (i & -i);
  }
  prefix(end: number): number {
    let total = 0;
    for (let i = Math.min(this.length, Math.max(0, end)); i > 0; i -= i & -i) total += this.tree[i]!;
    return total;
  }
  get total(): number { return this.prefix(this.length); }
  set(index: number, height: number): boolean {
    if (index < 0 || index >= this.length || !Number.isFinite(height) || height <= 0) return false;
    const delta = height - this.values[index]!;
    if (Math.abs(delta) < .25) return false;
    this.values[index] = height;
    for (let i = index + 1; i <= this.length; i += i & -i) this.tree[i] = this.tree[i]! + delta;
    return true;
  }
  at(offset: number): number {
    let index = 0, sum = 0;
    for (let bit = 2 ** Math.floor(Math.log2(Math.max(1, this.length))); bit; bit = Math.floor(bit / 2)) {
      const next = index + bit;
      if (next <= this.length && sum + this.tree[next]! <= Math.max(0, offset)) { index = next; sum += this.tree[next]!; }
    }
    return Math.min(index, Math.max(0, this.length - 1));
  }
}

/** Keep only the viewport/overscan and a focused row alive. Saved data stays in
 * its owner; this component never deletes records or changes a scroll position
 * simply because an offscreen DOM row was released. */
export function mountWindowedList<T>(host: HTMLElement, scroller: HTMLElement,
  rows: readonly T[], render: (row: T, index: number) => HTMLElement): () => void {
  const heights = new RowHeights(rows.length), nodes = new Map<number, HTMLElement>();
  let closed = false, frame = 0, shift = 0, width = scroller.clientWidth;
  const beforeAnchor = scroller.style.overflowAnchor;
  scroller.style.overflowAnchor = 'none';
  host.setAttribute('role', 'list');
  const localTop = (): number => Math.max(0, scroller.getBoundingClientRect().top - host.getBoundingClientRect().top + scroller.clientTop);
  const schedule = (): void => { if (!closed && !frame) frame = requestAnimationFrame(paint); };
  const observer = new ResizeObserver(() => {
    if (closed) return;
    const top = localTop(), anchor = heights.at(top), before = heights.prefix(anchor);
    if (Math.abs(width - scroller.clientWidth) > 1) { width = scroller.clientWidth; heights.reset(); }
    for (const [index, node] of nodes) heights.set(index, node.getBoundingClientRect().height);
    shift += heights.prefix(anchor) - before;
    schedule();
  });
  function paint(): void {
    frame = 0;
    if (closed) return;
    const top = Math.max(0, localTop() + shift), start = Math.max(0, heights.at(top) - 5);
    const end = Math.min(rows.length, heights.at(top + scroller.clientHeight) + 7);
    const wanted = new Set<number>();
    for (let i = start; i < end; i++) wanted.add(i);
    // Keyboard focus survives scrolling even when its row is outside overscan.
    for (const [i, node] of nodes) if (node.contains(document.activeElement)) wanted.add(i);
    for (const [i, node] of nodes) if (!wanted.has(i)) { observer.unobserve(node); node.remove(); nodes.delete(i); }
    const desired: HTMLElement[] = [];
    const gap = (height: number): void => {
      if (height <= 0) return;
      const spacer = document.createElement('div');
      spacer.dataset.virtualSpacer = ''; spacer.style.height = `${height}px`;
      spacer.style.pointerEvents = 'none'; spacer.setAttribute('aria-hidden', 'true');
      desired.push(spacer);
    };
    let previous = 0;
    for (const i of [...wanted].sort((a, b) => a - b)) {
      gap(heights.prefix(i) - heights.prefix(previous));
      let node = nodes.get(i);
      if (!node) {
        node = render(rows[i]!, i); nodes.set(i, node);
        node.dataset.virtualIndex = String(i); node.setAttribute('role', 'listitem');
        node.setAttribute('aria-posinset', String(i + 1)); node.setAttribute('aria-setsize', String(rows.length));
        observer.observe(node);
      }
      desired.push(node); previous = i + 1;
    }
    gap(heights.total - heights.prefix(previous));
    for (const spacer of host.querySelectorAll(':scope > [data-virtual-spacer]')) spacer.remove();
    let cursor = host.firstChild;
    for (const node of desired) {
      if (cursor === node) cursor = cursor.nextSibling;
      else host.insertBefore(node, cursor);
    }
    if (shift) { scroller.scrollTop += shift; shift = 0; }
  }
  scroller.addEventListener('scroll', schedule, { passive: true });
  observer.observe(scroller);
  paint();
  return () => {
    closed = true; if (frame) cancelAnimationFrame(frame);
    observer.disconnect(); scroller.removeEventListener('scroll', schedule);
    scroller.style.overflowAnchor = beforeAnchor;
    nodes.clear(); host.replaceChildren(); host.removeAttribute('role');
  };
}
