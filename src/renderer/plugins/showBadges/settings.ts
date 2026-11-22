import { t as i18nText } from "../../i18n";
import {definePluginSettings} from "../../api/plugin/settingsDef";
export const SHOW_BADGES_SETTINGS_EVENT="Syncord-show-badges-settings";
export const showBadgesSettings=definePluginSettings({
  size:{type:"number",default:14,get title() { return i18nText("ui.badge_size_px"); },get description() { return i18nText("ui.width_height_of_badge_icons_next_to_usernames"); }},
  memberList:{type:"boolean",default:false,get title() { return i18nText("ui.show_badges_in_member_list"); },get description() { return i18nText("ui.also_show_badges_beside_names_in_the_right_hand_member_list"); }},
});
