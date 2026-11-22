// One dialog per workspace. Native Discord layers remain outside this local stack.
let dismiss: (() => void) | undefined;
export function closeCanvasDialog(): void { dismiss?.(); }

export function registerCanvasDialog(onClose: () => void): () => void {
  closeCanvasDialog();
  dismiss = onClose;
  return () => { if (dismiss === onClose) dismiss = undefined; };
}

export function mountCanvasDialog(root: HTMLElement, backdrop: HTMLElement, onClose: () => void): () => void {
  closeCanvasDialog();
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const background = Array.from(root.children).filter((el): el is HTMLElement => el instanceof HTMLElement);
  const inert = background.map(el => el.inert);
  background.forEach(el => { el.inert = true; });
  root.append(backdrop);
  const dialog = backdrop.querySelector<HTMLElement>('[role="dialog"]')!;
  dialog.tabIndex = -1;
  const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"], a[href]'))
    .filter(el => !el.hidden && el.getClientRects().length > 0);
  const keydown = (event: KeyboardEvent) => {
    // Discord's global shortcuts must not handle keys typed in our dialogs.
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    if (event.key === "Tab") {
      const items = focusable();
      const first = items[0] ?? dialog, last = items.at(-1) ?? dialog;
      if (!items.length || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    }
  };
  backdrop.addEventListener("keydown", keydown);
  let active = true;
  const cleanup = () => {
    if (!active) return;
    active = false;
    backdrop.removeEventListener("keydown", keydown);
    backdrop.remove();
    background.forEach((el, index) => { el.inert = inert[index]; });
    if (dismiss === onClose) dismiss = undefined;
    if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
  };
  dismiss = onClose;
  return cleanup;
}
