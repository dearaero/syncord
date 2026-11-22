/** Local navigation only. No selectors touch Discord chat, member lists or real guild rows. */
export const CSS=`
[data-syncord-virtual-entry]{display:flex;justify-content:center;flex-shrink:0;padding:4px 0}
[data-syncord-virtual-entry][hidden]{display:none}
[data-syncord-virtual-entry] button{position:relative;width:var(--guildbar-avatar-size,40px);height:var(--guildbar-avatar-size,40px);border:0;border-radius:50%;background:var(--background-surface-high,var(--background-secondary));color:var(--text-default,var(--text-normal));font:600 14px var(--font-primary);cursor:pointer;transition:border-radius 160ms ease,background 160ms ease}
[data-syncord-virtual-entry] button:hover,[data-syncord-virtual-entry] button[aria-pressed=true]{border-radius:12px;background:var(--brand-500,#5865f2);color:white}
[data-syncord-virtual-entry] button[data-unread=true]::before{content:'';position:absolute;inset-inline-start:-10px;top:calc(50% - 3px);width:4px;height:6px;border-radius:4px;background:var(--text-default,white)}
[data-syncord-virtual-entry] button[aria-pressed=true]::before{content:'';position:absolute;inset-inline-start:-10px;top:8px;width:4px;height:24px;border-radius:4px;background:var(--text-default,white)}
[data-syncord-virtual-entry] small{position:absolute;bottom:-3px;inset-inline-end:-3px;min-width:16px;border-radius:8px;background:var(--status-danger,#da373c);color:white;font-size:11px;line-height:16px}
[data-list-id="private-channels-syncord-virtual"]{display:flex;flex:1;min-height:0;min-width:0;overflow:hidden}
[data-syncord-virtual-sidebar]{display:flex;flex:1;flex-direction:column;min-height:0;min-width:0;width:100%;overflow:hidden;background:var(--background-base-lowest,var(--background-secondary));color:var(--text-default,var(--text-normal,#dbdee1));font:14px var(--font-primary,sans-serif)}
[data-syncord-virtual-sidebar] header{display:flex;align-items:center;justify-content:space-between;min-height:48px;flex-shrink:0;padding:0 12px;border-bottom:1px solid var(--border-subtle,transparent);font-weight:600;font-size:16px;gap:8px}
[data-virtual-title]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-syncord-virtual-sidebar] button{box-sizing:border-box;font:500 14px var(--font-primary,sans-serif);border:0;border-radius:6px;color:var(--channels-default,var(--text-muted,#949ba4));background:transparent;cursor:pointer;min-width:0;transition:background 160ms ease,color 160ms ease}
[data-syncord-virtual-sidebar] button:hover{background:var(--background-modifier-hover,rgba(128,128,128,.12));color:var(--text-default,var(--text-normal,#dbdee1))}
[data-syncord-virtual-sidebar] button[aria-current=page],[data-syncord-virtual-sidebar] button[aria-pressed=true]{background:var(--background-modifier-selected,rgba(128,128,128,.2));color:var(--text-default,var(--text-normal,#dbdee1))}
[data-syncord-virtual-sidebar] button:disabled{opacity:.5;cursor:not-allowed}
[data-syncord-virtual-sidebar] button:focus-visible,[data-syncord-virtual-entry] button:focus-visible,[data-syncord-virtual-sidebar] input:focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:-2px}
[data-virtual-exit],[data-virtual-picker-close]{width:28px;height:28px;flex-shrink:0;font-size:20px!important}
[data-syncord-virtual-sidebar] [data-virtual-options]{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:1;min-width:0;height:40px;padding:0 4px;color:var(--header-primary,var(--text-normal,#dbdee1));font-weight:600;font-size:16px}
[data-virtual-toolbar]{display:flex;gap:6px;padding:8px;flex-shrink:0}
[data-virtual-toolbar] button{display:flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:6px 8px;flex:1}
[data-virtual-toolbar] button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-virtual-chevron]{flex-shrink:0;transition:transform 200ms cubic-bezier(.2,.8,.2,1)}
[aria-expanded=true]>[data-virtual-chevron]{transform:rotate(180deg)}
[data-syncord-virtual-sidebar] form{display:flex;flex-direction:column;gap:8px;padding:8px 12px;flex-shrink:0}
[data-syncord-virtual-sidebar] form button{min-height:32px}
[data-syncord-virtual-sidebar] label{display:flex;flex-direction:column;gap:6px}
[data-syncord-virtual-sidebar] input{box-sizing:border-box;width:100%;min-width:0;background:var(--background-tertiary,#17181c);border:1px solid var(--border-subtle,#41434a);border-radius:6px;color:var(--text-default,var(--text-normal,#dbdee1));padding:8px;font:inherit}
[data-virtual-picker]{display:grid;grid-template-rows:0fr;opacity:0;flex-shrink:1;min-height:0;pointer-events:none;transition:grid-template-rows 200ms cubic-bezier(.2,.8,.2,1),opacity 160ms ease}
[data-virtual-picker][data-open=true]{grid-template-rows:1fr;opacity:1;pointer-events:auto}
[data-virtual-picker-clip]{min-height:0;overflow:hidden}
[data-virtual-picker-panel]{box-sizing:border-box;margin:0 8px 8px;padding:8px;display:flex;flex-direction:column;gap:8px;max-height:min(280px,40vh);border:1px solid var(--border-subtle,#41434a);border-radius:8px;background:var(--background-secondary,#202127)}
[data-virtual-picker-heading]{display:flex;align-items:center;gap:6px;justify-content:space-between;font-weight:600;font-size:12px;min-height:28px}
[data-virtual-picker-heading]>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-virtual-picker-panel]>input{flex-shrink:0}
[data-virtual-picker-results]{overflow-y:auto;min-height:0;overscroll-behavior:contain}
[data-virtual-picker-results] button{display:flex;align-items:center;width:100%;text-align:start;gap:10px;padding:8px}
[data-virtual-choice-text]{display:flex;flex:1;min-width:0;flex-direction:column;gap:2px}
[data-virtual-choice-name],[data-virtual-picker-results] small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-virtual-picker-results] small{font-size:11px;color:var(--text-muted,#949ba4)}
[data-virtual-picker-results] p,[data-virtual-empty]{margin:8px;font-size:13px;color:var(--text-muted,#949ba4);overflow-wrap:anywhere}
[data-virtual-channel-list]{flex:1;padding:0 8px 8px;overflow-y:auto;min-height:48px;overscroll-behavior:contain}
[data-virtual-channel-list],[data-virtual-picker-results]{scrollbar-width:thin;scrollbar-color:var(--background-modifier-accent,#41434a) transparent}
[data-virtual-channel-list]::-webkit-scrollbar,[data-virtual-picker-results]::-webkit-scrollbar{width:6px}
[data-virtual-channel-list]::-webkit-scrollbar-thumb,[data-virtual-picker-results]::-webkit-scrollbar-thumb{background:var(--background-modifier-accent,#41434a);border-radius:4px}
[data-virtual-channel-list] h3{font:600 11px var(--font-primary,sans-serif);color:var(--channels-default,#949ba4);margin:12px 8px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-virtual-channel-list] button[data-channel-id]{display:flex;width:100%;padding:8px;gap:8px;text-align:start;align-items:center;min-height:34px}
[data-virtual-channel-icon]{flex:0 0 20px;text-align:center;font-size:20px;line-height:18px;opacity:.75}
[data-virtual-channel-name]{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-virtual-row-actions]{display:flex;flex-wrap:wrap;gap:4px;padding:2px 8px 6px}
[data-virtual-row-actions] button{padding:5px 8px}
[data-virtual-mentions]{display:block;padding:2px 8px;color:var(--text-muted);font-size:11px}
[data-virtual-avatar]{width:24px;height:24px;flex:0 0 24px;border-radius:50%;object-fit:cover}
[data-virtual-row]{position:relative}
[data-virtual-row][draggable=true]{cursor:grab}
[data-virtual-row][draggable=true]:active{cursor:grabbing}
[data-virtual-row][data-virtual-drop]::after{content:'';position:absolute;height:2px;inset-inline:6px;background:var(--brand-500,#5865f2);pointer-events:none;border-radius:2px}
[data-virtual-row][data-virtual-drop=before]::after{top:0}
[data-virtual-row][data-virtual-drop=after]::after{bottom:0}
[data-virtual-grip]{align-self:center;color:var(--text-muted,#949ba4)}
@media(prefers-reduced-motion:reduce){[data-syncord-virtual-entry] button,[data-syncord-virtual-sidebar] button,[data-virtual-picker],[data-virtual-chevron]{transition:none}}
`;
