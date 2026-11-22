export const IMAGE_ZOOM_CSS=`
[data-iz-media=true],#Syncord-image-zoom canvas{transition:transform 100ms ease-out;}
[data-iz-smooth=false],[data-iz-pixel=true]{transition:none!important;}
[data-iz-pixel=true]{image-rendering:pixelated!important;}
#Syncord-image-zoom{position:absolute;inset:0;z-index:5;pointer-events:none;color:#fff;font:11px var(--font-primary,system-ui,sans-serif);}
#Syncord-image-zoom canvas{position:absolute;transform-origin:0 0;pointer-events:none;max-width:none;max-height:none;}
#Syncord-image-zoom [hidden]{display:none!important;}
#Syncord-image-zoom .iz-controls{position:absolute;bottom:4px;left:4px;right:4px;display:flex;align-items:center;flex-wrap:wrap;gap:3px;max-height:calc(100% - 8px);overflow:auto;pointer-events:none;}
#Syncord-image-zoom button,#Syncord-image-zoom .iz-status,#Syncord-image-zoom .iz-frame{box-sizing:border-box;border:0;border-radius:4px;padding:3px 5px;background:#111d;color:#fff;font:inherit;line-height:1.2;}
#Syncord-image-zoom button{pointer-events:auto;cursor:pointer;min-height:22px;}
#Syncord-image-zoom button:hover{background:#333e;}
#Syncord-image-zoom button:focus-visible{outline:2px solid var(--brand-500,#5865f2);outline-offset:-2px;}
#Syncord-image-zoom button[aria-pressed=true]{background:var(--brand-500,#5865f2);}
#Syncord-image-zoom button:disabled{opacity:.45;cursor:default;}
#Syncord-image-zoom .iz-status{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;}
#Syncord-image-zoom .iz-gif{display:contents;}
@media(prefers-reduced-motion:reduce){[data-iz-media=true],#Syncord-image-zoom canvas{transition:none;}}
`;
