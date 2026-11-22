/**
 * Styles for the Scheduled Messages section.
 *
 * Injected by the plugin with `ctx.css.inject`, which puts them in the document
 * rather than inside the settings panel, so the class names are prefixed to stay
 * out of the panel's way. Colours come from Discord's own theme variables, so
 * light and dark are both covered without a second rule set — the one place a
 * literal appears is the transparent-black overlay, which is correct in both.
 *
 * The layout is built to survive a narrow window: the header wraps, the actions
 * wrap, and nothing relies on a fixed width.
 */
export const SCHEDULED_CSS = `
.dion-sm-list {
  padding: 0;
}

.dion-sm-empty {
  padding: 22px 16px 24px;
  text-align: center;
}

.dion-sm-empty-title {
  margin: 0 0 4px;
  color: var(--dion-text, var(--text-normal, #f2f3f5));
  font-size: 12px;
  font-weight: 600;
}

.dion-sm-empty-hint {
  margin: 0 auto;
  max-width: 46ch;
  color: var(--dion-muted, var(--text-muted, #a6a6ad));
  font-size: 11px;
  line-height: 16px;
}

.dion-sm-group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 9px 11px 5px;
  color: var(--dion-muted, var(--text-muted, #a6a6ad));
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
}

.dion-sm-count {
  min-width: 16px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dion-muted, #a6a6ad) 18%, transparent);
  font-size: 9px;
  line-height: 15px;
  text-align: center;
  letter-spacing: 0;
}

.dion-sm-card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 11px 11px;
  border-bottom: 1px solid var(--dion-border, rgba(255,255,255,.06));
}

.dion-sm-card:last-child {
  border-bottom: 0;
}

/* A due message is the one thing worth noticing at a glance. */
.dion-sm-card.is-due {
  box-shadow: inset 2px 0 0 var(--text-warning, #f0b232);
}

.dion-sm-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
}

.dion-sm-where {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  color: var(--dion-text, var(--text-normal, #f2f3f5));
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dion-sm-when {
  flex: 0 0 auto;
  color: var(--dion-muted, var(--text-muted, #a6a6ad));
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.dion-sm-body {
  margin: 0;
  color: color-mix(in srgb, var(--dion-text, #f2f3f5) 78%, transparent);
  font-size: 11.5px;
  line-height: 16px;
  overflow-wrap: anywhere;
  cursor: text;
}

/* Long messages open up on click, and the caret-free block keeps the jump
   from looking like a text selection. */
.dion-sm-body[aria-expanded="true"] {
  white-space: pre-wrap;
}

.dion-sm-editor {
  width: 100%;
  min-height: 62px;
  padding: 7px 9px;
  border: 1px solid var(--dion-border, rgba(255,255,255,.09));
  border-radius: 9px;
  outline: 0;
  background: color-mix(in srgb, var(--dion-bg, #1a1a1e) 80%, black 5%);
  color: var(--dion-text, var(--text-normal, #f2f3f5));
  font: inherit;
  font-size: 11.5px;
  line-height: 16px;
  resize: vertical;
}

.dion-sm-editor:focus {
  border-color: color-mix(in srgb, var(--dion-brand, #5865f2) 64%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dion-brand, #5865f2) 12%, transparent);
}

.dion-sm-error {
  margin: 0;
  padding: 6px 8px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--text-danger, #f23f43) 12%, transparent);
  color: var(--text-danger, #f23f43);
  font-size: 10.5px;
  line-height: 15px;
  overflow-wrap: anywhere;
}

.dion-sm-when-edit {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/*
 * The hidden attribute only sets "display: none" in the user-agent sheet, so
 * any display rule here beats it. Without this the date form shows on every
 * card even though the markup says it is hidden, which is what it did.
 */
.dion-sm-when-edit[hidden],
.dion-sm-editor[hidden],
.dion-sm-btn[hidden] {
  display: none;
}

.dion-sm-when-edit input {
  height: 30px;
  min-width: 0;
  flex: 1 1 128px;
  padding: 0 8px;
  border: 1px solid var(--dion-border, rgba(255,255,255,.09));
  border-radius: 9px;
  outline: 0;
  background: color-mix(in srgb, var(--dion-bg, #1a1a1e) 80%, black 5%);
  color: var(--dion-text, var(--text-normal, #f2f3f5));
  font: inherit;
  font-size: 11.5px;
  color-scheme: dark;
}

.dion-sm-when-edit input:focus {
  border-color: color-mix(in srgb, var(--dion-brand, #5865f2) 64%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dion-brand, #5865f2) 12%, transparent);
}

/* Following the client theme keeps the native date and time spinners from
   rendering light-on-light. */
@media (prefers-color-scheme: light) {
  .dion-sm-when-edit input {
    color-scheme: light;
  }
}

.dion-sm-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.dion-sm-btn {
  min-height: 26px;
  padding: 0 9px;
  border: 1px solid var(--dion-border, rgba(255,255,255,.09));
  border-radius: 8px;
  background: rgba(255,255,255,.03);
  color: var(--dion-muted, var(--text-muted, #a6a6ad));
  font: inherit;
  font-size: 10.5px;
  font-weight: 600;
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease, transform 120ms ease;
}

.dion-sm-btn:hover:not(:disabled) {
  border-color: var(--dion-border-strong, rgba(255,255,255,.16));
  background: rgba(255,255,255,.07);
  color: var(--dion-text, var(--text-normal, #f2f3f5));
}

.dion-sm-btn:active:not(:disabled) {
  transform: scale(.97);
}

.dion-sm-btn:disabled {
  opacity: .45;
  cursor: not-allowed;
}

.dion-sm-btn.is-primary {
  border-color: transparent;
  background: var(--dion-brand, #5865f2);
  color: #fff;
}

.dion-sm-btn.is-primary:hover:not(:disabled) {
  filter: brightness(1.08);
  background: var(--dion-brand, #5865f2);
  color: #fff;
}

.dion-sm-btn.is-danger:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--text-danger, #f23f43) 55%, transparent);
  background: color-mix(in srgb, var(--text-danger, #f23f43) 12%, transparent);
  color: var(--text-danger, #f23f43);
}

.dion-sm-history {
  border-top: 1px solid var(--dion-border, rgba(255,255,255,.06));
}

.dion-sm-history > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 11px;
  color: var(--dion-muted, var(--text-muted, #a6a6ad));
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
  cursor: pointer;
  list-style: none;
}

.dion-sm-history > summary::-webkit-details-marker {
  display: none;
}

.dion-sm-history > summary::after {
  content: "";
  width: 5px;
  height: 5px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform 140ms ease;
}

.dion-sm-history[open] > summary::after {
  transform: rotate(45deg);
}
`;
