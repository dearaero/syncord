export const ISLAND_CSS=`
#Syncord-titlebar-btn[data-notify-morphing]>*{opacity:var(--ni-label,1)}
#Syncord-notify-island{position:fixed;inset:auto;margin:0;padding:0;border:0;max-width:none;max-height:none;overflow:hidden;background:#000;color:#fff;box-shadow:0 8px 24px #0004;box-sizing:border-box;contain:layout paint style;font:13px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-app-region:no-drag;z-index:2147483001;isolation:isolate}
#Syncord-notify-island::backdrop{background:transparent;pointer-events:none}
#Syncord-notify-island *{box-sizing:border-box;-webkit-app-region:no-drag}
#Syncord-notify-island [hidden]{display:none!important}
#Syncord-notify-island .ni-item,#Syncord-notify-island .ni-list{padding:12px 14px;opacity:var(--ni-reveal,0);transform:translateY(calc((1 - var(--ni-reveal,0)) * 6px))}
#Syncord-notify-island .ni-item{position:relative}
#Syncord-notify-island .ni-head,#Syncord-notify-island .ni-row{display:flex;align-items:center;gap:10px;min-width:0}
#Syncord-notify-island.ni-clickable [data-ni-open]{cursor:pointer}
#Syncord-notify-island .ni-face{width:34px;height:34px;flex:none;border-radius:50%;overflow:hidden;display:grid;place-items:center;background:#1c1c1e;font-size:17px}
#Syncord-notify-island .ni-face img{width:100%;height:100%;object-fit:cover}
#Syncord-notify-island .ni-copy{display:flex;flex-direction:column;min-width:0;flex:1;text-align:start}
#Syncord-notify-island .ni-title,#Syncord-notify-island .ni-place,#Syncord-notify-island .ni-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#Syncord-notify-island .ni-title{font-weight:600;letter-spacing:-.2px}
#Syncord-notify-island .ni-place{color:#ffffff8c;font-size:11px;line-height:15px}
#Syncord-notify-island .ni-count{flex:none;font-size:11px;font-weight:600;color:#000;background:#fff;border-radius:999px;padding:0 7px}
#Syncord-notify-island .ni-count:empty{display:none}
#Syncord-notify-island .ni-text{margin:8px 0 0;color:#f2f2f2}
#Syncord-notify-island .ni-mention{font-weight:700;color:#fff}
#Syncord-notify-island .ni-mention.ni-self{color:#f0b232}
#Syncord-notify-island .ni-toast{display:flex;align-items:center;gap:8px;width:max-content;height:36px;margin-inline:auto;padding:0 16px 0 10px;white-space:nowrap;font-weight:600;opacity:var(--ni-reveal,0)}
#Syncord-notify-island .ni-toast-icon{width:20px;height:20px;flex:none;border-radius:50%;display:grid;place-items:center;font-size:12px;line-height:1;background:#23a55a;color:#fff}
#Syncord-notify-island .ni-toast[data-ok=false] .ni-toast-icon{background:#f23f43}
#Syncord-notify-island .ni-actions{display:flex;align-items:center;gap:4px;margin-top:8px}
#Syncord-notify-island .ni-reactions{display:flex;gap:2px;margin-inline-end:auto}
#Syncord-notify-island button{border:0;background:#ffffff14;color:#f7f7f7;cursor:pointer;border-radius:999px;padding:4px 10px;font:inherit;font-size:12px;transition:opacity 160ms,transform 200ms cubic-bezier(.2,.75,.25,1)}
#Syncord-notify-island button:hover{background:#ffffff26}#Syncord-notify-island button:active{transform:scale(.92)}
#Syncord-notify-island .ni-reactions button{background:transparent;padding:4px 5px;font-size:15px}
#Syncord-notify-island .ni-actions[data-message=false]{justify-content:flex-end;margin-top:0;position:absolute;top:12px;right:12px}
#Syncord-notify-island .ni-actions[data-message=false] [data-ni-dismiss]{background:transparent;color:#ffffff70}
#Syncord-notify-island [data-ni-read-all]{display:inline-grid;place-items:center;padding:4px 8px}
#Syncord-notify-island [data-ni-read-all] svg{display:block}
#Syncord-notify-island .ni-reply{display:flex;gap:6px;margin-top:8px}
#Syncord-notify-island .ni-reply input{flex:1;min-width:0;border:0;border-radius:999px;background:#ffffff1f;color:#fff;padding:6px 12px;font:inherit;outline:none}
#Syncord-notify-island .ni-reply input:focus-visible{box-shadow:0 0 0 2px #5865f2}
#Syncord-notify-island .ni-error{margin:4px 0 0;font-size:11px;color:#ffa3ad}
#Syncord-notify-island .ni-error:empty{display:none}
#Syncord-notify-island :focus-visible{outline:2px solid #fff;outline-offset:2px}
#Syncord-notify-island .ni-list-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
#Syncord-notify-island .ni-rows{display:flex;flex-direction:column;gap:2px;max-height:300px;overflow-y:auto}
#Syncord-notify-island .ni-entry{position:relative;overflow:hidden;border-radius:12px;flex:none}
#Syncord-notify-island .ni-row{width:100%;background:transparent;border-radius:12px;padding:6px 6px;text-align:start;transition:transform 280ms cubic-bezier(.2,.75,.25,1),opacity 200ms,background 160ms}
#Syncord-notify-island .ni-del{position:absolute;inset-block:0;inset-inline-start:0;width:20%;display:flex;align-items:center;justify-content:center;gap:8px;border-radius:12px;padding:0;background:#f23f4333;color:#ffb3b8;white-space:nowrap;overflow:hidden;transform:translateX(-100%);transition:transform 280ms cubic-bezier(.2,.75,.25,1),width 320ms cubic-bezier(.2,.75,.25,1),background 200ms,color 200ms}
#Syncord-notify-island .ni-del:hover{background:#f23f4352}
#Syncord-notify-island .ni-del:active{transform:none}
#Syncord-notify-island .ni-del-text{display:none;font-weight:600}
#Syncord-notify-island .ni-entry:is(:hover,:focus-within) .ni-del{transform:none}
#Syncord-notify-island .ni-entry:is(:hover,:focus-within) .ni-row{transform:translateX(20%)}
#Syncord-notify-island .ni-entry[data-armed] .ni-del{width:100%;background:#f23f43e6;color:#fff}
#Syncord-notify-island .ni-entry[data-armed] .ni-del-text{display:inline}
#Syncord-notify-island .ni-entry[data-armed] .ni-row{transform:translateX(100%);opacity:0}
#Syncord-notify-island[dir=rtl] .ni-del{transform:translateX(100%)}
#Syncord-notify-island[dir=rtl] .ni-entry:is(:hover,:focus-within) .ni-row{transform:translateX(-20%)}
#Syncord-notify-island[dir=rtl] .ni-entry[data-armed] .ni-row{transform:translateX(-100%)}
#Syncord-notify-island[data-motion=false] :is(.ni-row,.ni-del){transition:none!important}
@media(prefers-reduced-motion:reduce){#Syncord-notify-island :is(.ni-row,.ni-del){transition:none!important}}
#Syncord-notify-island .ni-row .ni-face{width:28px;height:28px;font-size:14px}
#Syncord-notify-island .ni-empty{color:#ffffff8c;margin:8px 0}
#Syncord-notify-pill{position:fixed;z-index:2147482999;height:22px;min-width:22px;padding:0 7px;border:0;border-radius:999px;background:#000;color:#fff;font:600 11px/22px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;-webkit-app-region:no-drag;box-shadow:0 2px 8px #0005}
#Syncord-notify-pill[hidden]{display:none}
#Syncord-notify-pill[data-unread=false]{width:22px;padding:0;display:grid;place-items:center;opacity:.85}#Syncord-notify-pill[data-unread=false]:hover{opacity:1}#Syncord-notify-pill svg{display:block;flex:none;max-width:100%;max-height:100%}#Syncord-notify-pill[data-unread=false]{overflow:hidden}
#Syncord-notify-island[data-motion=false] button{transition:none!important}
@media(prefers-reduced-motion:reduce){#Syncord-notify-island button{transition:none!important}}
`;
