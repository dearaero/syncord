import { t as i18nText } from "../../i18n";
import { definePlugin, type PluginContext } from "../../api/plugin";
import {
  hideSessionRestorePrompt,
  removeSessionRestorePromptStyle,
  showSessionRestorePrompt,
} from "./prompt";
import type { SessionScrollState, SessionSnapshot } from "./types";

const SNAPSHOT_KEY = "last-session";
const DONT_ASK_KEY = "dontAsk";
const SNAPSHOT_VERSION = 1 as const;

const CAPTURE_INTERVAL_MS = 900;
const RESTORE_TIMEOUT_MS = 10_000;
const SCROLL_STABILIZE_MS = 1_800;
const SCROLL_STABILIZE_STEP_MS = 90;
const MAX_SNAPSHOT_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Discord's ChannelMessage draft type is currently 0.
 * This is only used for reading DraftStore. The DOM fallback remains in place.
 */
const CHANNEL_MESSAGE_DRAFT_TYPE = 0;

type SelectedChannelStoreLike = {
  getChannelId?: () => string | undefined;
};

type SelectedGuildStoreLike = {
  getGuildId?: () => string | undefined;
};

type ChannelLike = {
  id?: string;
  name?: string;
  guild_id?: string;
  recipients?: string[];
};

type ChannelStoreLike = {
  getChannel?: (id: string) => ChannelLike | undefined;
};

type GuildLike = {
  id?: string;
  name?: string;
};

type GuildStoreLike = {
  getGuild?: (id: string) => GuildLike | undefined;
};

type UserLike = {
  id?: string;
  username?: string;
  globalName?: string;
};

type UserStoreLike = {
  getUser?: (id: string) => UserLike | undefined;
};

type DraftStoreLike = {
  getDraft?: (
    channelId: string,
    draftType: number,
  ) => string | undefined;
};

type NavigationRouterLike = {
  transitionTo?: (route: string) => void;
};

function isValidSnapshot(
  value: unknown,
): value is SessionSnapshot {
  if (
    value == null ||
    typeof value !== "object"
  ) {
    return false;
  }

  const snapshot =
    value as Partial<SessionSnapshot>;

  if (
    snapshot.version !==
      SNAPSHOT_VERSION ||
    typeof snapshot.savedAt !==
      "number" ||
    typeof snapshot.route !==
      "string"
  ) {
    return false;
  }

  if (
    !snapshot.route.startsWith(
      "/channels/",
    )
  ) {
    return false;
  }

  const age =
    Date.now() -
    snapshot.savedAt;

  return (
    age >= 0 &&
    age <= MAX_SNAPSHOT_AGE_MS
  );
}

function currentRoute(): string {
  return (
    location.pathname +
    location.search +
    location.hash
  );
}

/**
 * Keep snapshots on the channel route itself.
 *
 * During restore we temporarily navigate to Discord's message permalink route
 * (/channels/guild/channel/message) so Discord loads the old message history.
 * We do not want that temporary message id to become the next saved session.
 */
function normalizedChannelRoute(
  guildId: string | undefined,
  channelId: string | undefined,
): string {
  if (!channelId) {
    return currentRoute();
  }

  return `/channels/${guildId ?? "@me"}/${channelId}`;
}

function routeParts(): {
  guildId?: string;
  channelId?: string;
} {
  const match =
    location.pathname.match(
      /^\/channels\/([^/]+)(?:\/([^/]+))?/,
    );

  if (!match) {
    return {};
  }

  const guildSegment =
    match[1];

  const channelSegment =
    match[2];

  return {
    guildId:
      guildSegment &&
      guildSegment !== "@me"
        ? guildSegment
        : undefined,

    channelId:
      channelSegment &&
      channelSegment !== "@me"
        ? channelSegment
        : undefined,
  };
}

function commonStores() {
  return window.Syncord
    ?.common
    ?.stores;
}

