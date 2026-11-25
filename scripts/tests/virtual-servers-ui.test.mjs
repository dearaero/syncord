import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
const root=process.cwd(),electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(p=>path.join(root,'node_modules/electron/dist',p)).find(existsSync);
function setup(){
 window.nativeModuleReady=true;window.observerReady=true;window.fixtureToasts=[];window.account='100';window.allowed=true;window.prefs=new Map();window.listeners=new Set();window.routeListeners=new Set();window.routes=[];window.creates=0;window.unmounts=0;window.paints=0;window.tooltipCount=0;window.disposers=[];
 window.locationFixture={pathname:'/channels/10/11',key:'initial'};history.replaceState({key:'initial'},'',locationFixture.pathname);
 window.channels=Object.freeze({'11':Object.freeze({id:'11',guild_id:'10',parent_id:'99',type:0,name:'general'}),'21':Object.freeze({id:'21',guild_id:'20',type:0,name:'coding'}),'31':Object.freeze({id:'31',type:1,recipients:['200']}),'41':Object.freeze({id:'41',type:3,name:'Weekend group',recipients:['200','300']})});
 const layout=document.createElement('style');layout.textContent='#native-sidebar{display:flex;width:var(--fixture-width,240px);height:var(--fixture-height,600px)}';document.head.append(layout);const react={createElement:(type,props,...children)=>Object.freeze({type,props:Object.freeze({...props,children:children.length===1?children[0]:children})}),cloneElement:(node,props)=>Object.freeze({...node,props:Object.freeze({...node.props,...props})}),isValidElement:n=>!!n&&typeof n==='object'&&'type'in n&&'props'in n};window.fixtureReact=react;
 const refs=[];window.flushRefs=()=>{for(const [node,fn]of refs.splice(0))if(node.isConnected)fn(node);};const mount=value=>{if(value==null||value===false)return document.createTextNode('');if(Array.isArray(value)||typeof value?.type==='symbol'){const f=document.createDocumentFragment();for(const n of Array.isArray(value)?value:[value.props.children])f.append(mount(n));return f;}if(typeof value!=='object')return document.createTextNode(String(value));const node=document.createElement(value.type);for(const[k,v]of Object.entries(value.props)){if(k==='children'||v==null)continue;if(k==='ref'){refs.push([node,v]);continue;}if(k==='inert'){node.inert=v;continue;}if(k.startsWith('on'))node.addEventListener(k.slice(2).toLowerCase(),v);else if(k==='disabled')node.disabled=v;else node.setAttribute(k,String(v));}node.append(mount(value.props.children));return node;};
 window.fixtureMount=mount;window.fixtureRoot=host=>{creates++;return{render:tree=>{host.replaceChildren(mount(tree));flushRefs();},unmount:()=>{unmounts++;host.replaceChildren();}};};
 class Sidebar{
  props={guild:{id:'10'}};
  renderChannelList(){return 'native channels';}renderGuildHeader(){return 'native header';}getGuildBannerHash(){return null;}
  render(){return react.createElement('nav',{'class':'native-sidebar'},this.renderGuildHeader(),this.renderChannelList());}
  forceUpdate(){paints++;const result=this.render(),nav=document.getElementById('native-sidebar');for(const a of [...nav.attributes])if(a.name!=='id')nav.removeAttribute(a.name);for(const[k,v]of Object.entries(result.props)){if(k!=='children'&&v!=null&&typeof v!=='function')nav.setAttribute(k,String(v));}nav.replaceChildren(mount(result.props.children));flushRefs();nav.__reactFiber$fixture={stateNode:this};}
 }
 window.sidebar=new Sidebar();sidebar.forceUpdate();window.originalRender=Sidebar.prototype.render;
 const manager={addRouteChangeListener:fn=>{routeListeners.add(fn);fn(locationFixture,'REPLACE');return()=>routeListeners.delete(fn);},getHistory:()=>({location:locationFixture})};
 const router={transitionTo:path=>{routes.push(path);navigate(path,'PUSH');},back(){},forward(){}};
 window.navigate=(pathname,action,key='key-'+routes.length)=>{locationFixture={pathname,key};history.pushState({key},'',pathname);const id=pathname.split('/')[2];sidebar.props={guild:{id}};document.getElementById('native-chat').dataset.guild=id;document.getElementById('native-members').dataset.guild=id;for(const fn of routeListeners)fn(locationFixture,action);};
 const source={addChangeListener:fn=>listeners.add(fn),removeChangeListener:fn=>listeners.delete(fn)};
 window.Syncord={common:{react:{React:react},stores:{UserStore:{...source,getCurrentUser:()=>({id:account}),getUser:id=>({id,username:'User '+id,avatar:'abc'})},ChannelStore:{...source,getChannel:id=>channels[id],getMutablePrivateChannels:()=>Object.fromEntries(Object.entries(channels).filter(([,c])=>[1,3].includes(c.type))),getMutableGuildChannelsForGuild:id=>Object.fromEntries(Object.entries(channels).filter(([,c])=>c.guild_id===id))},GuildStore:{...source,getGuilds:()=>({'10':{id:'10'},'20':{id:'20'}}),getGuild:id=>['10','20'].includes(id)?{id,name:'Guild '+id}:null},PermissionStore:{...source,can:()=>allowed},ReadStateStore:{...source,hasUnread:()=>false,getMentionCount:()=>0}}},webpack:{findByStoreName:()=>undefined,findByProps:(...p)=>!nativeModuleReady?undefined:p[0]==='transitionTo'?router:p[0]==='addRouteChangeListener'&&observerReady?manager:undefined}};
 window.ctx={settings:{get:k=>prefs.get(k),set:(k,v)=>prefs.set(k,v)},log:{warn(){}},css:{inject:css=>{const s=document.createElement('style');s.textContent=css;document.head.append(s);disposers.push(()=>s.remove());}},disposable:fn=>disposers.push(fn),patch:{after:(...args)=>{const off=api.after(...args);disposers.push(off);return off;}}};
 window.stop=()=>disposers.splice(0).reverse().forEach(fn=>fn());
}
async function checks(){
 const wait=ms=>new Promise(r=>setTimeout(r,ms));const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await wait(10);}throw Error('Virtual fixture timeout '+document.body.innerText);};
 const chat=document.getElementById('native-chat'),members=document.getElementById('native-members'),composer=document.querySelector('textarea');composer.value='draft';const before=JSON.stringify(channels);
 api.startTrial(ctx);await until(()=>api.trialService()?.ready());const service=api.trialService();
 const settings=document.createElement('div');settings.id='Syncord-settings-root';settings.innerHTML=api.virtualSectionHtml();document.body.append(settings);
 const sheet=document.createElement('style');sheet.textContent=api.VIRTUAL_PANEL_CSS;document.head.append(sheet);
 if(settings.querySelectorAll('input').length!==1)throw Error('settings still asks for channel IDs');
 const name=settings.querySelector('input');name.value='My Space';if(getComputedStyle(name).backgroundColor==='rgb(255, 255, 255)')throw Error('unstyled settings input');
 let opened=0;const offCreate=api.bindVirtualPanel(settings,()=>opened++);settings.querySelector('[data-virtual-save]').click();
 if(!service.read()||service.read().channels.length||opened!==1)throw Error('create/open from Settings failed');offCreate();settings.remove();sheet.remove();await until(()=>document.querySelector('[data-syncord-virtual-open]'));
 service.open();await until(()=>document.querySelector('[data-virtual-empty]'));if(routes.length)throw Error('empty server navigated to unrelated channel');
 const scroller=document.getElementById('guild-scroll'),entry=document.querySelector('[data-syncord-virtual-entry]');
 if(entry.parentElement!==scroller)throw Error('virtual entry mounted outside native guild scroller');
 {const home=document.querySelector('[data-list-item-id="guildsnav___home"]').getBoundingClientRect(),button=entry.querySelector('button'),box=button.getBoundingClientRect(),style=getComputedStyle(button);
  if(Math.abs(box.left-home.left)>1||box.width!==36||style.borderTopLeftRadius!=='9px'||entry.style.getPropertyValue('--syncord-virtual-bg')!=='rgb(1, 2, 3)'||!entry.style.getPropertyValue('--syncord-virtual-font').startsWith('700 18px'))throw Error('virtual entry does not copy the native Direct Messages item: '+JSON.stringify([box.left,home.left,box.width,style.borderTopLeftRadius,entry.style.getPropertyValue('--syncord-virtual-font')]));}
 const beforeScroll=entry.getBoundingClientRect().top;scroller.scrollTop=100;await wait(30);
 if(Math.abs(entry.getBoundingClientRect().top-(beforeScroll-100))>1||entry.getBoundingClientRect().bottom>scroller.getBoundingClientRect().top)throw Error('virtual server remains pinned while guild list scrolls');
 scroller.scrollTop=0;

 if(document.querySelector('[data-virtual-picker]').getBoundingClientRect().height>1)throw Error('closed picker consumes space');
 document.querySelector('[data-virtual-add]').click();await until(()=>document.activeElement?.matches('[data-virtual-picker] input'));
 document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await until(()=>document.activeElement?.matches('[data-virtual-add]'));await wait(240);
 if(document.querySelector('[data-virtual-picker]').getAttribute('aria-hidden')!=='true'||!document.querySelector('[data-virtual-picker]').inert)throw Error('closed picker remains accessible');
 document.querySelector('[data-virtual-add]').click();await until(()=>document.querySelector('[data-virtual-choice="11"]'));
 document.querySelector('[data-virtual-choice="11"]').click();await until(()=>document.querySelector('[data-channel-id="11"]'));
 if(document.querySelector('[data-virtual-add]').getAttribute('aria-expanded')!=='false')throw Error('picker did not close after adding');document.querySelector('[data-virtual-add]').click();await until(()=>document.querySelector('[data-virtual-choice="21"]'));document.querySelector('[data-virtual-choice="21"]').click();await until(()=>document.querySelector('[data-channel-id="21"]'));
 if(service.read().channels.length!==2)throw Error('picker did not save channels');
 document.querySelector('[data-channel-id="11"]').click();await until(()=>routes.at(-1)==='/channels/10/11');
 document.querySelector('[data-channel-id="21"]').click();await until(()=>chat.dataset.guild==='20'&&document.querySelector('[data-channel-id="21"]')?.getAttribute('aria-current')==='page');
 // Constrain the owned surface to a narrow/short sidebar, then exercise filter and dismissal.
 document.body.style.setProperty('--fixture-width','180px');document.body.style.setProperty('--fixture-height','420px');
 document.querySelector('[data-virtual-add]').click();await until(()=>document.activeElement?.matches('[data-virtual-picker] input'));await wait(240);
 const picker=document.querySelector('[data-virtual-picker]'),list=document.querySelector('[data-virtual-channel-list]'),surface=document.querySelector('[data-syncord-virtual-sidebar]');
 if(picker.getBoundingClientRect().height>290||list.getBoundingClientRect().height<48||surface.scrollWidth>surface.clientWidth+1)throw Error('picker crowds out channel list or overflows narrow sidebar');
 const search=document.activeElement;search.value='coding';search.dispatchEvent(new Event('change',{bubbles:true}));await until(()=>!document.querySelector('[data-virtual-choice="11"]')&&document.querySelector('[data-virtual-choice="21"]'));
 document.querySelector('[data-virtual-picker-close]').click();await until(()=>document.activeElement?.matches('[data-virtual-add]'));await wait(240);
 if(picker.getBoundingClientRect().height>1)throw Error('dismissed picker still occupies space');
 for(let i=0;i<6;i++)document.querySelector('[data-virtual-add]').click();await wait(250);if(document.querySelector('[data-virtual-add]').getAttribute('aria-expanded')!=='false'||document.querySelector('[data-virtual-picker]').getBoundingClientRect().height>1)throw Error('rapid toggles leave picker stuck');
 document.body.style.removeProperty('--fixture-width');document.body.style.removeProperty('--fixture-height');
 const result={scrollsWithNativeGuilds:true,compactPickerAndKeyboard:true,sourceRoute:routes.at(-1)==='/channels/20/21',sameChat:document.getElementById('native-chat')===chat,sameMembers:document.getElementById('native-members')===members,composerKept:composer.value==='draft',sourceMembersContext:members.dataset.guild==='20',virtualName:document.querySelector('[data-syncord-virtual-sidebar] header').textContent.includes('My Space'),storesUntouched:JSON.stringify(channels)===before};
 document.querySelector('[data-virtual-edit]').click();await until(()=>document.querySelector('[data-virtual-rename]'));
 const rename=document.querySelector('[data-virtual-rename]');rename.value='Focus';rename.dispatchEvent(new Event('change',{bubbles:true}));
 document.querySelector('[data-syncord-virtual-sidebar] form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await until(()=>document.querySelector('[data-syncord-virtual-sidebar] header')?.textContent.includes('Focus'));
 document.querySelector('[data-virtual-edit]').click();await until(()=>document.querySelector('[data-virtual-row-actions]'));
 const row=id=>document.querySelector('[data-channel-id="'+id+'"]').closest('[data-virtual-row]');
 row('11').querySelectorAll('[data-virtual-row-actions] button')[1].click();await until(()=>document.querySelector('[data-virtual-row] [data-channel-id]')?.getAttribute('data-channel-id')==='21');result.reordered=true;
 row('11').querySelector('[data-virtual-row-actions] button:last-child').click();await until(()=>!document.querySelector('[data-channel-id="11"]'));result.removedLocally=!!channels['11'];
 document.querySelector('[data-virtual-add]').click();await until(()=>document.querySelector('[data-virtual-choice="11"]'));document.querySelector('[data-virtual-choice="11"]').click();await until(()=>service.read().channels.length===2);result.renamed=service.read().name==='Focus';await until(()=>document.querySelector('[data-channel-id="11"]'));await wait(25);
 document.querySelector('[data-virtual-options]').click();if(!document.querySelector('#fixture-native-menu #Syncord-virtual-add'))throw Error('header did not use native menu adapter');document.querySelector('#Syncord-virtual-add').click();await until(()=>document.querySelector('[data-virtual-choice="31"]'));
 if(!document.querySelector('[data-virtual-choice="31"] img')||!document.querySelector('[data-virtual-choice="41"] svg'))throw Error('private picker missing DM avatar/group icon');
 document.querySelector('[data-virtual-choice="31"]').click();await until(()=>document.querySelector('[data-channel-id="31"]'));
 document.querySelector('[data-virtual-add]').click();await until(()=>document.querySelector('[data-virtual-choice="41"]'));document.querySelector('[data-virtual-choice="41"]').click();await until(()=>document.querySelector('[data-channel-id="41"]'));
 document.querySelector('[data-channel-id="31"]').click();await until(()=>routes.at(-1)==='/channels/@me/31');if(!document.querySelector('[data-channel-id="31"]').textContent.includes('User 200'))throw Error('DM label missing');
 document.querySelector('[data-channel-id="41"]').click();await until(()=>routes.at(-1)==='/channels/@me/41');result.privateNativeRoutes=chat.dataset.guild==='@me'&&!!document.querySelector('[data-syncord-virtual-sidebar]');
 document.querySelector('[data-channel-id="21"]').click();await until(()=>chat.dataset.guild==='20');
 // Browser DragEvents drive the real scoped handlers; no Discord channel action is invoked.
 document.querySelector('[data-virtual-edit]').click();await until(()=>row('31').draggable);
 const drag=(source,target,after)=>{const dt=new DataTransfer(),from=row(source),to=row(target),rect=to.getBoundingClientRect(),y=after?rect.bottom-1:rect.top+1;from.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));to.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt,clientY:y}));if(to.dataset.virtualDrop!==(after?'after':'before'))throw Error('drop edge not visible');to.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientY:y}));from.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));};
 drag('31','21',false);await until(()=>document.querySelector('[data-virtual-row] [data-channel-id]')?.dataset.channelId==='31');drag('41','21',true);await until(()=>[...document.querySelectorAll('[data-virtual-row] [data-channel-id]')][2]?.dataset.channelId==='41');
 const localOrder=service.read().channels.map(c=>c.channelId).join(',');result.dragOrderSaved=localOrder==='31,21,41,11'&&prefs.get('account.100.trial').channels.map(c=>c.channelId).join(',')===localOrder&&JSON.stringify(channels)===before;
 const external=new DataTransfer();external.setData('application/x-syncord-virtual-channel','11');row('31').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:external}));if(service.read().channels.map(c=>c.channelId).join(',')!==localOrder)throw Error('external drag reordered channels');
 row('31').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));if(!document.querySelector('#fixture-native-menu #Syncord-virtual-down'))throw Error('row missing native context menu');document.querySelector('#Syncord-virtual-down').click();await until(()=>[...document.querySelectorAll('[data-virtual-row] [data-channel-id]')][1]?.dataset.channelId==='31');result.nativeContextOrdering=true;
 document.querySelector('[data-virtual-edit]').click();await until(()=>!row('31').draggable);

 await wait(40);
 const count=paints;for(let i=0;i<200;i++)document.getElementById('native-chat').append(document.createTextNode('message'));for(const fn of listeners)fn();await wait(90);result.unrelatedUpdatesDoNotRepaint=paints===count;
 allowed=false;for(const fn of listeners)fn();await wait(70);result.permissionsDisableRows=[...document.querySelectorAll('[data-channel-id]')].filter(n=>channels[n.dataset.channelId]?.guild_id).every(n=>n.disabled);allowed=true;for(const fn of listeners)fn();await wait(50);
 document.getElementById('real-guild').click();await until(()=>!document.querySelector('[data-syncord-virtual-sidebar]'));result.realGuildExits=true;
 for(let i=0;i<20;i++){service.open();await wait(18);document.querySelector('[data-channel-id="21"]')?.click();await wait(18);document.getElementById('real-guild').click();await wait(18);}result.singleRoot=creates===1;
 const oldHost=document.querySelector('[data-syncord-virtual-entry]'),oldRail=document.querySelector('[data-list-id=guildsnav]');oldRail.remove();const rail=document.createElement('div');rail.dataset.listId='guildsnav';document.body.prepend(rail);await until(()=>rail.contains(oldHost));result.remountUsesSameRoot=creates===1;
 // A new native scroller can hydrate inside the same rail, without replacing it.
 const nested=document.createElement('div');nested.style.cssText='height:100px;overflow-y:auto';nested.innerHTML='<div style="height:500px"><button data-list-item-id="guildsnav___20">native guild</button></div>';rail.append(nested);
 await until(()=>oldHost.parentElement===nested);const nestedTop=oldHost.getBoundingClientRect().top;nested.scrollTop=70;await wait(25);
 result.sameRailScrollerHydration=creates===1&&Math.abs(oldHost.getBoundingClientRect().top-(nestedTop-70))<1&&rail.querySelectorAll('[data-syncord-virtual-entry]').length===1;
 nested.scrollTop=0;

 service.open();await wait(50);const editor=document.createElement('div');editor.innerHTML=api.virtualSectionHtml();document.body.append(editor);const offPanel=api.bindVirtualPanel(editor);
 document.querySelector('[data-virtual-options]').click();const staleRemove=document.querySelector('#Syncord-virtual-close');account='200';for(const fn of listeners)fn();await wait(50);staleRemove?.click();result.nativeMenuAccountCleanup=!document.getElementById('fixture-native-menu');result.accountBoundary=!service.read()&&!document.querySelector('[data-syncord-virtual-sidebar]')&&[...editor.querySelectorAll('input')].every(n=>n.value==='')&&!prefs.has('account.200.trial');offPanel();editor.remove();
 stop();await wait(30);result.cleanup=listeners.size===0&&routeListeners.size===0&&unmounts===1&&tooltipCount===0&&!document.querySelector('[data-syncord-virtual-entry]')&&sidebar.render===originalRender;
 account='100';api.startTrial(ctx);await until(()=>api.trialService()?.read());result.restored=api.trialService().read().name==='Focus'&&api.trialService().read().channels.map(c=>c.channelId).join(',')==='21,31,41,11';stop();
 document.getElementById('native-sidebar').remove();locationFixture={pathname:'/channels/@me',key:'dm'};history.replaceState({key:'dm'},'',locationFixture.pathname);
 const privateOuter=document.createElement('div');privateOuter.setAttribute('data-syncord-private-channels','');document.body.append(privateOuter);
 class PrivateList{
  props={privateChannelIds:[],channels:{}};renderRow(){}renderSection(){}getRowHeight(){return 40;}getSectionHeight(){return 20;}
  _list={getScrollerNode:()=>privateOuter};
  render(){return fixtureReact.createElement('div',{'data-list-id':'private-channels-native'},'native DMs');}
  forceUpdate(){privateOuter.replaceChildren(fixtureMount(this.render()));flushRefs();for(const node of privateOuter.querySelectorAll('*'))node.__reactFiber$fixture={stateNode:this};}
 }
 nativeModuleReady=false;api.startTrial(ctx);api.trialService().clear();api.trialService().save('Empty from Friends');
 await until(()=>document.querySelector('[data-syncord-virtual-open]'));
 let nativeRailClicks=0;const nativeRail=document.querySelector('[data-list-id="guildsnav"]'),nativeClick=()=>nativeRailClicks++;nativeRail.addEventListener('click',nativeClick);
 const pendingButton=document.querySelector('[data-syncord-virtual-open]');result.clickNotSilentlyDisabled=!pendingButton.disabled;
 const toastCount=fixtureToasts.length;pendingButton.click();result.unavailableClickReports=fixtureToasts.length===toastCount+1;
 // Native DM list hydrates after the rail and plugin, with no store or route event.
 const dm=new PrivateList();dm.forceUpdate();
 await until(()=>document.querySelector('[data-syncord-virtual-open]')?.getAttribute('data-virtual-ready')==='true');result.lateSidebarNotifiesRail=true;
 const routesBefore=routes.length;document.querySelector('[data-syncord-virtual-open]').click();await until(()=>privateOuter.querySelector('[data-virtual-empty]'));
 result.emptyDoesNotNeedRouter=!nativeModuleReady;result.ownedClickDoesNotBubble=nativeRailClicks===0;nativeRail.removeEventListener('click',nativeClick);
 // A real channel click still requires the router; local UI must not pretend it opened.
 document.querySelector('[data-virtual-add]').click();await until(()=>document.querySelector('[data-virtual-choice="11"]'));document.querySelector('[data-virtual-choice="11"]').click();await until(()=>document.querySelector('[data-channel-id="11"]'));
 const beforeChannel=fixtureToasts.length;document.querySelector('[data-channel-id="11"]').click();result.channelStillRequiresRouter=fixtureToasts.length===beforeChannel+1&&routes.length===routesBefore;

 result.emptyOpensFromFriends=routes.length===routesBefore&&locationFixture.pathname==='/channels/@me';
 nativeModuleReady=true;observerReady=false;document.querySelector('[data-channel-id="11"]').click();await until(()=>routes.length===routesBefore+1);
 result.routerWithoutObserverOpens=locationFixture.pathname==='/channels/10/11'&&!!privateOuter.querySelector('[data-syncord-virtual-sidebar]');
 const ownKey=history.state.key;for(const fn of listeners)fn();await wait(35);result.confirmedRouteSurvivesSelectionEvents=history.state.key===ownKey&&!!privateOuter.querySelector('[data-syncord-virtual-sidebar]');
