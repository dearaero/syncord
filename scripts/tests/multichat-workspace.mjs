import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir = await mkdtemp(path.join(tmpdir(), 'Syncord-workspace-'));
let browser;
try {
  await build({entryPoints:['scripts/tests/fixtures/multichat-media.js'],bundle:true,platform:'browser',outfile:path.join(dir,'fixture.js')});
  await writeFile(path.join(dir,'index.html'), `<!doctype html><meta charset="utf-8"><style>
    body { margin:0; font-family:Arial; }
    [data-window-chrome] { height:32px; background:#121214; color:#aaa; }
    #app-mount { position:fixed; inset:32px 0 0; --background-base-lower:#1a1a1e; --text-default:#dbdee1; --text-strong:#f2f3f5; }
    .baseLayer_fixture { position:absolute; inset:0; transform:translateZ(0); }
    #native-content { position:absolute; inset:0; }
    #native-modal { position:absolute; inset:60px 30px; z-index:10; background:#eee; color:#111; }
  </style><body><div data-window-chrome="true">Discord</div><div id="app-mount"><div class="baseLayer_fixture"><div id="native-content"><button id="launcher">MultiChat</button>
    <div style="position:fixed;inset:0 0 auto;height:48px;z-index:9999;background:blue">Native header</div>
    <div style="position:fixed;bottom:0;left:0;width:350px;height:70px;z-index:9999;background:blue">Native account panel</div>
    <form><div role="textbox" contenteditable="true"></div><button aria-label="GIF"><svg viewBox="0 0 24 24" style="width:48px;height:48px;background:blue;color:blue"><path class="native-active" style="fill:blue" fill="blue" d="M4 4h16v16H4z"/></svg></button></form>
    <div class="layerContainer_fixture" id="native-popouts" style="position:absolute;inset:0;pointer-events:none"></div>
    </div></div></div>
  <div id="Syncord-fake-voice-host" style="position:fixed;bottom:0;left:0;z-index:100">Headphones</div><script>window.workspaceMessageCount=120;document.querySelector('#launcher').focus();</script><script src="fixture.js"></script>`);
  browser = await chromium.launch({headless:true,...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(10_000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://**/*',route=>route.abort());
  await page.route('https://example.com/avatar-*.png',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=','base64')}));
  await page.goto(pathToFileURL(path.join(dir,'index.html')).href);
  const root=page.locator('#Syncord-multichat-root');
  const p1=page.locator('[data-mc-pane="pane-1"]');
  const editor=p1.locator('[data-mc-composer]');
  await editor.waitFor();
  await p1.locator('[data-mc-day]').first().waitFor();
  assert.equal(await page.evaluate(()=>{
    const editor=document.querySelector('[data-mc-pane="pane-1"] [data-mc-composer]');
    const time=document.querySelector('[data-mc-pane="pane-1"] [data-mc-time]');
    const day=document.querySelector('[data-mc-pane="pane-1"] [data-mc-day]');
    const contents=document.querySelector('[data-mc-pane="pane-1"] .dion-mc-message-content');
    const originalText=contents?.textContent,originalDraft=editor.textContent;
    let valid=true;
    for(const locale of canvasI18n.SUPPORTED_LOCALES){canvasI18n.setLocale(locale);
      valid=valid&&document.querySelector('[data-mc-pane="pane-1"] [data-mc-composer]')===editor
        &&document.querySelector('[data-mc-pane="pane-1"] [data-mc-time]')===time
        &&day.querySelector('.dion-mc-date-label').textContent.trim()===new Date(Number(day.dataset.mcDay)).toLocaleDateString(locale,{day:'2-digit',month:'long',year:'numeric'})
        &&contents?.textContent===originalText&&editor.textContent===originalDraft;
    }
    canvasI18n.setLocale('en-US');return valid;
  }),true,'All locales update owned dates without replacing message or composer nodes');

  assert.equal(await page.evaluate(()=>{
    const editor=document.querySelector('[data-mc-pane="pane-1"] [data-mc-composer]');const draft=editor.textContent;window.fixtureTogglePopouts(true);
    const button=document.querySelector('[data-mc-pane="pane-1"] [data-mc-popout]');if(!button)return false;button.click();const opened=window.fixturePopoutCalls.length===1;
    window.fixtureTogglePopouts(false);return opened&&!document.querySelector('[data-mc-popout]')&&document.querySelector('[data-mc-pane="pane-1"] [data-mc-composer]')===editor&&editor.textContent===draft;
  }),true,'Popout toggles preserve Canvas composer identity/draft and route the selected pane');

  assert.equal(await page.locator('#Syncord-fake-voice-host').isVisible(),false);
  await editor.focus();
  assert.equal(await editor.evaluate(el=>getComputedStyle(el).outlineStyle),'none');
  assert.equal(await root.evaluate(el=>el.parentElement.classList.contains('baseLayer_fixture')),true);
  assert.equal((await root.boundingBox()).y,32);
  assert.equal(await page.locator('#native-content').evaluate(el=>el.inert),false,'A native portal ancestor must remain interactive');
  assert.equal(await page.locator('#launcher').evaluate(el=>el.inert),true);
  assert.equal(await page.locator('#native-content').evaluate(el=>getComputedStyle(el).visibility),'hidden');
  assert.equal(await page.evaluate(()=>!!document.elementFromPoint(80,960)?.closest('#Syncord-multichat-root')),true);
  const gifIcon=p1.locator('[data-mc-media-tool="GIF"] svg');
  assert.deepEqual(await gifIcon.evaluate(el=>[el.getBoundingClientRect().width,el.getBoundingClientRect().height,getComputedStyle(el).backgroundColor]),[20,20,'rgba(0, 0, 0, 0)']);
  assert.equal(await gifIcon.locator('path').getAttribute('style'),null);
  assert.equal(await gifIcon.locator('path').getAttribute('fill'),'currentColor');

  // A native Discord popout inside covered chat content must paint above Canvas.
  await page.evaluate(()=>{const button=document.createElement('button');button.id='native-expression';button.textContent='Native Discord picker';button.style.cssText='position:absolute;top:90px;left:180px;width:200px;height:80px;pointer-events:auto;background:#eee';button.onclick=()=>window.nativePickerClicked=true;document.querySelector('#native-popouts').append(button)});
  await page.locator('#native-expression').click();
  assert.equal(await page.evaluate(()=>window.nativePickerClicked),true);
  assert.equal(await page.evaluate(()=>document.elementFromPoint(210,140)?.id),'native-expression');
  assert.equal(await page.locator('#native-popouts').evaluate(el=>!!el.closest('[inert]')),false);
  await page.evaluate(()=>document.querySelector('#native-expression').remove());
  // A portal that mounts later must not inherit the covered wrapper's inertness.
  await page.evaluate(()=>{const wrapper=document.createElement('div');wrapper.id='late-wrapper';wrapper.style.cssText='position:absolute;inset:0';wrapper.innerHTML='<div class="layerContainer_late" style="position:absolute;inset:0;pointer-events:none"><button id="late-native-picker" style="position:absolute;top:90px;left:180px;width:200px;height:80px;pointer-events:auto">Late native picker</button></div>';document.querySelector('.baseLayer_fixture').append(wrapper)});
  await page.locator('#late-native-picker').click();
  assert.equal(await page.locator('#late-native-picker').evaluate(el=>!!el.closest('[inert]')),false);
  assert.equal(await page.evaluate(()=>document.elementFromPoint(210,140)?.id),'late-native-picker');
  await page.evaluate(()=>document.querySelector('#late-wrapper').remove());

  // The native layer wins hit testing even when our media dialog is open.
  await p1.locator('[data-mc-media-tool="Emoji"]').click();
  const media=page.getByRole('dialog');
  assert.equal(await media.evaluate(el=>!el.closest('#Syncord-multichat-root')),true,'Picker escapes Canvas isolation/overflow');
  const popover=page.locator('.dion-mc-native-picker-host');
  assert.equal(await popover.evaluate(el=>el.matches(':popover-open')),true);
  assert.equal(await popover.evaluate(el=>getComputedStyle(el).getPropertyValue('--background-base-lower').trim()),'#1a1a1e','Top Layer retains Discord theme tokens');
  await page.evaluate(()=>document.querySelector('#app-mount').style.setProperty('--background-base-lower','#222233'));
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.dion-mc-native-picker-host')).getPropertyValue('--background-base-lower').trim()==='#222233');
  await page.evaluate(()=>document.querySelector('#app-mount').style.removeProperty('--background-base-lower'));
  assert.equal(await media.evaluate(el=>{const panel=el.firstElementChild,box=panel.getBoundingClientRect();return panel.contains(document.elementFromPoint(box.left+20,box.top+20))}),true,'Picker is painted above Canvas and wins hit testing');
  assert.equal(await page.locator('[data-mc-canvas]').evaluate(el=>el.inert),false);
  await page.evaluate(()=>{const modal=document.createElement('div');modal.id='native-modal';modal.innerHTML='<button>Native profile</button>';document.querySelector('#app-mount').append(modal)});
  assert.equal(await page.evaluate(()=>document.elementFromPoint(100,120).closest('#native-modal')?.id),'native-modal');
  await page.evaluate(()=>document.querySelector('#native-modal').remove());
  await page.getByRole('searchbox').press('Escape');
  assert.equal(await page.getByRole('dialog').count(),0);
  assert.equal(await p1.locator('[data-mc-media-tool="Emoji"]').evaluate(el=>document.activeElement===el),true);
  assert.equal(await page.locator('[data-mc-canvas]').evaluate(el=>el.inert),false);

  // A channel dialog uses the same focus trap, restores focus and leaves Canvas open.
  await p1.locator('[data-mc-pick-channel]').click();
  const dialog=page.getByRole('dialog');
  const avatars=dialog.locator('[data-mc-choice-avatar]');
  assert.equal(await avatars.count(),2);
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('[data-mc-choice-avatar]')).every(el=>el.complete&&el.naturalWidth>0));
  assert.deepEqual(await avatars.first().evaluate(el=>[el.clientWidth,el.clientHeight]),[30,30]);
  await avatars.first().dispatchEvent('error');
  assert.equal(await avatars.count(),1);
  assert.equal(await dialog.locator('.dion-mc-choice-icon svg').count(),2);
  await page.locator('[data-mc-picker-close]').focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.count(),0);
  assert.equal(await root.count(),1);
  assert.equal(await p1.locator('[data-mc-pick-channel]').evaluate(el=>document.activeElement===el),true);

  await p1.locator('[data-mc-messages]').evaluate(el=>{el.scrollTop=300;window.keptScroller=el});
  await page.waitForTimeout(50);

  // Resizing/focus/count changes preserve actual DOM nodes and the selection.
  await editor.fill('A draft that must survive every layout change');
  assert.equal(await editor.evaluate(el=>{
    const range=document.createRange(); range.selectNodeContents(el);
    const text=range.getBoundingClientRect(), box=el.getBoundingClientRect(), style=getComputedStyle(el);
    return text.width>0 && text.height>0 && text.top>=box.top && text.bottom<=box.bottom && style.visibility==='visible' && style.webkitTextFillColor!=='rgba(0, 0, 0, 0)' && document.elementFromPoint(text.left+3,text.top+3)?.closest('[data-mc-composer]')===el;
  }),true,'Typed text is painted inside the editor and unobstructed by native panels');
  await editor.evaluate(el=>{window.keptEditor=el;const range=document.createRange();range.setStart(el.firstChild,7);range.collapse(true);getSelection().removeAllRanges();getSelection().addRange(range)});
  await page.setViewportSize({width:375,height:667});
  await page.locator('[data-mc-tabs]:visible').waitFor();
  assert.equal(await editor.evaluate(el=>el===window.keptEditor),true);
  assert.equal(await page.evaluate(()=>getSelection().anchorOffset),7);
  await page.locator('[data-mc-tab="pane-1"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('[data-mc-pane="pane-2"]').isVisible(),true);
  assert.equal(await p1.isVisible(),false);
  await page.keyboard.press('Home');
  assert.equal(await p1.isVisible(),true);
  assert.equal(await editor.innerText(),'A draft that must survive every layout change');
  assert.equal(await p1.locator('[data-mc-messages]').evaluate(el=>el.scrollTop),300);
  await page.locator('[data-mc-pane-count="4"]').click();
  assert.equal(await page.getByRole('tab').count(),4);
  await page.locator('[data-mc-tab="pane-1"]').focus();await page.keyboard.press('End');
  assert.equal(await page.locator('[data-mc-pane="pane-4"]').isVisible(),true);
  await page.keyboard.press('Home');
  await page.setViewportSize({width:1440,height:1000});
  await page.waitForFunction(()=>document.querySelectorAll('[data-mc-pane]:not([hidden])').length===4);
  assert.equal(await editor.evaluate(el=>el===window.keptEditor),true);
  await p1.locator('[data-mc-focus-pane]').click();
  assert.equal(await page.locator('[data-mc-pane]:visible').count(),1);
  await p1.locator('[data-mc-focus-pane]').click();
  assert.equal(await page.locator('[data-mc-pane]:visible').count(),4);
  await p1.locator('[data-mc-messages]').evaluate(el=>el.scrollTop=el.scrollHeight);
  await page.waitForTimeout(50);
  await page.setViewportSize({width:1200,height:930});
  await page.waitForTimeout(100);
  assert.ok(await p1.locator('[data-mc-messages]').evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<2),'Latest messages stay anchored when the pane height changes');
  if(process.env.SCREENSHOT_PATH) await page.screenshot({path:process.env.SCREENSHOT_PATH.replace('.png','-desktop.png')});

  // Theme tokens propagate from Discord without remounting or hardcoded dark text.
  await page.locator('#app-mount').evaluate(el=>{el.style.setProperty('--background-base-lower','rgb(250, 250, 250)');el.style.setProperty('--text-default','rgb(20, 20, 20)')});
  assert.deepEqual(await root.evaluate(el=>[getComputedStyle(el).backgroundColor,getComputedStyle(el).color]),['rgb(250, 250, 250)','rgb(20, 20, 20)']);
  await page.locator('#app-mount').evaluate(el=>el.removeAttribute('style'));

  await page.locator('.baseLayer_fixture').evaluate(el=>el.style.width='600px');
  await page.locator('[data-mc-tabs]:visible').waitFor();
  assert.equal((await root.boundingBox()).width,600);
  assert.equal(await page.locator('[data-mc-pane]:visible').count(),1);
  await page.locator('.baseLayer_fixture').evaluate(el=>el.style.removeProperty('width'));
  await page.waitForFunction(()=>document.querySelectorAll('[data-mc-pane]:not([hidden])').length===4);

  // Desktop grids must survive ordinary laptop heights (the previous 850px
  // height breakpoint silently changed 3/4 panes into a single conversation).
  for(const count of [2,3,4]) {
    await page.locator(`[data-mc-pane-count="${count}"]`).click();
    await page.setViewportSize({width:1440,height:700});
    await page.waitForFunction(count=>document.querySelectorAll('[data-mc-pane]:not([hidden])').length===count,count);
    assert.equal(await page.locator('[data-mc-tabs]').isVisible(),false);
    const boxes=await page.locator('[data-mc-pane]:not([hidden])').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().x));
    assert.ok(new Set(boxes).size===2,'Two grid columns remain visible');
  }

  if(process.env.SCREENSHOT_PATH) await page.screenshot({path:process.env.SCREENSHOT_PATH.replace('.png','-short-grid.png')});

  // Height changes, embedded app bounds and long drafts must not push Send offscreen.
  for(const [width,height] of [[1440,700],[844,390],[320,480]]) {
    await page.setViewportSize({width,height});
    if(width<720) await page.locator('[data-mc-tab="pane-1"]').click();
    await editor.fill('Long message\n'.repeat(30));
    await p1.locator('[data-mc-files]').setInputFiles(Array.from({length:10},(_,i)=>({name:`a-long-attachment-name-${i}.txt`,mimeType:'text/plain',buffer:Buffer.from('test')})));
    const pane=await p1.boundingBox(), messages=await p1.locator('.dion-mc-messages-wrap').boundingBox();
    assert.ok(messages.height>=80,JSON.stringify({width,height,messages}));
    await p1.locator('[data-mc-send]').scrollIntoViewIfNeeded();
    const send=await p1.locator('[data-mc-send]').boundingBox();
    assert.ok(send.y+send.height<=pane.y+pane.height && send.x+send.width<=pane.x+pane.width,JSON.stringify({width,height,pane,send}));
    await p1.locator('[data-mc-pick-channel]').click();
    const pickerBounds=await dialog.boundingBox();
    assert.ok(pickerBounds.y>=32&&pickerBounds.y+pickerBounds.height<=height);
    await page.keyboard.press('Escape');
    // Remove files through the same UI to leave room for the next iteration.
    for(let i=0;i<10;i++) await p1.locator('.dion-mc-draft-item button').first().click();
  }
  if(process.env.SCREENSHOT_PATH) await page.screenshot({path:process.env.SCREENSHOT_PATH});

  // Closing/removal restores the host and its focusability, with no stranded inert surface.
  await page.evaluate(()=>window.closeCanvas());
  assert.equal(await page.locator('#Syncord-fake-voice-host').isVisible(),true);
  assert.equal(await page.locator('#native-content').evaluate(el=>el.inert),false);
  assert.equal(await page.locator('#native-content').evaluate(el=>getComputedStyle(el).visibility),'visible');
  assert.equal(await page.locator('.dion-mc-exposed-native-overlay, .dion-mc-native-overlay-path').count(),0,'Closing restores all native layer markers');
  assert.equal(await page.locator('#launcher').evaluate(el=>document.activeElement===el),true);
  await page.evaluate(()=>window.openCanvas());
  await page.evaluate(()=>document.querySelector('.baseLayer_fixture').remove());
  await page.waitForFunction(()=>!document.querySelector('#Syncord-multichat-root'));
  await page.evaluate(()=>window.disposeCanvas());
  assert.deepEqual(errors,[]);
  console.log('PASS: native layer hit testing, theme inheritance, dialog focus/inert/Escape, adaptive tabs/keyboard, DOM and draft preservation, short viewports with 10 files, host cleanup');
} finally {await browser?.close();await rm(dir,{recursive:true,force:true});}
