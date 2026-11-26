import { definePlugin } from "../../api/plugin";
import { canonicalMessage, t } from "../../i18n";
import { clientThemeFactoryReport, nativeThemeAccess, setClientThemesUnlocked } from "./factory";

type UserStore = { getCurrentUser?: () => unknown; emitChange?: () => void; addChangeListener?: (fn: () => void) => void; removeChangeListener?: (fn: () => void) => void };
type SyncStore = { shouldSync?: (section: string) => boolean };
type AppearanceActions = { setShouldSyncAppearanceSettings?: (sync: boolean) => unknown };

const webpack = () => window.Syncord?.webpack;

export const ClientThemesPlugin = definePlugin({
  id: "client-themes",
  name: canonicalMessage("clientthemes.name"),
  get description() { return t("clientthemes.description"); },
  enabledByDefault: false,

  /** No ctx.patch: the perks factory adapter is installed at boot and stays native while disabled. */
  permissions: { discordStores: ["UserStore", "SelectivelySyncedUserSettingsStore"], discordActions: ["user-settings"] },

  start(ctx) {
    const report = clientThemeFactoryReport();
    if (report !== "installed") ctx.log.warn(`theme gate not adapted (${report}); restart Discord`);
    const users = webpack()?.findByStoreName("UserStore") as UserStore | undefined;
    const actions = webpack()?.findByProps("setShouldSyncAppearanceSettings") as AppearanceActions | undefined;
    // ClientThemesBackgroundStore re-checks the gate on every UserStore change.
    const refreshGate = (): void => { try { users?.emitChange?.(); } catch { /* next change refreshes it */ } };
    const setSync = (sync: boolean): void => {
      try {
        void Promise.resolve(actions?.setShouldSyncAppearanceSettings?.(sync)).catch((err: unknown) => ctx.log.warn("appearance sync change failed", err));
      } catch (err) { ctx.log.warn("appearance sync change failed", err); }
    };

    /**
     * With appearance sync on, Discord stores the theme only in the server-side
     * settings proto, and the server drops a non-Nitro gradient a moment later.
     * Keep appearance on this device instead, via Discord's own toggle action.
     */
    let checked = false;
    const keepThemeLocal = (): void => {
      if (checked) return;
      const user = users?.getCurrentUser?.();
      if (!user) return;
      checked = true;
      users?.removeChangeListener?.(keepThemeLocal);
      if (nativeThemeAccess(user) !== false) return; // real Nitro syncs fine; unknown means leave it alone
      const sync = webpack()?.findByStoreName("SelectivelySyncedUserSettingsStore") as SyncStore | undefined;
      if (sync?.shouldSync?.("appearance") === false) return;
      if (typeof actions?.setShouldSyncAppearanceSettings !== "function") { ctx.log.warn("appearance sync toggle not found; turn it off manually"); return; }
      setSync(false);
      ctx.settings.set("restoreSync", true);
    };

    setClientThemesUnlocked(true);
    users?.addChangeListener?.(keepThemeLocal);
    keepThemeLocal();
    refreshGate();
    ctx.disposable(() => {
      users?.removeChangeListener?.(keepThemeLocal);
      setClientThemesUnlocked(false);
      refreshGate();
      // Undo only what this plugin turned off.
      if (ctx.settings.get("restoreSync", false)) {
        ctx.settings.set("restoreSync", false);
        setSync(true);
      }
    });
  },
});
