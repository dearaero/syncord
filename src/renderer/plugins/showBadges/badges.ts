import { t as i18nText } from "../../i18n";
import {withoutOfficialProfileBadges} from "../../core/profileBadges";
import {officialBadges} from "../../api/ecosystem/badges";
import {ecosystemArt} from "../../ui/ecosystem/art";
import type {BadgeArt} from "../../../shared/ecosystem";
/**
 * Badge resolution.
 *
 * Source of truth: GET /users/:id/profile?guild_id=…
 *   → badges (Nitro, quests, Last Meadow, boost tenure, …)
 *   → guild_badges (server-specific, e.g. boosting *this* guild)
 *
 * Visible authors use the shared native profile queue. Public flags render immediately.
 */

export type BadgeDef = {
  ecosystemArt?:BadgeArt;
  ecosystemImage?:string;
  id: string;
  label: string;
  icon: string;
};

export type ChatUser = {
  id: string;
  flags?: number;
  publicFlags?: number;
  public_flags?: number;
  premium_type?: number | null;
  premium_since?: string | number | Date | null;
  premium_guild_since?: string | number | Date | null;
  premiumType?: number | null;
  premiumSince?: string | number | Date | null;
  /** Global boost start — used for guild_booster_lvl fallback. */
  premiumGuildSince?: string | number | Date | null;
};

type FlagBadge = BadgeDef & { bit: number };

const FLAG_BADGES: readonly FlagBadge[] = [
  {
    bit: 0,
    id: "staff",
    get label() { return i18nText("ui.discord_staff"); },
    icon: "5e74e9b61934fc1f67c65515d1f7e60d",
  },
  {
    bit: 1,
    id: "partner",
    get label() { return i18nText("ui.partnered_server_owner"); },
    icon: "3f9748e53446a137a052f3454e2de41e",
  },
  {
    bit: 2,
    id: "hypesquad",
    get label() { return i18nText("ui.hypesquad_events"); },
    icon: "bf01d1073931f921909045f3a39fd264",
  },
  {
    bit: 3,
    id: "bug1",
    get label() { return i18nText("ui.bug_hunter"); },
    icon: "2717692c7dca7289b35297368a940dd0",
  },
  {
    bit: 14,
    id: "bug2",
    get label() { return i18nText("ui.bug_hunter_level_2"); },
    icon: "848f79194d4be5ff5f81505cbd0ce1e6",
  },
  {
    bit: 6,
    id: "bravery",
    get label() { return i18nText("ui.hypesquad_bravery"); },
    icon: "8a88d63823d8a71cd5e390baa45efa02",
  },
  {
    bit: 7,
    id: "brilliance",
    get label() { return i18nText("ui.hypesquad_brilliance"); },
    icon: "011940fd013da3f7fb926e4a1cd2e618",
  },
  {
    bit: 8,
    id: "balance",
    get label() { return i18nText("ui.hypesquad_balance"); },
    icon: "3aa41de486fa12454c3761e8e223442e",
  },
  {
    bit: 9,
    id: "early_supporter",
    get label() { return i18nText("ui.early_supporter"); },
    icon: "7060786766c9c840eb3019e725d2b358",
  },
  {
    bit: 17,
    id: "verified_dev",
    get label() { return i18nText("ui.early_verified_bot_developer"); },
    icon: "6df5892e0f35b051f8b61eace34f4967",
  },
  {
    bit: 18,
    id: "mod_alumni",
    get label() { return i18nText("ui.moderator_programs_alumni"); },
    icon: "fee1624003e2fee35cb398e125dc479b",
  },
  {
    bit: 22,
    id: "active_developer",
    get label() { return i18nText("ui.active_developer"); },
    icon: "6bdc42827a38498929a4920da12695d9",
  },
];

