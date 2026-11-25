import { t as i18nText } from "../../i18n";
import { definePlugin, type PluginContext } from "../../api/plugin";
import { definePluginSettings } from "../../api/plugin/settingsDef";
import { sharedDispatcher } from "../../api/discordEvents";
import { installDmHomeMenu, type DmHomeMenuHandle } from "./menu";
import { ackChannels, markAllAsRead, type MarkOutcome } from "./readState";

/** Dispatched by the settings panel after it writes this plugin's keys. */
export const markAllAsReadChangeEvent = "Syncord-mark-all-as-read-change";

/** Arrivals are batched, and acked outside the dispatch that delivered them. */
const ALWAYS_READ_DELAY_MS = 300;

const settings = definePluginSettings({
  alwaysRead: {
    type: "boolean",
    default: false,
    get title() { return i18nText("markread.always"); },
    get description() { return i18nText("markread.always_desc"); },
  },
});

/**
 * A short, honest report.
 *
 * Discord's toast is used rather than a custom element so the confirmation
 * looks like the rest of the client's, and it is skipped when there was simply
 * nothing unread — a toast for "nothing to do" every time is noise.
 */
function report(outcome: MarkOutcome, log: PluginContext["log"]): void {
  const toast = window.Syncord?.toast;
  if (!outcome.ok && outcome.guilds === 0 && outcome.channels === 0) {
    // "Nothing to do" and "could not see anything" are different failures, and
    // the difference is in what the client said it knew about.
    const message =
      outcome.considered.guilds === 0 && outcome.considered.dms === 0
        ? i18nText("ui.could_not_mark_as_read_discord_s_channel_data_was_not_reachable")
        : outcome.detail === "nothing was unread"
          ? i18nText("ui.everything_is_already_read")
          : i18nText("ui.could_not_mark_as_read_discord_s_read_state_was_not_reachable");
    toast?.show(message, { type: "message", duration: 4000 });
    return;
  }

  const parts: string[] = [];
  if (outcome.guilds > 0) parts.push(i18nText("count.servers", {count: outcome.guilds}));
  if (outcome.channels > 0) parts.push(i18nText("count.dms", {count: outcome.channels}));

  toast?.show(i18nText("ui.marked_as_read_value", {v0: parts.join(" and ")}), {
    type: outcome.ok ? "success" : "message",
    duration: 4000,
  });
  if (!outcome.ok) log.warn(`mark all as read was partial: ${outcome.detail}`);
}

export const MarkAllAsReadPlugin = definePlugin({
  id: "mark-all-as-read",
  name: i18nText("ui.mark_all_as_read"),
  get description() { return i18nText("ui.right_click_the_direct_messages_button_at_the_top_of_the_server_list_a"); },
  author: i18nText("ui.syncord"),
  enabledByDefault: true,

  /**
   * Reads the channel, guild and read-state stores to build Discord's own
   * BULK_ACK action. It patches nothing,
   * injects no stylesheet, opens no socket of its own and touches no file, so
   * the declaration is exactly those three stores plus the action it performs.
   */
  permissions: {
    discordStores: ["channel", "guild", "read-state"],
    discordActions: ["read-ack"],
  },

  start(ctx) {
    const handle: DmHomeMenuHandle = installDmHomeMenu({
      log: ctx.log,
      onRun: () => {
        try {
          report(markAllAsRead(), ctx.log);
        } catch (err) {
          // One broken click must not take the menu, or the plugin, down.
          ctx.log.error("mark all as read failed:", err);
          window.Syncord?.toast?.show(i18nText("ui.could_not_mark_as_read"), {
            type: "failure",
            duration: 4000,
          });
        }
      },
    });
    ctx.disposable(() => handle.dispose());

    const cfg = settings.bind(ctx.plugin.id);
    const pending = new Set<string>();
    let timer = 0;
    const flush = (): void => {
      timer = 0;
      const ids = [...pending];
      pending.clear();
      try {
        ackChannels(ids);
      } catch (err) {
        ctx.log.warn("always read: ack failed", err);
      }
    };
    const onMessage = (action: Record<string, unknown>): void => {
      if (cfg.store.alwaysRead !== true) return;
      const message = action.message as { channel_id?: unknown } | undefined;
      const id = action.channelId ?? message?.channel_id;
      if (typeof id !== "string" || !id) return;
      pending.add(id);
      if (!timer) timer = window.setTimeout(flush, ALWAYS_READ_DELAY_MS);
    };
    // Unread from before (offline, or just switched on) is cleared once, silently.
    const catchUp = (): void => {
      if (cfg.store.alwaysRead !== true) return;
      try {
        markAllAsRead();
      } catch (err) {
        ctx.log.warn("always read: catch-up failed", err);
      }
    };
    const onConnect = (): void => {
      window.setTimeout(catchUp, 1500);
    };

    // Plugins can start before Discord's dispatcher exists, so binding retries briefly.
    let flux: ReturnType<typeof sharedDispatcher>;
    const bind = (): boolean => {
      flux = sharedDispatcher();
      if (!flux) return false;
      flux.subscribe("MESSAGE_CREATE", onMessage);
      flux.subscribe("CONNECTION_OPEN", onConnect);
      return true;
    };
    let retry = 0;
    let giveUp = 0;
    if (!bind()) {
      retry = window.setInterval(() => {
        if (bind()) { window.clearInterval(retry); window.clearTimeout(giveUp); }
      }, 500);
      giveUp = window.setTimeout(() => {
        window.clearInterval(retry);
        ctx.log.warn("always read unavailable: Discord dispatcher not found");
      }, 30_000);
    }
    ctx.disposable(() => {
      window.clearInterval(retry);
      window.clearTimeout(giveUp);
      flux?.unsubscribe("MESSAGE_CREATE", onMessage);
      flux?.unsubscribe("CONNECTION_OPEN", onConnect);
    });
    ctx.disposable(() => {
      window.clearTimeout(timer);
      pending.clear();
    });

    let wasOn = cfg.store.alwaysRead === true;
    if (wasOn) catchUp();
    const onSettings = (): void => {
      const on = cfg.store.alwaysRead === true;
      if (on && !wasOn) catchUp();
      wasOn = on;
    };
    window.addEventListener(markAllAsReadChangeEvent, onSettings);
    ctx.disposable(() => window.removeEventListener(markAllAsReadChangeEvent, onSettings));
  },
});
