export const CSS=`
.Syncord-server-cloner{box-sizing:border-box;width:min(640px,calc(100vw - 24px));max-height:calc(100dvh - 32px);overflow:auto;padding:22px;border:1px solid var(--border-subtle,#404249);border-radius:14px;background:var(--background-primary,#313338);color:var(--text-normal,#f2f3f5);font:14px/1.5 var(--font-primary,system-ui);box-shadow:0 16px 64px #0006}
.Syncord-server-cloner::backdrop{background:#0009}.Syncord-server-cloner *{box-sizing:border-box}
.Syncord-server-cloner header,.Syncord-server-cloner footer,.Syncord-server-cloner nav{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-block:12px}.Syncord-server-cloner header{justify-content:space-between;margin-top:0}
.Syncord-server-cloner h2{font-size:20px;margin:0}.Syncord-server-cloner p{margin-block:12px;overflow-wrap:anywhere}.Syncord-server-cloner small{display:block;color:var(--text-muted,#949ba4)}
.Syncord-server-cloner button,.Syncord-server-cloner select{font:inherit;color:inherit;background:var(--background-secondary,#2b2d31);border:1px solid var(--border-subtle,#4e5058);border-radius:8px;padding:9px 12px;cursor:pointer;max-width:100%;min-width:0}
.Syncord-server-cloner select{width:100%}.Syncord-server-cloner button:hover{background:var(--background-modifier-hover,#404249)}.Syncord-server-cloner button:active{transform:scale(.98)}.Syncord-server-cloner button:disabled{opacity:.45;cursor:default}
.Syncord-server-cloner label:has(input[type=checkbox]){display:flex;align-items:flex-start;gap:10px;margin-block:14px;overflow-wrap:anywhere}.Syncord-server-cloner input[type=checkbox]{appearance:auto;flex-shrink:0;width:18px;height:18px;margin-block-start:2px;accent-color:var(--brand-500,#5865f2)}
.Syncord-server-cloner :focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:2px}.Syncord-server-cloner button[data-primary]{background:var(--brand-500,#5865f2);color:white}
.Syncord-server-cloner dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 16px;margin:12px 0}.Syncord-server-cloner dd{margin:0;font-variant-numeric:tabular-nums}
.Syncord-server-cloner details{padding:10px 0;border-top:1px solid var(--border-subtle,#4e5058)}.Syncord-server-cloner summary{cursor:pointer;font-weight:600}.Syncord-server-cloner li{margin-block:6px;overflow-wrap:anywhere}.Syncord-server-cloner ul{padding-inline-start:20px}
.Syncord-server-cloner pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 var(--font-code,monospace);max-height:200px;overflow:auto;padding:10px;background:var(--background-secondary,#2b2d31);border-radius:6px}
.Syncord-server-cloner [role=alert]{color:var(--text-danger,#fa777c)}.Syncord-server-cloner [role=status]{color:var(--text-muted,#949ba4)}
@media(prefers-reduced-motion:no-preference){.Syncord-server-cloner button{transition:background 140ms ease,transform 140ms ease}}
`;