function selectedChannelId():
  | string
  | undefined {
  const store =
    commonStores()
      ?.SelectedChannelStore as
      | SelectedChannelStoreLike
      | undefined;

  try {
    const id =
      store?.getChannelId?.();

    if (
      typeof id === "string" &&
      id
    ) {
      return id;
    }
  } catch {
    /* Discord store changed shape. */
  }

  return routeParts().channelId;
}

function selectedGuildId():
  | string
  | undefined {
  const store =
    commonStores()
      ?.SelectedGuildStore as
      | SelectedGuildStoreLike
      | undefined;

  try {
    const id =
      store?.getGuildId?.();

    if (
      typeof id === "string" &&
      id
    ) {
      return id;
    }
  } catch {
    /* Discord store changed shape. */
  }

  return routeParts().guildId;
}

function currentChannel():
  | ChannelLike
  | undefined {
  const channelId =
    selectedChannelId();

  if (!channelId) {
    return undefined;
  }

  const store =
    commonStores()
      ?.ChannelStore as
      | ChannelStoreLike
      | undefined;

  try {
    return store
      ?.getChannel?.(
        channelId,
      );
  } catch {
    return undefined;
  }
}

function currentGuild():
  | GuildLike
  | undefined {
  const guildId =
    selectedGuildId();

  if (!guildId) {
    return undefined;
  }

  const store =
    commonStores()
      ?.GuildStore as
      | GuildStoreLike
      | undefined;

  try {
    return store
      ?.getGuild?.(
        guildId,
      );
  } catch {
    return undefined;
  }
}

function channelName(
  channel: ChannelLike | undefined,
): string | undefined {
  const raw =
    channel?.name?.trim();

  if (raw) return raw;

  const recipients =
    channel?.recipients;

  if (
    !Array.isArray(recipients) ||
    recipients.length === 0
  ) {
    return channel?.id
      ? i18nText("ui.direct_message")
      : undefined;
  }

  const users =
    commonStores()
      ?.UserStore as
      | UserStoreLike
      | undefined;

  const names =
    recipients
      .map((id) => {
        try {
          const user =
            users?.getUser?.(id);

          return (
            user?.globalName?.trim() ||
            user?.username?.trim() ||
            ""
          );
        } catch {
          return "";
        }
      })
      .filter(Boolean);

  return (
    names.join(", ") ||
    i18nText("ui.direct_message")
  );
}

function readComposerText():
  | string
  | undefined {
  const selectors = [
    "[class*=\"channelTextArea\"] textarea",
    "[class*=\"channelTextArea\"] [role=\"textbox\"][contenteditable=\"true\"]",
    "[class*=\"channelTextArea\"] [contenteditable=\"true\"]",
  ];

  for (
    const selector
    of selectors
  ) {
    const element =
      document.querySelector<
        HTMLTextAreaElement |
        HTMLElement
      >(selector);

    if (!element) continue;

    if (
      element instanceof
      HTMLTextAreaElement
    ) {
      return element.value;
    }

    const text =
      element.innerText ??
      element.textContent ??
      "";

    return text;
  }

  return undefined;
}

function readDraft(
  channelId: string | undefined,
): string | undefined {
  if (channelId) {
    const store =
      commonStores()
        ?.DraftStore as
        | DraftStoreLike
        | undefined;

    try {
      const value =
        store?.getDraft?.(
          channelId,
          CHANNEL_MESSAGE_DRAFT_TYPE,
        );

      if (
        typeof value === "string"
      ) {
        return value;
      }
    } catch {
      /* Fall back to DOM composer. */
    }
  }

  const domDraft =
    readComposerText();

  return typeof domDraft ===
    "string"
    ? domDraft
    : undefined;
}

function isScrollable(
  element: HTMLElement,
): boolean {
  if (
    element.scrollHeight <=
      element.clientHeight + 8
  ) {
    return false;
  }

  const overflowY =
    getComputedStyle(
      element,
    ).overflowY;

  return (
    overflowY === "auto" ||
    overflowY === "scroll"
  );
}

