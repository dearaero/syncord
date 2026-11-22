import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.cwd(),electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(n=>path.join(root,'node_modules/electron/dist',n)).find(existsSync);

function measure(){
 const {scan,uninstallDecorations,usernameCandidates}=api;
 const channel='1425993161108357301',user='1425993161108357191';
 window.Syncord={common:{stores:{UserStore:{getUser:id=>({id,publicFlags:128})},UserProfileStore:{getUserProfile:()=>({badges:[]})},ChannelStore:{getChannel:()=>({id:channel,type:1})}}},webpack:{find:()=>undefined,getRequire:()=>undefined}};
 const host=document.querySelector('ul');
 for(let i=0;i<100;i++){
   const row=document.createElement('li');row.className='messageListItem_fixture';
   row.innerHTML='<div id="chat-messages-'+channel+'-'+i+'"><h3><span id="message-username-'+i+'">User</span></h3><p>Message</p></div>';
   row.querySelector('span').__reactFiber$fixture={memoizedProps:{message:{author:{id:user,public_flags:128},channel_id:channel}}};host.append(row);
 }
 const observer=new MutationObserver(()=>{});observer.observe(host,{subtree:true,attributes:true,childList:true});
 const original=Element.prototype.getBoundingClientRect;let reads=0,readAfterWrite=0;
 Element.prototype.getBoundingClientRect=function(){reads++;if(observer.takeRecords().length)readAfterWrite++;return original.call(this);};
 const candidates=usernameCandidates(host).length;
 const targets=scan(host,14);const first={candidates,geometryReads:reads,readAfterWrite,decorated:host.querySelectorAll('.dion-badges').length,visibleTargets:targets.length};
 observer.takeRecords();reads=readAfterWrite=0;
 scan(host,14);const repeatReads=reads,repeatReadAfterWrite=readAfterWrite;
 Element.prototype.getBoundingClientRect=original;observer.disconnect();
 uninstallDecorations();
 return {...first,repeatReads,repeatReadAfterWrite,clean:!host.querySelector('.dion-badges,[data-dion-badge-user]')};
}
test('badge layout: nested native roots are deduplicated and geometry is read before decoration writes',{skip:!electron,timeout:20000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-decoration-layout-'));
 try{
  await build({stdin:{resolveDir:root,contents:`import {scan,uninstallDecorations} from './src/renderer/plugins/showBadges/inject';import {usernameCandidates} from './src/renderer/ui/userNames';window.api={scan,uninstallDecorations,usernameCandidates};`},bundle:true,platform:'browser',format:'iife',outfile:dir+'/fixture.js',logLevel:'silent'});
  writeFileSync(dir+'/index.html','<!doctype html><html><style>li{height:30px}h3,p{margin:0}</style><body><ul></ul><script src="fixture.js"></script></body></html>');
  writeFileSync(dir+'/main.cjs',`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(dir+'/profile')});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:800,height:600});try{await win.loadFile(${JSON.stringify(dir+'/index.html')});console.log('DECORATION_LAYOUT:'+JSON.stringify(await win.webContents.executeJavaScript('('+${JSON.stringify(measure.toString())}+')()')));win.destroy();app.exit(0)}catch(e){console.error(e);win.destroy();app.exit(1)}});`);
  const run=spawnSync(electron,[dir+'/main.cjs'],{encoding:'utf8',timeout:15000,env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
  assert.equal(run.status,0,run.stdout+'\n'+run.stderr);
  const line=run.stdout.split('\n').find(s=>s.startsWith('DECORATION_LAYOUT:'));assert.ok(line,run.stdout);console.log(line);
  const result=JSON.parse(line.slice('DECORATION_LAYOUT:'.length));
  assert.equal(result.candidates,100);assert.equal(result.geometryReads,100);assert.equal(result.readAfterWrite,0);
  assert.equal(result.decorated,100);assert.equal(result.visibleTargets,1);assert.equal(result.repeatReads,100);assert.equal(result.repeatReadAfterWrite,0);assert.equal(result.clean,true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
