import { t as i18nText } from "../../i18n";
import { definePluginSettings } from '../../api/plugin/settingsDef';
export const IMAGE_ZOOM_ID = 'image-zoom';
export const IMAGE_ZOOM_CHANGED = 'Syncord-image-zoom-settings';
export const imageZoomSettings = definePluginSettings({
  hover: {type:'boolean',default:true,get title() { return i18nText("ui.inspect_images_on_hover"); },get description() { return i18nText("ui.zoom_directly_inside_message_images_without_opening_a_separate_preview"); }},
  avatars: {type:'boolean',default:false,get title() { return i18nText("ui.also_inspect_avatars"); },get description() { return i18nText("ui.include_discord_user_and_server_avatars_emoji_badges_and_interface_ico"); }},
  highResolution: {type:'boolean',default:true,get title() { return i18nText("ui.original_resolution"); },get description() { return i18nText("ui.request_the_original_attachment_or_the_largest_available_discord_image"); }},
  hoverDelay: {type:'number',default:0,get title() { return i18nText("ui.hover_delay_ms"); },get description() { return i18nText("ui.zero_activates_immediately_increase_this_to_avoid_accidental_activatio"); }},
  closeDelay: {type:'number',default:180,get title() { return i18nText("ui.close_delay_ms"); },get description() { return i18nText("ui.delay_before_restoring_the_native_image_after_the_pointer_leaves_it"); }},
  smooth: {type:'boolean',default:true,get title() { return i18nText("ui.smooth_zoom_and_pan"); },get description() { return i18nText("ui.animate_view_changes_respects_the_operating_system_s_reduced_motion_pr"); }},
  pan: {type:'boolean',default:true,get title() { return i18nText("ui.pan_with_pointer_movement"); },get description() { return i18nText("ui.move_across_the_existing_image_to_inspect_zoomed_details"); }},
  zoomEnabled: {type:'boolean',default:true,get title() { return i18nText("ui.wheel_zoom"); },get description() { return i18nText("ui.use_the_zoom_modifier_with_the_mouse_wheel"); }},
  zoomModifier: {type:'string',default:'alt',get title() { return i18nText("ui.zoom_modifier"); },get description() { return i18nText("ui.modifier_held_while_scrolling_to_zoom"); }},
  zoomStep: {type:'number',default:0.2,get title() { return i18nText("ui.zoom_sensitivity"); },get description() { return i18nText("ui.larger_values_zoom_faster"); }},
  maxZoom: {type:'number',default:16,get title() { return i18nText("ui.maximum_source_pixel_zoom"); },get description() { return i18nText("ui.16_means_each_original_pixel_can_fill_a_16_16_area_the_inline_1_1_butt"); }},
  resizeEnabled: {type:'boolean',default:true,get title() { return i18nText("ui.wheel_image_resizing"); },get description() { return i18nText("ui.temporarily_resize_the_message_image_using_its_modifier_and_the_wheel_"); }},
  resizeModifier: {type:'string',default:'shift',get title() { return i18nText("ui.resize_modifier"); },get description() { return i18nText("ui.choose_a_different_modifier_from_wheel_zoom_zoom_wins_if_both_match"); }},
  resizeStep: {type:'number',default:40,get title() { return i18nText("ui.resize_step_px"); },get description() { return i18nText("ui.amount_added_to_or_removed_from_the_image_width_per_wheel_step"); }},
  pixelPerfect: {type:'boolean',default:false,get title() { return i18nText("ui.pixel_perfect_by_default"); },get description() { return i18nText("ui.use_sharp_nearest_neighbor_scaling_instead_of_smoothing_pixels"); }},
  gifControls: {type:'boolean',default:true,get title() { return i18nText("ui.gif_frame_controls"); },get description() { return i18nText("ui.decode_gifs_locally_for_pause_resume_and_exact_frame_stepping_no_frame"); }},
  gifAutoplay: {type:'boolean',default:true,get title() { return i18nText("ui.autoplay_gifs"); },get description() { return i18nText("ui.start_animations_automatically_turn_off_to_inspect_their_first_frame"); }},
  gifLoop: {type:'boolean',default:true,get title() { return i18nText("ui.loop_gif_playback"); },get description() { return i18nText("ui.repeat_playback_after_the_final_frame"); }},
  gifSpeed: {type:'number',default:1,get title() { return i18nText("ui.gif_playback_speed"); },description:'1 is normal speed; individual GIF frame durations are preserved.'},
  gifMaxMB: {type:'number',default:32,get title() { return i18nText("ui.gif_file_budget_mb"); },get description() { return i18nText("ui.larger_gifs_use_the_native_animated_image_without_frame_controls"); }},
  gifMaxMP: {type:'number',default:16,get title() { return i18nText("ui.gif_frame_budget_megapixels"); },get description() { return i18nText("ui.limits_each_decoded_frame_s_dimensions_independently_of_the_compressed"); }},
  protectTyping: {type:'boolean',default:true,get title() { return i18nText("ui.protect_text_inputs"); },get description() { return i18nText("ui.leave_shortcuts_alone_while_a_message_or_settings_field_has_focus_focu"); }},
  pauseKey: {type:'string',default:"Space",get title() { return i18nText("ui.pause_resume_key"); },get description() { return i18nText("ui.key_name_or_leave_empty_to_disable_this_shortcut"); }},
  previousKey: {type:'string',default:'ArrowLeft,ArrowUp',get title() { return i18nText("ui.previous_frame_keys"); },get description() { return i18nText("ui.comma_separated_key_names_stepping_pauses_playback"); }},
  nextKey: {type:'string',default:'ArrowRight,ArrowDown',get title() { return i18nText("ui.next_frame_keys"); },get description() { return i18nText("ui.comma_separated_key_names_stepping_pauses_playback"); }},
  pixelKey: {type:'string',default:'P',get title() { return i18nText("ui.pixel_perfect_key"); },get description() { return i18nText("ui.toggle_sharp_pixel_rendering_for_this_image"); }},
  resetKey: {type:'string',default:'R',get title() { return i18nText("ui.reset_zoom_key"); },get description() { return i18nText("ui.fit_the_full_image_and_center_the_view"); }},
  closeKey: {type:'string',default:"Escape",get title() { return i18nText("ui.end_inspection_key"); },get description() { return i18nText("ui.restore_the_native_message_image"); }},
});
export type ImageZoomOptions = ReturnType<ReturnType<typeof imageZoomSettings.bind>['snapshot']>;
const ranges: Partial<Record<keyof ImageZoomOptions, readonly [number,number]>> = {
  hoverDelay:[0,3000],closeDelay:[0,2000],zoomStep:[0.05,1],maxZoom:[1,64],resizeStep:[10,160],gifSpeed:[0.25,4],gifMaxMB:[1,64],gifMaxMP:[1,32],
};
export function normalizeOptions(raw: Partial<Record<keyof ImageZoomOptions,unknown>> = {}): ImageZoomOptions {
  const out = {} as ImageZoomOptions;
  for (const key of imageZoomSettings.keys) {
    const def = imageZoomSettings.schema[key], value = raw[key];
    let next: unknown = def.default;
    if (def.type === 'boolean' && typeof value === 'boolean') next = value;
    if (def.type === 'string' && typeof value === 'string') next = value.slice(0,80).trim();
    const range = ranges[key];
    if (range && typeof value === 'number' && Number.isFinite(value)) next = Math.min(range[1],Math.max(range[0],value));
    if ((key === 'zoomModifier' || key === 'resizeModifier') && !['alt','shift','ctrl','meta','none'].includes(String(next))) next = def.default;
    (out as Record<string,unknown>)[key] = next;
  }
  return out;
}
export function imageZoomOptions(): ImageZoomOptions { return normalizeOptions(imageZoomSettings.bind(IMAGE_ZOOM_ID).snapshot()); }
export const numericRange = (key: keyof ImageZoomOptions): readonly [number,number] | undefined => ranges[key];