const FLAG_TO_PROFILE_IDS: Record<string, string[]> = {
  staff: ["staff"],
  partner: ["partner"],
  hypesquad: ["hypesquad"],
  bug1: ["bug_hunter_level_1"],
  bug2: ["bug_hunter_level_2"],
  bravery: ["hypesquad_house_1"],
  brilliance: ["hypesquad_house_2"],
  balance: ["hypesquad_house_3"],
  early_supporter: ["early_supporter"],
  verified_dev: ["verified_developer", "early_verified_bot_developer"],
  mod_alumni: ["certified_moderator", "moderator_programs_alumni"],
  active_developer: ["active_developer"],
  nitro: ["premium", "premium_tenure"],
};

/** Boost tenure ladder (1m → 24m). */
const BOOST_MILESTONES: readonly { minMonths: number; badge: BadgeDef }[] = [
  {
    minMonths: 24,
    badge: {
      id: "guild_booster_lvl9",
      get label() { return i18nText("ui.server_boosting_2_years"); },
      icon: "ec92202290b48d0879b7413d2dde3bab",
    },
  },
  {
    minMonths: 18,
    badge: {
      id: "guild_booster_lvl8",
      get label() { return i18nText("ui.server_boosting_1_year_6_months"); },
      icon: "7142225d31238f6387d9f09efaa02759",
    },
  },
  {
    minMonths: 15,
    badge: {
      id: "guild_booster_lvl7",
      get label() { return i18nText("ui.server_boosting_1_year_3_months"); },
      icon: "cb3ae83c15e970e8f3d410bc62cb8b99",
    },
  },
  {
    minMonths: 12,
    badge: {
      id: "guild_booster_lvl6",
      get label() { return i18nText("ui.server_boosting_1_year"); },
      icon: "991c9f39ee33d7537d9f408c3e53141e",
    },
  },
  {
    minMonths: 9,
    badge: {
      id: "guild_booster_lvl5",
      get label() { return i18nText("ui.server_boosting_9_months"); },
      icon: "996b3e870e8a22ce519b3a50e6bdd52f",
    },
  },
  {
    minMonths: 6,
    badge: {
      id: "guild_booster_lvl4",
      get label() { return i18nText("ui.server_boosting_6_months"); },
      icon: "df199d2050d3ed4ebf84d64ae83989f8",
    },
  },
  {
    minMonths: 3,
    badge: {
      id: "guild_booster_lvl3",
      get label() { return i18nText("ui.server_boosting_3_months"); },
      icon: "72bed924410c304dbe3d00a6e593ff59",
    },
  },
  {
    minMonths: 2,
    badge: {
      id: "guild_booster_lvl2",
      get label() { return i18nText("ui.server_boosting_2_months"); },
      icon: "0e4080d1d333bc7ad29ef6528b6f2fb7",
    },
  },
  {
    minMonths: 0,
    badge: {
      id: "guild_booster_lvl1",
      get label() { return i18nText("ui.server_boosting_1_month"); },
      icon: "51040c70d4f20a921ad6674ff86fc95c",
    },
  },
];

