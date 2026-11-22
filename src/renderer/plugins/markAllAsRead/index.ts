import { t as i18nText } from "../../i18n";
import { definePlugin, type PluginContext } from "../../api/plugin";
import { installDmHomeMenu, type DmHomeMenuHandle } from "./menu";
import { markAllAsRead, type MarkOutcome } from "./readState";

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
  },
});
