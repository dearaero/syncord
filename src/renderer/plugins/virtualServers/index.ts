import {BodyMutationObserver} from "../../ui/bodyObserver";
import {definePlugin,type PluginContext} from '../../api/plugin';
import {canonicalMessage,getLocale,onLocaleChange,t} from '../../i18n';
import {rootFactory,type Root} from '../../discordKit';
import {registerDmView} from '../../ui/privateChannelView';
import {workspace,closePicker,type WorkspaceState} from './workspace';
import {getFiber} from '../../ui/userNames';
import {showToast,ToastType} from '../../ui/toast';
import {bindTooltip} from '../../ui/tooltip';
import {isNativeReact,type NativeReact,type ElementLike} from '../dmFilters/native';
import {accountId,channelFor,channelChoices,channelLabel,guildName,unread,routing,routeLocation,store,type FluxStore} from './discord';
import {normalizeTrial,reorderChannels,routeFor,VirtualNavigation,type Trial,type ChannelRef} from './model';
import {isSidebar,projectSidebar,type NativeSidebar} from './projection';
import {registerTrialService} from './service';
import {createVirtualMenu} from './menu';
import {railMountPoint,railStructureChanged} from './rail';
import {CSS} from './styles';

const RAIL='[data-list-id="guildsnav"]';
export const VirtualServersPlugin=definePlugin({
 id:'virtual-servers',name:canonicalMessage('virtual.pluginName'),get description(){return t('virtual.description');},enabledByDefault:false,
 permissions:{media:true,userData:true,webpackPatch:true,discordStores:['UserStore','GuildStore','ChannelStore','PermissionStore','ReadStateStore','SelectedChannelStore','SelectedGuildStore'],discordActions:['channel-navigation']},
 start(ctx){startTrial(ctx);},
});
/** Local organization; Discord retains ownership of actual routes and chat. */
export function startTrial(ctx:PluginContext):void {
 let layoutDirty=true,lastView='',lastRail='';
 let stopped=false,frame=0,account=accountId(),trial:Trial|undefined,root:Root|undefined,host:HTMLElement|undefined,rail:Element|undefined,offTooltip:(()=>void)|undefined;
 let lastRoutingAttempt=-Infinity;
 let navigationApi:ReturnType<typeof routing>,offRoute:(()=>void)|undefined;
 const supported=new WeakSet<NativeSidebar>();
 const subscribed=new Set<string>();
 const entries=new Map<NativeSidebar,Element>(),patches=new Map<object,()=>void>(),offs:(()=>void)[]=[];
 const key=(id:string)=>`account.${id}.trial`;
 const load=():void=>{trial=account?normalizeTrial(ctx.settings.get(key(account))):undefined;};load();
 const menu=createVirtualMenu(()=>!stopped&&sameAccount());ctx.disposable(menu.dispose);
 const navigation=new VirtualNavigation(()=>trial);
 const ui:WorkspaceState={adding:false,editing:false,name:'',query:'',choices:[]};
 const react=():NativeReact|undefined=>{const value=window.Syncord?.common?.react.React;return isNativeReact(value)?value:undefined;};
 const sameAccount=():boolean=>!!account&&accountId()===account;
 const ready=():boolean=>!stopped&&sameAccount()&&!!react()&&(dmView.available()||[...entries].filter(([instance,node])=>node.isConnected&&supported.has(instance)).length===1);
 const refresh=():void=>{if(!stopped&&!frame)frame=requestAnimationFrame(paint);};
 const failOpen=(stage:'account'|'react'|'sidebar'|'router'|'route'):false=>{ctx.log.warn(`Virtual server open unavailable: ${stage}`);showToast(t('virtual.notReady'),{type:ToastType.FAILURE});return false;};
 const exit=():void=>{closePicker(ui,false);ui.editing=false;navigation.exit();refresh();};
 const open=(ref?:ChannelRef):boolean=>{
  if(!ready()||!trial)return failOpen(!sameAccount()?'account':!react()?'react':'sidebar');
  connectRouting(true);
  closePicker(ui,false);
  const target=ref??trial.channels.find(c=>c.channelId===navigation.selected&&channelFor(c))??trial.channels.find(c=>channelFor(c));
  if(!target||(!ref&&!navigationApi)){navigation.enter(routeLocation(navigationApi?.manager));refresh();return true;}
  if(!navigationApi)return failOpen('router');
  if(!trial.channels.some(c=>c.guildId===target.guildId&&c.channelId===target.channelId)||!channelFor(target))return false;
  navigation.begin(target);
  try{navigationApi!.router.transitionTo(routeFor(target));const location=routeLocation(navigationApi.manager);if(location.pathname!==routeFor(target)){navigation.exit();refresh();return failOpen('route');}navigation.confirm(location);refresh();return true;}
  catch{navigation.exit();refresh();return failOpen('router');}
 };
 const persist=(value:Trial):boolean=>{
  if(stopped||!sameAccount())return false;const normalized=normalizeTrial(value);if(!normalized)return false;
  ctx.settings.set(key(account!),normalized);trial=normalized;refresh();return true;
 };
 const contents=(r:NativeReact,current:Trial):unknown=>{
  const expected=account,valid=()=>!stopped&&!!expected&&accountId()===expected&&trial===current;
  return workspace(r,current,navigation.selected,ui,{
   menu:(event,label,items)=>{if(valid())menu.open(event,label,items.map(item=>({...item,action:()=>{if(valid())item.action();}})));},
   open:ref=>{if(valid())open(ref);},exit,refresh,
   add:()=>{if(!valid())return;if(ui.adding)closePicker(ui);else{ui.adding=true;ui.editing=false;ui.query='';ui.choices=channelChoices();ui.focus='search';}refresh();},
   rename:name=>valid()&&persist({...current,name}),
   select:ref=>{if(!valid()||!channelFor(ref)||current.channels.length>=100||current.channels.some(c=>c.channelId===ref.channelId))return;if(persist({...current,channels:[...current.channels,ref]}))closePicker(ui);},
   remove:id=>{if(valid())persist({...current,channels:current.channels.filter(c=>c.channelId!==id)});},
   reorder:(source,target,after)=>{if(valid())persist({...current,channels:reorderChannels(current.channels,source,target,after)});},
   move:(id,delta)=>{if(!valid())return;const list=[...current.channels],index=list.findIndex(c=>c.channelId===id),next=index+delta;if(index<0||next<0||next>=list.length)return;[list[index],list[next]]=[list[next],list[index]];persist({...current,channels:list});},
  });
 };
 const dmView=registerDmView(ctx,{availabilityChanged:()=>{refresh();},content:r=>!stopped&&sameAccount()&&navigation.active&&trial?r.createElement('div',{'data-list-id':'private-channels-syncord-virtual'},contents(r,trial)):undefined});
 const updateInstances=():void=>{for(const [instance,node]of entries){if(!node.isConnected){entries.delete(instance);continue;}try{instance.forceUpdate();}catch{entries.delete(instance);}}};
 const connectRouting=(force=false):void=>{
  if(offRoute)return;
  const now=performance.now();if(!force&&(navigationApi||now-lastRoutingAttempt<1000))return;
  lastRoutingAttempt=now;const api=routing();if(!api)return;navigationApi=api;
  if(!api.manager)return;
  try{offRoute=api.manager.addRouteChangeListener((location,action)=>{if(!sameAccount())navigation.reset();else navigation.settle(location,action);refresh();});}
  catch{ctx.log.warn('Native route observer unavailable; using confirmed browser history.');}
 };
 const scanSidebars=():void=>{
  for(const nav of document.querySelectorAll('nav')){
   if(nav.closest('[role="dialog"],[data-syncord-private-channels],#Syncord-settings-root,.sn-workspace'))continue;
   let fiber=getFiber(nav) as {stateNode?:unknown;return?:unknown}|null;
   for(let depth=0;fiber&&depth<24;depth++,fiber=fiber.return as typeof fiber){
    const instance=fiber.stateNode;if(!isSidebar(instance))continue;
    const prototype=Object.getPrototypeOf(instance) as {render:()=>unknown};
    if(!patches.has(prototype)){
     try{
      const undo=ctx.patch.after(prototype,'render',function(this:NativeSidebar,_args,result){
       const r=react();if(!entries.has(this)||!r)return result;
       const compatible=r.isValidElement(result)&&(result as ElementLike).type==='nav';
       if(compatible&&!supported.has(this)){supported.add(this);refresh();}else if(!compatible&&supported.has(this)){supported.delete(this);navigation.exit();refresh();}
       if(stopped||!compatible||!sameAccount()||!navigation.active||!trial)return result;
       return projectSidebar(result,r,contents(r,trial),trial.name);
      });patches.set(prototype,undo);
     }catch{ctx.log.warn('Native guild sidebar projection is unavailable.');continue;}
    }
    entries.set(instance,nav);break;
   }
  }
 };
 const mountRail=():void=>{
  const native=document.querySelector(RAIL)??document.querySelector('[data-list-item-id="guildsnav___home"]')?.closest('[role="tree"]');if(!native)return;
  const mount=railMountPoint(native);
  if(native!==rail||host?.parentElement!==mount){
   // One owned root for the plugin's entire lifetime, reattached on native remounts.
   if(!host){const factory=rootFactory();if(!factory)return;host=document.createElement('div');host.dataset.syncordVirtualEntry='';host.setAttribute('role','group');root=factory(host);}
   // Participate in the native scroller's normal flow, outside pinned rail controls.
   mount.prepend(host);rail=native;
  }
 };
 function paint():void {
  frame=0;if(stopped)return;
  const next=accountId();if(next!==account){menu.dispose();account=next;navigation.reset();load();ui.adding=ui.editing=false;ui.name=ui.query='';ui.choices=[];ui.focus=undefined;ui.drag=undefined;lastView=lastRail='';}
  const remount=layoutDirty;listenStores();connectRouting();if(!offRoute&&navigation.active)navigation.observe(routeLocation(navigationApi?.manager));if(layoutDirty){layoutDirty=false;scanSidebars();mountRail();}
  if([...entries.values()].filter(node=>node.isConnected).length>1)navigation.exit();
  const r=react();if(r&&root&&host){
   const current=sameAccount()?trial:undefined;
   const states=current?.channels.map(unread)??[],mentions=states.reduce((sum,s)=>sum+s.mentions,0);
   host.hidden=!current;
   const railKey=JSON.stringify([getLocale(),current?.name,navigation.active,mentions,states.some(s=>s.unread),ready()]);
   if(railKey!==lastRail||remount){lastRail=railKey;root.render(current?r.createElement('button',{type:'button','data-syncord-virtual-open':'','aria-label':current.name,'aria-pressed':navigation.active,'data-unread':states.some(s=>s.unread),'data-virtual-ready':ready(),onClick:(event:{preventDefault:()=>void;stopPropagation:()=>void})=>{event.preventDefault();event.stopPropagation();open();}},current.name.slice(0,2).toLocaleUpperCase(),mentions?r.createElement('small',null,Math.min(mentions,99)):null):null);}
   if(!current){offTooltip?.();offTooltip=undefined;}
   // React commits asynchronously; the shared tooltip binds after commit.
  }
  const viewKey=JSON.stringify([getLocale(),account,trial?.name,navigation.active,navigation.selected,ui.adding,ui.editing,ui.name,ui.query,trial?.channels.map(ref=>[ref.guildId,ref.channelId,channelLabel(ref),guildName(ref.guildId),unread(ref).mentions])]);
  if(viewKey!==lastView||remount){lastView=viewKey;updateInstances();dmView.refresh();}
 }
 const observer=new BodyMutationObserver(records=>{
  if(stopped)return;
  const button=host?.querySelector<HTMLElement>('[data-syncord-virtual-open]');
  if(button&&!offTooltip)offTooltip=bindTooltip(button,()=>ready()?trial?.name??t('virtual.name'):t('virtual.notReady'),{position:'right'});
  if(host&&!host.isConnected){layoutDirty=true;refresh();return;}
  if([...entries.values()].some(node=>!node.isConnected)){layoutDirty=true;refresh();return;}
  if(records.some(record=>railStructureChanged(rail,record))){layoutDirty=true;refresh();return;}
  // Chat rows/keystrokes and our own navigation changes cannot schedule a scan.
  for(const record of records)for(const node of record.addedNodes){if(!(node instanceof Element)||node.closest('[data-syncord-virtual-entry],[data-syncord-virtual-sidebar],[role="log"],[data-slate-editor],[data-list-id^="chat-messages"]'))continue;
   if(node.matches('nav,'+RAIL)||node.querySelector('nav,'+RAIL)){layoutDirty=true;refresh();return;}}
 });
 observer.observe(document.body,{childList:true,subtree:true});
 const untrackedNavigation=():void=>{if(!offRoute){navigation.observe(routeLocation(navigationApi?.manager));refresh();}};
 const historyPopped=():void=>{if(!offRoute){navigation.settle(routeLocation(navigationApi?.manager),'POP');refresh();}};
 window.addEventListener('popstate',historyPopped);
 const nativeClick=(event:Event):void=>{const target=event.target;if(!(target instanceof Element)||target.closest('[data-syncord-virtual-entry],[data-syncord-virtual-sidebar]'))return;
  if(target.closest('[data-list-item-id^="guildsnav___"]'))exit();
 };
 document.addEventListener('click',nativeClick,true);
 function listenStores():void {
  for(const name of ['UserStore','ChannelStore','GuildStore','PermissionStore','ReadStateStore','SelectedChannelStore','SelectedGuildStore']){
   if(subscribed.has(name))continue;
   const value=store<FluxStore>(name);if(!value?.addChangeListener||!value.removeChangeListener)continue;
   const callback=name==='SelectedChannelStore'||name==='SelectedGuildStore'?()=>{untrackedNavigation();refresh();}:refresh;
   try{value.addChangeListener(callback);subscribed.add(name);offs.push(()=>value.removeChangeListener?.(callback));}catch{/* Missing subscription is not permission. */}
  }
 }
 offs.push(onLocaleChange(refresh));
 const service=registerTrialService({
  read:()=>sameAccount()?trial:undefined,ready,
  save:name=>{
   if(stopped||!sameAccount())return false;
   return persist({id:'virtual:trial',name,channels:trial?.channels??[]});
  },open:()=>open(),clear:()=>{if(!stopped&&sameAccount()){ctx.settings.set(key(account!),null);trial=undefined;navigation.reset();refresh();}},
 });
 ctx.disposable(()=>{stopped=true;if(frame)cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('popstate',historyPopped);document.removeEventListener('click',nativeClick,true);offRoute?.();for(const off of offs)try{off();}catch{/* A closing native store cannot prevent remaining cleanup. */}service();offTooltip?.();navigation.reset();for(const undo of patches.values())undo();patches.clear();updateInstances();entries.clear();root?.unmount();host?.remove();trial=undefined;ui.choices=[];ui.drag=undefined;});
 ctx.css.inject(CSS);paint();
}
