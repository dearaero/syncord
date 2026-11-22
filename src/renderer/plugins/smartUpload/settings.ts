import { t as i18nText } from "../../i18n";
import {definePluginSettings} from '../../api/plugin/settingsDef';
import {options} from './model';
export const SMART_ID='smart-upload';
export const smartSettings=definePluginSettings({
 images:{type:'boolean',default:true,get title() { return i18nText("ui.images"); },get description() { return i18nText("ui.optimize_oversized_static_jpeg_png_and_webp_images"); }},
 videos:{type:'boolean',default:true,get title() { return i18nText("ui.videos"); },get description() { return i18nText("ui.resize_and_re_encode_oversized_videos_locally_about_one_playback_durat"); }},
 audio:{type:'boolean',default:true,get title() { return i18nText("ui.audio"); },get description() { return i18nText("ui.re_encode_oversized_audio_locally_as_opus_in_webm"); }},
 maxHeight:{type:'number',default:720,get title() { return i18nText("ui.maximum_video_edge"); },get description() { return i18nText("ui.lower_resolutions_use_less_processing_power"); }},
});
export function smartOptions(){return options(smartSettings.bind(SMART_ID).snapshot());}
