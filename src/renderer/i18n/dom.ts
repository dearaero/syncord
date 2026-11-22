import {escapeHtml, getDirection, getLocale, h, messageKeyForLabel, onLocaleChange, t, type Params} from './core';

type Binding = {key: string; params: Params; last: string};
const textBindings = new WeakMap<Element, Binding>();
const attributeBindings = new WeakMap<Element, Map<string, Binding>>();
let registered = new WeakSet<Element>();
const roots = new Set<WeakRef<Element>>();
const attributes = ['title', 'placeholder', 'aria-label', 'aria-description', 'aria-valuetext', 'alt'] as const;

/** Comments preserve the existing layout: no span wrappers, styles or observers. */
export function messageHtml(key: string, params: Params = {}): string {
  const encoded = encodeURIComponent(JSON.stringify(params, (_key, value: unknown) => typeof value === 'bigint' ? String(value) : value === undefined ? null : value));
  if (encoded.length > 8192) return h(key, params);
  return '<!--si18n:'+escapeHtml(key)+';'+encoded+'-->'+h(key, params)+'<!--/si18n-->';
}
/** Only for built-in plugin/schema metadata; user-authored content stays literal. */
export function productHtml(value: string | undefined): string {
  const label = value ?? '', key = messageKeyForLabel(label);
  return key ? messageHtml(key) : escapeHtml(label);
}
export function productAttribute(attribute: string, value: string | undefined): string {
  if (!(attributes as readonly string[]).includes(attribute)) return '';
  const label = value ?? '', key = messageKeyForLabel(label);
  return attribute+'="'+escapeHtml(label)+'"'+(key ? ' data-si18n-'+attribute+'="'+escapeHtml(key)+'"' : '');
}
function bindRoot(root: Element): void {
  if (registered.has(root)) return;
  registered.add(root);
  if (roots.size >= 512) for (const ref of roots) {
    const node = ref.deref();
    if (!node || !node.isConnected) { roots.delete(ref); if (node) registered.delete(node); }
  }
  roots.add(new WeakRef(root));
}
export function setLocalizedHtml(root: Element, value: string): void {
  root.innerHTML = value;
  if (value.includes('<!--si18n:') || value.includes('data-si18n-')) {
    bindRoot(root);
    root.setAttribute('lang', getLocale()); root.setAttribute('dir', getDirection());
  }
}
export function setLocalizedText(root: Element, key: string, params: Params = {}): void {
  root.textContent = t(key, params);
  root.setAttribute('lang',getLocale()); root.setAttribute('dir',getDirection());
  textBindings.set(root, {key, params, last:root.textContent ?? ''}); bindRoot(root);
}
export function setLocalizedAttribute(root: Element, attribute: string, key: string, params: Params = {}): void {
  if (!(attributes as readonly string[]).includes(attribute)) return;
  root.setAttribute(attribute, t(key, params));
  let bindings = attributeBindings.get(root);
  if (!bindings) { bindings = new Map(); attributeBindings.set(root, bindings); }
  bindings.set(attribute, {key, params, last:root.getAttribute(attribute) ?? ''}); bindRoot(root);
}
function update(root: Element): void {
  const text = textBindings.get(root);
  if (text && root.textContent === text.last) root.textContent = text.last = t(text.key, text.params);
  else if (text) textBindings.delete(root);
  for (const [attribute, value] of attributeBindings.get(root) ?? []) {
    if (root.getAttribute(attribute) === value.last) root.setAttribute(attribute, value.last = t(value.key, value.params));
    else attributeBindings.get(root)?.delete(attribute);
  }
  root.setAttribute('lang', getLocale()); root.setAttribute('dir', getDirection());
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  while (walker.nextNode()) {
    const comment = walker.currentNode as Comment;
    if (!comment.data.startsWith('si18n:')) continue;
    const node = comment.nextSibling, end = node?.nextSibling;
    // Only the explicit, text-only message range emitted above is writable.
    if (node?.nodeType === Node.TEXT_NODE && end?.nodeType === Node.COMMENT_NODE && end.nodeValue === '/si18n') {
      const [key, encoded] = comment.data.slice(6).split(';',2);
      let params: Params = {};
      if (encoded && encoded.length <= 8192) try {
        const parsed: unknown = JSON.parse(decodeURIComponent(encoded));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.values(parsed).every(value => value === null || ['string','number','boolean'].includes(typeof value))) params = parsed as Params;
      } catch { /* Invalid metadata cannot interrupt the view. */ }
      if (key) node.nodeValue = t(key, params);
    }
  }
  for (const attr of attributes) {
    const marker = 'data-si18n-'+attr;
    for (const el of [root, ...root.querySelectorAll('['+marker+']')]) {
      const key = el.getAttribute(marker);
      if (key) el.setAttribute(attr, t(key));
    }
  }
}
onLocaleChange(() => {
  for (const ref of roots) {
    const root = ref.deref();
    if (!root || !root.isConnected) { roots.delete(ref); if(root)registered.delete(root); continue; }
    update(root);
  }
});

/** Realm teardown; no document-wide observer or polling was installed. */
export function clearLocaleRoots(): void { roots.clear(); registered = new WeakSet<Element>(); }

/** Keep in-progress settings input when a view must rebuild translated labels. */
export function preserveInputs(root: Element, repaint: () => void): void {
  const fields = Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select'));
  const values = fields.map((field, index) => ({index, value: field.value,
    checked: field instanceof HTMLInputElement ? field.checked : undefined,
    focused: field === root.ownerDocument.activeElement,
    start: field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement ? field.selectionStart : null,
    end: field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement ? field.selectionEnd : null,
    marker: Array.from(field.attributes).filter(a => a.name === 'id' || a.name.startsWith('data-')).map(a => [a.name,a.value] as const),
  }));
  const scroll = {top: root.scrollTop, left: root.scrollLeft};
  repaint();
  const next = Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select'));
  for (const snapshot of values) {
    const field = snapshot.marker.length ? next.find(node => snapshot.marker.every(([name,value]) => node.getAttribute(name) === value)) : next[snapshot.index];
    if (!field || field instanceof HTMLInputElement && field.type === 'file') continue;
    field.value = snapshot.value;
    if (field instanceof HTMLInputElement && snapshot.checked !== undefined) field.checked = snapshot.checked;
    if (snapshot.focused) {
      field.focus({preventScroll:true});
      if (snapshot.start !== null && snapshot.end !== null && (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement))
        try { field.setSelectionRange(snapshot.start, snapshot.end); } catch { /* Number/date inputs have no text selection. */ }
    }
  }
  root.scrollTop = scroll.top; root.scrollLeft = scroll.left;
}
