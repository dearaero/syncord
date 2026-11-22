import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root=process.cwd();
const electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(n=>path.join(root,'node_modules/electron/dist',n)).find(existsSync);
test('notes UI: native navigation, autosave, account isolation, imports, Markdown safety, responsive layout and cleanup', {skip:!electron&&'Electron is not installed',timeout:35_000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-notes-ui-'));
 try{
  await build({stdin:{resolveDir:root,loader:'ts',contents:`
   import {NotesPlugin} from './src/renderer/plugins/notes';
   import {NotesStore,createNote} from './src/renderer/plugins/notes/store';
   import {renderMarkdown} from './src/renderer/plugins/notes/markdown';
   window.api={NotesPlugin,NotesStore,createNote,renderMarkdown};
   const data=new Map(),disposers=[];
   const ctx={settings:{get:(key,fallback)=>data.get(key)??fallback,set:(key,value)=>data.set(key,value)},
    log:{warn(){},info(){}},css:{inject(text){const style=document.createElement('style');style.textContent=text;document.head.appendChild(style);disposers.push(()=>style.remove());}},disposable:fn=>disposers.push(fn)};
   window.startNotes=()=>NotesPlugin.start(ctx);window.stopNotes=async()=>{for(const fn of disposers.splice(0).reverse())fn();await NotesPlugin.stop(ctx);};
   window.readPreference=key=>data.get(key);
   startNotes();
  `},bundle:true,platform:'browser',outfile:dir+'/fixture.js',logLevel:'silent',plugins:[{name:'notes-test-stubs',setup(b){
   b.onResolve({filter:/\/api\/plugin$/},args=>({path:'plugin',namespace:'notes-fixture'}));
   b.onResolve({filter:/\/ui\/toast$/},args=>({path:'toast',namespace:'notes-fixture'}));
   b.onLoad({filter:/.*/,namespace:'notes-fixture'},args=>({loader:'js',contents:args.path==='plugin'?'export const definePlugin=def=>def;':'export const ToastType={FAILURE:"failure"};export const toast={show:()=>{}};'}));
  }}]});
  writeFileSync(dir+'/index.html',`<!doctype html><html><head><meta charset="UTF-8"><style>
   body{--background-modifier-selected:rgb(70,70,70);--interactive-active:white;user-select:none;margin:0;background:#17171b;color:#eee}#layout{display:flex;width:100vw;height:100vh}#sidebar{width:240px;flex:none}.privateChannels_test{height:100%;padding:10px;box-sizing:border-box}.selected_test,.interactiveSelected_test,.linkButtonSelected_test{background:rgb(70,70,70)!important;color:white}.interactive_test{border-radius:8px}#sidebar a:hover{background:rgb(36,36,41)}a{display:block;color:inherit;padding:12px;text-decoration:none}.name_test{display:inline-block}svg{width:20px;height:20px;margin-right:8px;vertical-align:middle}#chat{flex:1;min-width:0;height:100%;position:relative}.native-chat{height:100%;padding:20px;box-sizing:border-box}
  </style></head><body><div id="layout"><div id="sidebar"><nav class="privateChannels_test"><input placeholder="Sohbet bul ya da başlat"><div class="channel_test selected_test"><a class="interactive_test interactiveSelected_test linkButtonSelected_test" aria-selected="true" data-selected="true" href="/channels/@me"><svg viewBox="0 0 24 24"><path d="M0 0"/></svg><span class="name_test">Arkadaşlar</span></a></div><a href="/channels/@me/123">Alice</a><a href="/store">Mağaza</a></nav></div><div id="chat"><main class="native-chat" role="main">Native DM</main></div></div><script>
   window.account='900'+Date.now();window.Syncord={common:{stores:{UserStore:{getCurrentUser:()=>({id:account})}}}};
   window.downloads=[];const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{downloads.push(blob);return create(blob);};
   document.addEventListener('click',event=>{if(event.target.closest('a'))event.preventDefault();},true);
  </script><script src="fixture.js"></script></body></html>`);
  function driver(file){
   const {app,BrowserWindow}=require('electron');app.disableHardwareAcceleration();
   app.whenReady().then(async()=>{
    const win=new BrowserWindow({show:false,width:1240,height:850,frame:false,webPreferences:{backgroundThrottling:false}});
    win.webContents.on('console-message',(_event,details)=>console.log('RENDERER:'+details.message));
    try{
     await win.loadFile(file);
     const result=await win.webContents.executeJavaScript(String.raw`(async()=>{
      const q=s=>document.querySelector(s),pause=(ms=80)=>new Promise(r=>setTimeout(r,ms));
      const clickText=(text,scope='.sn-workspace')=>{const b=[...document.querySelectorAll(scope+' button')].find(e=>e.textContent===text);if(!b)throw Error('button missing: '+text);b.click();};
      const input=(selector,value)=>{const e=q(selector);e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));};
      const assert=(condition,message)=>{if(!condition)throw Error(message);};
      const open=async()=>{q('[data-syncord-notes-nav] a').click();await pause(250);assert(q('.sn-source'),'workspace did not open');};
      await pause(100);
      assert(q('[data-syncord-notes-nav]').nextElementSibling.querySelector('a[href="/channels/@me"]'),'Notes must precede Friends');
      const inactiveLink=q('[data-syncord-notes-nav] .sn-nav-link');
      assert(!inactiveLink.classList.contains('interactiveSelected_test')&&!inactiveLink.classList.contains('linkButtonSelected_test')&&!inactiveLink.hasAttribute('aria-selected'),'cloned selection state survived');
      assert(getComputedStyle(inactiveLink).backgroundColor==='rgba(0, 0, 0, 0)','inactive Notes must be transparent');
      await open();
      assert(getComputedStyle(q('[data-syncord-notes-nav] .sn-nav-link')).backgroundColor!=='rgba(0, 0, 0, 0)','active Notes missing selection');
      assert(q('.sn-header').parentElement===q('.sn-document')&&!q('.sn-list-panel .sn-header'),'header must sit above editor, not note list');
      assert(!q('.sn-list-panel')&&q('.sn-tabs').parentElement===q('.sn-document'),'vertical note sidebar must be replaced by top tabs');
      assert(q('.sn-tabs').getBoundingClientRect().bottom<=q('.sn-header').getBoundingClientRect().top,'tabs must sit at very top');
      assert(q('.sn-list').getAttribute('role')==='tablist'&&q('.sn-note-row').getAttribute('role')==='tab','notes must be accessible tabs');
      const friends=q('#sidebar a[href="/channels/@me"]');
      assert(friends.classList.contains('interactiveSelected_test')&&friends.getAttribute('aria-selected')==='true','native selection state must not be mutated');
      assert(getComputedStyle(friends).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(friends.parentElement).backgroundColor==='rgba(0, 0, 0, 0)','previous native selected row still highlighted');
      for(const selector of ['.sn-search','select[aria-label="New note template"]','select[aria-label="Filter notes"]','select[aria-label="Sort notes"]','input[type=file]']){
        assert(q(selector).closest('.sn-manager')?.parentElement===q('.sn-document'),'management control must sit above editor: '+selector);
      }
      for(const label of ['+ New','Import','Back up'])assert([...q('.sn-manager').querySelectorAll('button')].some(e=>e.textContent===label),'missing management action: '+label);
      assert(q('.native-chat').inert&&getComputedStyle(q('.native-chat')).visibility==='hidden','native pane not covered');
      assert(!q('#sidebar').inert&&getComputedStyle(q('#sidebar')).visibility!=='hidden','sidebar must stay available');
      assert(getComputedStyle(q('.sn-source')).userSelect==='text','editor text cannot be selected');
      const welcome=q('.sn-source').value;assert(welcome.includes('# Welcome to Notes'),'welcome missing');
      assert(q('.sn-header strong').textContent==='Notes'&&q('.sn-nav-link').getAttribute('aria-label')==='Notes','English workspace/navigation labels missing');
      const template=q('select[aria-label="New note template"]');template.value='meeting';clickText('+ New');await pause(150);
      assert(q('.sn-title').value==='Meeting'&&q('.sn-source').value.startsWith('# Meeting notes'),'meeting template must be English');
      assert(!q('.sn-tags')&&document.querySelectorAll('.sn-title').length===1&&q('.sn-title').closest('label').textContent==='Note title','tags must be replaced with a single labeled title field');
      input('.sn-title','Project <script>');assert(q('.sn-note-row[aria-selected="true"] strong').textContent==='Project <script>','tab title must update immediately');input('.sn-source','# Başlık\n\n**Kalın** ve *italik*.\n\nFirst line\r\nSecond **line**\nThird line\n\n- [x] Görev\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n<script>window.pwned=true</script>\n\n[x](javascript:alert(1))\n\n![tracker](https://example.com/image.png)');
      await pause(850);
      assert(q('.sn-save-status').textContent.includes('Saved'),'autosave failed');
      const id=readPreference('selectedId'),store=new api.NotesStore(account),note=await store.get(id);
      assert(note.title==='Project <script>','metadata save failed');
      const other=new api.NotesStore(account+'1');assert((await other.list()).length===0,'account isolation failed');await other.close();
      clickText('Split');await pause(100);
      assert(q('.sn-preview strong').textContent==='Kalın'&&q('.sn-preview table')&&q('.sn-preview input[type=checkbox]').checked,'GFM preview missing');assert(!q('.sn-preview li').textContent.includes('[x]'),'task marker rendered twice');assert(q('.sn-preview input[type=checkbox]').getAttribute('aria-label')==='Completed','English task label missing');
      assert(!q('.sn-preview script')&&!q('.sn-preview img')&&!q('.sn-preview a[href^="javascript:"]')&&!window.pwned,'unsafe preview');
      for(const mode of ['Split','Preview']){
        clickText(mode);
        const paragraph=[...q('.sn-preview').querySelectorAll('p')].find(p=>p.textContent.startsWith('First line'));
        assert(paragraph?.querySelectorAll('br').length===2,mode+' must preserve single LF/CRLF line breaks');
        assert(paragraph.querySelector('strong')?.textContent==='line',mode+' must preserve inline Markdown');
        const lineY=node=>{const range=document.createRange();range.selectNodeContents(node);return range.getBoundingClientRect().top;};
        assert(lineY(paragraph.firstChild)<lineY(paragraph.querySelector('strong'))&&lineY(paragraph.querySelector('strong'))<lineY(paragraph.lastChild),mode+' lines must be visibly separate');
        assert(q('.sn-source').value===note.content,mode+' must not rewrite stored Markdown');
      }
      clickText('Split');
      input('.sn-search','project');await pause(140);assert(q('.sn-list').children.length===1,'title search failed');input('.sn-search','');await pause(140);
      const editor=q('.sn-source'),position=editor.value.indexOf('Görev');editor.focus();editor.setSelectionRange(position,position+5);
      editor.dispatchEvent(new KeyboardEvent('keydown',{key:'b',ctrlKey:true,bubbles:true}));assert(editor.value.includes('**Görev**'),'keyboard formatting failed');
      editor.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}));assert(editor.value===note.content,'undo did not restore text');
      editor.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,shiftKey:true,bubbles:true}));assert(editor.value.includes('**Görev**'),'redo failed');
      editor.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}));
      clickText('Pin');await pause(750);assert((await store.get(id)).pinned,'pin failed');
      clickText('Export .md');await pause(30);assert((await downloads.at(-1).text()).includes('# Başlık'),'Markdown download failed');
      clickText('Back up');await pause(100);const backup=JSON.parse(await downloads.at(-1).text());assert(backup.documents.length===2&&backup.format==='syncord-notes','backup failed');
      clickText('Close');await pause(150);assert(!q('.sn-workspace')&&!q('.native-chat').inert&&!q('.native-chat').classList.contains('sn-covered'),'close did not restore DM');
      assert(getComputedStyle(q('[data-syncord-notes-nav] .sn-nav-link')).backgroundColor==='rgba(0, 0, 0, 0)','closed Notes still selected');
      assert(!q('[data-syncord-notes-active]')&&getComputedStyle(q('#sidebar a[href="/channels/@me"]')).backgroundColor==='rgb(70, 70, 70)','closing must restore native page selection');
      await open();assert(q('.sn-title').value==='Project <script>'&&q('.sn-source').value===note.content,'reopen lost document');
      const jsonTransfer=new DataTransfer();jsonTransfer.items.add(new File([JSON.stringify(backup)],'notes.json',{type:'application/json'}));q('input[type=file]').files=jsonTransfer.files;q('input[type=file]').dispatchEvent(new Event('change'));await pause(220);
      assert((await store.list()).length===4&&await store.get(id),'backup import overwrote existing notes');
      const invalid=new DataTransfer();invalid.items.add(new File(['{"format":"wrong"}'],'bad.json'));q('input[type=file]').files=invalid.files;q('input[type=file]').dispatchEvent(new Event('change'));await pause(120);assert(!q('.sn-banner').hidden&&q('.sn-banner').textContent==='This file is not a Syncord notes backup.'&&(await store.list()).length===4,'invalid backup must show an English error');
      const dt=new DataTransfer();dt.items.add(new File(['# İçe aktarılan\n\nİçerik'],'Import.md',{type:'text/markdown'}));q('input[type=file]').files=dt.files;q('input[type=file]').dispatchEvent(new Event('change'));await pause(250);
      assert(q('.sn-title').value==='Import'&&q('.sn-source').value.includes('İçerik'),'Markdown import failed');
      clickText('Move to trash');await pause(160);const filter=q('select[aria-label="Filter notes"]');filter.value='trash';filter.dispatchEvent(new Event('change'));await pause(50);
      assert(q('.sn-list').textContent.includes('Import'),'trash missing');q('.sn-note-row').click();await pause(140);assert(q('.sn-source').disabled,'trashed note must be read-only');
      clickText('Restore');await pause(150);assert(!q('.sn-source').disabled,'restore failed');
      clickText('Move to trash');await pause(150);filter.value='trash';filter.dispatchEvent(new Event('change'));q('.sn-note-row').click();await pause(140);
      const removedId=readPreference('selectedId');clickText('Delete permanently');await pause(50);assert(q('.sn-confirm').open,'confirmation missing');clickText('Cancel','.sn-confirm');await pause(80);assert(await store.get(removedId),'cancel removed note');
      clickText('Delete permanently');await pause(50);clickText('Delete permanently','.sn-confirm');await pause(140);assert(!await store.get(removedId),'permanent deletion failed');
      filter.value='all';filter.dispatchEvent(new Event('change'));q('.sn-note-row').click();await pause(140);
      input('.sn-source','unsaved before navigation');q('#sidebar a[href="/channels/@me/123"]').click();await pause(180);
      assert(!q('.sn-workspace'),'navigation must close Notes');assert((await store.get(readPreference('selectedId'))).content==='unsaved before navigation','navigation lost draft');
      await open();
      q('#sidebar a[href="/store"]').click();await pause(150);assert(!q('.sn-workspace'),'native non-channel navigation must close Notes');await open();
      const originalAccount=account;account=account+'3';q('.sn-title').value='account-change';q('.sn-title').dispatchEvent(new Event('input',{bubbles:true}));await pause(160);assert(!q('.sn-workspace'),'account switch must close Notes');account=originalAccount;await open();
      const quota=new api.NotesStore(account+'2');const docs=Array.from({length:200},()=>api.createNote('quota','x'));await quota.importNotes(docs);
      let rejected=false;try{await quota.importNotes([api.createNote('one'),api.createNote('two')]);}catch{rejected=true;}
      assert(rejected&&(await quota.list()).length===200,'import must fail atomically at limit');await quota.close();
      const originalSave=api.NotesStore.prototype.save;api.NotesStore.prototype.save=()=>Promise.reject(new Error('disk full'));
      input('.sn-source','retained on save failure');clickText('Save');await pause(90);
      assert(q('.sn-save-status').dataset.error==='true','save failure must be visible');clickText('Close');await pause(90);
      assert(q('.sn-workspace')&&q('.sn-source').value==='retained on save failure','failed save must not discard draft');await stopNotes();assert(!q('.sn-workspace'),'disable left UI mounted');startNotes();await pause(100);await open();assert(q('.sn-source').value==='retained on save failure','forced close lost recovery draft');
      api.NotesStore.prototype.save=originalSave;clickText('Save');await pause(90);
      input('.sn-title','Proje fikirleri');input('.sn-source','# Syncord için fikirler\n\n## Öncelikler\n- [x] Yerel notlar\n- [ ] Yeni bir tasarım hazırla\n\n> Küçük adımlarla ilerle.\n\n| Alan | Durum |\n| --- | --- |\n| Markdown | Hazır |\n| Yerel kayıt | Hazır |\n\n**Not:** Ctrl/Cmd+B ile kalın yazabilirsin.');clickText('Save');await pause(300);
      await store.close();
      return {native:true,persistence:true,markdown:true,imports:true,quota:true,saveFailure:true};
     })().catch(error=>({failure:error.stack}))`);
     if(result.failure)throw Error(result.failure);
     async function hover(selector){
      const point=await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
      win.webContents.sendInputEvent({type:'mouseMove',...point});await new Promise(r=>setTimeout(r,60));
      const hovered=await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).matches(':hover')`);
      if(!hovered)throw Error('real pointer hover did not reach '+selector);
     }
     await hover('#sidebar a[href="/channels/@me"]');
     result.nativeHover=await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('#sidebar a[href="/channels/@me"]')).backgroundColor==='rgb(36, 36, 41)'`);
     await hover('#sidebar a[href="/channels/@me/123"]');
     result.activeHover=await win.webContents.executeJavaScript(String.raw`(()=>{
      const note=document.querySelector('.sn-nav-link'),other=document.querySelector('#sidebar a[href="/channels/@me/123"]');
      const own=getComputedStyle(note),sibling=getComputedStyle(other),previous=getComputedStyle(document.querySelector('#sidebar a[href="/channels/@me"]'));
      return previous.backgroundColor==='rgba(0, 0, 0, 0)'&&note.getAttribute('aria-pressed')==='true'&&!note.matches(':hover')&&own.backgroundColor!==sibling.backgroundColor&&own.boxShadow==='none'&&own.backgroundColor==='rgb(70, 70, 70)'&&own.color==='rgb(255, 255, 255)'&&sibling.backgroundColor==='rgb(36, 36, 41)';
     })()`);
     await win.webContents.executeJavaScript(`[...document.querySelectorAll('.sn-workspace button')].find(e=>e.textContent==='Close').click()`);
     await new Promise(r=>setTimeout(r,150));
     await hover('#sidebar a[href="/channels/@me/123"]');
     result.inactiveHover=await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.sn-nav-link')).backgroundColor==='rgba(0, 0, 0, 0)'`);
     await hover('.sn-nav-link');
     result.ownHover=await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.sn-nav-link')).backgroundColor==='rgb(36, 36, 41)'`);
     await win.webContents.executeJavaScript(`document.querySelector('.sn-nav-link').click()`);await new Promise(r=>setTimeout(r,250));
     await hover('#sidebar a[href="/channels/@me/123"]');
     result.navigationRemount=await win.webContents.executeJavaScript(String.raw`(async()=>{
       const nav=document.querySelector('.privateChannels_test'),replacement=nav.cloneNode(true);replacement.querySelector('[data-syncord-notes-nav]').remove();replacement.removeAttribute('data-syncord-notes-active');nav.replaceWith(replacement);
       await new Promise(r=>setTimeout(r,120));
       return document.querySelectorAll('[data-syncord-notes-nav]').length===1&&replacement.dataset.syncordNotesActive==='true'&&getComputedStyle(replacement.querySelector('a[href="/channels/@me"]')).backgroundColor==='rgba(0, 0, 0, 0)';
     })()`);
     result.tabKeyboard=await win.webContents.executeJavaScript(String.raw`(async()=>{
       const q=s=>document.querySelector(s),pause=()=>new Promise(r=>setTimeout(r,140));
       const selected=q('.sn-note-row[aria-selected="true"]'),id=selected.dataset.noteId;
       selected.focus();selected.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await pause();
       if(q('.sn-note-row[aria-selected="true"]').dataset.noteId===id||q('.sn-source').value==='# Syncord için fikirler')return false;
       const target=[...q('.sn-list').children].find(tab=>tab.dataset.noteId===id);target.click();await pause();
       return q('.sn-note-row[aria-selected="true"]').dataset.noteId===id&&q('.sn-source').value.includes('# Syncord için fikirler')&&q('.sn-list').querySelectorAll('[tabindex="0"]').length===1;
     })()`);
     for(const width of [1240,860,620,480]){
      win.setContentSize(width,850);
      await new Promise(r=>setTimeout(r,80));
      const bounds=await win.webContents.executeJavaScript(String.raw`(()=>{const r=document.querySelector('.sn-workspace');return {width:r.clientWidth,scroll:r.scrollWidth,source:document.querySelector('.sn-source').getBoundingClientRect().toJSON(),preview:document.querySelector('.sn-preview').getBoundingClientRect().toJSON(),manager:document.querySelector('.sn-manager').getBoundingClientRect().toJSON(),controls:[...document.querySelectorAll('.sn-manager input:not([hidden]),.sn-manager select,.sn-manager button')].map(e=>e.getBoundingClientRect().toJSON())};})()`);
      if(width===1240||width===620)require('node:fs').writeFileSync('/tmp/syncord-notes-'+width+'.png',(await win.webContents.capturePage()).toPNG());
      for(const rect of bounds.controls){if(rect.width<=0||rect.left<bounds.manager.left||rect.right>bounds.manager.right||rect.bottom>bounds.manager.bottom)throw Error('management controls overflow at '+width+': '+JSON.stringify(bounds));}
      if(bounds.source.height<60)throw Error('controls left no editing space at '+width+': '+JSON.stringify(bounds));
      if(bounds.scroll>bounds.width+1)throw Error('responsive overflow at '+width+': '+JSON.stringify(bounds));
      if(bounds.width<=620&&bounds.preview.y<=bounds.source.y)throw Error('split panes did not stack: '+JSON.stringify(bounds));
     }
     result.responsive=true;
     result.tabOverflow=await win.webContents.executeJavaScript(String.raw`(async()=>{
       const list=document.querySelector('.sn-list');if(list.scrollWidth<=list.clientWidth)return false;
       const last=list.querySelector('[role="tab"]:last-child');last.click();await new Promise(r=>setTimeout(r,150));
       const tab=list.querySelector('[aria-selected="true"]').getBoundingClientRect(),strip=list.getBoundingClientRect();
       return tab.left>=strip.left-1&&tab.right<=strip.right+1&&list.scrollLeft>0;
     })()`);
     result.emptyHeader=await win.webContents.executeJavaScript(String.raw`(async()=>{
       await stopNotes();const store=new api.NotesStore(account);
       for(const summary of await store.list()){const note=await store.get(summary.id);note.deletedAt=Date.now();await store.save(note);}await store.close();
       startNotes();await new Promise(r=>setTimeout(r,80));document.querySelector('[data-syncord-notes-nav] a').click();await new Promise(r=>setTimeout(r,200));
       const header=document.querySelector('.sn-header');return header.getBoundingClientRect().height>0&&document.querySelector('.sn-manager').getBoundingClientRect().height>0&&!document.querySelector('.sn-empty').hidden&&document.querySelector('.sn-document-content').hidden;
     })()`);
     result.cleanup=await win.webContents.executeJavaScript(String.raw`(async()=>{await stopNotes();return !document.querySelector('.sn-workspace')&&!document.querySelector('[data-syncord-notes-nav]')&&!document.querySelector('[data-syncord-notes-active]')&&!document.querySelector('.sn-covered')&&!document.querySelector('.sn-host')&&!document.querySelector('.native-chat').inert;})()`);
     console.log('NOTES_UI_RESULT:'+JSON.stringify(result));win.destroy();app.exit(0);
    }catch(error){console.error(error.stack);win.destroy();app.exit(1);}
   });
  }
  writeFileSync(dir+'/main.cjs',`(${driver.toString()})(${JSON.stringify(dir+'/index.html')});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const run=spawnSync(electron,[dir+'/main.cjs'],{env,encoding:'utf8',timeout:30_000});
  assert.equal(run.error,undefined,run.stdout+'\n'+run.stderr);
  assert.equal(run.status,0,`${run.error??''}\n${run.stdout}\n${run.stderr}`);
  const line=run.stdout.split('\n').find(l=>l.startsWith('NOTES_UI_RESULT:'));assert.ok(line,run.stdout);
  const result=JSON.parse(line.slice('NOTES_UI_RESULT:'.length));for(const [key,value] of Object.entries(result))assert.equal(value,true,key);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
