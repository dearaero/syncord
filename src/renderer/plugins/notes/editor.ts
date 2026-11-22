import { getLocale, t as i18nText } from "../../i18n";
export type Edit = { text: string; start: number; end: number };
export function formatSelection(text: string, start: number, end: number, action: string): Edit {
  const selected = text.slice(start, end);
  const wraps: Record<string, [string, string, string]> = {
    bold: ["**", "**", i18nText("ui.bold_text")], italic: ["*", "*", i18nText("ui.italic_text")], strike: ["~~", "~~", "text"],
    code: ["`", "`", "code"], link: ["[", "](https://example.com)", "link"],
  };
  if (wraps[action]) {
    const [before, after, fallback] = wraps[action]; const value = selected || fallback;
    return { text: text.slice(0, start) + before + value + after + text.slice(end), start: start + before.length, end: start + before.length + value.length };
  }
  const prefixes: Record<string, string> = { heading: "## ", bullet: "- ", task: "- [ ] ", quote: "> " };
  if (prefixes[action] || action === "indent" || action === "outdent") {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const after = text.indexOf("\n", Math.max(start, end - 1)); const lineEnd = after === -1 ? text.length : after;
    const value = text.slice(lineStart, lineEnd).split("\n").map(line => action === "outdent" ? line.replace(/^(  |\t)/, "") : (prefixes[action] ?? "  ") + line).join("\n");
    return { text: text.slice(0, lineStart) + value + text.slice(lineEnd), start: lineStart, end: lineStart + value.length };
  }
  const inserts: Record<string, string> = {
    fence: "\n```\n" + (selected || "code") + "\n```\n", table: "\n| Heading | Heading |\n| --- | --- |\n| Cell | Cell |\n",
    rule: "\n\n---\n\n", date: new Date().toLocaleDateString(getLocale()),
  };
  const value = inserts[action] ?? selected;
  return { text: text.slice(0, start) + value + text.slice(end), start: start + value.length, end: start + value.length };
}
/** Only the open document has history; bounded by both count and memory. */
export class EditHistory {
  private entries: Edit[] = [];
  private cursor = -1;
  private lastInput = 0;
  reset(edit: Edit): void { this.entries = [{ ...edit }]; this.cursor = 0; this.lastInput = 0; }
  record(edit: Edit, coalesce = false): void {
    if (this.entries[this.cursor]?.text === edit.text) return;
    this.entries.splice(this.cursor + 1);
    const now = Date.now();
    if (coalesce && now - this.lastInput < 500 && this.cursor > 0) this.entries[this.cursor] = { ...edit };
    else { this.entries.push({ ...edit }); this.cursor++; }
    this.lastInput = coalesce ? now : 0;
    while (this.entries.length > 40 || this.entries.length > 2 && this.entries.reduce((s, e) => s + e.text.length * 2, 0) > 4 * 1024 * 1024) {
      this.entries.shift(); this.cursor--;
    }
  }
  move(delta: -1 | 1): Edit | undefined {
    const next = this.cursor + delta;
    if (next < 0 || next >= this.entries.length) return;
    this.cursor = next; this.lastInput = 0; return { ...this.entries[next] };
  }
}
