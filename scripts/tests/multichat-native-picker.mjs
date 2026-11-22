import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir=await mkdtemp(path.join(tmpdir(),'Syncord-native-picker-test-'));
let browser;
try {
  await build({entryPoints:['scripts/tests/fixtures/multichat-media.js'],bundle:true,platform:'browser',outfile:path.join(dir,'fixture.js')});
  await writeFile(path.join(dir,'index.html'),'<!doctype html><meta charset="utf-8"><body style="margin:0"><script src="fixture.js"></script>');
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1000,height:700}});
  page.setDefaultTimeout(10_000);
  const errors=[],warnings=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',msg=>{if(msg.type()==='warning')warnings.push(msg.text())});
  await page.route('https://**/*',route=>route.abort());
  await page.goto(pathToFileURL(path.join(dir,'index.html')).href);
  await page.waitForSelector('.dion-mc-content');
  const p1=page.locator('[data-mc-pane="pane-1"]'),p2=page.locator('[data-mc-pane="pane-2"]');
  const editor=p1.locator('[data-mc-composer]'),other=p2.locator('[data-mc-composer]'),picker=page.getByRole('dialog');
  const open=async(kind,pane=p1)=>{await pane.locator(`[data-mc-media-tool="${kind}"]`).click();await picker.waitFor()};
  const closed=async()=>{await page.waitForFunction(()=>!document.querySelector('.dion-mc-native-picker-host'));assert.equal(await page.evaluate(()=>window.nativePickerListeners()),0)};
  await editor.fill('kept');await other.fill('other');

  // Restore the previous native owner and search, without touching any native draft.
  await page.evaluate(()=>{window.originalOwner={native:true};window.nativePickerStore.setState({activeView:'gif',activeViewType:window.originalOwner,activeChannelId:'original-channel',searchQuery:'cats'})});
  await open('Emoji');
  assert.equal(await page.evaluate(()=>window.nativePickerStore.getState().activeViewType===window.originalOwner),false);
  assert.equal(await page.evaluate(()=>window.nativePickerProps.channel.id),'a');
  assert.equal(await picker.evaluate(el=>!el.closest('#Syncord-multichat-root')),true);
  assert.equal(await page.locator('.dion-mc-native-picker-host').evaluate(el=>el.parentElement===document.body && el.matches(':popover-open')),true,'Native picker uses the browser Top Layer');
  await page.evaluate(()=>{const shield=document.createElement('div');shield.id='stacking-shield';shield.style.cssText='position:fixed;inset:0;z-index:2147483647;background:red';document.body.append(shield)});
  assert.equal(await picker.evaluate(el=>{const panel=el.firstElementChild,b=panel.getBoundingClientRect();return panel.contains(document.elementFromPoint(b.left+20,b.top+20))}),true,'Picker paints above even the highest ordinary z-index');
  await page.evaluate(()=>document.querySelector('#stacking-shield').remove());
  assert.equal(await picker.evaluate(el=>{const r=el.getBoundingClientRect(),p=el.firstElementChild.getBoundingClientRect();return r.width>p.width}),true);
  await page.waitForTimeout(2200);
  assert.equal(await picker.count(),1,'Visible native drawer remains open past the hit-test deadline');
  assert.equal(await picker.evaluate(el=>!!el.closest('.fixture-app-layer-container.dion-mc-native-picker-container')),true,'Native picker portals through the discovered App layer provider/container');
  await picker.getByRole('searchbox').press('Escape');await closed();
  assert.equal(await page.locator('.dion-mc-content').count(),2,'Escape closes the native picker without closing Canvas');
  assert.deepEqual(await page.evaluate(()=>{const s=window.nativePickerStore.getState();return [s.activeView,s.activeViewType===window.originalOwner,s.activeChannelId,s.searchQuery]}),['gif',true,'original-channel','cats']);
  assert.equal(await editor.innerText(),'kept');
  await page.evaluate(()=>window.nativePickerStore.setState({activeView:null,activeViewType:null,activeChannelId:null,searchQuery:''}));

  // Switching panes releases the former root/subscription; delayed callbacks cannot cross drafts.
  await open('GIF');await page.evaluate(()=>window.oldSelect=window.nativePickerProps.onSelectGIF);
  await open('Emoji',p2);
  assert.equal(await page.evaluate(()=>window.nativePickerListeners()),1);
  assert.equal(await page.evaluate(()=>window.nativePickerProps.channel.id),'b');
  await page.evaluate(()=>window.oldSelect({url:'https://example.com/stale'}));
  assert.equal(await editor.innerText(),'kept');assert.equal(await other.innerText(),'other');
  await picker.getByRole('searchbox').press('Escape');await closed();

  // Native Shift selections stay open and continue inserting at the saved cursor.
  await editor.fill('ab');
  await editor.evaluate(el=>{el.focus();const r=document.createRange();r.setStart(el.firstChild,1);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r)});
  await page.evaluate(()=>window.keepNativeEmojiOpen=true);
  await open('Emoji');
  await picker.getByRole('button',{name:'smile',exact:true}).click();
  await picker.getByRole('button',{name:'smile',exact:true}).click();
  assert.equal(await editor.innerText(),'a😄😄b');assert.equal(await picker.count(),1);
  assert.equal(await picker.evaluate(el=>el.contains(document.activeElement)),true);
  await picker.getByRole('searchbox').press('Escape');await closed();
  await page.evaluate(()=>window.keepNativeEmojiOpen=false);

  // A native composer can take the shared store; Canvas must not restore over it.
  await open('Stickers');
  await page.evaluate(()=>{window.nextOwner={native:true};window.nativePickerStore.setState({activeView:'sticker',activeViewType:window.nextOwner,activeChannelId:'next-channel',searchQuery:'wave'})});
  await closed();
  assert.deepEqual(await page.evaluate(()=>{const s=window.nativePickerStore.getState();return [s.activeView,s.activeViewType===window.nextOwner,s.activeChannelId,s.searchQuery]}),['sticker',true,'next-channel','wave']);

  // Missing cached components and render failures preserve drafts and release everything.
  await page.evaluate(()=>window.noNativePicker=true);
  await p1.locator('[data-mc-media-tool="GIF"]').click();
  await closed();assert.match(await page.evaluate(()=>window.lastToast),/native media picker is not ready/);
  assert.equal(await editor.innerText(),'a😄😄b');
  await page.evaluate(()=>{window.noNativePicker=false;window.noNativeLayers=true});
  await p1.locator('[data-mc-media-tool="GIF"]').click();await closed();
  assert.match(await p1.locator('[role="alert"]').innerText(),/native media picker is not ready/);
  assert.ok(warnings.some(message=>message.includes('App layer provider')),'Missing native layer is diagnosed without leaving an empty popout');
  assert.equal(await editor.innerText(),'a😄😄b');
  await page.evaluate(()=>{window.noNativeLayers=false;window.nativeRenderError=true});
  await p1.locator('[data-mc-media-tool="GIF"]').click();await closed();
  assert.equal(await page.evaluate(()=>window.nativePickerStore.getState().activeViewType===window.nextOwner),true);
  assert.equal(await editor.innerText(),'a😄😄b');
  await page.evaluate(()=>{window.nativeRenderError=false;window.nativeBlank=true});
  await p1.locator('[data-mc-media-tool="GIF"]').click();
  await closed();
  assert.ok(warnings.some(message=>message.includes('no visible/clickable dialog')),'Silent native renders produce an actionable error and dispose the empty host');
  assert.match(await p1.locator('[role="alert"]').innerText(),/media menu could not be displayed/);
  assert.equal(await page.evaluate(()=>window.nativePickerStore.getState().activeViewType===window.nextOwner),true);
  await page.evaluate(()=>window.nativeBlank=false);

  // Shared dialog replacement and hiding/disabling clean up the native React root.
  await open('Emoji');await p1.locator('[data-mc-pick-channel]').click();
  assert.equal(await page.locator('.dion-mc-native-picker-host').count(),0);
  assert.equal(await page.evaluate(()=>window.nativePickerListeners()),0);
  await page.keyboard.press('Escape');
  await open('Emoji');await page.evaluate(()=>window.closeCanvas());await closed();
  await page.evaluate(()=>window.openCanvas());await open('GIF');
  await page.evaluate(()=>window.disposeCanvas());await closed();
  assert.equal(await page.evaluate(()=>window.nativePickerStore.getState().activeViewType===window.nextOwner),true);
  assert.equal(await page.evaluate(()=>window.sent.length),0);
  assert.deepEqual(errors,[]);
  console.log('PASS: native picker ownership/restoration; pane routing; stale callbacks; repeated emoji; missing/render failures; close/dispose cleanup; no immediate sends');
} finally {await browser?.close();await rm(dir,{recursive:true,force:true})}