const NITRO_MILESTONES: readonly { minMonths: number; badge: BadgeDef }[] = [
  {
    minMonths: 72,
    badge: {
      id: "nitro_opal",
      get label() { return i18nText("ui.nitro_6_years_opal"); },
      icon: "5b154df19c53dce2af92c9b61e6be5e2",
    },
  },
  {
    minMonths: 60,
    badge: {
      id: "nitro_ruby",
      get label() { return i18nText("ui.nitro_5_years_ruby"); },
      icon: "cd5e2cfd9d7f27a8cdcd3e8a8d5dc9f4",
    },
  },
  {
    minMonths: 36,
    badge: {
      id: "nitro_emerald",
      get label() { return i18nText("ui.nitro_3_years_emerald"); },
      icon: "11e2d339068b55d3a506cff34d3780f3",
    },
  },
  {
    minMonths: 24,
    badge: {
      id: "nitro_diamond",
      get label() { return i18nText("ui.nitro_2_years_diamond"); },
      icon: "0d61871f72bb9a33a7ae568c1fb4f20a",
    },
  },
  {
    minMonths: 12,
    badge: {
      id: "nitro_platinum",
      get label() { return i18nText("ui.nitro_1_year_platinum"); },
      icon: "0334688279c8359120922938dcb1d6f8",
    },
  },
  {
    minMonths: 6,
    badge: {
      id: "nitro_gold",
      get label() { return i18nText("ui.nitro_6_months_gold"); },
      icon: "2895086c18d5531d499862e41d1155a6",
    },
  },
  {
    minMonths: 3,
    badge: {
      id: "nitro_silver",
      get label() { return i18nText("ui.nitro_3_months_silver"); },
      icon: "4514fab914bdbfb4ad2fa23df76121a6",
    },
  },
  {
    minMonths: 1,
    badge: {
      id: "nitro_bronze",
      get label() { return i18nText("ui.nitro_1_month_bronze"); },
      icon: "4f33c4a9c64ce221936bd256c356f91f",
    },
  },
  {
    minMonths: 0,
    badge: {
      id: "nitro",
      get label() { return i18nText("ui.nitro"); },
      icon: "2ba85e8026a8614b640c2837bcdfe21b",
    },
  },
];

const iconUrl = (hash: string) =>
  hash.startsWith("http")
    ? hash
    : `https://cdn.discordapp.com/badge-icons/${hash}.png`;

type ProfileBadge = {
  id?: string;
  description?: string;
  icon?: string;
  iconSrc?: string;
  fallbackIconSrc?: string;
};

/** Discord owns the profile cache; retain only the discovered DisplayProfile constructor. */
export function clearBadgeCache():void {displayCtor=undefined;displayLookupAt=0;}

function currentGuildId(): string | null {
  const store = window.Syncord?.common?.stores.SelectedGuildStore as
    | { getGuildId?: () => string | null | undefined }
    | undefined;
  const id = store?.getGuildId?.();
  return id || null;
}

type ProfileStore = {
  getUserProfile?: (id: string) =>
    | {
        badges?: ProfileBadge[];
        premiumType?: ChatUser["premiumType"];
        premiumSince?: ChatUser["premiumSince"];
        premiumGuildSince?: ChatUser["premiumGuildSince"];
      }
    | undefined;
  getGuildMemberProfile?: (
    userId: string,
    guildId: string | undefined,
  ) => { badges?: ProfileBadge[] } | null | undefined;
  addChangeListener?: (cb: () => void) => void;
  removeChangeListener?: (cb: () => void) => void;
};

/** Boot snapshot first, then the live webpack cache if that snapshot is empty. */
export function profileStore(): ProfileStore | undefined {
  const fromCommon = window.Syncord?.common?.stores.UserProfileStore as
    | ProfileStore
    | undefined;
  if (fromCommon?.getUserProfile) return fromCommon;
  return window.Syncord?.webpack.findByStoreName("UserProfileStore") as
    | ProfileStore
    | undefined;
}

function monthsSince(since: ChatUser["premiumSince"]): number | null {
  if (since == null || since === "") return null;
  const t =
    since instanceof Date
      ? since.getTime()
      : typeof since === "number"
        ? since
        : Date.parse(String(since));
  if (!Number.isFinite(t)) return null;
  const ms = Date.now() - t;
  if (ms < 0) return 0;
  return Math.floor(ms / (30.44 * 24 * 60 * 60 * 1000));
}

function pickMilestone(
  months: number,
  table: readonly { minMonths: number; badge: BadgeDef }[],
): BadgeDef {
  for (let i = 0; i < table.length; i++) {
    const row = table[i]!;
    if (months >= row.minMonths) return row.badge;
  }
  return table[table.length - 1]!.badge;
}

