import { t as i18nText } from "../../i18n";
import {definePluginSettings} from '../../api/plugin/settingsDef';
import {RN_ID,type Config} from './types';
export const relationshipSettings=definePluginSettings({
 friends:{type:'boolean',default:true,get title() { return i18nText("ui.friendship_changes"); }},requests:{type:'boolean',default:true,get title() { return i18nText("ui.friend_request_changes"); }},
 groups:{type:'boolean',default:true,get title() { return i18nText("ui.group_dm_access_changes"); }},servers:{type:'boolean',default:true,get title() { return i18nText("ui.server_access_changes"); }},
 members:{type:'boolean',default:false,get title() { return i18nText("ui.group_member_joins_and_leaves"); }},
 history:{type:'boolean',default:true,get title() { return i18nText("ui.save_local_history"); }},backup:{type:'boolean',default:true,get title() { return i18nText("ui.maintain_friend_list_backup"); }},
 offline:{type:'boolean',default:true,get title() { return i18nText("ui.detect_changes_since_the_previous_session"); }},
 notifyFriendAdded:{type:'boolean',default:true,get title() { return i18nText("ui.friend_added"); }},notifyFriendRemoved:{type:'boolean',default:true,get title() { return i18nText("ui.friendship_ended"); }},
 notifyRequestReceived:{type:'boolean',default:true,get title() { return i18nText("ui.incoming_friend_request_received"); }},notifyIncomingRequestEnded:{type:'boolean',default:true,get title() { return i18nText("ui.incoming_friend_request_ended"); }},notifyOutgoingRequestEnded:{type:'boolean',default:true,get title() { return i18nText("ui.outgoing_friend_request_ended"); }},
 notifyGroupRemoved:{type:'boolean',default:true,get title() { return i18nText("ui.group_dm_access_ended"); }},notifyServerRemoved:{type:'boolean',default:true,get title() { return i18nText("ui.server_access_ended"); }},
 notifyMemberAdded:{type:'boolean',default:false,get title() { return i18nText("ui.group_member_joined"); }},notifyMemberRemoved:{type:'boolean',default:false,get title() { return i18nText("ui.group_member_left"); }},notifySelf:{type:'boolean',default:false,get title() { return i18nText("ui.also_notify_about_your_own_actions"); }},
 notifyOffline:{type:'boolean',default:true,get title() { return i18nText("ui.notify_about_offline_changes"); }},duration:{type:'number',default:10,get title() { return i18nText("ui.notification_duration_seconds"); }},
});
export function config():Config {
 const raw=relationshipSettings.bind(RN_ID).snapshot(),out={} as Config;
 for(const key of relationshipSettings.keys){const def=relationshipSettings.schema[key];(out as unknown as Record<string,unknown>)[key]=typeof raw[key]===def.type?raw[key]:def.default;}
 out.duration=Number.isFinite(out.duration)?Math.min(60,Math.max(4,out.duration)):10;return out;
}
