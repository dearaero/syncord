/** Scoped to the account-owned custom badge editor. */
export const SUPPORTER_CSS = String.raw`
.eco-supporter{margin-top:24px;border-top:1px solid var(--eco-line);padding-top:20px;min-width:0}
.eco-supporter header,.eco-supporter .sup-metrics{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.eco-supporter .sup-help{color:var(--eco-muted);font-size:12px;line-height:1.6}
.eco-supporter>.sup-help{margin-top:8px}.eco-supporter .sup-metrics{margin:16px 0;font-size:12px}
.eco-supporter .sup-layout{display:grid;grid-template-columns:minmax(140px,190px) minmax(0,1fr);gap:16px;align-items:start}
.eco-supporter .sup-list{display:flex;flex-direction:column;gap:6px;min-width:0}
.eco-supporter .sup-list button{display:flex;flex-direction:column;gap:4px;text-align:start;align-items:flex-start;min-width:0;overflow-wrap:anywhere;padding:12px}
.eco-supporter .sup-list button[aria-pressed=true]{border-color:var(--eco-accent);background:var(--background-modifier-selected,#383a42)}
.eco-supporter .sup-list small{color:var(--eco-muted);font-size:11px;font-weight:400}
.eco-supporter .sup-editor{min-width:0;border:1px solid var(--eco-line);border-radius:13px;background:var(--eco-panel);overflow:hidden}
.eco-supporter .sup-editor-heading{padding:16px 18px;border-bottom:1px solid var(--eco-line);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.eco-supporter .sup-editor-heading strong{overflow-wrap:anywhere;min-width:0}
.eco-supporter .sup-body{padding:18px;display:flex;flex-direction:column;gap:16px}
.eco-supporter .sup-image{display:flex;align-items:center;gap:14px;min-width:0}
.eco-supporter .sup-image-controls{display:flex;flex-direction:column;align-items:flex-start;gap:7px;min-width:0;flex:1}
.eco-supporter .sup-filename{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--eco-muted);font-size:11px}
.eco-supporter .sup-preview{flex-shrink:0;display:grid;place-items:center;width:64px;height:64px;border:1px solid var(--eco-line);border-radius:14px;background:var(--eco-base);color:var(--eco-muted)}
.eco-supporter .sup-preview img{object-fit:contain;max-width:100%}
.eco-supporter .sup-size-preview{display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:12px 0 0}
.eco-supporter .sup-size-preview span{display:flex;flex-direction:column;align-items:center;gap:6px}
.eco-supporter .sup-size-preview img{object-fit:contain}
.eco-supporter details{font-size:12px;color:var(--eco-muted)}
.eco-supporter summary{cursor:pointer;width:fit-content;max-width:100%;border-radius:4px}
.eco-supporter label{display:flex;flex-direction:column;gap:7px;font-size:12px;font-weight:600;min-width:0}
.eco-supporter form{display:flex;flex-direction:column;gap:14px}
.eco-supporter input:not([type=file]),.eco-supporter textarea{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--eco-line);border-radius:9px;padding:10px 12px;background:var(--background-base-lowest,var(--background-tertiary,#17181c));color:var(--text-normal,#eee);font:14px/1.5 var(--font-primary,system-ui)}
.eco-supporter textarea{resize:vertical;min-height:76px;max-height:200px}
.eco-supporter input:disabled,.eco-supporter textarea:disabled{opacity:.65}
.eco-supporter .sup-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.eco-supporter .sup-footer{padding-top:16px;border-top:1px solid var(--eco-line)}
.eco-supporter .sup-footer .eco-danger{margin-inline-start:auto}
.eco-supporter [hidden]{display:none!important}
.eco-supporter button:focus-visible,.eco-supporter input:focus-visible,.eco-supporter textarea:focus-visible,.eco-supporter summary:focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:3px}
.eco-supporter [role=status]:empty{display:none}.eco-supporter [role=status]:not(:empty){margin:12px 0}
.eco-supporter [role=status],.eco-supporter .sup-reason{overflow-wrap:anywhere;font-size:12px}
.eco-supporter [data-error=true]{color:var(--text-danger,#fa777c)}
@container(max-width:650px){.eco-supporter .sup-layout{grid-template-columns:1fr}.eco-supporter .sup-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(140px,100%),1fr))}.eco-supporter .sup-body{padding:14px}.eco-supporter .sup-editor-heading{padding:14px}}
@container(max-width:350px){.eco-supporter .sup-image{align-items:flex-start}.eco-supporter .sup-image-controls .sup-actions{align-items:stretch;flex-direction:column}.eco-supporter .sup-footer button{flex:1 1 auto}.eco-supporter .sup-footer .eco-danger{margin-inline-start:0}}
@media(prefers-reduced-motion:reduce){.eco-supporter button{transition:none}}
`;