function messageScroller():
  | HTMLElement
  | undefined {
  const list =
    document.querySelector<HTMLElement>(
      '[data-list-id="chat-messages"]',
    ) ??
    document.querySelector<HTMLElement>(
      'ol[aria-label*="Messages"]',
    );

  if (list) {
    let current:
      | HTMLElement
      | null = list;

    while (
      current &&
      current !==
        document.body
    ) {
      if (
        isScrollable(current)
      ) {
        return current;
      }

      current =
        current.parentElement;
    }
  }

  const fallbacks = [
    "[class*=\"messagesWrapper\"] [class*=\"scroller\"]",
    "[class*=\"chatContent\"] [class*=\"scroller\"]",
  ];

  for (
    const selector
    of fallbacks
  ) {
    const element =
      document.querySelector<HTMLElement>(
        selector,
      );

    if (
      element &&
      isScrollable(element)
    ) {
      return element;
    }
  }

  return undefined;
}

type VisibleMessageAnchor = {
  messageId: string;
  offset: number;
};

function visibleMessageAnchor(
  scroller: HTMLElement,
): VisibleMessageAnchor | undefined {
  const scrollerRect =
    scroller.getBoundingClientRect();

  const rows =
    document.querySelectorAll<HTMLElement>(
      '[id^="chat-messages-"]',
    );

  let best:
    | VisibleMessageAnchor
    | undefined;

  let bestDistance =
    Number.POSITIVE_INFINITY;

  for (
    const row
    of rows
  ) {
    const rect =
      row.getBoundingClientRect();

    /*
     * Ignore rows completely outside the visible chat viewport.
     */
    if (
      rect.bottom <=
        scrollerRect.top + 1 ||
      rect.top >=
        scrollerRect.bottom - 1
    ) {
      continue;
    }

    const match =
      row.id.match(
        /(\d{15,22})$/,
      );

    if (!match?.[1]) {
      continue;
    }

    const offset =
      rect.top -
      scrollerRect.top;

    /*
     * Prefer the visible message closest to the top edge. If the first
     * message is partially clipped, its negative offset is intentionally
     * preserved so we can reproduce the exact same viewport.
     */
    const distance =
      Math.abs(offset);

    if (
      best === undefined ||
      offset >= -rect.height / 2 &&
      distance < bestDistance
    ) {
      best = {
        messageId:
          match[1],
        offset:
          Math.round(offset),
      };

      bestDistance =
        distance;
    }
  }

  return best;
}

function readScroll():
  | SessionScrollState
  | undefined {
  const scroller =
    messageScroller();

  if (!scroller) {
    return undefined;
  }

  const bottom =
    Math.max(
      0,
      scroller.scrollHeight -
        scroller.scrollTop -
        scroller.clientHeight,
    );

  const anchor =
    visibleMessageAnchor(
      scroller,
    );

  return {
    top:
      Math.max(
        0,
        Math.round(
          scroller.scrollTop,
        ),
      ),

    bottom:
      Math.max(
        0,
        Math.round(bottom),
      ),

    atBottom:
      bottom <= 48,

    anchorMessageId:
      anchor?.messageId,

    anchorOffset:
      anchor?.offset,
  };
}

function captureSnapshot():
  | SessionSnapshot
  | undefined {
  const liveRoute =
    currentRoute();

  if (
    !liveRoute.startsWith(
      "/channels/",
    )
  ) {
    return undefined;
  }

  const channel =
    currentChannel();

  const guild =
    currentGuild();

  const channelId =
    selectedChannelId();

  const guildId =
    selectedGuildId();

  const route =
    normalizedChannelRoute(
      guildId,
      channelId,
    );

  const draft =
    readDraft(channelId);

  return {
    version:
      SNAPSHOT_VERSION,

    savedAt:
      Date.now(),

    route,

    guildId,

    guildName:
      guild?.name?.trim() ||
      undefined,

    channelId,

    channelName:
      channelName(channel),

    draft:
      draft === undefined
        ? undefined
        : draft,

    scroll:
      readScroll(),
  };
}

