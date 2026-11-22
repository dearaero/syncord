import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';

// Real Chromium layout with deterministic Discord stores. No account/network access.
const dir = await mkdtemp(path.join(tmpdir(), 'Syncord-multichat-'));
try {
  await build({stdin: {contents: `
    import { openMultiChatCanvas, closeMultiChatCanvas } from './src/renderer/plugins/multiChatCanvas/canvas';
    import { MULTICHAT_CSS } from './src/renderer/plugins/multiChatCanvas/styles';
    document.head.appendChild(Object.assign(document.createElement('style'), {textContent: MULTICHAT_CSS}));
    const messages = ['hello', 'second line', 'two\\nlines'].map((content, i) => ({id: String(i+1), content, author: {id:'user', username:'User'}, timestamp: new Date(2026,8,27,12,0,i).toISOString()}));
    const channels = { a: {id:'a', type:1, name:'A'}, b: {id:'b', type:1, name:'B'} };
    window.saved = {version:1,paneCount:2,panes:[{id:'pane-1',channelId:'a',draft:'kept draft'},{id:'pane-2',channelId:'b'}]};
    window.routes = []; window.sends = 0;
    const actions = { fetchMessages: async () => {}, sendMessage: async () => {window.sends++} };
    window.Syncord = { common: { stores: {
      ChannelStore: {getChannel:id=>channels[id]}, SelectedChannelStore:{getChannelId:()=> 'a'},
      MessageStore:{getMessages:()=>({_array:messages,ready:true,hasMoreBefore:false})}
    }, actions:{MessageActions:actions} }, webpack:{findByProps:(...props)=> props.includes('transitionTo') ? {transitionTo:route=>window.routes.push(route)} : undefined}, toast:{show:()=>{}} };
    window.openCanvas = () => openMultiChatCanvas({settings:{get:()=>window.saved,set:(_,v)=>window.saved=v},log:console});
    window.closeCanvas = closeMultiChatCanvas;
    window.openCanvas();
  `,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',outfile:path.join(dir,'fixture.js')});
  await writeFile(path.join(dir,'index.html'), '<!doctype html><meta charset="utf-8"><body style="margin:0"><script src="fixture.js"></script>');
  const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:800}});
    await page.goto(pathToFileURL(path.join(dir,'index.html')).href);
    await page.waitForSelector('.dion-mc-content');
    const content = await page.locator('.dion-mc-content').evaluateAll(elements => elements.map(e => ({text:e.textContent,height:e.getBoundingClientRect().height})));
    assert.deepEqual(content.slice(0,3), [{text:'hello',height:22},{text:'second line',height:22},{text:'two\nlines',height:44}]);
    for (const count of [2,3,4]) {
      await page.locator(`[data-mc-pane-count="${count}"]`).click();
      for(const [width,height] of [[1440,1000],[1440,900],[900,600],[760,600],[375,667],[320,480],[844,390]]) {
        await page.setViewportSize({width,height});
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const layout = await page.locator('.dion-mc-pane').evaluateAll(panes => panes.filter(p => !p.hidden).map(p => ({
          editorWidth:p.querySelector(".dion-mc-editor").clientWidth, editorText:p.querySelector(".dion-mc-editor").textContent, composerDisplay:getComputedStyle(p.querySelector(".dion-mc-composer")).display, width:p.clientWidth, overflow:p.scrollWidth>p.clientWidth,
          input:p.querySelector('.dion-mc-native-text-area').getBoundingClientRect().height,
          toolOverflow:p.querySelector('.dion-mc-composer-tools').scrollWidth>p.querySelector('.dion-mc-composer-tools').clientWidth,
          messages:p.querySelector('.dion-mc-messages-wrap').clientHeight,
          enabled:!p.querySelector('[data-mc-media-tool]').disabled,
          channel:!!p.querySelector('[data-mc-composer][contenteditable="plaintext-only"]')
        })));
        for(const pane of layout){
          const context=JSON.stringify({width,height,count,pane});
          assert.equal(pane.overflow,false,context);
          assert.equal(pane.toolOverflow,false,context);
          assert.equal(pane.input,56,context);
          assert.ok(pane.messages>80,context);
          assert.equal(pane.enabled,pane.channel);
        }
      }
    }
    console.log('PASS: message whitespace, 21 viewport/layout combinations, tool availability');
  } finally {await browser.close();}
} finally {await rm(dir,{recursive:true,force:true});}
