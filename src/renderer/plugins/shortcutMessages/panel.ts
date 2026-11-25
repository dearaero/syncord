import { h, messageHtml as i18nHtml, t as i18nText } from "../../i18n";
import { hideTooltip } from "../../ui/tooltip";
import { MAX_KEY_LENGTH, MAX_VALUE_LENGTH, validKey, validValue } from "./model";
import { saveShortcuts, shortcuts } from "./settings";

let expanded = false;
const esc = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export const isShortcutsExpanded = (): boolean => expanded;

export function shortcutsExpandButtonHtml(): string {
  return `<button type="button" class="dion-icon-btn dion-expand" data-sc-expand aria-expanded="${expanded}" aria-label="${h("shortcuts.options")}" data-si18n-aria-label="shortcuts.options"><svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z"/></svg></button>`;
}

const inputs = (key: string, value: string, index?: number): string => {
  const at = index === undefined ? "data-sc-new" : `data-sc-index="${index}"`;
  return `<input type="text" ${at} data-sc-field="key" value="${esc(key)}" maxlength="${MAX_KEY_LENGTH}" placeholder="${h("shortcuts.key_placeholder")}" aria-label="${h("shortcuts.key")}" spellcheck="false">` +
    `<input type="text" ${at} data-sc-field="value" value="${esc(value)}" maxlength="${MAX_VALUE_LENGTH}" placeholder="${h("shortcuts.value_placeholder")}" aria-label="${h("shortcuts.value")}">`;
};

function listHtml(): string {
  const list = shortcuts();
  if (list.length === 0) return `<p class="dion-setting-desc">${i18nHtml("shortcuts.empty")}</p>`;
  return list.map((s, i) =>
    `<div class="dion-field-row dion-sc-row">${inputs(s.key, s.value, i)}<button type="button" class="dion-icon-btn" data-sc-delete="${i}" aria-label="${h("shortcuts.delete")}"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Z"/></svg></button></div>`,
  ).join("");
}

export function shortcutsSectionHtml(): string {
  return `<div class="dion-plugin-details dion-sc-options">
    <div class="dion-details-head"><div><span class="dion-eyebrow">${i18nHtml("shortcuts.name")}</span><h4>${i18nHtml("shortcuts.heading")}</h4></div><span class="dion-details-note">${i18nHtml("ui.changes_are_saved_instantly")}</span></div>
    <p class="dion-setting-desc">${i18nHtml("shortcuts.help")}</p>
    <div class="dion-settings-group" data-sc-list>${listHtml()}</div>
    <div class="dion-subsection-label">${i18nHtml("shortcuts.add_title")}</div>
    <div class="dion-settings-group"><div class="dion-field-row dion-sc-row">${inputs("", "")}<button type="button" class="dion-primary-btn" data-sc-add>${i18nHtml("shortcuts.add")}</button></div></div>
    <span class="dion-setting-status" data-sc-status role="status"></span>
  </div>`;
}

export function bindShortcutsPanel(root: HTMLElement): () => void {
  const status = (message: string, error = false): void => {
    const el = root.querySelector<HTMLElement>("[data-sc-status]");
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("is-error", error);
  };
  const redraw = (): void => {
    const list = root.querySelector<HTMLElement>("[data-sc-list]");
    if (list) list.innerHTML = listHtml();
  };
  // Explains a rejected key/value; undefined when both are fine.
  const problem = (key: string, value: string, skip?: number): string | undefined => {
    if (!validKey(key)) return i18nText("shortcuts.error_key");
    if (!validValue(value)) return i18nText("shortcuts.error_value");
    if (shortcuts().some((s, i) => i !== skip && s.key === key)) return i18nText("shortcuts.error_duplicate", { key });
    return undefined;
  };

  const add = (): void => {
    const key = root.querySelector<HTMLInputElement>('[data-sc-new][data-sc-field="key"]');
    const value = root.querySelector<HTMLInputElement>('[data-sc-new][data-sc-field="value"]');
    if (!key || !value) return;
    const error = problem(key.value, value.value);
    if (error) { status(error, true); return; }
    saveShortcuts([...shortcuts(), { key: key.value, value: value.value }]);
    key.value = "";
    value.value = "";
    redraw();
    status(i18nText("shortcuts.saved"));
    key.focus();
  };

  const click = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : null;
    const expand = target?.closest<HTMLButtonElement>("[data-sc-expand]");
    if (expand) {
      event.preventDefault();
      event.stopPropagation();
      hideTooltip();
      expanded = !expanded;
      expand.setAttribute("aria-expanded", String(expanded));
      expand.closest(".dion-plugin")?.classList.toggle("is-open", expanded);
      return;
    }
    if (target?.closest("[data-sc-add]")) { event.preventDefault(); add(); return; }
    const del = target?.closest<HTMLElement>("[data-sc-delete]");
    if (del) {
      event.preventDefault();
      const index = Number(del.dataset.scDelete);
      saveShortcuts(shortcuts().filter((_, i) => i !== index));
      redraw();
      status(i18nText("shortcuts.deleted"));
    }
  };

  const change = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.dataset.scIndex === undefined) return;
    const index = Number(input.dataset.scIndex);
    const list = shortcuts();
    const entry = list[index];
    if (!entry) return;
    const next = { ...entry, [input.dataset.scField === "key" ? "key" : "value"]: input.value };
    const error = problem(next.key, next.value, index);
    if (error) {
      status(error, true);
      input.value = input.dataset.scField === "key" ? entry.key : entry.value;
      return;
    }
    saveShortcuts(list.map((s, i) => (i === index ? next : s)));
    status(i18nText("shortcuts.saved"));
  };

  const keydown = (event: KeyboardEvent): void => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.dataset.scNew !== undefined) {
      event.preventDefault();
      add();
    }
  };

  root.addEventListener("click", click);
  root.addEventListener("change", change);
  root.addEventListener("keydown", keydown);
  return () => {
    root.removeEventListener("click", click);
    root.removeEventListener("change", change);
    root.removeEventListener("keydown", keydown);
  };
}
