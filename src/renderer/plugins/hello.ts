import { t as i18nText } from "../i18n";
import { definePlugin } from "../api/plugin";

/** Built-in smoke plugin — validates context + common stores. */
export const HelloPlugin = definePlugin({
  id: "hello",
  name: i18nText("ui.hello"),
  description: "Logs a greeting using UserStore; safe smoke test.",
  author: i18nText("ui.syncord"),
  enabledByDefault: true,

  /**
   * Least privilege (Phase 9). Reads the user store and injects a local
   * stylesheet. No network, no patch, no clipboard, no native capabilities.
   */
  permissions: {
    discordStores: ["user"],
    media: true,
  },

  start(ctx) {
    const userStore = window.Syncord?.common?.stores.UserStore as
      | { getCurrentUser?: () => { username?: string } | null }
      | undefined;
    const user = userStore?.getCurrentUser?.();

    ctx.log.info(
      user?.username
        ? `Hello — logged in as ${user.username}`
        : "Hello — UserStore ready (no user yet)",
    );

    // Example: plugin-scoped CSS cleaned up automatically on disable/stop.
    ctx.css.inject(`
      /* Syncord-hello: no visual change, marker only */
      html[data-Syncord-hello] {}
    `);
    document.documentElement.setAttribute("data-Syncord-hello", "1");
    ctx.disposable(() => {
      document.documentElement.removeAttribute("data-Syncord-hello");
    });
  },
});
