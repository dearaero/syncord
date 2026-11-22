import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir=await mkdtemp(path.join(tmpdir(),'Syncord-media-test-'));
let browser;
try {
  await build({entryPoints:['scripts/tests/fixtures/multichat-media.js'],bundle:true,platform:'browser',outfile:path.join(dir,'fixture.js')});
  await writeFile(path.join(dir,'index.html'),'<!doctype html><meta charset="utf-8"><body style="margin:0"><script src="fixture.js"></script>');
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1000,height:700}});
  page.setDefaultTimeout(10_000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  // Only mock stores and local fixture assets are allowed; no Discord messages/files leave the test.
  await page.route('https://**/*',route=>route.abort());
  await page.route('https://cdn.discordapp.com/emojis/**',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=','base64')}));
  await page.goto(pathToFileURL(path.join(dir,'index.html')).href);
  await page.waitForSelector('.dion-mc-content');
  const p1=page.locator('[data-mc-pane="pane-1"]'), p2=page.locator('[data-mc-pane="pane-2"]');
  const editor=p1.locator('[data-mc-composer]');
  const picker=page.getByRole('dialog');
  const open=async(kind,pane=p1)=>{await pane.locator(`[data-mc-media-tool="${kind}"]`).click();await picker.waitFor();};
  const noPicker=async()=>assert.equal(await picker.count(),0);

  // Emoji insertion preserves cursor position and existing text, including custom emoji syntax.
  await editor.fill('ab');
  await editor.evaluate(el=>{const r=document.createRange();r.setStart(el.firstChild,1);r.collapse(true);const s=getSelection();s.removeAllRanges();s.addRange(r)});
  await open('Emoji');await picker.getByRole('button',{name:'smile',exact:true}).click();
  assert.equal(await editor.innerText(),'a😄b');await noPicker();
  await open('Emoji',p2);await picker.getByRole('button',{name:'party',exact:true}).click();
  assert.equal(await p2.locator('[data-mc-composer] img').getAttribute('data-mc-composer-emoji'),'<a:party:123456>');
  assert.deepEqual(await page.evaluate(()=>window.emojiQueries),['a','b']);
  assert.equal(await page.evaluate(()=>window.sent.length),0);

  // Custom emoji is an image in the editor, but its persisted/sent value is Discord syntax.
  const secondEditor=p2.locator('[data-mc-composer]');
  await secondEditor.fill('ab');
  await secondEditor.evaluate(el=>{const r=document.createRange();r.setStart(el.firstChild,1);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r)});
  await open('Emoji',p2);await picker.getByRole('button',{name:'party',exact:true}).click();
  await page.keyboard.type('Z');
  assert.equal(await secondEditor.textContent(),'aZb');
  await page.waitForFunction(()=>document.querySelector('[data-mc-pane="pane-2"] [data-mc-composer] img')?.naturalWidth>0);
  assert.deepEqual(await secondEditor.locator('img').evaluate(el=>[el.clientWidth,el.clientHeight]),[22,22]);
  await page.evaluate(()=>{window.closeCanvas();window.openCanvas()});
  assert.equal(await page.evaluate(()=>window.saved.panes[1].draft),'a<a:party:123456>Zb');
  assert.equal(await secondEditor.locator('img').count(),1);
  // Delete the entire emoji atom without exposing its numeric identifier.
  await secondEditor.evaluate(el=>{el.focus();const r=document.createRange();r.setStartAfter(el.querySelector('img'));r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r)});
  await page.keyboard.press('Backspace');
  assert.equal(await secondEditor.locator('img').count(),0);
  assert.equal(await secondEditor.innerText(),'aZb');
  await secondEditor.fill('');
  await open('Emoji',p2);await picker.getByRole('button',{name:'R53KPTN',exact:true}).click();
  assert.ok((await secondEditor.locator('img').getAttribute('src')).endsWith('/1425993161108357191.png?size=48'));
  await page.keyboard.type('!');await page.keyboard.press('Shift+Enter');await page.keyboard.type('next');
  await page.evaluate(()=>{window.closeCanvas();window.openCanvas()});
  assert.equal(await page.evaluate(()=>window.saved.panes[1].draft),'<:R53KPTN:1425993161108357191>!\nnext');
  assert.equal(await secondEditor.locator('img').count(),1);
  assert.equal(await secondEditor.evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(r);const data=new DataTransfer();el.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));return data.getData('text/plain')}),'<:R53KPTN:1425993161108357191>!\nnext');
  await secondEditor.fill('');
  await open('Emoji',p2);await picker.getByRole('button',{name:'party',exact:true}).click();

  // The native picker owns tabs/favorites/search. Its callbacks only add drafts.
  await open('GIF');
  assert.equal(await picker.getAttribute('data-native-expression-picker'),'true');
  assert.equal(await page.locator('.dion-mc-media-grid, .dion-mc-media-picker').count(),0);
  assert.equal(await page.evaluate(()=>window.nativePickerProps.channel.id),'a');
  assert.equal(await page.evaluate(()=>window.nativePickerProps.hideGifFavorites),false);
  await picker.getByRole('button',{name:'Trending GIF',exact:true}).click();
  assert.ok((await editor.innerText()).includes('https://example.com/fast'));
  assert.equal(await page.evaluate(()=>window.sent.length),0);
  assert.deepEqual(await page.evaluate(()=>window.gifRequests),[],'Canvas does not search GIFs itself');
  await open('Emoji');
  await picker.getByRole('tablist').getByRole('button',{name:'GIF',exact:true}).click();
  await picker.getByRole('button',{name:'Trending GIF',exact:true}).waitFor();
  await picker.getByRole('searchbox').press('Escape');await noPicker();

  // Stickers remain explicit draft attachments and unavailable entries are not shown.
  await open('Stickers');await picker.getByRole('button',{name:'Wave',exact:true}).click();
  assert.equal(await p1.getByRole('button',{name:'Remove Wave'}).count(),1);
  await open('Stickers');assert.equal(await picker.getByRole('button',{name:'Removed',exact:true}).count(),0);
  await picker.getByRole('button',{name:'Dance',exact:true}).click();

  // File chooser supports several files, removal, repeated selections, paste and drop.
  const image={name:'tiny.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=','base64')};
  const text={name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('local fixture')};
  const chooserPromise=page.waitForEvent('filechooser');await p1.locator('[data-mc-media-tool="Upload files"]').click();
  await (await chooserPromise).setFiles([image,text]);
  assert.equal(await p1.locator('.dion-mc-draft-item').count(),4);
  await p1.getByRole('button',{name:'Remove notes.txt'}).click();
  await p1.locator('[data-mc-files]').setInputFiles(text);
  await editor.evaluate(el=>{const data=new DataTransfer();data.items.add(new File(['paste'],'pasted.txt',{type:'text/plain'}));el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
  await p1.evaluate(el=>{const data=new DataTransfer();data.items.add(new File(['drop'],'dropped.txt'));el.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));});
  assert.equal(await p1.locator('.dion-mc-draft-item').count(),6);
  await page.evaluate(()=>{window.closeCanvas();window.openCanvas();});
  assert.equal(await p1.locator('.dion-mc-draft-item').count(),6);

  if (process.env.SCREENSHOT_PATH) await page.screenshot({path:process.env.SCREENSHOT_PATH});

  // Failure preserves content and files for an explicit retry (including native swallowed errors).
  for(const mode of ['throw','resolved-error','upload-error','unconfirmed']) {
    await page.evaluate(mode=>window.mode=mode,mode);
    await p1.locator('[data-mc-send]').click();
    await p1.locator('[role="alert"]').waitFor();
    assert.equal(await p1.locator('.dion-mc-draft-item').count(),6);
    assert.ok((await editor.innerText()).includes('https://example.com/fast'));
    assert.equal(await p1.locator('[data-mc-send]').isEnabled(),true);
  }

  // The in-flight guard blocks duplicate click/Enter/submit and channel switching.
  await page.evaluate(()=>window.mode='delay');
  const before=await page.evaluate(()=>window.sent.length);
  await p1.locator('[data-mc-send]').click();
  await page.waitForFunction(()=>!!window.finishSend);
  await p1.locator('[data-mc-form]').evaluate(el=>{el.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));el.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  assert.equal(await page.evaluate(()=>window.sent.length),before+1);
  assert.equal(await p1.locator('[data-mc-pick-channel]').isDisabled(),true);
  assert.equal(await editor.getAttribute('contenteditable'),'false');
  await page.evaluate(()=>{window.closeCanvas();window.openCanvas();});
  assert.equal(await p1.locator('[data-mc-send]').isDisabled(),true);
  await page.evaluate(()=>window.finishSend());
  await page.waitForFunction(()=>document.querySelector('[data-mc-pane="pane-1"] [data-mc-composer]').textContent==='');
  assert.equal(await p1.locator('.dion-mc-draft-item').count(),0);
  const sent=await page.evaluate(()=>window.sent.at(-1));
  assert.equal(sent.channelId,'a');assert.deepEqual(sent.stickers,['222','444']);
  assert.deepEqual(sent.files.map(f=>f.name),['tiny.png','notes.txt','pasted.txt','dropped.txt']);
  assert.ok(sent.files.every(f=>f.channelId==='a'&&f.platform===1));
  assert.equal(await p2.locator('[data-mc-composer] img').getAttribute('data-mc-composer-emoji'),'<a:party:123456>');

  // File-only and sticker-only messages are sendable; limits do not discard existing files.
  await page.evaluate(()=>window.mode='success');
  await p1.locator('[data-mc-files]').setInputFiles(text);
  assert.equal(await p1.locator('[data-mc-send]').isEnabled(),true);
  await p1.locator('[data-mc-send]').click();
  await page.waitForFunction(()=>window.sent.at(-1).files.length===1);
  await page.waitForFunction(()=>!document.querySelector('[data-mc-pane="pane-1"] .dion-mc-draft-item'));
  await open('Stickers');await picker.getByRole('button',{name:'Wave',exact:true}).click();
  await p1.locator('[data-mc-send]').click();
  await page.waitForFunction(()=>window.sent.at(-1).stickers[0]==='222');
  await page.waitForFunction(()=>!document.querySelector('[data-mc-pane="pane-1"] .dion-mc-draft-item'));
  await p1.locator('[data-mc-files]').setInputFiles(Array.from({length:11},(_,i)=>({...text,name:`${i}.txt`})));
  await p1.getByText('You can attach up to 10 files to one message.').waitFor();
  assert.equal(await p1.locator('.dion-mc-draft-item').count(),0);

  // Re-check emoji permissions on send, not just when the picker opened.
  await page.evaluate(()=>window.blockEmoji=true);
  const permissionBefore=await page.evaluate(()=>window.sent.length);
  await p2.locator('[data-mc-send]').click();await p2.locator('[role="alert"]').waitFor();
  assert.equal(await page.evaluate(()=>window.sent.length),permissionBefore);
  await page.evaluate(()=>window.blockEmoji=false);
  await p2.locator('[data-mc-send]').click();
  await page.waitForFunction(()=>window.sent.at(-1).channelId==='b');
  assert.equal(await page.evaluate(()=>window.sent.at(-1).emojis[0].id),'123456');
  assert.equal(await page.evaluate(()=>window.sent.at(-1).content),'<a:party:123456>');
  assert.deepEqual(await page.evaluate(()=>window.routes),[]);

  // Modal fits a narrow/short viewport and closes cleanly with no late DOM updates.
  await page.setViewportSize({width:320,height:480});
  await page.locator('[data-mc-tab="pane-1"]').click();await open('GIF');
  const rect=await picker.boundingBox();assert.ok(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=320&&rect.y+rect.height<=480, JSON.stringify(rect));
  await picker.getByRole('searchbox').fill('slow');
  await picker.getByRole('searchbox').press('Escape');
  await p1.locator('[data-mc-files]').setInputFiles(image);
  await page.evaluate(()=>window.disposeCanvas());
  await page.waitForTimeout(600);
  assert.equal(await page.locator('#Syncord-multichat-root').count(),0);
  assert.equal(await page.evaluate(()=>window.blobsCreated.length===window.blobsRevoked.length),true);
  assert.equal(await page.evaluate(()=>window.nativePickerListeners()),0);
  assert.deepEqual(errors,[]);
  console.log('PASS: emoji cursor/custom permissions; native expression tabs/callbacks/state; sticker drafts; file chooser/paste/drop/removal; upload errors; panel isolation; no duplicate sends; hide/reopen; limits; narrow picker; blob cleanup');
} finally {await browser?.close();await rm(dir,{recursive:true,force:true});}
