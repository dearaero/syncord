import { t as i18nText } from "../../i18n";
import {definePlugin} from '../../api/plugin';
import {parseFilter} from './model';
import {registerDmView} from '../../ui/privateChannelView';
export const DmFiltersPlugin=definePlugin({
  id:'dm-filters',name:i18nText("ui.dm_filters"),author:i18nText("ui.syncord"),enabledByDefault:true,
  get description() { return i18nText("ui.filter_the_direct_messages_sidebar_by_all_conversations_groups_or_one_"); },
  permissions:{media:true,userData:true,webpackPatch:true,discordStores:['channel','ChannelStore']},
  start(ctx){
    let mode=parseFilter(ctx.settings.get('filter','all'));
    ctx.css.inject(`
      [data-syncord-dm-filter-section]{display:flex;flex-direction:column;min-width:0;}
      [data-syncord-dm-filter-section]>:first-child{box-sizing:border-box;margin-block:0;height:24px;min-height:24px;padding-block:0;}
      [data-syncord-dm-filters]{display:flex;align-items:center;gap:4px;box-sizing:border-box;height:36px;padding:4px 8px;min-width:0;}
      [data-syncord-dm-filters]>button{appearance:none;flex:1 1 0;min-width:0;height:28px;box-sizing:border-box;border:0;border-radius:6px;padding:0 5px;background:transparent;color:var(--interactive-normal,var(--text-muted,#94959c));font:600 12px/1 var(--font-primary,'gg sans',sans-serif);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      [data-syncord-dm-filters]>button:hover{background:var(--background-modifier-hover,#242429);color:var(--interactive-hover,#dbdee1);}
      [data-syncord-dm-filters]>button[aria-pressed=true]{background:var(--background-modifier-selected,#2a2a30);color:var(--interactive-active,var(--text-normal,#f2f3f5));}
      [data-syncord-dm-filters]>button:focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:-2px;}
      [data-syncord-dm-filter-empty]{box-sizing:border-box;padding:16px 12px;color:var(--text-muted,#94959c);font:13px/1.4 var(--font-primary,sans-serif);}
    `);

    const view=registerDmView(ctx,{mode:()=>mode,select:next=>{if(next===mode)return;mode=next;ctx.settings.set('filter',next);view.refresh(true);}});
  },
});
