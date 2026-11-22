import {definePlugin} from '../../api/plugin';
import {t} from '../../i18n';
import {simulateGame} from '../../api/gameSimulation';
import {watchAccount} from '../globalMessageSearch/discord';
import {currentUserId} from '../multiChatCanvas/discord';
import {wait} from '../autoQuests/modules';
import {GAME_ID,GAME_CHANGE,config} from './settings';
import {resolveGame,gameRuntime} from './discord';
import {publish,gameState} from './state';
export const CustomGamePresencePlugin=definePlugin({
 id:GAME_ID,get name(){return t('game.name');},get description(){return t('game.description');},enabledByDefault:false,
 permissions:{webpackPatch:true,userData:true,discordStores:['RunningGameStore','ApplicationStore','UserStore','DetectableApplicationsStore'],discordActions:['LOCAL_ACTIVITY_UPDATE','RUNNING_GAMES_CHANGE']},
 start(ctx){
  let fingerprint='';
  let stopped=false,running=false,revision=0,abort:AbortController|undefined,release:(()=>void)|undefined;
  const refresh=(retry=false):void=>{const id=currentUserId(),cfg=id?config(id):undefined;const key=JSON.stringify([id,cfg?.selected?.id,cfg?.initialSeconds,cfg?.realPriority]);if(key===fingerprint&&!(retry&&['game.unavailable','game.lookup_failed','game.busy'].includes(gameState().status)))return;fingerprint=key;revision++;abort?.abort();void reconcile();};
  async function reconcile():Promise<void>{
   if(running||stopped)return;running=true;
   try{let seen=-1;while(!stopped&&seen!==revision){
    seen=revision;const account=currentUserId(),cfg=account?config(account):undefined;release?.();release=undefined;
    if(!account||!cfg?.selected){publish({running:true,status:'game.ready'});continue;}
    const request=new AbortController();abort=request;publish({running:true,status:'game.switching',game:cfg.selected});
    try{
     let modules=gameRuntime();for(let n=0;!modules&&n<8;n++){await wait(1000,request.signal);modules=gameRuntime();}
     if(!modules)throw Error('game.unavailable');
     const selected=await resolveGame(cfg.selected.id,request.signal);
     if(stopped||seen!==revision||account!==currentUserId()||request.signal.aborted)continue;
     const start=Date.now()-cfg.initialSeconds*1000;
     release=simulateGame(ctx,modules.store,modules.dispatcher,selected,start,'custom',cfg.realPriority,(active,reason)=>{if(!stopped&&seen===revision)publish({running:true,status:reason==='unavailable'?'game.unavailable':active?'game.playing':reason==='quest'?'game.paused_quest':'game.paused_real',game:selected,start});});
    }catch(error){if(!stopped&&seen===revision&&!request.signal.aborted)publish({running:true,status:error instanceof Error&&error.message.startsWith('game.')?error.message:'game.unavailable',game:cfg.selected});}
   }}finally{running=false;}
  }
  const settingsChanged=():void=>refresh(true);window.addEventListener(GAME_CHANGE,settingsChanged);const offAccount=watchAccount(()=>refresh());
  ctx.disposable(()=>{stopped=true;revision++;abort?.abort();release?.();offAccount();window.removeEventListener(GAME_CHANGE,settingsChanged);publish({running:false,status:'game.disabled'});});refresh();
 },
});
