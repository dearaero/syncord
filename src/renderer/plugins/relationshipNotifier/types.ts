import { t as i18nText } from "../../i18n";
export const RN_ID='relationship-notifier';
export const RN_CHANGED='Syncord-relationship-notifier-changed';
export const RN_STATUS='Syncord-relationship-notifier-status';
export const RN_DATA='Syncord-relationship-notifier-data';
export const validId=(value:unknown):value is string=>typeof value==='string'&&/^\d{17,20}$/.test(value);
export const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
export const text=(value:unknown,max=160):string=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,max):'';
export type Person={id:string;username:string;name:string};
export type Relationship=Person&{type:number};
export type Group={id:string;name:string;members:Record<string,Person>;membersComplete:boolean};
export type Guild={id:string;name:string;unavailable?:boolean};
export type Snapshot={accountId:string;revision:number;seenAt:number;historyCount:number;backupAt?:number;ready:{relationships:boolean;groups:boolean;guilds:boolean};relationships:Record<string,Relationship>;groups:Record<string,Group>;guilds:Record<string,Guild>};
export const KINDS=['friend-added','friend-removed','request-received','incoming-request-ended','outgoing-request-ended','group-removed','server-removed','group-member-added','group-member-removed'] as const;
export type Kind=typeof KINDS[number];
export type Cause='local'|'unknown';
export type Entry={id?:number;accountId:string;kind:Kind;subjectId:string;name:string;user?:Person;context?:string;detectedAt:number;previousSeenAt?:number;offline:boolean;cause:Cause};
export type Backup=Person&{accountId:string;firstSeenAt:number;lastSeenAt:number;isFriend:boolean};
export type Config={friends:boolean;requests:boolean;groups:boolean;servers:boolean;members:boolean;history:boolean;backup:boolean;offline:boolean;notifyFriendAdded:boolean;notifyFriendRemoved:boolean;notifyRequestReceived:boolean;notifyIncomingRequestEnded:boolean;notifyOutgoingRequestEnded:boolean;notifyGroupRemoved:boolean;notifyServerRemoved:boolean;notifyMemberAdded:boolean;notifyMemberRemoved:boolean;notifySelf:boolean;notifyOffline:boolean;duration:number};
export type Input={relationships?:Record<string,Relationship>;groups?:Record<string,Group>;guilds?:Record<string,Guild>;complete?:{relationships?:boolean;groups?:boolean;guilds?:boolean}};
export type Delta={scope:'relationship';id:string;value?:Relationship}|{scope:'group';id:string;value?:Group}|{scope:'guild';id:string;value?:Guild}|{scope:'member';id:string;user:Person;added:boolean};
export type Change={snapshot:Snapshot;entries:Entry[];backup:Backup[]};
export function emptySnapshot(accountId:string):Snapshot{return{accountId,revision:0,seenAt:0,historyCount:0,ready:{relationships:false,groups:false,guilds:false},relationships:{},groups:{},guilds:{}};}
export function describe(entry:Entry):string {
 const name=entry.user?.name||entry.name;
 switch(entry.kind){
  case'friend-added':return i18nText("ui.you_and_value_are_now_friends", {v0: name});
  case'friend-removed':return entry.cause==='local'?i18nText("ui.your_account_ended_the_friendship_with_value", {v0: name}):i18nText("ui.your_friendship_with_value_ended", {v0: name});
  case'request-received':return i18nText("ui.value_sent_you_a_friend_request", {v0: name});
  case'incoming-request-ended':return i18nText("ui.the_incoming_friend_request_from_value_is_no_longer_pending", {v0: name});
  case'outgoing-request-ended':return i18nText("ui.your_friend_request_to_value_is_no_longer_pending", {v0: name});
  case'group-removed':return entry.cause==='local'?i18nText("ui.you_left_value", {v0: entry.name}):i18nText("ui.you_no_longer_have_access_to_group_dm_value", {v0: entry.name});
  case'server-removed':return entry.cause==='local'?i18nText("ui.you_left_value", {v0: entry.name}):i18nText("ui.you_no_longer_have_access_to_server_value", {v0: entry.name});
  case'group-member-added':return i18nText("ui.value_joined_value", {v0: name, v1: entry.context||i18nText("ui.a_group_dm")});
  case'group-member-removed':return i18nText("ui.value_is_no_longer_in_value", {v0: name, v1: entry.context||i18nText("ui.a_group_dm")});
 }
}
export const kindLabel:Record<Kind,string>={get 'friend-added'(){return i18nText("ui.friend_added");},get 'friend-removed'(){return i18nText("ui.friendship_ended");},get 'request-received'(){return i18nText("ui.friend_request");},get 'incoming-request-ended'(){return i18nText("ui.incoming_request_ended");},get 'outgoing-request-ended'(){return i18nText("ui.outgoing_request_ended");},get 'group-removed'(){return i18nText("ui.group_access_ended");},get 'server-removed'(){return i18nText("ui.server_access_ended");},get 'group-member-added'(){return i18nText("ui.group_member_joined");},get 'group-member-removed'(){return i18nText("ui.group_member_left");}};
export function notificationEnabled(row:Entry,cfg:Config):boolean {
 if(row.cause==='local'&&!cfg.notifySelf)return false;
 if(row.offline&&!cfg.notifyOffline)return false;
 const switches:Record<Kind,keyof Config>={'friend-added':'notifyFriendAdded','friend-removed':'notifyFriendRemoved','request-received':'notifyRequestReceived','incoming-request-ended':'notifyIncomingRequestEnded','outgoing-request-ended':'notifyOutgoingRequestEnded','group-removed':'notifyGroupRemoved','server-removed':'notifyServerRemoved','group-member-added':'notifyMemberAdded','group-member-removed':'notifyMemberRemoved'};
 return cfg[switches[row.kind]]===true;
}
