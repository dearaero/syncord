import {definePlugin} from '../../api/plugin';
import {t} from '../../i18n';
import {ISLAND_ID,ISLAND_SETTINGS,options,readRaw,setOption} from './settings';
import {createIslandCore,parseHistory} from './core';
import {startSources} from './sources';
import {mountIsland} from './view';
import {ISLAND_CSS} from './styles';
export const NotificationIsland=definePlugin({
  id:ISLAND_ID,get name(){return t('island.name');},get description(){return t('island.description');},enabledByDefault:false,
  permissions:{media:true,userData:true,discordStores:['UserStore','ChannelStore','GuildStore','RelationshipStore','VoiceStateStore','SelectedChannelStore','ReadStateStore','GuildMemberStore'],discordActions:['message-send','read-ack','reaction-add','channel-navigation'],native:['ecosystem-profile']},
  start(ctx){
    ctx.css.inject(ISLAND_CSS);
    // Session history is never written; switching to it also erases what was kept.
    const save=(history:unknown[]):void=>{if(options().historyMode==='persistent')setOption('history',JSON.stringify(history));};
    const core=createIslandCore(save,options().historyMode==='persistent'?parseHistory(readRaw('history')):[]);
    const modeChanged=():void=>{if(options().historyMode==='session'&&readRaw('history')!=='[]')setOption('history','[]');else save(core.history());};
    window.addEventListener(ISLAND_SETTINGS,modeChanged);ctx.disposable(()=>window.removeEventListener(ISLAND_SETTINGS,modeChanged));
    const view=mountIsland(core,ctx.log);ctx.disposable(view.dispose);
    ctx.disposable(startSources(ctx,item=>{core.push(item,!options().silent);view.wake();}));
  },
});
