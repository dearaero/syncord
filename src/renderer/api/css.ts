const styles = new Map<string, HTMLStyleElement>();

/** Inject (or replace) a `<style>` tag by id. Returns a remover. */
export function inject(id: string, css: string): () => void {
  let el = styles.get(id);
  if (!el) {
    el = document.createElement("style");
    el.id = `Syncord-${id}`;
    el.setAttribute("data-Syncord", id);
    (document.documentElement ?? document.head ?? document.body).appendChild(
      el,
    );
    styles.set(id, el);
  }
  el.textContent = css;

  return () => remove(id);
}

export function remove(id: string): void {
  const el = styles.get(id);
  if (!el) return;
  el.remove();
  styles.delete(id);
}

export function removeAll(): void {
  for (const id of [...styles.keys()]) remove(id);
}

export const css = { inject, remove, removeAll };