function fingerprint(
  snapshot: SessionSnapshot,
): string {
  const scroll =
    snapshot.scroll;

  return JSON.stringify({
    route:
      snapshot.route,

    guildId:
      snapshot.guildId,

    channelId:
      snapshot.channelId,

    draft:
      snapshot.draft ?? "",

    scroll:
      scroll
        ? {
            top:
              Math.round(
                scroll.top / 16,
              ) * 16,

            bottom:
              Math.round(
                scroll.bottom / 16,
              ) * 16,

            atBottom:
              scroll.atBottom,

            anchor:
              scroll.anchorMessageId,

            anchorOffset:
              typeof scroll.anchorOffset === "number"
                ? Math.round(
                    scroll.anchorOffset / 4,
                  ) * 4
                : undefined,
          }
        : null,
  });
}

function findNavigationRouter():
  | NavigationRouterLike
  | undefined {
  const webpack =
    window.Syncord
      ?.webpack;

  if (!webpack) {
    return undefined;
  }

  const precise =
    webpack.findByProps(
      "transitionTo",
      "back",
      "forward",
    ) as
      | NavigationRouterLike
      | undefined;

  if (
    typeof precise?.transitionTo ===
    "function"
  ) {
    return precise;
  }

  const loose =
    webpack.findByProps(
      "transitionTo",
    ) as
      | NavigationRouterLike
      | undefined;

  return typeof loose
    ?.transitionTo ===
    "function"
    ? loose
    : undefined;
}

function navigate(
  route: string,
): void {
  const router =
    findNavigationRouter();

  if (
    typeof router?.transitionTo ===
    "function"
  ) {
    router.transitionTo(route);
    return;
  }

  /*
   * Last-resort browser history fallback.
   * Normally Discord's NavigationRouter above is available.
   */
  history.pushState(
    null,
    "",
    route,
  );

  window.dispatchEvent(
    new PopStateEvent(
      "popstate",
    ),
  );
}

function restoreRoute(
  snapshot: SessionSnapshot,
): string {
  const state =
    snapshot.scroll;

  /*
   * A Discord message permalink forces the client to fetch/render the history
   * around that message. This is the key to restoring old scroll positions in
   * Discord's virtualized message list.
   */
  if (
    !state?.atBottom &&
    state?.anchorMessageId &&
    snapshot.channelId
  ) {
    return `/channels/${snapshot.guildId ?? "@me"}/${snapshot.channelId}/${state.anchorMessageId}`;
  }

  return snapshot.route;
}

function anchorElement(
  snapshot: SessionSnapshot,
): HTMLElement | undefined {
  const messageId =
    snapshot.scroll
      ?.anchorMessageId;

  const channelId =
    snapshot.channelId;

  if (
    !messageId ||
    !channelId
  ) {
    return undefined;
  }

  return (
    document.getElementById(
      `chat-messages-${channelId}-${messageId}`,
    ) ??
    undefined
  );
}

function sleep(
  ms: number,
): Promise<void> {
  return new Promise(
    (resolve) =>
      window.setTimeout(
        resolve,
        ms,
      ),
  );
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs:
    number = RESTORE_TIMEOUT_MS,
): Promise<boolean> {
  const started =
    Date.now();

  while (
    Date.now() - started <
    timeoutMs
  ) {
    try {
      if (predicate()) {
        return true;
      }
    } catch {
      /* Retry while Discord mounts. */
    }

    await sleep(120);
  }

  return false;
}

function setTextareaValue(
  input:
    | HTMLTextAreaElement
    | HTMLInputElement,
  value: string,
): void {
  const prototype =
    input instanceof
    HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;

  const descriptor =
    Object.getOwnPropertyDescriptor(
      prototype,
      "value",
    );

  descriptor?.set?.call(
    input,
    value,
  );

  input.dispatchEvent(
    new InputEvent(
      "input",
      {
        bubbles: true,
        inputType:
          "insertText",
        data: value,
      },
    ),
  );

  input.dispatchEvent(
    new Event(
      "change",
      {
        bubbles: true,
      },
    ),
  );
}

