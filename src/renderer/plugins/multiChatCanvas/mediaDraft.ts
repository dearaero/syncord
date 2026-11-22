import { setLocalizedAttribute, setLocalizedText, t as i18nText } from "../../i18n";
import { clearStickerPreviews, renderStickerPreview } from "./stickerPreview";
import type { PaneRuntime } from "./types";

export function releaseFiles(pane: PaneRuntime): void {
  for (const item of pane.files) if (item.preview) URL.revokeObjectURL(item.preview);
  pane.files = [];
}

export function addFiles(pane: PaneRuntime, files: File[]): void {
  if (pane.sending) return;
  if (pane.files.length + files.length > 10) throw new Error("You can attach up to 10 files to one message.");
  if (files.some(file => file.size === 0)) throw new Error("Empty files cannot be uploaded.");
  for (const file of files) {
    pane.files.push({id:crypto.randomUUID(), file, ...(file.type.startsWith("image/") ? {preview:URL.createObjectURL(file)} : {})});
  }
  pane.sendError = undefined;
}

export function renderMediaDraft(pane: PaneRuntime, host: HTMLElement, changed: () => void): void {
  clearStickerPreviews(host);
  host.replaceChildren();
  host.hidden = !pane.files.length && !pane.stickers.length && !pane.sendError && !pane.sending;
  for (const file of pane.files) {
    const card = document.createElement("div");
    card.className = "dion-mc-draft-item";
    if (file.preview) {
      const img = document.createElement("img");
      img.src = file.preview; img.alt = "";
      card.append(img);
    }
    const label = document.createElement("span");
    setLocalizedText(label, "ui.value_value_kb", {v0: file.file.name, v1: Math.ceil(file.file.size / 1024)});
    const progress = document.createElement("span");
    progress.dataset.mcFileProgress = file.id;
    progress.textContent = pane.sending ? ` · ${file.progress ?? 0}%` : "";
    label.append(progress);
    const remove = document.createElement("button");
    remove.type = "button"; remove.textContent = "×";
    setLocalizedAttribute(remove, "aria-label", "ui.remove_value", {v0: file.file.name});
    remove.disabled = pane.sending;
    remove.onclick = () => {
      if (pane.sending) return;
      if (file.preview) URL.revokeObjectURL(file.preview);
      pane.files = pane.files.filter(item => item.id !== file.id);
      pane.sendError = undefined;
      changed();
    };
    card.append(label, remove); host.append(card);
  }
  for (const sticker of pane.stickers) {
    const card = document.createElement("div"); card.className = "dion-mc-draft-item";
    const image = document.createElement("span"); image.className = "dion-mc-sticker-thumb";
    renderStickerPreview(image, sticker, 40);
    const label = document.createElement("span"); label.textContent = sticker.name;
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×";
    setLocalizedAttribute(remove, "aria-label", "ui.remove_value", {v0: sticker.name}); remove.disabled = pane.sending;
    remove.onclick = () => { if (pane.sending) return; pane.stickers = pane.stickers.filter(item => item.id !== sticker.id); pane.sendError = undefined; changed(); };
    card.append(image, label, remove); host.append(card);
  }
  if (pane.sendError || pane.sending) {
    const status = document.createElement("div");
    status.className = "dion-mc-draft-status";
    status.setAttribute("role", pane.sendError ? "alert" : "status");
    status.textContent = pane.sendError ?? i18nText("ui.sending");
    host.append(status);
  }
}
