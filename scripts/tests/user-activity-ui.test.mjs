import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";

const root=process.cwd();
const electron=["Electron.app/Contents/MacOS/Electron","electron.exe","electron"]
  .map(name=>path.join(root,"node_modules/electron/dist",name)).find(existsSync);

test("activity UI: user selection, avatars, live options, keyboard and panel cleanup",{
  skip:!electron&&"Electron is not installed",timeout:25_000,
},async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),"syncord-activity-ui-"));
  try {
    await build({stdin:{resolveDir:root,loader:"ts",contents:`
      import * as panel from './src/renderer/plugins/userActivity/panel';
      import {startActivity} from './src/renderer/plugins/userActivity/runtime';
      import {settings} from './src/renderer/api/settings';
      import {discordEventStats} from './src/renderer/api/discordEvents';
      window.activityEventStats=discordEventStats;
      window.readActivitySetting = name => settings.get('plugins.user-activity.data.'+name);
      window.setActivityUsers = ids => {settings.set('plugins.user-activity.data.userIds',ids);window.dispatchEvent(new Event('Syncord-user-activity-settings'));};
      const disposers=[];
      startActivity({settings:{get:(key,fallback)=>settings.get('plugins.user-activity.data.'+key,fallback)},
        log:{warn(){}},disposable:fn=>disposers.push(fn)});
      const root=document.getElementById('Syncord-settings-root');
      window.redrawActivityFixture = () => {root.innerHTML='<div class="dion-plugin '+(panel.isActivityExpanded()?'is-open':'')+'"><div class="dion-row">'+panel.activityExpandButtonHtml()+'</div>'+panel.activitySectionHtml()+'</div>';};
      window.redrawActivityFixture();
      const dispose=panel.bindActivityPanel(root);
      window.disposeActivityFixture = () => {dispose();for(const fn of disposers)fn();};
    `},bundle:true,platform:"browser",format:"iife",outfile:path.join(dir,"fixture.js"),logLevel:"warning",
    plugins:[{name:"activity-ui-stubs",setup(b){
      b.onResolve({filter:/\/(toast|settings|logger)$/},args=>({path:args.path.split("/").pop(),namespace:"fixture"}));
      b.onLoad({filter:/.*/,namespace:"fixture"},args=>({loader:"js",contents:args.path==="settings"
        ? `const data=new Map(); export const settings={get:(key,fallback)=>data.has(key)?data.get(key):fallback,set:(key,value)=>data.set(key,value)};`
        : args.path==="toast" ? `export const showToast=()=>{};` : `export const createLogger=()=>({info(){},warn(){}});`}));
    }}]});
    const USER="1425993161108357191";
    const settingsSource=readFileSync(path.join(root,"src/renderer/ui/settingsPanel.ts"),"utf8");
    const begin=settingsSource.indexOf('    #${ROOT_ID} .dion-ua-selected');
    const end=settingsSource.indexOf('    #${ROOT_ID} .dion-plugin-details {',begin);
    const buttonsBegin=settingsSource.indexOf('    #${ROOT_ID} .dion-close,');
    const buttonsEnd=settingsSource.indexOf('    #${ROOT_ID} .dion-main-divider {',buttonsBegin);
    const css=(settingsSource.slice(buttonsBegin,buttonsEnd)+settingsSource.slice(begin,end)).replaceAll('${ROOT_ID}','Syncord-settings-root');
    writeFileSync(path.join(dir,"index.html"),`<!doctype html><html><head><style>
      body{font:14px sans-serif;background:#232428;color:white;margin:0;}#Syncord-settings-root{padding:20px;width:calc(100% - 40px);box-sizing:content-box;}
      .dion-plugin-details{display:none}.is-open .dion-plugin-details{display:block}.dion-setting-row{display:flex;justify-content:space-between;gap:10px;margin:12px 0;}
      .dion-switch{flex-shrink:0}.dion-field-row{display:flex;justify-content:space-between;gap:12px;margin:12px 0}.dion-setting-desc{font-size:12px;color:#ccc;}
      ${css}
    </style></head><body><div id="Syncord-settings-root"></div><script>
      const user={id:'${USER}',username:'alice',globalName:'Alice <img onerror="bad">',avatar:'hash',getAvatarURL:()=> 'https://cdn.discordapp.com/avatars/user/hash.png'};
      const other={...user,id:'1425993161108357192',username:'bob',globalName:'Bob'};
      window.eventSubscriptions=new Map();window.Syncord={common:{flux:{FluxDispatcher:{
        dispatch:()=>{},subscribe:(type,fn)=>eventSubscriptions.set(type,fn),unsubscribe:(type)=>eventSubscriptions.delete(type)}},stores:{
        UserStore:{getCurrentUser:()=>({id:"1425993161108357999"}),getUser:id=>id===user.id?user:id===other.id?other:undefined,getUsers:()=>({[user.id]:user,[other.id]:other})},
        RelationshipStore:{getFriendIDs:()=>[user.id,other.id]},PresenceStore:{getStatus:()=> 'offline',getActivities:()=>[]}
      }}};
    </script><script src="fixture.js"></script></body></html>`);
    // Build the Electron driver from a function, avoiding nested template escaping.
    function driver(file){
      const {app,BrowserWindow}=require("electron");
      app.setPath("userData",require("node:path").join(require("node:path").dirname(file),"profile"));
      app.disableHardwareAcceleration();
      app.whenReady().then(async()=>{
        const win=new BrowserWindow({width:600,height:900,show:false,frame:false,webPreferences:{backgroundThrottling:false}});
        win.webContents.session.webRequest.onBeforeRequest({urls:["https://*/*"]},(_details,callback)=>callback({cancel:true}));
        try {
          await win.loadFile(file);
          const result=await win.webContents.executeJavaScript(`(async()=>{
            const q=selector=>document.querySelector(selector);
            const click=selector=>q(selector).click();
            const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
            const out={initialSubscriptions:window.activityEventStats().listeners};
            click('[data-dion-ua-expand]');
            const input=q('[data-dion-ua-search]');input.focus();input.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));
            out.options=document.querySelectorAll('[data-dion-ua-user]').length;
            out.avatar=!!q('[data-dion-ua-results] img');
            q('[data-dion-ua-results] img').dispatchEvent(new Event('error'));
            out.avatarFallback=!!q('[data-dion-ua-results] .dion-ua-initial');
            out.escaped=!q('[data-dion-ua-results] [onerror]');
            input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
            out.keyboard=document.activeElement.hasAttribute('data-dion-ua-user');
            document.activeElement.click();
            out.selected=window.readActivitySetting('userId');
            out.name=q('[data-dion-ua-selected]').textContent;
            out.subscriptions=window.activityEventStats().listeners;
            out.closed=q('[data-dion-ua-results]').hidden;
            input.click();out.remainingOptions=document.querySelectorAll('[data-dion-ua-user]').length;
            input.value='1425993161108357192';click('[data-dion-ua-use-id]');
            out.multiple=window.readActivitySetting('userIds');
            out.multipleRows=document.querySelectorAll('[data-dion-ua-tracked]').length;
            out.count=q('[data-dion-ua-count]').textContent;
            out.clearFits=q('[data-dion-ua-clear]').scrollWidth<=q('[data-dion-ua-clear]').clientWidth;
            out.sharedSubscriptions=window.activityEventStats().listeners===out.subscriptions;
            click('[data-dion-ua-log="1425993161108357192"]');await pause();
            const log=document.getElementById('Syncord-user-activity-history');
            out.logModal=log?.matches(':modal');out.logPerson=log?.querySelector('h2').textContent;
            log.querySelector('[data-ua-log-close]').click();
            window.redrawActivityFixture();
            out.restoredRows=document.querySelectorAll('[data-dion-ua-tracked]').length;
            q('[data-dion-ua-search]').value='1425993161108357191';click('[data-dion-ua-use-id]');
            out.duplicate=q('[data-dion-ua-error]').textContent;
            out.duplicateCount=window.readActivitySetting('userIds').length;
            click('[data-dion-ua-remove="1425993161108357192"]');
            out.removed=window.readActivitySetting('userIds');
            const activeInput=q('[data-dion-ua-search]');
            activeInput.focus();activeInput.value='not an ID';click('[data-dion-ua-use-id]');
            out.invalid=q('[data-dion-ua-error]').textContent;
            out.unchanged=window.readActivitySetting('userId');
            activeInput.focus();activeInput.dispatchEvent(new Event('input',{bubbles:true}));await pause();
            activeInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
            out.escape=q('[data-dion-ua-results]').hidden;
            const ids=Array.from({length:32},(_,i)=>String(1425993161108357200n+BigInt(i)));
            window.setActivityUsers(ids);window.redrawActivityFixture();
            q('[data-dion-ua-search]').value='1425993161108357999';click('[data-dion-ua-use-id]');
            out.limit=q('[data-dion-ua-error]').textContent;
            out.limitCount=window.readActivitySetting('userIds').length;
            const selectedList=q('[data-dion-ua-selected]');
            out.scrollable=selectedList.scrollHeight>selectedList.clientHeight;
            click('[data-dion-ua-remove="'+ids[0]+'"]');
            q('[data-dion-ua-search]').value='1425993161108357999';click('[data-dion-ua-use-id]');
            out.replaced=window.readActivitySetting('userIds').includes('1425993161108357999');
            click('[data-dion-ua-clear]');out.cleared=window.readActivitySetting('userIds');
            out.clearStopped=window.activityEventStats().listeners;
            out.clearHidden=q('[data-dion-ua-clear]').hidden;
            q('[data-dion-ua-search]').value='1425993161108357191';click('[data-dion-ua-use-id]');
            const flag=q('[data-dion-ua-flag="typing"]');flag.checked=false;flag.dispatchEvent(new Event('change',{bubbles:true}));
            out.typing=window.readActivitySetting('typing');
            const interval=q('[data-dion-ua-number="notificationInterval"]');interval.value='0';interval.dispatchEvent(new Event('change',{bubbles:true}));
            out.interval=interval.value;
            const paused=q('[data-dion-ua-flag="paused"]');paused.checked=true;paused.dispatchEvent(new Event('change',{bubbles:true}));
            out.paused=window.activityEventStats().listeners;
            out.status=q('[data-dion-ua-status]').textContent;
            const root=document.getElementById('Syncord-settings-root'), bounds=root.getBoundingClientRect();
            out.overflow=root.scrollWidth>bounds.width+1;
            window.disposeActivityFixture();
            out.stopped=window.activityEventStats().listeners;
            return out;
          })()`);
          win.setContentSize(340,900);
          result.smallOverflow=await win.webContents.executeJavaScript(`(()=>{
            window.setActivityUsers(Array.from({length:32},(_,i)=>String(1425993161108357200n+BigInt(i))));
            window.redrawActivityFixture();
            const root=document.getElementById('Syncord-settings-root');return root.scrollWidth>root.getBoundingClientRect().width+1;
          })()`);
          console.log("ACTIVITY_UI_RESULT:"+JSON.stringify(result));win.destroy();app.exit(0);
        }catch(error){console.error(error.stack);win.destroy();app.exit(1);}
      });
    }
    writeFileSync(path.join(dir,"main.cjs"),`(${driver.toString()})(${JSON.stringify(path.join(dir,"index.html"))});`);
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const run=spawnSync(electron,[path.join(dir,"main.cjs")],{env,encoding:"utf8",timeout:20_000});
    assert.equal(run.status,0,`${run.error??""}\n${run.stdout}\n${run.stderr}`);
    const line=run.stdout.split("\n").find(line=>line.startsWith("ACTIVITY_UI_RESULT:"));assert.ok(line);
    const result=JSON.parse(line.slice("ACTIVITY_UI_RESULT:".length));
    assert.equal(result.initialSubscriptions,0);assert.equal(result.options,2,JSON.stringify(result));assert.equal(result.avatar,true);assert.equal(result.avatarFallback,true);assert.equal(result.escaped,true);
    assert.equal(result.keyboard,true);assert.equal(result.selected,USER);assert.match(result.name,/Alice <img/);
    assert.deepEqual(result.multiple,[USER,"1425993161108357192"]);assert.equal(result.multipleRows,2);
    assert.equal(result.count,"Tracking 2 / 32 users");assert.equal(result.clearFits,true);assert.equal(result.sharedSubscriptions,true);assert.equal(result.logModal,true);assert.match(result.logPerson,/Bob/);assert.equal(result.restoredRows,2);
    assert.equal(result.remainingOptions,1);assert.match(result.duplicate,/Already tracking/);assert.equal(result.duplicateCount,2);
    assert.deepEqual(result.removed,[USER]);assert.match(result.limit,/Track up to 32/);assert.equal(result.limitCount,32);assert.equal(result.scrollable,true);
    assert.equal(result.replaced,true);assert.deepEqual(result.cleared,[]);assert.equal(result.clearStopped,0);assert.equal(result.clearHidden,true);
    assert.ok(result.subscriptions>0);assert.equal(result.closed,true);assert.match(result.invalid,/valid Discord user ID/);
    assert.equal(result.unchanged,USER);assert.equal(result.escape,true);assert.equal(result.typing,false);assert.equal(result.interval,"5");
    assert.equal(result.paused,15);assert.equal(result.status,"Notifications paused · logging events");assert.equal(result.overflow,false);assert.equal(result.smallOverflow,false);assert.equal(result.stopped,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
