export const STRIP_ID = "Syncord-time-machine";
export const CSS = `
#${STRIP_ID}{position:relative;display:flex;align-items:center;gap:8px;margin:0 0 8px;padding:6px 10px;border-radius:8px;
  background:var(--background-secondary,#2b2d31);color:var(--text-normal,#dbdee1);font-size:12px;line-height:16px}
#${STRIP_ID} button{flex:none;display:grid;place-items:center;min-width:28px;height:28px;padding:0 6px;border:0;border-radius:6px;
  background:transparent;color:var(--interactive-normal,#b5bac1);font:600 12px/1 inherit;cursor:pointer}
#${STRIP_ID} button:hover{background:var(--background-modifier-hover,#80848e29);color:var(--interactive-hover,#dbdee1)}
#${STRIP_ID} button:focus-visible,#${STRIP_ID} input:focus-visible{outline:2px solid var(--brand-500,#5865f2);outline-offset:1px}
#${STRIP_ID} button[hidden]{display:none}
#${STRIP_ID} .tm-track{position:relative;flex:1;min-width:80px;display:flex;flex-direction:column;gap:2px}
#${STRIP_ID} input[type=range]{width:100%;margin:0;accent-color:var(--brand-500,#5865f2);cursor:pointer}
#${STRIP_ID} .tm-heat{display:flex;gap:1px;height:4px}
#${STRIP_ID} .tm-heat span{flex:1;border-radius:1px;background:var(--brand-500,#5865f2)}
#${STRIP_ID} .tm-info{flex:0 1 40%;min-width:0;display:flex;flex-direction:column}
#${STRIP_ID} .tm-label,#${STRIP_ID} .tm-hint{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${STRIP_ID} .tm-label{cursor:pointer}#${STRIP_ID} .tm-label:hover{text-decoration:underline}
#${STRIP_ID} .tm-hint{color:var(--text-muted,#949ba4)}
#${STRIP_ID} .tm-badge{position:absolute;right:12px;bottom:calc(100% + 8px);padding:3px 9px;border-radius:999px;pointer-events:none;
  background:#000000b3;color:#f5e6c8;font:700 12px/16px var(--font-code,ui-monospace,monospace);letter-spacing:.5px}
#${STRIP_ID} .tm-badge[hidden]{display:none}
ol.tm-active{filter:sepia(.35) saturate(.85);transition:filter 200ms ease}
ol.tm-active li.tm-future{opacity:.18;filter:grayscale(1)}
ol.tm-active li.tm-ghost{opacity:.62;border-radius:4px;box-shadow:inset 3px 0 0 var(--status-danger,#f23f43);
  background:color-mix(in srgb,var(--status-danger,#f23f43) 10%,transparent)}
ol.tm-active li.tm-alive{background:none!important}
ol.tm-active .dion-ml-note,ol.tm-active .dion-ml-versions,ol.tm-active .tm-hidden{display:none!important}
ol.tm-active .tm-text{white-space:pre-wrap;overflow-wrap:anywhere;font-style:italic}
ol.tm-active .tm-note{margin:0 16px 2px 56px;font-size:12px;font-weight:600;line-height:16px;color:var(--status-danger,#f23f43)}
ol.tm-active li.tm-focus{border-radius:4px;outline:2px solid var(--brand-500,#5865f2);outline-offset:-2px;animation:tm-pulse 900ms ease}
@keyframes tm-pulse{from{background:color-mix(in srgb,var(--brand-500,#5865f2) 30%,transparent)}to{background:transparent}}
form.tm-locked [class*="channelTextArea"]{opacity:.5}
@media (prefers-reduced-motion:reduce){ol.tm-active,ol.tm-active li.tm-focus{transition:none;animation:none}}
`;