function restoreComposerText(
  value: string,
): boolean {
  if (!value) {
    return true;
  }

  const textarea =
    document.querySelector<
      HTMLTextAreaElement
    >(
      '[class*="channelTextArea"] textarea',
    );

  if (textarea) {
    /*
     * Never overwrite a draft Discord already restored itself.
     */
    if (
      textarea.value.trim()
    ) {
      return true;
    }

    textarea.focus();

    setTextareaValue(
      textarea,
      value,
    );

    return true;
  }

  const editable =
    document.querySelector<HTMLElement>(
      '[class*="channelTextArea"] [role="textbox"][contenteditable="true"]',
    ) ??
    document.querySelector<HTMLElement>(
      '[class*="channelTextArea"] [contenteditable="true"]',
    );

  if (!editable) {
    return false;
  }

  const existing =
    (
      editable.innerText ??
      editable.textContent ??
      ""
    ).trim();

  if (existing) {
    return true;
  }

  editable.focus();
  editable.textContent =
    value;

  editable.dispatchEvent(
    new InputEvent(
      "input",
      {
        bubbles: true,
        inputType:
          "insertText",
        data: value,
      },
    ),
  );

  return true;
}

function applyAnchoredScroll(
  snapshot: SessionSnapshot,
): boolean {
  const state =
    snapshot.scroll;

  if (
    !state ||
    state.atBottom
  ) {
    return false;
  }

  const scroller =
    messageScroller();

  const anchor =
    anchorElement(
      snapshot,
    );

  if (
    !scroller ||
    !anchor
  ) {
    return false;
  }

  const scrollerRect =
    scroller.getBoundingClientRect();

  const anchorRect =
    anchor.getBoundingClientRect();

  const desiredOffset =
    typeof state.anchorOffset ===
      "number"
      ? state.anchorOffset
      : Math.min(
          72,
          scroller.clientHeight *
            0.18,
        );

  const currentOffset =
    anchorRect.top -
    scrollerRect.top;

  const correction =
    currentOffset -
    desiredOffset;

  if (
    Math.abs(correction) >
    0.75
  ) {
    scroller.scrollTop +=
      correction;
  }

  return true;
}

function applyFallbackScroll(
  snapshot: SessionSnapshot,
): boolean {
  const state =
    snapshot.scroll;

  if (!state) {
    return true;
  }

  const scroller =
    messageScroller();

  if (!scroller) {
    return false;
  }

  if (state.atBottom) {
    scroller.scrollTop =
      scroller.scrollHeight;

    return true;
  }

  if (
    scroller.scrollHeight <=
    scroller.clientHeight
  ) {
    return false;
  }

  /*
   * Absolute scrollTop is only a fallback. In Discord's virtualized list the
   * same scrollTop can point to a completely different message after restart.
   */
  scroller.scrollTop =
    Math.min(
      state.top,
      Math.max(
        0,
        scroller.scrollHeight -
          scroller.clientHeight,
      ),
    );

  return true;
}