function nitroFromTenure(user: ChatUser): BadgeDef | null {
  if ((user.premiumType ?? user.premium_type ?? (user.premiumSince || user.premium_since ? 2 : 0)) <= 0) return null;
  return pickMilestone(monthsSince(user.premiumSince ?? user.premium_since) ?? 0, NITRO_MILESTONES);
}

function boostFromTenure(since: ChatUser["premiumGuildSince"]): BadgeDef | null {
  const months = monthsSince(since);
  if (months == null) return null;
  return pickMilestone(months, BOOST_MILESTONES);
}

function badgesFromFlags(user: ChatUser): BadgeDef[] {
  const flags = user.publicFlags ?? user.public_flags ?? user.flags ?? 0;
  const out: BadgeDef[] = [];
  for (let i = 0; i < FLAG_BADGES.length; i++) {
    const def = FLAG_BADGES[i]!;
    if (flags & (1 << def.bit)) {
      out.push({ id: def.id, label: def.label, icon: def.icon });
    }
  }
  const nitro = nitroFromTenure(user);
  if (nitro) out.push(nitro);
  const boost = boostFromTenure(user.premiumGuildSince ?? user.premium_guild_since);
  if (boost) out.push(boost);
  return out;
}

function badgeIcon(b: ProfileBadge): string | undefined {
  const rec = b as Record<string, unknown>;
  const candidates = [rec.icon, rec.iconSrc, rec.icon_hash, rec.fallbackIconSrc, rec.src];
  for (let i = 0; i < candidates.length; i++) {
    const raw = candidates[i];
    if (typeof raw === "string" && raw.length > 6) return normalizeIcon(raw);
    if (raw != null && typeof raw === "object") {
      const obj = raw as { hash?: unknown; src?: unknown; url?: unknown };
      const nested = obj.hash ?? obj.src ?? obj.url;
      if (typeof nested === "string" && nested.length > 6) return normalizeIcon(nested);
    }
  }
  return undefined;
}

function normalizeIcon(raw: string):string|undefined {
  if(/^[a-f0-9]{32}$/i.test(raw))return raw;
  try {
    const url=new URL(raw);
    if(url.protocol!=='https:'||url.hostname!=='cdn.discordapp.com'||url.username||url.password)return undefined;
    return url.pathname.match(/^\/badge-icons\/([a-f0-9]{32})(?:\.png|\.webp|\.svg)?$/i)?.[1];
  }catch{return undefined;}
}

function mapProfileBadges(badges: ProfileBadge[] | undefined): BadgeDef[] {
  if (!badges?.length) return [];
  const out: BadgeDef[] = [];
  const seen = new Set<string>();
  const hasTenure = badges.some((b) => b.id?.startsWith("premium_tenure"));

  for (let i = 0; i < badges.length; i++) {
    const b = badges[i]!;
    const icon = badgeIcon(b);
    if (!icon) continue;
    const id = b.id ?? icon;
    if (seen.has(id)) continue;
    if (id === "premium" && hasTenure) continue;
    seen.add(id);
    out.push({ id, label: b.description ?? id, icon });
  }
  return out;
}

function mergeLists(a: BadgeDef[], b: BadgeDef[]): BadgeDef[] {
  if (!a.length) return b.slice();
  if (!b.length) return a.slice();
  const seen = new Set(a.map((x) => x.id));
  const out = a.slice();
  for (let i = 0; i < b.length; i++) {
    const x = b[i]!;
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    out.push(x);
  }
  return out;
}

