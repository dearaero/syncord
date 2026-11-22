import { t as i18nText } from "../../i18n";
import {definePluginSettings} from '../../api/plugin/settingsDef';
export const PLATFORM_ID='platform-indicators';
export const PLATFORM_SETTINGS_EVENT='Syncord-platform-indicators-settings';
export const platformSettings=definePluginSettings({
  messages:{type:'boolean',default:true,get title() { return i18nText("ui.chat_messages"); },get description() { return i18nText("ui.show_platform_icons_beside_message_authors"); }},
  memberList:{type:'boolean',default:true,get title() { return i18nText("ui.member_list"); },get description() { return i18nText("ui.show_platform_icons_beside_names_in_the_server_member_list"); }},
  dms:{type:'boolean',default:true,get title() { return i18nText("ui.direct_messages_95e6670"); },get description() { return i18nText("ui.show_platform_icons_beside_one_to_one_conversations_in_the_dm_sidebar"); }},
  friends:{type:'boolean',default:true,get title() { return i18nText("ui.friends_list"); },get description() { return i18nText("ui.show_platform_icons_beside_names_on_the_friends_page"); }},
  profiles:{type:'boolean',default:true,get title() { return i18nText("ui.profiles"); },get description() { return i18nText("ui.show_platform_icons_on_loaded_profile_cards_and_popouts"); }},
  activityPlatforms:{type:'boolean',default:true,get title() { return i18nText("ui.console_and_vr_activities"); },get description() { return i18nText("ui.also_show_explicitly_reported_xbox_playstation_and_meta_quest_activiti"); }},
});
export type PlatformOptions=ReturnType<ReturnType<typeof platformSettings.bind>['snapshot']>;
