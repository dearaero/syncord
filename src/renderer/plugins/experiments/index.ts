import {definePlugin} from '../../api/plugin';
import {t} from '../../i18n';
import {setRunning} from './state';
import {installNativeAccess} from './nativeAccess';

export const Experiments=definePlugin({
 id:'experiments',get name(){return t('exp.name');},get description(){return t('exp.description');},
 enabledByDefault:false,
 permissions:{webpackPatch:true,discordStores:['ExperimentStore','DeveloperExperimentStore'],discordActions:['user-settings']},
 start(ctx){
  ctx.disposable(()=>setRunning(false));
  installNativeAccess(ctx,(root,transform)=>{ctx.patch.after(root,'buildLayout',(_args,result)=>transform(result));});
  setRunning(true);
 },
});
