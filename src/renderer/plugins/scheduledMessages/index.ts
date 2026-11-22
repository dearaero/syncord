import { t as i18nText } from "../../i18n";
import { definePlugin, type PluginContext } from "../../api/plugin";
import { clearDraft, currentTarget, readDraft, sendMessage } from "./discord";
import { installScheduleButton, type ComposerHandle } from "./composer";
import { installSchedulePicker, type PickerHandle } from "./picker";
import { isPresetId, resolvePreset, type PresetId } from "./presets";
import { customTimeProblem, formatWhen, parseLocalDateTime } from "./time";
import {
  SCHEDULED_PLUGIN_ID,
  isScheduledExpanded,
  refreshCountdowns,
  setActionHandler,
  setScheduledExpanded,
} from "./panel";
import { Scheduler } from "./scheduler";
import { ScheduledStore, activeStore, scheduledChangeEvent, setActiveStore } from "./store";
import { SCHEDULED_CSS } from "./styles";
import { contentProblem, type ScheduledMessage } from "./types";

/**
 * Scheduled Messages.
 *
 * The user writes a message, picks when it should go out, and the plugin sends it
 * while Discord is open. Everything is stored locally and driven by a tick that
 * reads the wall clock, so a sleep, a restart or a clock change all resolve the
 * same way.
 *
 * Two deliberate choices worth stating:
 *
 *  - Sending goes through Discord's own `MessageActions.sendMessage`, the same
 *    function its composer uses, so the optimistic message, the local echo, rate
 *    limits and the store update all behave normally.
 *  - Discord's *own* scheduled messages, which ride on the same call as a
 *    `scheduledTimestamp` option, are not used. That feature is behind a
 *    server-side experiment and gated on Nitro Tier 2, so it would fail at send
 *    time for most accounts. Everything here runs in the client instead.
 */

/** How often the panel's countdowns are refreshed while it is open. */
const COUNTDOWN_INTERVAL_MS = 30_000;

