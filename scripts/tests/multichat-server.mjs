import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir=await mkdtemp(path.join(tmpdir(),'Syncord-server-test-'));
let browser;
try {
  await build({entryPoints:['scripts/tests/fixtures/multichat-server.js'],bundle:true,platform:'browser',outfile:path.join(dir,'fixture.js')});
  await writeFile(path.join(dir,'index.html'),'<!doctype html><meta charset="utf-8"><body style="margin:0"><script src="fixture.js"></script>');
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.setDefaultTimeout(10_000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://**/*',route=>route.abort());
  await page.goto(pathToFileURL(path.join(dir,'index.html')).href);
  const ids=await page.evaluate(()=>window.serverIds);
  const p1=page.locator('[data-mc-pane="pane-1"]'), p2=page.locator('[data-mc-pane="pane-2"]');
  const editor=p1.locator('[data-mc-composer]'), dialog=page.getByRole('dialog');
  await editor.waitFor();
  const choose=async(query,id,pane=p1)=>{
    await pane.locator('[data-mc-pick-channel]').click();
    await dialog.locator('[data-mc-picker-search]').fill(query);
    assert.equal(await dialog.locator('[data-mc-channel-choice]').count(),1);
    await dialog.locator(`[data-mc-channel-choice="${id}"]`).click();
    await dialog.waitFor({state:'detached'});
  };
  // Every joined guild is queried; native getChannelIds() returns only DMs.
  await p1.locator('[data-mc-pick-channel]').click();
  const choices=await dialog.locator('[data-mc-channel-choice]').evaluateAll(els=>els.map(el=>el.dataset.mcChannelChoice));
  assert.ok(choices.includes('a')&&choices.includes('b'));
  for(const name of ['text','announcement','publicThread','privateThread','announcementThread','readOnly','otherServer']) assert.ok(choices.includes(ids[name]),name);
  assert.equal(new Set(choices).size,choices.length,'IDs are deduplicated across maps');
  for(const name of ['hidden','voice','category','forum','media','cachedThread','getterGuild']) assert.ok(!choices.includes(ids[name]),name);
  await dialog.locator('[data-mc-picker-search]').fill('First Server');
  assert.ok(await dialog.locator('[data-mc-channel-choice]').count()>1);
  assert.ok((await dialog.innerText()).includes('First Server · Community'));
  await dialog.locator('[data-mc-picker-search]').fill('Community');
  assert.equal(await dialog.locator('[data-mc-channel-choice]').count(),1);
  await page.keyboard.press('Escape');

  // Unknown or unsupported IDs cannot be selected; whitespace and mentions work.
  for(const id of ['999999999999999999',ids.hidden,ids.voice,ids.forum]) {
    await p1.locator('[data-mc-pick-channel]').click();
    await dialog.locator('[data-mc-picker-search]').fill(id);
    assert.equal(await dialog.locator('[data-mc-channel-choice]').count(),0);
    assert.match(await dialog.innerText(),/not found or inaccessible/);
    await page.keyboard.press('Escape');
  }
  await choose('  '+ids.text+'  ',ids.text);
  await page.waitForFunction(id=>window.fetched.includes(id),ids.text);
  assert.ok((await p1.innerText()).includes('#general'));
  assert.ok((await p1.innerText()).includes('Server Nick'));
  assert.ok((await p1.innerText()).includes('Message in general'));
  assert.ok((await p2.innerText()).includes('hello'));
  await editor.fill('Server message');
  await p1.locator('[data-mc-send]').click();
  await page.waitForFunction(()=>window.sent.length===1);
  assert.deepEqual(await page.evaluate(()=>({channelId:window.sent[0].channelId,content:window.sent[0].content})),{channelId:ids.text,content:'Server message'});

  // Native media uses the server destination; selection stays draft-only.
  await p1.locator('[data-mc-media-tool="Emoji"]').click();
  await dialog.getByRole('button',{name:'party',exact:true}).click();
  assert.equal(await editor.locator('img').count(),1);
  assert.equal(await page.evaluate(()=>window.emojiQueries.at(-1)),ids.text);
  await p1.locator('[data-mc-media-tool="Stickers"]').click();
  await dialog.getByRole('button',{name:'Wave',exact:true}).click();
  await p1.locator('[data-mc-media-tool="GIF"]').click();
  await dialog.getByRole('button',{name:'Trending GIF',exact:true}).click();
  await p1.locator('[data-mc-files]').setInputFiles({name:'server.txt',mimeType:'text/plain',buffer:Buffer.from('test')});
  assert.equal(await page.evaluate(()=>window.sent.length),1);
  await p1.locator('[data-mc-message-id]').first().hover();
  await p1.locator('[data-mc-reply-message]').first().click();
  await p1.locator('[data-mc-send]').click();
  await page.waitForFunction(()=>window.sent.length===2);
  const media=await page.evaluate(()=>window.sent[1]);
  assert.equal(media.channelId,ids.text);
  assert.match(media.content,/<a:party:123456>/);
  assert.match(media.content,/https:\/\/example.com\/fast/);
  assert.deepEqual(media.stickers,['222']);
  assert.equal(media.files[0].channelId,ids.text);
  assert.equal(media.reply.guild_id,'700000000000000001');
  assert.equal(media.reply.channel_id,ids.text);
  assert.equal(await page.evaluate(()=>window.nativeDraft),'Native Discord draft');
  assert.deepEqual(await page.evaluate(()=>window.routes),[]);

  // Explicit ID lookup reaches cached threads excluded from enumeration, and
  // thread sending uses SEND_MESSAGES_IN_THREADS rather than SEND_MESSAGES.
  await choose('<#'+ids.cachedThread+'>',ids.cachedThread);
  await editor.fill('Thread message');
  await p1.locator('[data-mc-send]').click();
  await page.waitForFunction(()=>window.sent.length===3);
  assert.equal(await page.evaluate(()=>window.sent[2].channelId),ids.cachedThread);
  await choose(ids.getterGuild,ids.getterGuild);
  assert.match(await p1.locator('[data-mc-pick-channel]').getAttribute('title'),/Second Server/);
  await page.evaluate(()=>{window.closeCanvas();window.openCanvas()});
  assert.equal(await page.evaluate(()=>window.saved.panes[0].channelId),ids.getterGuild);
  assert.ok((await p1.innerText()).includes('#getterGuild'));

  // Native server navigation has the guild ID even for getGuildId-only records.
  await p1.locator('[data-mc-open-native]').click();
  assert.equal(await page.evaluate(()=>window.routes.at(-1)),'/channels/700000000000000002/'+ids.getterGuild);
  await page.evaluate(()=>window.openCanvas());

  // Read-only channels can be viewed, but failed sends preserve their drafts.
  await choose(ids.readOnly,ids.readOnly);
  await editor.fill('Keep this draft');
  await p1.locator('[data-mc-files]').setInputFiles({name:'kept.txt',mimeType:'text/plain',buffer:Buffer.from('test')});
  await p1.locator('[data-mc-send]').click();
  await page.waitForFunction(()=>document.querySelector('[data-mc-pane="pane-1"]').innerText.includes('permission to send'));
  assert.equal(await editor.innerText(),'Keep this draft');
  assert.ok((await p1.innerText()).includes('kept.txt'));
  assert.equal(await page.evaluate(()=>window.sent.length),3);
  // Drafts cannot silently change their destination.
  await p1.locator('[data-mc-pick-channel]').click();
  await dialog.locator('[data-mc-picker-search]').fill(ids.text);
  await dialog.locator(`[data-mc-channel-choice="${ids.text}"]`).click();
  assert.ok((await p1.innerText()).includes('#readOnly'));
  assert.match(await p1.innerText(),/Send or clear this draft/);

  // Large DM lists cannot crowd all server channels out of the initial dialog.
  await page.evaluate(()=>{
    const store=window.Syncord.common.stores.ChannelStore;
    const bulk=Object.fromEntries(Array.from({length:350},(_,i)=>{const id=String(900000000000000001n+BigInt(i));return[id,{id,type:1,recipients:['bulk-user-'+i]}]}));
    const originalGet=store.getChannel, originalIds=store.getChannelIds;
    store.getChannel=id=>bulk[id]??originalGet(id);
    store.getChannelIds=guildId=>guildId?originalIds(guildId):[...originalIds(),...Object.keys(bulk)];
  });
  await p2.locator('[data-mc-pick-channel]').click();
  assert.equal(await dialog.locator('[data-mc-channel-choice]').count(),300);
  assert.ok(await dialog.locator(`[data-mc-channel-choice="${ids.text}"]`).count());
  assert.match(await dialog.getByRole('status').innerText(),/Search to narrow/i);
  await dialog.locator('[data-mc-picker-search]').fill(ids.cachedThread);
  assert.equal(await dialog.locator('[data-mc-channel-choice]').count(),1);
  await page.keyboard.press('Escape');

  // Older cached APIs may have only maps, or only guild-specific ID lists.
  await page.evaluate(()=>{
    const stores=window.Syncord.common.stores;
    delete stores.ChannelStore.getChannelIds;
    delete stores.GuildStore.getGuildIds;
  });
  assert.ok((await page.evaluate(()=>window.getServerChoices('First Server'))).some(c=>c.id===ids.text));
  await page.evaluate(()=>{const store=window.Syncord.common.stores.ChannelStore;store.getMutableBasicGuildChannelsForGuild=()=>{throw new Error('version drift')}});
  assert.ok((await page.evaluate(()=>window.getServerChoices('First Server'))).some(c=>c.id===ids.text));
  // A DM pane still sends independently while the server pane keeps its draft.
  await p2.locator('[data-mc-composer]').fill('Still a DM');
  await p2.locator('[data-mc-send]').click();
  await page.waitForFunction(()=>window.sent.length===4);
  assert.equal(await page.evaluate(()=>window.sent[3].channelId),'b');
  assert.equal(await editor.innerText(),'Keep this draft');
  assert.ok((await p1.innerText()).includes('kept.txt'));
  await page.evaluate(()=>window.disposeCanvas());
  assert.deepEqual(errors,[]);
  console.log('PASS: guild enumeration, name/server/category/ID search, cached threads, inaccessible/type filtering, server history/media/replies, guild navigation, independent drafts, read-only rejection, API drift');
} finally {await browser?.close();await rm(dir,{recursive:true,force:true});}
