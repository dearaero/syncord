import { h, messageHtml as i18nHtml, setLocalizedHtml, setLocalizedText, t as i18nText } from "../../i18n";
/** A top-layer dialog keeps saved attachments above the settings/log overlays. */
export type ImageSource = {
  name: string;
  blob?: Blob;
  url?: string;
  readBlob: (signal: AbortSignal) => Promise<Blob>;
};

let active: { close: () => void } | undefined;

export function closeImagePreview(): boolean {
  if (!active) return false;
  active.close();
  return true;
}

export function isImageFile(name: string, type = ""): boolean {
  if (type.toLowerCase().startsWith("image/")) return true;
  return /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|tiff?|ico)$/i.test(name);
}

export function openImagePreview(host: HTMLElement, source: ImageSource): void {
  closeImagePreview();
  const previous = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "dion-log-preview";
  dialog.setAttribute("aria-labelledby", "dion-log-preview-title");
  setLocalizedHtml(dialog, `
    <header class="dion-log-preview-head">
      <h3 id="dion-log-preview-title"></h3>
      <div class="dion-log-preview-actions">
        <button type="button" class="dion-log-download" data-dion-image-download>${i18nHtml("ui.download")}</button>
        <button type="button" class="dion-log-x" data-dion-image-close aria-label="${h("ui.close_image_preview")}" data-si18n-aria-label="ui.close_image_preview">×</button>
      </div>
    </header>
    <div class="dion-log-preview-media"><img alt="" /></div>
    <p class="dion-log-preview-status" role="status">${i18nHtml("ui.loading_image")}</p>`);
  const title = dialog.querySelector<HTMLHeadingElement>("h3")!;
  const image = dialog.querySelector<HTMLImageElement>("img")!;
  const status = dialog.querySelector<HTMLParagraphElement>("[role=status]")!;
  const download = dialog.querySelector<HTMLButtonElement>("[data-dion-image-download]")!;
  const closeButton = dialog.querySelector<HTMLButtonElement>("[data-dion-image-close]")!;
  title.textContent = source.name;
  image.alt = source.name;
  image.referrerPolicy = "no-referrer";
  const controller = new AbortController();
  const urls = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  let downloadBlob = source.blob;
  const objectUrl = (blob: Blob): string => {
    const url = URL.createObjectURL(blob);
    urls.add(url);
    return url;
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    controller.abort();
    image.removeAttribute("src");
    dialog.close();
    dialog.remove();
    for (const timer of timers) clearTimeout(timer);
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
    timers.clear();
    active = undefined;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    else host.querySelector<HTMLButtonElement>("[data-dion-log-close]")?.focus();
  };
  active = { close };
  closeButton.addEventListener("click", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });
  image.addEventListener("load", () => { status.textContent = ""; });
  image.addEventListener("error", () => {
    setLocalizedText(status, "ui.this_image_cannot_be_displayed_you_can_still_try_downloading_the_file");
  });
  download.addEventListener("click", () => {
    if (download.disabled || closed) return;
    download.disabled = true;
    setLocalizedText(download, "ui.downloading");
    void (async () => {
      try {
        const blob = downloadBlob ?? await source.readBlob(controller.signal);
        if (closed) return;
        downloadBlob = blob;
        const url = objectUrl(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = source.name.replace(/[\\/\u0000-\u001f\u007f]/g, "_") || "image";
        dialog.appendChild(anchor);
        anchor.click();
        anchor.remove();
        const timer = setTimeout(() => {
          URL.revokeObjectURL(url);
          urls.delete(url);
          timers.delete(timer);
        }, 1000);
        timers.add(timer);
      } catch (error) {
        if (!closed) status.textContent = error instanceof Error && error.message === "Attachment too large"
          ? i18nText("ui.this_image_exceeds_the_32_mb_download_limit")
          : i18nText("ui.the_file_could_not_be_downloaded_its_original_discord_link_may_have_ex");
      } finally {
        if (!closed) { download.disabled = false; setLocalizedText(download, "ui.download"); }
      }
    })();
  });
  host.appendChild(dialog);
  dialog.showModal();
  image.src = source.blob ? objectUrl(source.blob) : source.url ?? "";
  closeButton.focus();
}
