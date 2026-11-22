/** Visual custom emojis stay atomic; drafts and Discord payloads remain strings. */
export function composerFragment(value: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const pattern = /<(a?):([A-Za-z0-9_]+):(\d+)>/g;
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    fragment.append(value.slice(offset, match.index));
    const image = document.createElement("img");
    image.className = "dion-mc-composer-emoji";
    image.dataset.mcComposerEmoji = match[0];
    image.src = `https://cdn.discordapp.com/emojis/${match[3]}.${match[1] ? "gif" : "png"}?size=48`;
    image.alt = `:${match[2]}:`;
    image.title = image.alt;
    image.contentEditable = "false";
    image.draggable = false;
    fragment.append(image);
    offset = match.index + match[0].length;
  }
  fragment.append(value.slice(offset));
  return fragment;
}

export function composerText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof HTMLImageElement && node.dataset.mcComposerEmoji) return node.dataset.mcComposerEmoji;
  if (node instanceof HTMLBRElement) return "\n";
  let text = "";
  const children = Array.from(node.childNodes);
  for (const [index, child] of children.entries()) {
    const block = child instanceof HTMLElement && /^(DIV|P)$/.test(child.tagName);
    if (block && index > 0 && !text.endsWith("\n")) text += "\n";
    // Chromium's empty editable line contains a placeholder BR.
    text += block && child.childNodes.length === 1 && child.firstChild instanceof HTMLBRElement
      ? "" : composerText(child);
    if (block && index < children.length - 1 && !text.endsWith("\n")) text += "\n";
  }
  return text.replace(/\r\n?/g, "\n");
}

export function insertComposerText(editor: HTMLElement, value: string, savedRange?: Range): void {
  const range = savedRange ?? document.createRange();
  if (!savedRange) { range.selectNodeContents(editor); range.collapse(false); }
  const fragment = composerFragment(value);
  // An empty text node after the image gives the browser a caret position.
  const caret = document.createTextNode("");
  fragment.append(caret);
  range.deleteContents();
  range.insertNode(fragment);
  range.setStart(caret, 0);
  range.collapse(true);
  editor.focus();
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