history.replaceState({key:'external'},'',locationFixture.pathname);window.dispatchEvent(new PopStateEvent('popstate'));await until(()=>!privateOuter.querySelector('[data-syncord-virtual-sidebar]'));result.untrackedHistoryExits=true;stop();await wait(20);result.privateSidebarRestored=privateOuter.textContent==='native DMs';return result;
}
function driver(dir){
 const {app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{const fs=require('node:fs'),http=require('node:http'),path=require('node:path');const server=http.createServer((req,res)=>{const script=req.url.endsWith('fixture.js');res.setHeader('Content-Type',script?'application/javascript':'text/html');res.end(fs.readFileSync(path.join(dir,script?'fixture.js':'index.html')));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});await win.loadURL('http://127.0.0.1:'+server.address().port+'/channels/10/11');try{const result=await win.webContents.executeJavaScript('('+checks.toString()+')()');console.log('VIRTUAL_UI:'+JSON.stringify(result));app.exit(0);}catch(e){console.error(e);app.exit(1);}});
}
test('Chromium virtual-server creation and management: real-route ownership, untouched native surfaces, permissions, account changes, remounts and cleanup',{skip:!electron},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-virtual-ui-'));
 try{
 await build({stdin:{resolveDir:root,contents:`import {startTrial} from './src/renderer/plugins/virtualServers';import {trialService} from './src/renderer/plugins/virtualServers/service';import {virtualSectionHtml,bindVirtualPanel,VIRTUAL_PANEL_CSS} from './src/renderer/plugins/virtualServers/panel';import {after} from './src/renderer/api/patcher';window.api={startTrial,trialService,virtualSectionHtml,bindVirtualPanel,VIRTUAL_PANEL_CSS,after};`},bundle:true,platform:'browser',format:'iife',outfile:path.join(dir,'fixture.js'),plugins:[{name:'fixture',setup(b){b.onResolve({filter:/api\/plugin$/},()=>({path:'plugin',namespace:'fixture'}));b.onResolve({filter:/discordKit$/},()=>({path:'kit',namespace:'fixture'}));b.onResolve({filter:/ui\/toast$/},()=>({path:'toast',namespace:'fixture'}));b.onResolve({filter:/ui\/tooltip$/},()=>({path:'tooltip',namespace:'fixture'}));b.onResolve({filter:/ui\/nativeTooltip$/},()=>({path:'nativeTooltip',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='plugin'?'export const definePlugin=p=>p;':a.path==='kit'?"export const rootFactory=()=>window.fixtureRoot;export const kit={menu:'div',menuItem:'button',closeContextMenu:()=>document.getElementById('fixture-native-menu')?.remove()};export const scanKit=()=>{kit.react={createElement:(type,props,...children)=>window.fixtureReact.createElement(type,props?.action?{...props,onClick:props.action}:props,...(props?.action?[props.label]:children))};};export const openNativeMenu=(event,view,navId,label)=>{scanKit();kit.closeContextMenu();const host=document.createElement('div');host.id='fixture-native-menu';host.append(window.fixtureMount(view({navId,label,onClose:kit.closeContextMenu})));document.body.append(host);return true;};":a.path==='toast'?'export const ToastType={FAILURE:1};export const showToast=text=>window.fixtureToasts.push(text);':a.path==='nativeTooltip'?'export const nativeTooltipLike=()=>undefined;':'export const bindTooltip=()=>{window.tooltipCount++;return()=>window.tooltipCount--;};'}));}}],logLevel:'silent'});
 writeFileSync(path.join(dir,'index.html'),`<!doctype html><html><body><div data-list-id="guildsnav" style="height:180px;overflow:hidden"><div data-pinned-home style="height:40px;padding-left:20px"><div data-list-item-id="guildsnav___home" style="width:36px;height:36px;border-radius:9px;background:rgb(1, 2, 3)"></div></div><div id="guild-scroll" style="height:140px;overflow-y:auto"><div style="height:1000px"><div style="height:50px;overflow-y:auto"><button id="real-guild" data-list-item-id="guildsnav___10">real</button><div data-list-item-id="guildsnav___11"><span style="position:absolute;width:1px;height:1px;overflow:hidden;font-weight:400">m</span><div style="width:36px;height:36px"><span style="font-weight:700;font-size:18px">m</span></div></div></div></div></div></div><nav id="native-sidebar"></nav><main id="native-chat"><textarea></textarea></main><aside id="native-members"></aside><script src="fixture.js"></script><script>(${setup.toString()})();</script></body></html>`);
 writeFileSync(path.join(dir,'main.cjs'),`const checks=${checks.toString()};(${driver.toString()})(${JSON.stringify(dir)});`);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const run=spawnSync(electron,[path.join(dir,'main.cjs')],{env,encoding:'utf8',timeout:20000});assert.equal(run.status,0,`${run.error??''}\n${run.stdout}\n${run.stderr}`);const line=run.stdout.split('\n').find(l=>l.startsWith('VIRTUAL_UI:'));assert.ok(line,run.stdout);const result=JSON.parse(line.slice('VIRTUAL_UI:'.length));for(const[k,v]of Object.entries(result))assert.equal(v,true,k);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
