export const NATIVE_PICKER_CSS = `
  /* Native Expression Picker owns tabs, search, results and dismissal. */
  .dion-mc-native-picker-host, .dion-mc-native-picker-host * { box-sizing: border-box; }
  .dion-mc-native-picker-host { position: absolute; inset: 0; z-index: 2; pointer-events: none; }
  .dion-mc-native-picker-host[popover] {
    position: fixed; inset: 0; width: 100%; height: 100%; max-width: none; max-height: none;
    margin: 0; padding: 0; border: 0; overflow: visible; background: transparent;
    visibility: visible !important;
  }
  .dion-mc-native-picker-host::backdrop { background: transparent; pointer-events: none; }
  .dion-mc-native-picker-container { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }

  /* A standalone native picker owns its whole window, with no anchor gutter. */
  .syncord-native-picker-window-layer {
    position:fixed!important;inset:0!important;width:100%!important;height:100%!important;
    transform:none!important;translate:none!important;margin:0!important;
  }
  /* PositionLayer can leave an anchor offset on the dialog itself as well as
     its outer layer. A dedicated window has no surrounding composer gutter. */
  .syncord-native-picker-window-layer [role="dialog"] {
    position:absolute!important;inset:0!important;transform:none!important;translate:none!important;
    margin:0!important;width:100%!important;height:100%!important;
  }
  .syncord-native-picker-window-layer [role="dialog"] > * {max-height:100%!important;max-width:100%!important;margin:0!important;}
`;