function profileCoversFlag(profileIds: Set<string>, flagId: string): boolean {
  if (profileIds.has(flagId)) return true;
  const alts = FLAG_TO_PROFILE_IDS[flagId];
  if (alts) {
    for (let i = 0; i < alts.length; i++) {
      const a = alts[i]!;
      if (profileIds.has(a)) return true;
      if (a === "premium_tenure") {
        for (const id of profileIds) {
          if (id.startsWith("premium_tenure") || id === "premium") return true;
        }
      }
    }
  }
  if (flagId.startsWith("nitro")) {
    for (const id of profileIds) {
      if (id === "premium" || id.startsWith("premium_tenure")) return true;
    }
  }
  if (flagId.startsWith("guild_booster") || flagId.startsWith("nitro_boost")) {
    for (const id of profileIds) {
      if (id.startsWith("guild_booster")) return true;
    }
  }
  return false;
}

function mergeWithFlags(profile: BadgeDef[], flags: BadgeDef[]): BadgeDef[] {
  if (!profile.length) return flags;
  if (!flags.length) return profile;
  const ids = new Set(profile.map((b) => b.id));
  const out = profile.slice();
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!;
    if (profileCoversFlag(ids, f.id)) continue;
    out.push(f);
    ids.add(f.id);
  }
  return out;
}

function ensureBoostPresent(
  list: BadgeDef[],
  premiumGuildSince: ChatUser["premiumGuildSince"],
): BadgeDef[] {
  if (list.some((b) => b.id.startsWith("guild_booster"))) return list;
  const boost = boostFromTenure(premiumGuildSince);
  if (!boost) return list;
  return [...list, boost];
}

