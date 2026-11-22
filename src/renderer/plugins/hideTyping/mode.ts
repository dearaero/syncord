import { t as i18nText } from "../../i18n";
/**
 * Typing-mode policy.
 *
 * Kept free of DOM and Discord access so the rules can be asserted directly.
 * Everything here answers one question: given the selected mode, what should
 * happen to an outgoing typing action, and should we be driving one ourselves?
 */

export type TypingMode = "hide" | "always" | "default";

/** The action the composer dispatches when you start typing. */
export const OUTGOING_TYPING_ACTION = "TYPING_START_LOCAL";

export const TYPING_MODES: {
  value: TypingMode;
  label: string;
  description: string;
}[] = [
  {
    value: "hide",
    get label() { return i18nText("ui.hide_typing"); },
    get description() { return i18nText("ui.your_typing_status_is_never_sent_so_nobody_sees_it"); },
  },
  {
    value: "always",
    get label() { return i18nText("ui.always_typing"); },
    get description() { return i18nText("ui.you_appear_as_typing_in_whichever_channel_is_open"); },
  },
  {
    value: "default",
    get label() { return i18nText("ui.no_select"); },
    get description() { return i18nText("ui.nothing_is_touched_discord_behaves_normally"); },
  },
];

export function isTypingMode(value: unknown): value is TypingMode {
  return (
    value === "hide" || value === "always" || value === "default"
  );
}

/**
 * The mode in force.
 *
 * With the chat-input switch off there is no way to pick a mode, so the plugin
 * falls back to `hide`, which is what it has always done.
 */
export function effectiveMode(
  easyChange: boolean,
  stored: unknown,
): TypingMode {
  if (!easyChange) return "hide";
  return isTypingMode(stored) ? stored : "hide";
}

/** True only for the outgoing typing action, matched exactly. */
export function isOutgoingTypingAction(action: unknown): boolean {
  return (
    action != null &&
    typeof action === "object" &&
    (action as { type?: unknown }).type === OUTGOING_TYPING_ACTION
  );
}

/** Whether an outgoing typing action should be dropped. */
export function shouldDropOutgoing(mode: TypingMode, action: unknown): boolean {
  if (mode !== "hide") return false;
  return isOutgoingTypingAction(action);
}

/**
 * How often to refresh "always typing".
 *
 * `TypingStore` expires a typing entry after `E` (10s) and refuses to accept a
 * new local typing action until `0.8 * E` (8s) has passed. Refreshing at half
 * that window keeps the indicator permanently lit; the store does its own
 * throttling, so the extra dispatches cost nothing and send no extra packets.
 */
export const ALWAYS_TYPING_INTERVAL_MS = 4_000;

/** First dispatch is immediate so the mode takes effect without waiting. */
export const ALWAYS_TYPING_INITIAL_MS = 250;

export function shouldDriveTyping(mode: TypingMode, visible: boolean): boolean {
  // Paused while the window is hidden: there is no open channel to be "typing"
  // in from the user's point of view, and it is not something to do behind their
  // back.
  return mode === "always" && visible;
}