async function stabilizeScroll(
  snapshot: SessionSnapshot,
  ctx: PluginContext,
): Promise<boolean> {
  const state =
    snapshot.scroll;

  if (!state) {
    return true;
  }

  if (state.atBottom) {
    return waitFor(
      () =>
        applyFallbackScroll(
          snapshot,
        ),
      4_000,
    );
  }

  /*
   * First wait until Discord has actually rendered the permalink message.
   * Merely finding the channel scroller is not enough; Discord initially
   * mounts the channel at the bottom and later swaps in the requested history.
   */
  const anchorReady =
    state.anchorMessageId
      ? await waitFor(
          () =>
            Boolean(
              messageScroller() &&
              anchorElement(
                snapshot,
              ),
            ),
          RESTORE_TIMEOUT_MS,
        )
      : false;

  if (!anchorReady) {
    ctx.log.warn(
      "scroll anchor was not rendered; using scrollTop fallback",
    );

    return waitFor(
      () =>
        applyFallbackScroll(
          snapshot,
        ),
      4_000,
    );
  }

  /*
   * Discord performs several asynchronous list/layout passes after the old
   * history is inserted. Any one of them can move the viewport back to the
   * newest message. Re-apply the anchor offset for a short stabilization
   * window so our restored viewport wins after those internal passes finish.
   */
  const started =
    performance.now();

  let applied =
    false;

  while (
    performance.now() -
      started <
    SCROLL_STABILIZE_MS
  ) {
    applied =
      applyAnchoredScroll(
        snapshot,
      ) || applied;

    await sleep(
      SCROLL_STABILIZE_STEP_MS,
    );
  }

  /*
   * One final correction on the next two animation frames catches late height
   * changes from embeds/images/font layout without keeping a permanent lock.
   */
  await new Promise<void>(
    (resolve) => {
      requestAnimationFrame(
        () =>
          requestAnimationFrame(
            () => {
              applyAnchoredScroll(
                snapshot,
              );

              resolve();
            },
          ),
      );
    },
  );

  return applied;
}

async function restoreSnapshot(
  snapshot: SessionSnapshot,
  ctx: PluginContext,
): Promise<void> {
  const targetRoute =
    restoreRoute(snapshot);

  ctx.log.info(
    `restoring ${targetRoute}`,
  );

  /*
   * Even if Discord already opened the correct channel, navigate to the
   * message permalink when we have an anchor. That makes Discord fetch the
   * historical message range instead of mounting the channel at the bottom.
   */
  if (
    currentRoute() !==
    targetRoute
  ) {
    navigate(
      targetRoute,
    );
  }

  if (snapshot.channelId) {
    await waitFor(
      () =>
        selectedChannelId() ===
        snapshot.channelId,
    );
  } else {
    await sleep(350);
  }

  /*
   * Let Discord mount the composer and begin loading the message list.
   */
  await sleep(180);

  if (
    snapshot.draft &&
    snapshot.draft.trim()
  ) {
    await waitFor(
      () =>
        restoreComposerText(
          snapshot.draft!,
        ),
      4_000,
    );
  }

  if (snapshot.scroll) {
    const restored =
      await stabilizeScroll(
        snapshot,
        ctx,
      );

    if (!restored) {
      ctx.log.warn(
        "could not reproduce the previous scroll position",
      );
    }
  }

  window.Syncord
    ?.toast
    ?.show?.(
      i18nText("ui.previous_session_restored"),
    );

  ctx.log.info(
    "session restored",
  );
}

function beginTracking(
  ctx: PluginContext,
): () => void {
  let lastFingerprint =
    "";

  let disposed =
    false;

  const persist = (
    force = false,
  ) => {
    if (disposed) return;

    // A hidden window has no scroll position worth recording, and capturing
    // one forces a layout by measuring every message row. Skipping it while
    // the tab is in the background removes most of this plugin's cost.
    if (!force && document.hidden) {
      return;
    }

    const snapshot =
      captureSnapshot();

    if (!snapshot) {
      return;
    }

    const nextFingerprint =
      fingerprint(snapshot);

    if (
      !force &&
      nextFingerprint ===
        lastFingerprint
    ) {
      return;
    }

    lastFingerprint =
      nextFingerprint;

    ctx.settings.set(
      SNAPSHOT_KEY,
      snapshot,
    );
  };

  const timer =
    window.setInterval(
      () => persist(false),
      CAPTURE_INTERVAL_MS,
    );

  const onVisibility =
    () => {
      if (
        document.visibilityState ===
        "hidden"
      ) {
        persist(true);
      }
    };

  const onPageHide =
    () => {
      persist(true);

      void window.Syncord
        ?.settings
        ?.flush?.();
    };

  document.addEventListener(
    "visibilitychange",
    onVisibility,
  );

  window.addEventListener(
    "pagehide",
    onPageHide,
  );

  /*
   * Initial snapshot after Discord's first render settles.
   */
  const initial =
    window.setTimeout(
      () => persist(true),
      650,
    );

  return () => {
    disposed = true;

    window.clearInterval(
      timer,
    );

    window.clearTimeout(
      initial,
    );

    document.removeEventListener(
      "visibilitychange",
      onVisibility,
    );

    window.removeEventListener(
      "pagehide",
      onPageHide,
    );

    /*
     * Capture one final state while the DOM still exists.
     */
    const snapshot =
      captureSnapshot();

    if (snapshot) {
      ctx.settings.set(
        SNAPSHOT_KEY,
        snapshot,
      );
    }
  };
}

