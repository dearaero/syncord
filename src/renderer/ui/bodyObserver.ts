/** Drop-in for `new MutationObserver(cb)` on `document.body` subtrees.
 * Every plugin used to register its own body-wide observer, so Chromium queued
 * and allocated one record list per plugin for every Discord DOM change. This
 * keeps a single native observer and hands each subscriber only the records its
 * own `observe()` options would have delivered (same order, same batch). Any
 * other target/option shape falls back to a real MutationObserver.
 */
type Callback = (records: MutationRecord[]) => void;
interface Sub { cb: Callback; attrs: ReadonlySet<string>; chars: boolean }

const subs = new Set<Sub>();
let shared: MutationObserver | undefined;

const accepts = (s: Sub, r: MutationRecord): boolean =>
  r.type === 'childList' || (r.type === 'characterData' ? s.chars : !!r.attributeName && s.attrs.has(r.attributeName));

function dispatch(records: MutationRecord[]): void {
  for (const s of [...subs]) {
    if (!subs.has(s)) continue;
    const mine = records.every(r => accepts(s, r)) ? records : records.filter(r => accepts(s, r));
    if (!mine.length) continue;
    try { s.cb(mine); } catch (error) { reportError(error); }
  }
}

function reconfigure(): void {
  if (!subs.size) { shared?.disconnect(); return; }
  const init: MutationObserverInit = { childList: true, subtree: true };
  const names = new Set<string>();
  for (const s of subs) { s.attrs.forEach(n => names.add(n)); if (s.chars) init.characterData = true; }
  if (names.size) { init.attributes = true; init.attributeFilter = [...names]; }
  shared ??= new MutationObserver(dispatch);
  shared.observe(document.body, init); // Re-observing replaces options and keeps queued records.
}

export class BodyMutationObserver {
  private sub?: Sub;
  private native?: MutationObserver;
  constructor(private readonly cb: Callback) {}

  observe(target: Node, init: MutationObserverInit): void {
    this.disconnect();
    const plain = init.attributes === undefined || !!init.attributeFilter;
    if (target !== document.body || !init.childList || !init.subtree || !plain || init.attributeOldValue || init.characterDataOldValue) {
      this.native = new MutationObserver(this.cb);
      this.native.observe(target, init);
      return;
    }
    this.sub = { cb: this.cb, attrs: new Set(init.attributes ? init.attributeFilter : []), chars: !!init.characterData };
    subs.add(this.sub);
    reconfigure();
  }

  disconnect(): void {
    this.native?.disconnect(); this.native = undefined;
    if (!this.sub) return;
    subs.delete(this.sub); this.sub = undefined;
    reconfigure();
  }
}
