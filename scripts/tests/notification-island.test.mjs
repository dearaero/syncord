// Notification Island: message/voice classification and the queue + history core.
// Usage: node --test scripts/tests/notification-island.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
const out=await build({stdin:{contents:"export * from './src/renderer/plugins/notificationIsland/classify';export * from './src/renderer/plugins/notificationIsland/core';",resolveDir:'.',loader:'ts'},bundle:true,format:'esm',platform:'neutral',write:false,logLevel:'silent'});
const m=await import('data:text/javascript,'+encodeURIComponent(out.outputFiles[0].text));
const me='111111111111111111',other='222222222222222222';
const all={enabled:{mention:true,dm:true,reply:true,keyword:true},keywords:['release']};

test('messages are classified, and @everyone or own messages never notify',()=>{
  const msg=extra=>({author:{id:other},content:'hi',mentions:[],...extra});
  assert.equal(m.classifyMessage(msg({}),me,all,1),'dm');
  assert.equal(m.classifyMessage(msg({}),me,all,3),'dm');
  assert.equal(m.classifyMessage(msg({referenced_message:{author:{id:me}},mentions:[{id:me}]}),me,all,0),'reply');
  assert.equal(m.classifyMessage(msg({referenced_message:{author:{id:me}},mentions:[]}),me,all,0),undefined,'a silent (no-ping) reply, e.g. a bot answering my command, does not notify');
  assert.equal(m.classifyMessage(msg({mentions:[{id:me}]}),me,all,0),'mention');
  assert.equal(m.classifyMessage(msg({mentions:[me]}),me,all,0),'mention');
  assert.equal(m.classifyMessage(msg({content:'New RELEASE today'}),me,all,0),'keyword');
  assert.equal(m.classifyMessage(msg({mention_everyone:true,content:'@everyone'}),me,all,0),undefined);
  assert.equal(m.classifyMessage({author:{id:me},content:'release'},me,all,1),undefined);
  const off={enabled:{mention:true,dm:false,reply:false,keyword:false},keywords:['release']};
  assert.equal(m.classifyMessage(msg({}),me,off,1),undefined,'a disabled DM switch silences DMs');
  assert.equal(m.classifyMessage(msg({referenced_message:{author:{id:me}},mentions:[{id:me}]}),me,off,0),'mention','a pinged reply still counts as a mention');
});

test('voice changes: join, move, leave, stream; mute toggles stay quiet',()=>{
  const at=(channelId,stream=false)=>({channelId,stream});
  assert.equal(m.voiceChange(undefined,at('1')),'voiceJoin');
  assert.equal(m.voiceChange(at('1'),at('2')),'voiceJoin');
  assert.equal(m.voiceChange(at('1'),at(null)),'voiceLeave');
  assert.equal(m.voiceChange(at('1'),at('1',true)),'stream');
  assert.equal(m.voiceChange(at('1',true),at('1',true)),undefined);
  assert.equal(m.voiceChange(at('1'),at('1')),undefined);
});

test('message text and avatars are bounded and limited to Discord hosts',()=>{
  assert.equal(m.firstLine('\n\n  first  \nsecond'),'first');
  assert.equal(m.firstLine('x'.repeat(500)).length,140);
  assert.equal(m.avatarUrl({id:other,avatar:'a'.repeat(32)}),`https://cdn.discordapp.com/avatars/${other}/${'a'.repeat(32)}.webp?size=64`);
  assert.equal(m.avatarUrl({id:other,avatar:'../../evil'}),undefined);
});

test('queue shows one at a time; silent mode only records; history is capped and saved',()=>{
  const saved=[];const core=m.createIslandCore(h=>saved.push(h.length));
  const item=id=>({id,kind:'dm',title:'t',body:'b',at:1});
  core.push(item('a'),true);core.push(item('b'),true);core.push(item('c'),false);
  assert.equal(core.current().id,'a');assert.equal(core.pending(),2);assert.equal(core.unread(),3);
  assert.equal(core.advance().id,'b');assert.equal(core.advance(),undefined);
  assert.deepEqual(core.history().map(i=>i.id),['c','b','a']);
  core.markSeen();assert.equal(core.unread(),0);
  for(let i=0;i<80;i++)core.push(item('x'+i),false);
  assert.equal(core.history().length,m.HISTORY_LIMIT);
  core.clear();assert.equal(core.history().length,0);assert.equal(saved.at(-1),0);
});