export const SessionRestorePlugin =
  definePlugin({
    id:
      "session-restore",

    name:
      i18nText("ui.session_restore"),

    get description() { return i18nText("ui.restore_the_last_chat_draft_and_message_scroll_position_when_discord_s"); },

    author:
      i18nText("ui.syncord"),

    enabledByDefault:
      true,

    /**
     * Reopens the guilds, channels and DMs from the previous session, and
     * records a small history under the Syncord profile. No network
     * permission: every channel it opens is opened by Discord itself.
     */
    permissions: {
      userData: true,
      discordStores: ["channel", "guild"],
    },

    start(ctx) {
      const previous =
        ctx.settings.get<
          SessionSnapshot | null
        >(
          SNAPSHOT_KEY,
          null,
        );

      const dontAsk =
        ctx.settings.get<boolean>(
          DONT_ASK_KEY,
          false,
        ) === true;

      let stopTracking:
        | (() => void)
        | undefined;

      let promptCleanup:
        | (() => void)
        | undefined;

      let startupTimer:
        | number
        | undefined;

      const startTracking =
        () => {
          if (
            stopTracking
          ) {
            return;
          }

          stopTracking =
            beginTracking(ctx);
        };

      const discardPrevious =
        () => {
          ctx.settings.set(
            SNAPSHOT_KEY,
            null,
          );
        };

      const validPrevious =
        isValidSnapshot(
          previous,
        )
          ? previous
          : undefined;

      if (!validPrevious) {
        startTracking();

        ctx.disposable(
          () => {
            stopTracking?.();
            stopTracking =
              undefined;
          },
        );

        return;
      }

      const runRestore =
        async () => {
          try {
            await restoreSnapshot(
              validPrevious,
              ctx,
            );
          } catch (
            error
          ) {
            ctx.log.error(
              "restore failed:",
              error,
            );

            window.Syncord
              ?.toast
              ?.show?.(
                i18nText("ui.session_restore_failed"),
              );
          } finally {
            startTracking();
          }
        };

      /*
       * Important:
       * Do not begin tracking until the previous session has either been
       * restored or explicitly discarded. Otherwise Discord's startup route
       * could overwrite the saved session before we use it.
       */
      startupTimer =
        window.setTimeout(
          () => {
            if (dontAsk) {
              ctx.log.info(
                "Don't ask enabled — restoring previous session automatically",
              );

              void runRestore();

              return;
            }

            promptCleanup =
              showSessionRestorePrompt(
                validPrevious,
                {
                  onRestore:
                    runRestore,

                  onFresh() {
                    discardPrevious();
                    startTracking();
                  },
                },
              );
          },
          dontAsk
            ? 650
            : 900,
        );

      ctx.disposable(
        () => {
          if (
            startupTimer !==
            undefined
          ) {
            window.clearTimeout(
              startupTimer,
            );

            startupTimer =
              undefined;
          }

          promptCleanup?.();
          promptCleanup =
            undefined;

          hideSessionRestorePrompt();
          removeSessionRestorePromptStyle();

          stopTracking?.();
          stopTracking =
            undefined;
        },
      );
    },
  });