function looksLikeBadge(value: unknown): value is ProfileBadge {
  if (value == null || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return typeof o.id === "string" && badgeIcon(o as ProfileBadge) != null;
}

type DisplayCtor = new (
  userProfile: unknown,
  guildProfile?: unknown,
) => { getBadges?: () => ProfileBadge[] };

let displayCtor: DisplayCtor | undefined;
let displayLookupAt = 0;

/** Discord's DisplayProfile class — getBadges() is what the popout renders. */
function displayProfileClass(): DisplayCtor | undefined {
  if (displayCtor) return displayCtor;
  const now = Date.now();
  if (now < displayLookupAt) return undefined;
  displayLookupAt = now + 2000;

  const found = window.Syncord?.webpack.find((mod) => {
    if (typeof mod !== "function") return false;
    const proto = (mod as { prototype?: { getBadges?: unknown; getBannerURL?: unknown } })
      .prototype;
    return (
      typeof proto?.getBadges === "function" &&
      typeof proto?.getBannerURL === "function"
    );
  });
  if (typeof found === "function") {
    displayCtor = found as DisplayCtor;
    return displayCtor;
  }

  const cache = window.Syncord?.webpack.getRequire()?.c;
  if (!cache) return undefined;
  for (const id of Object.keys(cache)) {
    const exp = cache[id]?.exports;
    const queue = [exp];
    const seen = new Set<unknown>();
    let steps = 0;
    while (queue.length && steps < 40) {
      const value = queue.pop();
      steps++;
      if (value == null || seen.has(value)) continue;
      seen.add(value);
      if (typeof value === "function") {
        const proto = (value as { prototype?: { getBadges?: unknown; getBannerURL?: unknown } })
          .prototype;
        if (
          typeof proto?.getBadges === "function" &&
          typeof proto?.getBannerURL === "function"
        ) {
          displayCtor = value as DisplayCtor;
          return displayCtor;
        }
        continue;
      }
      if (typeof value !== "object") continue;
      for (const key of Object.keys(value as object)) {
        try {
          queue.push((value as Record<string, unknown>)[key]);
        } catch {
          /* skip */
        }
      }
    }
  }
  return undefined;
}

function badgesOnRecord(value: unknown): ProfileBadge[] {
  if (value == null || typeof value !== "object") return [];
  const rec = value as Record<string, unknown>;
  const out: ProfileBadge[] = [];
  for (const key of ["badges", "guildBadges", "guild_badges"]) {
    const arr = rec[key];
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      if (looksLikeBadge(arr[i])) out.push(arr[i] as ProfileBadge);
    }
  }
  const getBadges = rec.getBadges;
  if (typeof getBadges === "function") {
    try {
      const list = (getBadges as () => unknown).call(value);
      if (Array.isArray(list)) {
        for (let i = 0; i < list.length; i++) {
          if (looksLikeBadge(list[i])) out.push(list[i] as ProfileBadge);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * Badges already held by Discord's profile store / DisplayProfile.
 * No network — same objects the profile popout uses.
 */
function badgesFromClient(userId: string, guildId: string | null): BadgeDef[] {
  const store = profileStore();
  const profile = store?.getUserProfile?.(userId);
  if (!profile) return [];

  const guild = guildId
    ? (store?.getGuildMemberProfile?.(userId, guildId) ?? undefined)
    : undefined;

  const raw: ProfileBadge[] = [
    ...badgesOnRecord(profile),
    ...badgesOnRecord(guild),
  ];

  const Ctor = displayProfileClass();
  if (Ctor) {
    try {
      const view = new Ctor(profile, guild ?? undefined);
      const list = view.getBadges?.() ?? [];
      for (let i = 0; i < list.length; i++) raw.push(list[i]!);
    } catch {
      /* constructor shape differs */
    }
  }
  return mapProfileBadges(raw);
}

export type BadgeResolve = {
  badges: BadgeDef[];
  /** True when the client profile store already has this user's badges. */
  complete: boolean;
};

export function badgesForUser(user: ChatUser, guildId = currentGuildId()): BadgeResolve {
  const profile = profileStore()?.getUserProfile?.(user.id);
  const fromClient = withoutOfficialProfileBadges(() => badgesFromClient(user.id, guildId));
  const enriched: ChatUser = {
    ...user,
    premiumType: user.premiumType ?? user.premium_type ?? profile?.premiumType,
    premiumSince: user.premiumSince ?? user.premium_since ?? profile?.premiumSince,
    premiumGuildSince: user.premiumGuildSince ?? user.premium_guild_since ?? profile?.premiumGuildSince,
  };
  const list = ensureBoostPresent(
    mergeWithFlags(fromClient, badgesFromFlags(enriched)),
    enriched.premiumGuildSince,
  );

  for(const badge of officialBadges(user.id))list.push({id:'syncord:'+badge.id,label:'Syncord · '+badge.name,icon:'',ecosystemArt:badge.art,ecosystemImage:badge.image});
  // Profile object is in memory — this is the popout's badge set.
  if (profile) {
    return { badges: list, complete: true };
  }

  return { badges: list, complete: false };
}

export function badgeImgHtml(def: BadgeDef, size: number): string {
  if(def.ecosystemArt){const pixels=Number.isFinite(size)?Math.max(8,Math.min(32,size)):14;const label=def.label.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));return `<span class="dion-badge" title="${label}" role="img" aria-label="${label}" style="display:inline-flex;width:${pixels}px;height:${pixels}px">${ecosystemArt(def.ecosystemArt,pixels,def.ecosystemImage)}</span>`;}
  const icon=normalizeIcon(def.icon);if(!icon)return '';
  const escape=(value:string):string=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
  const pixels=Number.isFinite(size)?Math.max(8,Math.min(32,size)):14;
  return `<img class="dion-badge" src="${iconUrl(icon)}" alt="" title="${escape(def.label)}" width="${pixels}" height="${pixels}" loading="lazy" decoding="async" draggable="false" />`;
}

/** Unlock matching usernames, including rows that previously had no badge wrapper. */
export function unlockUserDecorations(userId: string): void {
  document
    .querySelectorAll(`[data-dion-badge-user="${CSS.escape(userId)}"]`)
    .forEach((node) => {
      node.removeAttribute("data-dion-badges");
      node
        .closest(
          'li[id^="chat-messages-"], [id^="chat-messages-"], [class*="messageListItem_"]',
        )
        ?.removeAttribute("data-dion-badge-msg");
    });
}
