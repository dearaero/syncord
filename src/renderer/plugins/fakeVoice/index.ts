import { t as i18nText } from "../../i18n";
import { definePlugin } from "../../api/plugin";
import { definePluginSettings } from "../../api/plugin/settingsDef";
import { attachGateway } from "./gateway";
import { installFakeVoiceUi } from "./ui";

const settings = definePluginSettings({
  active: {
    type: "boolean",
    default: false,
    get title() { return i18nText("ui.active"); },
    get description() { return i18nText("ui.others_see_the_fake_mute_deafen_state"); },
  },
  fakeMute: {
    type: "boolean",
    default: true,
    get title() { return i18nText("ui.appear_muted"); },
  },
  fakeDeafen: {
    type: "boolean",
    default: true,
    get title() { return i18nText("ui.appear_deafened"); },
  },
});

/**
 * Appear muted or deafened to everyone else. Local audio is untouched.
 * The account button and its menu are Discord's own components.
 */
export const FakeVoicePlugin = definePlugin({
  id: "fake-voice",
  name: i18nText("ui.fake_voice"),
  get description() { return i18nText("ui.appear_muted_or_deafened_in_voice_while_you_still_hear_and_speak_butto"); },
  author: i18nText("ui.syncord"),
  enabledByDefault: true,

  /**
   * Voice state and the voice gateway. `webpackPatch` is declared because the
   * plugin rewrites Discord's voice state dispatch.
   *
   * Note there is deliberately **no** network permission, even though the plugin
   * talks to a voice gateway: that traffic is Discord's own session, opened by
   * Discord's own code. A plugin that needed to reach a *third-party* host would
   * need an explicit host here, and the broker would log every request.
   */
  permissions: {
    webpackPatch: true,
    media: true,
    discordStores: ["voice-state", "user"],
    discordActions: ["voice-mute", "voice-deafen"],
  },

  start(ctx) {
    const cfg = settings.bind(ctx.plugin.id);
    const gateway = attachGateway(ctx, () => ({
      active: cfg.store.active === true,
      mute: cfg.store.fakeMute !== false,
      deaf: cfg.store.fakeDeafen !== false,
    }));

    const removeUi = installFakeVoiceUi(ctx, {
      read: () => ({
        active: cfg.store.active === true,
        mute: cfg.store.fakeMute !== false,
        deaf: cfg.store.fakeDeafen !== false,
      }),
      toggleActive: () => {
        const next = cfg.store.active !== true;
        cfg.store.active = next;
        if (next) gateway.pushFake();
        else gateway.pushReal();
      },
      setMute: (value) => {
        cfg.store.fakeMute = value;
        if (cfg.store.active === true) gateway.pushFake();
      },
      setDeaf: (value) => {
        cfg.store.fakeDeafen = value;
        if (cfg.store.active === true) gateway.pushFake();
      },
    });

    if (cfg.store.active === true) gateway.pushFake();

    ctx.disposable(() => {
      if (cfg.store.active === true) {
        cfg.store.active = false;
        gateway.pushReal();
      }
      removeUi();
    });
  },
});

export { settings as fakeVoiceSettings };
