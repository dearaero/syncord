/**
 * Discord module discovery for Auto Quests.
 *
 * Split out of the runner so the claim watcher and the completion runner share
 * one answer to "which module is the quest store, and which one is the request
 * helper". Two copies of that discovery is how a Discord release ends up
 * half-working: one path finds the store, the other silently resolves a
 * different module with a similar shape.
 *
 * Every lookup is defensive on purpose. These are internals that move between
 * releases, and the failure mode we want is "the plugin says it could not find
 * X" rather than "the plugin patched the wrong object".
 */

export type QuestTask = { target?: number; applications?: Array<{ id?: string }> };

/**
 * `config.rewards_config`, which is where Discord actually keeps this.
 *
 * Both spellings are declared because the quests payload has shipped in each:
 * camelCase from the client-facing shape, snake_case from the documented API.
 */
export type QuestRewardsConfig = {
  /** 1 = all rewards assigned, 2 = assigned in tiers. */
  assignmentMethod?: number;
  assignment_method?: number;
  rewards?: Array<{ type?: number; skuId?: string; sku_id?: string }>;
  rewardsExpireAt?: string | null;
  rewards_expire_at?: string | null;
  /** Platforms the reward can be redeemed on; 0 = cross-platform. */
  platforms?: number[];
};

export type Quest = {
  id: string;
  config?: {
    expiresAt?: string;
    messages?: { questName?: string };
    applicationName?: string;
    application?: { id?: string };
    taskConfigV2?: { tasks?: Record<string, QuestTask> };
    taskConfig?: { tasks?: Record<string, QuestTask> };
    rewardsConfig?: QuestRewardsConfig;
    rewards_config?: QuestRewardsConfig;
    rewardsExpireAt?: string;
    /** The same field, snake_case, as some Discord endpoints return it. */
    rewards_expire_at?: string;
  };
  userStatus?: {
    enrolledAt?: string;
    completedAt?: string;
    claimedAt?: string;
    streamProgressSeconds?: number;
    progress?: Record<string, { value?: number }> | Map<string, { value?: number }>;
  };
  trafficMetadataSealed?: string | null;
};

export type QuestStore = {
  getQuests?: () => Map<string, Quest> | Record<string, Quest>;
  getQuest?: (id: string) => Quest | undefined;
  quests?: Map<string, Quest> | Record<string, Quest>;
};

export type RestApi = {
  post: (args: { url: string; body?: Record<string, unknown>; headers?: Record<string, string> }) => Promise<{ body?: Record<string, any>; status?: number }>;
  get: (args: { url: string }) => Promise<{ body?: any; status?: number }>;
};

export type Dispatcher = {
  dispatch: (event: Record<string, unknown>) => void;
  subscribe: (name: string, cb: (payload: any) => void) => void;
  unsubscribe: (name: string, cb: (payload: any) => void) => void;
};

export type Modules = { store: QuestStore; api: RestApi; dispatcher: Dispatcher };

export function findModules(): Modules {
  const wp = window.Syncord?.webpack;

  const store = (
    wp?.findByStoreName("QuestsStore") ??
    wp?.findByProps("getQuest")
  ) as QuestStore | undefined;

  // Ham HTTP istemcisi fonksiyon; aradığımız REST modülü nesne.
  const api = wp?.find((value) => {
    if (!value || typeof value !== "object") return false;

    const candidate = value as Record<string, unknown>;

    return ["get", "post", "put", "patch", "del"].every(
      (key) => typeof candidate[key] === "function",
    );
  }) as RestApi | undefined;

  const dispatcher = wp?.findByProps(
    "dispatch",
    "subscribe",
    "flushWaitQueue",
  ) as Dispatcher | undefined;

  if (!store) throw new Error("QuestsStore was not found");
  if (!api) throw new Error("Discord's REST API module was not found");
  if (!dispatcher?.subscribe) {
    throw new Error("FluxDispatcher was not found");
  }

  return { store, api, dispatcher };
}

export function shortError(error: unknown): string {
  const value = error as { status?: number; httpStatus?: number; body?: { message?: string }; message?: string };
  const message = value?.body?.message ?? value?.message ?? String(error);
  return `${value?.status ?? value?.httpStatus ? `HTTP ${value.status ?? value.httpStatus}: ` : ""}${message}`
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 180);
}

/** Sleep that rejects on abort, so stopping the runner is immediate. */
export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Stopped", "AbortError"));
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new DOMException("Stopped", "AbortError")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The server's own view of our quests. The local store is not authoritative. */
export async function readServerQuests(api: RestApi): Promise<any> {
  let response: Awaited<ReturnType<RestApi["get"]>>;
  try {
    response = await api.get({ url: "/quests/@me" });
  } catch (error) {
    throw new Error(`Could not access the Quest API: ${shortError(error)}`);
  }
  if (response.status && (response.status < 200 || response.status >= 300)) {
    throw new Error(`Quest API returned HTTP ${response.status}`);
  }
  if (!response.body || typeof response.body !== "object") {
    throw new Error("Quest API did not return a valid JSON response");
  }
  return response.body;
}

export function questsOf(store: QuestStore): Quest[] {
  const raw = store.getQuests?.() ?? store.quests;
  return raw instanceof Map ? [...raw.values()] : Object.values(raw ?? {});
}

export function currentQuest(store: QuestStore, id: string): Quest | undefined {
  return store.getQuest?.(id) ?? questsOf(store).find((q) => q.id === id);
}

/** Find one quest in a `/quests/@me` response, whatever shape it arrived in. */
export function serverQuest(body: any, id: string): any {
  const list = body?.quests ?? body?.quest ?? body;
  if (Array.isArray(list)) return list.find((value) => String(value?.id) === id);
  if (list && typeof list === "object") {
    if (String(list.id) === id) return list;
    if (list[id]) return list[id];
    return Object.values(list).find((value: any) => String(value?.id) === id);
  }
  return undefined;
}

export function enrollmentStatus(value: any): { enrolledAt?: string; questId?: string } | undefined {
  const status = value?.userStatus ?? value?.user_status ??
    value?.enrolledQuestUserStatus ?? value?.enrolled_quest_user_status ?? value;
  if (!status || typeof status !== "object") return undefined;
  const enrolledAt = status.enrolledAt ?? status.enrolled_at;
  const questId = status.questId ?? status.quest_id;
  return enrolledAt ? { ...status, enrolledAt, questId } : undefined;
}