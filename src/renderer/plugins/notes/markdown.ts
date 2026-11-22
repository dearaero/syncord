import { setLocalizedText, t as i18nText } from "../../i18n";
import { Lexer, type Token, type Tokens } from "marked";
function decodeEntities(text: string): string {
  const names: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (original, entity: string) => {
    if (entity[0] !== "#") return names[entity.toLowerCase()] ?? original;
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
  });
}
export function safeLink(value: string): string | undefined {
  value = decodeEntities(value);
  if (/^#[a-zA-Z0-9_-]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (!["http:", "https:", "mailto:"].includes(url.protocol) || url.username || url.password) return;
    return url.href;
  } catch { return; }
}
export type Heading = { id: string; title: string; depth: number };
/** Render a token tree using DOM text nodes, never HTML from a note. */
export function renderMarkdown(source: string, target: HTMLElement): Heading[] {
  const fragment = document.createDocumentFragment();
  const headings: Heading[] = [];
  let budget = 12000;
  function append(tokens: Token[], parent: Node, depth = 0): void {
    if (depth > 48) { parent.appendChild(document.createTextNode("…")); return; }
    for (const token of tokens) {
      if (--budget < 0) break;
      const children = (node: HTMLElement, list: Token[] = "tokens" in token && Array.isArray(token.tokens) ? token.tokens : []) => append(list, node, depth + 1);
      const el = (tag: string, text?: string): HTMLElement => {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        parent.appendChild(node); return node;
      };
      switch (token.type) {
        case "space": case "def": case "checkbox": break;
        case "heading": {
          const t = token as Tokens.Heading;
          const node = el(`h${Math.min(6, Math.max(1, t.depth))}`);
          node.id = `syncord-note-heading-${headings.length}`; children(node);
          headings.push({ id: node.id, title: node.textContent ?? t.text, depth: t.depth }); break;
        }
        case "paragraph": children(el("p")); break;
        case "strong": children(el("strong")); break;
        case "em": children(el("em")); break;
        case "del": children(el("del")); break;
        case "blockquote": children(el("blockquote")); break;
        case "code": {
          const t = token as Tokens.Code;
          const pre = el("pre"); const code = document.createElement("code"); code.textContent = t.text;
          if (t.lang) code.dataset.language = t.lang.slice(0, 40); pre.appendChild(code); break;
        }
        case "codespan": el("code", token.text); break;
        case "hr": el("hr"); break;
        case "br": el("br"); break;
        case "list": {
          const t = token as Tokens.List; const list = el(t.ordered ? "ol" : "ul");
          if (t.ordered && typeof t.start === "number") list.setAttribute("start", String(t.start));
          for (const item of t.items) {
            if (--budget < 0) break;
            const li = document.createElement("li"); list.appendChild(li);
            if (item.task) {
              const input = document.createElement("input"); input.type = "checkbox"; input.checked = !!item.checked;
              input.disabled = true; input.setAttribute("aria-label", item.checked ? i18nText("ui.completed") : i18nText("ui.incomplete"));
              li.appendChild(input); li.className = "sn-task";
            }
            append(item.tokens, li, depth + 1);
          } break;
        }
        case "table": {
          const t = token as Tokens.Table; const wrap = el("div"); wrap.className = "sn-table-scroll";
          const table = document.createElement("table"); wrap.appendChild(table);
          const row = (cells: Tokens.TableCell[], header: boolean, holder: HTMLElement): void => {
            const tr = document.createElement("tr"); holder.appendChild(tr);
            cells.forEach((cell, i) => {
              if (--budget < 0) return;
              const td = document.createElement(header ? "th" : "td");
              if (t.align[i]) td.style.textAlign = t.align[i]!;
              append(cell.tokens, td, depth + 1); tr.appendChild(td);
            });
          };
          const head = document.createElement("thead"); table.appendChild(head); row(t.header, true, head);
          const body = document.createElement("tbody"); table.appendChild(body);
          for (const cells of t.rows) { if (budget < 0) break; row(cells, false, body); } break;
        }
        case "link": {
          const t = token as Tokens.Link; const href = safeLink(t.href);
          const node = el(href ? "a" : "span");
          if (href) { node.setAttribute("href", href); if (!href.startsWith("#")) { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); } }
          children(node); break;
        }
        case "image": {
          // No automatic image requests: a local document must not send tracking requests.
          const t = token as Tokens.Image; const href = safeLink(t.href);
          const node = el(href ? "a" : "span", i18nText("ui.image_value", {v0: decodeEntities(t.text) || "link"}));
          if (href) { node.setAttribute("href", href); node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
          break;
        }
        case "text": if (token.tokens) children(el("span")); else parent.appendChild(document.createTextNode(decodeEntities(token.text ?? token.raw))); break;
        case "escape": parent.appendChild(document.createTextNode(token.text)); break;
        default: parent.appendChild(document.createTextNode("text" in token && typeof token.text === "string" ? token.text : token.raw ?? ""));
      }
    }
  }
  try {
    // Notes previews keep Enter as a visible line break, including inside inline formatting.
    append(Lexer.lex(source, { gfm: true, breaks: true }), fragment);
    if (budget < 0) { const notice = document.createElement("p"); setLocalizedText(notice, "ui.preview_is_too_long_the_remaining_content_is_preserved_in_the_editor"); fragment.appendChild(notice); }
  } catch { const pre = document.createElement("pre"); pre.textContent = source; fragment.appendChild(pre); }
  target.replaceChildren(fragment);
  return headings;
}