export const ScheduledMessagesPlugin = definePlugin({
  id: SCHEDULED_PLUGIN_ID,
  name: i18nText("ui.scheduled_messages"),
  get description() { return i18nText("ui.write_a_message_now_send_it_later_schedules_a_message_for_a_date_and_t"); },
  enabledByDefault: true,

  /**
   * Sends messages on a timer. `message-send` is declared explicitly so the
   * capability is visible in the Security Center rather than implied. No network
   * permission: the send goes through Discord's own action, so the broker has
   * nothing to authorize and cannot be used as a side channel.
   */
  permissions: {
    media: true,
    userData: true,
    discordStores: ["message", "channel"],
    discordActions: ["message-send"],
  },

  start(ctx) {
    ctx.css.inject(SCHEDULED_CSS);

    const store = new ScheduledStore(ctx);
    store.load();
    setActiveStore(store);

    const toast = (message: string, type: "success" | "failure" | "message" = "message"): void => {
      try {
        window.Syncord?.toast?.show(message, { type });
      } catch (err) {
        ctx.log.warn("toast failed:", err);
      }
    };

    // ── the sender ─────────────────────────────────────────────────────
    /** True when the message was actually queued, so the caller knows it may
     * clear the composer. Refusing must never leave the box emptied. */
    const schedule = (content: string, sendAt: number): boolean => {
      const target = currentTarget();
      if (!target) {
        toast(i18nText("ui.open_a_channel_before_scheduling"), "failure");
        return false;
      }
      const problem = contentProblem(content);
      if (problem) {
        toast(problem, "failure");
        return false;
      }
      if (sendAt <= Date.now()) {
        toast(i18nText("ui.pick_a_time_in_the_future"), "failure");
        return false;
      }
      const message = store.add({
        content,
        target,
        sendAt,
        now: Date.now(),
      });
      toast(i18nText("ui.scheduled_for_value", {v0: formatWhen(message.sendAt, Date.now())}), "success");
      return true;
    };

    const scheduler = new Scheduler(ctx, {
      store,
      send: sendMessage,
      onSettled: (message, ok, error) => {
        if (ok) {
          toast(i18nText("ui.scheduled_message_sent"), "success");
          return;
        }
        toast(i18nText("ui.scheduled_message_failed_value", {v0: error ?? i18nText("ui.unknown_error")}), "failure");
      },
      onBacklog: (messages) => {
        // Offered, never fired. Draining a backlog unasked is the one thing this
        // feature must not do.
        toast(
          messages.length === 1
            ? i18nText("ui.a_scheduled_message_came_due_while_discord_was_closed")
            : i18nText("ui.value_scheduled_messages_came_due_while_discord_was_closed", {v0: messages.length}),
        );
      },
    });

    /**
     * Empty the composer, and say so when it could not be emptied.
     *
     * The composer is a controlled editor, so clearing it goes through the draft
     * store and is verified afterwards. When the write does not stick the user
     * has to know, because otherwise the message sits in the box looking like it
     * is still going to be sent now.
     */
    const reportClear = (channelId: string): void => {
      if (!clearDraft(channelId)) {
        toast(i18nText("ui.scheduled_the_text_is_still_in_the_box_clear_it_yourself"), "message");
      }
    };

    // ── the composer button ────────────────────────────────────────────
    /** The channel the picker was opened from, captured at open time. */
    let pickerChannelId: string | undefined;

    const picker: PickerHandle = installSchedulePicker({
      onConfirm: (sendAt) => {
        const channelId = pickerChannelId;
        if (!channelId) return;
        if (schedule(readDraft(channelId), sendAt)) reportClear(channelId);
      },
      onCancel: () => {
        /* nothing to undo */
      },
    });

    const composer: ComposerHandle = installScheduleButton({
      canSchedule: () => {
        const channelId = currentTarget()?.channelId;
        if (!channelId) return false;
        return !contentProblem(readDraft(channelId));
      },
      onPreset: (id: PresetId) => {
        const channelId = currentTarget()?.channelId;
        if (!channelId) {
          toast(i18nText("ui.open_a_channel_before_scheduling"), "failure");
          return;
        }
        const at = resolvePreset(id, Date.now());
        if (at === undefined) return;
        const content = readDraft(channelId);
        if (contentProblem(content)) {
          toast(i18nText("ui.write_something_in_the_box_first"), "failure");
          return;
        }
        if (schedule(content, at)) reportClear(channelId);
      },
      onUnavailable: (reason) => {
        // A dead button with no explanation is the worst outcome, so the user
        // is told in the client rather than only in the console.
        toast(i18nText("ui.scheduling_is_unavailable_right_now_value", {v0: reason}), "failure");
      },
      onCustom: () => {
        const channelId = currentTarget()?.channelId;
        const anchor = document.getElementById("Syncord-schedule-button");
        if (!channelId || !anchor) {
          toast(i18nText("ui.open_a_channel_before_scheduling"), "failure");
          return;
        }
        pickerChannelId = channelId;
        picker.open(anchor);
      },
    });

    ctx.disposable(() => {
      scheduler.stop();
      composer.dispose();
      picker.dispose();
      setActionHandler(undefined);
      setActiveStore(undefined);
      setScheduledExpanded(false);
    });

    // ── the settings panel section ─────────────────────────────────────
    setActionHandler((action, message, card) => {
      handlePanelAction(ctx, store, scheduler, toast, action, message, card);
    });

    const onChange = (): void => {
      // The panel redraws on this; the countdowns need their own heartbeat
      // because nothing else changes them.
      composer.refresh();
    };
    window.addEventListener(scheduledChangeEvent, onChange);
    ctx.disposable(() => window.removeEventListener(scheduledChangeEvent, onChange));

    const countdown = window.setInterval(() => {
      if (!isScheduledExpanded()) return;
      const list = document.querySelector("[data-dion-sm-list]");
      if (list) refreshCountdowns(list, Date.now());
    }, COUNTDOWN_INTERVAL_MS);
    ctx.disposable(() => window.clearInterval(countdown));

    scheduler.start();

    ctx.log.info(
      `ready: ${store.pending().length} pending, ${store.overdue(Date.now()).length} overdue`,
    );
  },
});

