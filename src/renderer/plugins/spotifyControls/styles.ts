export const SPOTIFY_CSS=`
#Syncord-titlebar-btn[data-spotify-island]{box-sizing:border-box;background:#000!important;color:#fff!important;border-radius:999px!important;height:28px;padding:0 10px;gap:5px;box-shadow:none;-webkit-app-region:no-drag}
#Syncord-titlebar-btn[data-spotify-island] .dion-titlebar-text{display:none}
[data-syncord-titlebar-layout]>#Syncord-titlebar-btn[data-spotify-island]:active{transform:translate(-50%,-50%)}
#Syncord-titlebar-btn[data-spotify-morphing]{background:transparent!important;box-shadow:none!important}
#Syncord-titlebar-btn[data-spotify-morphing]>*{visibility:hidden}
.syncord-spotify-compact{display:flex;align-items:center;gap:8px;min-width:0;flex:1;overflow:hidden}
.syncord-spotify-compact img{width:21px;height:21px;border-radius:50%;object-fit:cover;flex-shrink:0}
.syncord-spotify-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 12px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;flex:1;text-align:start;letter-spacing:-.15px}
.syncord-spotify-eq{display:flex;align-items:center;justify-content:center;gap:2px;height:15px;width:18px;color:#1ed760;margin-inline-start:auto;flex-shrink:0}
.syncord-spotify-eq i{width:2px;height:7px;border-radius:3px;background:currentColor;transform-origin:center;animation:syncord-spotify-eq 720ms cubic-bezier(.45,0,.55,1) infinite alternate;animation-play-state:paused;transition:opacity 180ms}
.syncord-spotify-eq i:nth-child(2){height:12px;animation-delay:-420ms;animation-duration:640ms}.syncord-spotify-eq i:nth-child(3){height:16px;animation-delay:-160ms;animation-duration:810ms}.syncord-spotify-eq i:nth-child(4){height:11px;animation-delay:-580ms;animation-duration:690ms}.syncord-spotify-eq i:nth-child(5){height:5px;animation-delay:-290ms}
.syncord-spotify-eq[data-moving=true] i{animation-play-state:running}.syncord-spotify-eq[data-moving=false] i{opacity:.45}
@keyframes syncord-spotify-eq{from{transform:scaleY(.35)}to{transform:scaleY(1)}}
#Syncord-spotify-island{position:fixed;inset:auto;margin:0;padding:0;border:0;max-width:none;max-height:none;overflow:hidden;background:#000;color:#fff;box-shadow:0 8px 24px #0004;box-sizing:border-box;contain:layout paint style;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-app-region:no-drag;z-index:2147483000;isolation:isolate}
#Syncord-spotify-island::backdrop{background:transparent;pointer-events:none}
.syncord-spotify-compact[hidden],.syncord-spotify-eq[hidden],#Syncord-spotify-island [hidden]{display:none!important}
#Syncord-spotify-island *{box-sizing:border-box;-webkit-app-region:no-drag}
.syncord-spotify-player{height:258px;position:relative;opacity:var(--spotify-content-opacity,0);transform:translateY(calc((1 - var(--spotify-content-opacity,0)) * 8px))}
.syncord-spotify-heading-space{height:62px}
.syncord-spotify-heading{position:absolute;min-width:0;pointer-events:none}
.syncord-spotify-heading [data-art-space]{display:none}
.syncord-spotify-name,.syncord-spotify-artist{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:start}
.syncord-spotify-name{font-weight:600;letter-spacing:-.25px}
.syncord-spotify-artist{color:#ffffff8c;font-size:13px;line-height:20px;letter-spacing:-.1px}
.syncord-spotify-artwork{position:absolute;overflow:hidden;isolation:isolate;background:#111}
.syncord-spotify-artwork img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.syncord-spotify-expanded-eq{position:absolute;margin:0;pointer-events:none}
#Syncord-spotify-island button{border:0;background:transparent;color:#f7f7f7;cursor:pointer;border-radius:12px;padding:8px;display:inline-grid;place-items:center;flex-shrink:0;transition:opacity 160ms,transform 200ms cubic-bezier(.2,.75,.25,1);touch-action:manipulation}
#Syncord-spotify-island button:hover{opacity:.72}#Syncord-spotify-island button:active{transform:scale(.9)}
#Syncord-spotify-island button:disabled{opacity:.26;cursor:default}
#Syncord-spotify-island button[aria-pressed=true]{color:#1ed760}
#Syncord-spotify-island :focus-visible{outline:2px solid #fff;outline-offset:3px}
#Syncord-spotify-island svg{width:19px;height:19px;display:block;pointer-events:none}
.syncord-spotify-controls{position:absolute;inset:140px 22px auto;direction:ltr;display:grid;grid-template-columns:1fr 1fr 1.15fr 1fr 1fr;align-items:center;justify-items:center;height:46px}
#Syncord-spotify-island [data-command=play]{width:48px;height:46px;padding:8px}
#Syncord-spotify-island [data-command=play] svg{width:30px;height:30px}
#Syncord-spotify-island [data-command=previous] svg,#Syncord-spotify-island [data-command=next] svg{width:29px;height:27px}
#Syncord-spotify-island [data-command=shuffle],#Syncord-spotify-island [data-command=repeat]{color:#ffffff82}
#Syncord-spotify-island [aria-pressed=true]{position:relative}
#Syncord-spotify-island [aria-pressed=true]::after{content:"";position:absolute;width:3px;height:3px;border-radius:50%;background:currentColor;bottom:1px}
#Syncord-spotify-island [data-command=repeat][data-mode=track]::before{content:"1";position:absolute;font-size:8px;font-weight:600;line-height:1;top:14px;left:50%;transform:translateX(-50%)}
#Syncord-spotify-island input[type=range]{appearance:none;-webkit-appearance:none;direction:ltr;padding:0;border:0;border-radius:0;outline-offset:3px;background:transparent;cursor:pointer;touch-action:none}
#Syncord-spotify-island input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:4px;background:linear-gradient(to right,#d3d3d3 var(--spotify-fill,0%),#ffffff29 var(--spotify-fill,0%))}
#Syncord-spotify-island input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:4px;height:4px;margin-top:0;border-radius:50%;background:#d3d3d3;transition:transform 160ms}
#Syncord-spotify-island input[type=range]:hover::-webkit-slider-thumb,#Syncord-spotify-island input[type=range]:focus-visible::-webkit-slider-thumb{transform:scale(2.4)}
#Syncord-spotify-island input[type=range]:disabled{opacity:.35;cursor:default}
.syncord-spotify-seek{position:absolute;top:102px;left:22px;width:calc(100% - 44px);margin:0;height:14px}
.syncord-spotify-times{position:absolute;top:121px;left:22px;right:22px;display:flex;justify-content:space-between;font-size:10px;font-weight:500;font-variant-numeric:tabular-nums;direction:ltr;color:#ffffff70}
.syncord-spotify-volume{position:absolute;top:204px;left:24px;right:112px;height:18px;display:flex;align-items:center;gap:10px;color:#ffffff70}
.syncord-spotify-volume [data-volume-label]{font-size:10px;position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.syncord-spotify-volume input{min-width:0;flex:1;height:14px}
.syncord-spotify-links{position:absolute;top:198px;right:18px;display:flex;align-items:center;justify-content:flex-end;gap:4px}
#Syncord-spotify-island .syncord-spotify-links button{font-size:10px;font-weight:500;line-height:13px;color:#ffffff70;padding:7px;flex-shrink:1;min-width:0;white-space:normal;text-align:start}
.syncord-spotify-error{position:absolute;top:232px;left:22px;right:22px;font-size:10px;line-height:14px;color:#ffa3ad;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0}
[data-spotify-options] input[type=range]{max-width:140px;accent-color:#1ed760}
#Syncord-spotify-island[data-motion=false] button,#Syncord-spotify-island[data-motion=false] input[type=range]::-webkit-slider-thumb{transition:none!important}
@media(prefers-reduced-motion:reduce){.syncord-spotify-eq i{animation:none!important}#Syncord-spotify-island button,#Syncord-spotify-island input[type=range]::-webkit-slider-thumb{transition:none!important}}
`;
