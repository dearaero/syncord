import { canonicalMessage as i18nText } from "../../i18n";
import { isDiscordRestApi } from "../../webpack/common/rest";
import { validId, type CleanupPort, type CleanupTarget, type RestResponse } from "./engine";
type Store = Record<string, unknown>;
type Channel = { id: string; type: number; name?: string; guild_id?: string; guildId?: string; recipients?: string[] };
type Rest = { post(options: Record<string, unknown>): Promise<RestResponse>; get(options: Record<string, unknown>): Promise<RestResponse>; del(options: Record<string, unknown>): Promise<RestResponse> };
function store<T>(name: string): T | undefined {
  const common = window.Syncord?.common?.stores as unknown as Store | undefined;
  return (common?.[name] ?? window.Syncord?.webpack?.findByStoreName?.(name)) as T | undefined;
}
function userId(): string | undefined { return store<{getCurrentUser(): {id?:string}|undefined}>("UserStore")?.getCurrentUser?.()?.id; }
function channel(id: string): Channel | undefined { return store<{getChannel(id:string):Channel|undefined}>("ChannelStore")?.getChannel?.(id); }
export function selectedTarget(): CleanupTarget | undefined {
  // SelectedChannelStore may retain the last visited channel on Friends/Shop.
  // The visible Discord route, when available, is the authority for this action.
  const route = window.location?.protocol === "https:"
    ? window.location.pathname.match(/^\/channels\/(?:@me|[1-9]\d*)\/([1-9]\d*)(?:\/|$)/) : undefined;
  const id = window.location?.protocol === "https:" ? route?.[1]
    : store<{getChannelId():string|undefined}>("SelectedChannelStore")?.getChannelId?.();
  const user = userId(); if (!validId(id) || !validId(user)) return;
  const c = channel(id); if (!c || ![0,1,3,5,10,11,12].includes(c.type)) return;
  let name = c.name;
  if (!name && c.type === 1 && c.recipients?.[0]) {
    const peer = store<{getUser(id:string):{globalName?:string;global_name?:string;username?:string}|undefined}>("UserStore")?.getUser?.(c.recipients[0]);
    name = peer?.globalName ?? peer?.global_name ?? peer?.username;
  }
  return {channelId:id,userId:user,name:name || (c.type===3?i18nText("ui.group_dm"):c.type===1?i18nText("ui.direct_message_cd3e160"):i18nText("ui.channel_value", {v0: id}))};
}
function permissionBits(c: Channel): bigint | undefined {
  // Use unpatched permission bits: Hidden Channels can override can().
  const raw = store<{computePermissions(c:Channel):unknown}>("PermissionStore")?.computePermissions?.(c);
  return typeof raw === "bigint" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? BigInt(raw)
    : typeof raw === "number" && Number.isSafeInteger(raw) ? BigInt(raw) : undefined;
}
function canBulk(target: CleanupTarget): boolean {
  if(userId()!==target.userId)return false;
  const c=channel(target.channelId);
  if(!c||(!c.guild_id&&!c.guildId))return false;
  const bits=permissionBits(c);
  return bits!==undefined&&((bits&8n)!==0n||(bits&(1n<<13n))!==0n);
}
export function assertTarget(target: CleanupTarget): void {
  if (userId() !== target.userId) throw new Error("Your Discord account changed. Cleanup stopped.");
  const c = channel(target.channelId);
  if (!c || ![0,1,3,5,10,11,12].includes(c.type)) throw new Error("This chat is unavailable.");
  if (!c.guild_id && !c.guildId) return;
  const bits = permissionBits(c);
  const required = (1n<<10n)|(1n<<16n);
  if (bits === undefined || ((bits & 8n) === 0n && (bits & required) !== required)) throw new Error("You need View Channel and Read Message History in this channel.");
}
export function discordPort(log: {warn(...args:unknown[]):void}): CleanupPort {
  const common = window.Syncord?.common;
  // Recheck the live cache on each attempt: the common snapshot may predate
  // REST initialization, and a non-null but incompatible entry is not usable.
  const preferred = common?.utils?.RestAPI;
  const candidate = isDiscordRestApi(preferred) ? preferred : window.Syncord?.webpack?.find?.(isDiscordRestApi);
  const rest = isDiscordRestApi(candidate) ? candidate as unknown as Rest : undefined;
  if (typeof rest?.get !== "function" || typeof rest.del !== "function") throw new Error("Discord's message API is not ready. Open a chat and try again.");
  const dispatcher = (common?.flux?.FluxDispatcher ?? window.Syncord?.webpack?.findByProps?.("dispatch","subscribe")) as {dispatch?(event:unknown):unknown}|undefined;
  return {
    assertTarget,
    canBulk,
    bulk(channelId, ids) {
      if(!validId(channelId)||ids.length<2||ids.length>100||ids.some(id=>!validId(id))||new Set(ids).size!==ids.length)throw new Error("Invalid bulk message selection.");
      if(!canBulk({channelId,userId:userId()??"",name:""}))return Promise.resolve({status:403});
      return rest.post({url:`/channels/${channelId}/messages/bulk-delete`,body:{messages:ids},
        retries:0,oldFormErrors:true,rejectWithError:true,failImmediatelyWhenRateLimited:true});
    },
    request(method, channelId, id) {
      if (!validId(channelId) || !validId(id)) throw new Error("Invalid message reference.");
      // Native REST owns authentication and its shared rate-limit queue. Avoid the
      // native deleteMessage action: some builds return before deletion finishes.
      const options = {url:`/channels/${channelId}/messages${method === "del"?`/${id}`:""}`,
        ...(method === "get"?{query:{limit:100,before:id}}:{}), retries:0, oldFormErrors:true, rejectWithError:true, failImmediatelyWhenRateLimited:true};
      return method === "get" ? rest.get(options) : rest.del(options);
    },
    deleted(channelId,id) {
      // Match Discord's own action only after a successful server deletion.
      try { void Promise.resolve(dispatcher?.dispatch?.({type:"MESSAGE_DELETE",channelId,id})).catch(error=>log.warn("Message cache update failed",error)); }
      catch (error) { log.warn("Message cache update failed",error); }
    },
  };
}