/**
 * One click in the panel's card.
 *
 * The card is a plain element, so the handler toggles its own sub-forms rather
 * than the panel re-rendering: a re-render mid-edit would throw away whatever
 * the user was typing.
 */
function handlePanelAction(
  ctx: PluginContext,
  store: ScheduledStore,
  scheduler: Scheduler,
  toast: (message: string, type?: "success" | "failure" | "message") => void,
  action: string,
  message: ScheduledMessage,
  card: HTMLElement,
): void {
  const now = Date.now();
  const editor = card.querySelector<HTMLTextAreaElement>("[data-dion-sm-editor]");
  const body = card.querySelector<HTMLElement>("[data-dion-sm-body]");
  const whenEdit = card.querySelector<HTMLElement>(".dion-sm-when-edit");
  const show = (node: Element | null | undefined, visible: boolean): void => {
    if (node instanceof HTMLElement) node.hidden = !visible;
  };

  switch (action) {
    case "edit": {
      show(editor, true);
      show(body, false);
      show(whenEdit, false);
      editor?.focus();
      editor?.setSelectionRange(editor.value.length, editor.value.length);
      toggle(card, "save", true);
      toggle(card, "revert", true);
      toggle(card, "edit", false);
      return;
    }
    case "revert": {
      show(editor, false);
      show(body, true);
      show(whenEdit, false);
      toggle(card, "save", false);
      toggle(card, "revert", false);
      toggle(card, "edit", true);
      return;
    }
    case "save": {
      // "Save" commits whichever sub-forms are open, so editing the text and
      // moving the time are one action rather than two.
      const content = editor?.value ?? message.content;
      const problem = contentProblem(content);
      if (problem) {
        toast(problem, "failure");
        return;
      }
      if (!store.setContent(message.id, content)) return;

      if (whenEdit && !whenEdit.hidden) {
        const date = whenEdit.querySelector<HTMLInputElement>("[data-dion-sm-date]")?.value ?? "";
        const time = whenEdit.querySelector<HTMLInputElement>("[data-dion-sm-time]")?.value ?? "";
        const parsed = parseLocalDateTime(date, time);
        if (parsed === undefined) {
          toast(i18nText("ui.that_date_and_time_cannot_be_read"), "failure");
          return;
        }
        if (customTimeProblem(date, time, now)) {
          toast(i18nText("ui.pick_a_time_in_the_future"), "failure");
          return;
        }
        if (!store.setSendAt(message.id, parsed, now)) {
          toast(i18nText("ui.that_time_is_not_available"), "failure");
          return;
        }
        toast(i18nText("ui.rescheduled"), "success");
      } else {
        toast(i18nText("ui.saved"), "success");
      }

      show(editor, false);
      show(body, true);
      show(whenEdit, false);
      toggle(card, "save", false);
      toggle(card, "revert", false);
      toggle(card, "edit", true);
      toggle(card, "time", true);
      return;
    }
    case "time": {
      show(whenEdit, true);
      toggle(card, "time", false);
      toggle(card, "save", true);
      toggle(card, "revert", true);
      return;
    }
    case "send": {
      void scheduler.sendNow(message).then((ok) => {
        if (!ok) toast(i18nText("ui.already_sending"), "message");
      });
      return;
    }
    case "retry": {
      if (store.retry(message.id, now)) {
        scheduler.tick();
        toast(i18nText("ui.queued_again"), "success");
      }
      return;
    }
    case "cancel": {
      store.cancel(message.id);
      toast(i18nText("ui.cancelled"), "message");
      return;
    }
    case "delete": {
      store.remove(message.id);
      return;
    }
    default:
      ctx.log.warn(`unknown panel action "${action}"`);
  }

}

function toggle(card: HTMLElement, action: string, visible: boolean): void {
  const button = card.querySelector<HTMLElement>(`[data-dion-sm-action="${action}"]`);
  if (button) button.hidden = !visible;
}