test('persisted history is re-validated on load',()=>{
  const raw=JSON.stringify([{id:'a',kind:'dm',title:'x'.repeat(500),body:'b',at:1,avatar:'https://evil.example/a.png',channelId:'not-an-id'},{bad:true},'nope',{id:'b',kind:'sp',title:'S',body:'+5',at:2,channelId:other}]);
  const list=m.parseHistory(raw);
  assert.equal(list.length,2);assert.equal(list[0].title.length,120);assert.equal(list[0].avatar,undefined);assert.equal(list[0].channelId,undefined);assert.equal(list[1].channelId,other);
  assert.deepEqual(m.parseHistory('{'),[]);
});

test('the ecosystem profile capability is gated to Notification Island',()=>{
  const context=readFileSync('src/renderer/api/plugin/context.ts','utf8');
  assert.match(context,/identity!=="notification-island"\|\|!permissions\.native\?\.includes\("ecosystem-profile"\)/);
  const index=readFileSync('src/renderer/plugins/notificationIsland/index.ts','utf8');
  assert.match(index,/native:\['ecosystem-profile'\]/);
  assert.doesNotMatch(readFileSync('src/renderer/plugins/notificationIsland/view.ts','utf8'),/innerHTML=(?!'<div class="ni-item")/,'message content must never reach innerHTML');
});

test('richParts splits user/channel mentions and flattens custom emoji',()=>{
  assert.deepEqual(m.richParts('hi <@909502563567677440> and <@!123456789012345678> in <#123456789012345679> <a:wave:123456789012345670>!'),[
    {type:'text',value:'hi '},{type:'user',id:'909502563567677440'},{type:'text',value:' and '},{type:'user',id:'123456789012345678'},
    {type:'text',value:' in '},{type:'channel',id:'123456789012345679'},{type:'text',value:' :wave:!'},
  ]);
  assert.deepEqual(m.richParts('<@&123456789012345678> <script>'),[{type:'text',value:'<@&123456789012345678> <script>'}]);
  assert.deepEqual(m.richParts(''),[]);
});

test('drain empties the whole queue for read-all but keeps history',()=>{
  const core=m.createIslandCore(()=>{});
  for(const id of ['a','b','c'])core.push({id,kind:'mention',title:'t',body:'b',at:1},true);
  assert.deepEqual(core.drain().map(item=>item.id),['a','b','c']);
  assert.equal(core.pending(),0);assert.equal(core.current(),undefined);assert.equal(core.history().length,3);
});

test('keywords match readable text only, not emoji names or mention ids',()=>{
  assert.equal(m.matchedKeyword('<:darknes_muttluuuu:123456789012345678>',['mut','1234']),undefined);
  assert.equal(m.matchedKeyword('hey <@909502563567677440>',['9095']),undefined);
  assert.equal(m.matchedKeyword('Release is out',['beta','release']),'release');
});

test('message requests, spam and muted DMs/keywords stay silent like in Discord',()=>{
  const f={request:false,spam:false,muted:false};
  assert.equal(m.silencedByDiscord('dm',f),false);
  assert.equal(m.silencedByDiscord('dm',{...f,request:true}),true,'stranger DM in Message Requests');
  assert.equal(m.silencedByDiscord('dm',{...f,spam:true}),true);
  assert.equal(m.silencedByDiscord('dm',{...f,muted:true}),true);
  assert.equal(m.silencedByDiscord('keyword',{...f,muted:true}),true);
  assert.equal(m.silencedByDiscord('mention',{...f,muted:true}),false,'pings still get through a mute');
  assert.equal(m.silencedByDiscord('reply',{...f,muted:true}),false);
});

test('keywords ignore links and only match from the start of a word',()=>{
  const link='https://cdn.discordapp.com/attachments/1/2/image.png?ex=6a1b&is=69ff&hm=0ace5b7d9e12c3f4&';
  assert.equal(m.matchedKeyword(link,['ace','image','cdn']),undefined,'a pasted image link never matches');
  assert.equal(m.matchedKeyword('bak <'+link+'>',['ace']),undefined);
  assert.equal(m.matchedKeyword("umut'a sor",['umut']),'umut');
  assert.equal(m.matchedKeyword('umutcum naber',['umut']),undefined);
  assert.equal(m.matchedKeyword('31qweqwe',['31']),undefined,'whole words only');
  assert.equal(m.matchedKeyword('2031',['31']),undefined);
  assert.equal(m.matchedKeyword("31'i gördün mü",['31']),'31');
  assert.equal(m.matchedKeyword('xumut',['umut']),undefined);
  assert.equal(m.matchedKeyword('Şimdi gel',['şimdi']),'şimdi');
  assert.equal(m.matchedKeyword('c++ soru',['c++']),'c++');
});
