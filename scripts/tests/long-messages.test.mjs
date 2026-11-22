import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';
const dir=mkdtempSync(tmpdir()+'/syncord-long-');
await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/renderer/plugins/longMessages/splitter';export * from './src/renderer/plugins/longMessages/draft';export * from './src/renderer/plugins/longMessages/queue';export * from './src/renderer/chat/longMessage';export * from './src/renderer/chat/messageLimit';export * from './src/renderer/plugins/longMessages/discord';export * from './src/renderer/i18n/longMessages';export {sendCanvasMessage} from './src/renderer/plugins/multiChatCanvas/discord';export {sendMessage as scheduledSend} from './src/renderer/plugins/scheduledMessages/discord';`},bundle:true,platform:'node',format:'esm',outfile:dir+'/test.mjs',logLevel:'silent'});
const E=await import(dir+'/test.mjs');test.after(()=>rmSync(dir,{recursive:true,force:true}));
const A='100000000000000001',C='200000000000000001';
for(const length of [500,2000,2001,5000,10000,20000])test('UTF-16 limit and exact source reconstruction '+length,()=>{const text='x'.repeat(length),parts=E.splitMessage(text,{limit:2000,maxParts:15});assert.equal(parts.map(p=>p.raw).join(''),text);assert.ok(parts.every(p=>p.content.length<=2000&&p.raw.length>0));assert.equal(parts.length,Math.ceil(length/2000));});
test('Unicode graphemes, Turkish and mixed whitespace are lossless; pathological sequences fail before sending',()=>{
 const text=('Türkçe ıİşğü e\u0301 👩🏽‍💻 👨‍👩‍👧‍👦 🇹🇷\n\n').repeat(190),parts=E.splitMessage(text,{limit:2000,maxParts:15});
 const boundaries=new Set([...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].map(g=>g.index+g.segment.length));
 assert.equal(parts.map(p=>p.raw).join(''),text);for(const p of parts){assert.ok(boundaries.has(p.end));assert.ok(!/[\uD800-\uDBFF]$/.test(p.raw));assert.ok(p.content.length<=2000);}
 assert.throws(()=>E.splitMessage('a'+'\u0301'.repeat(2100),{limit:2000,maxParts:15}),/long.grapheme/);
});
test('natural boundaries, mentions, links and Markdown retain raw slices and include structural overhead',()=>{
 const mention='<@123456789012345678>',url='https://example.com/'+ 'z'.repeat(70);
 for(const text of ['a'.repeat(1790)+'\n\n'+'b'.repeat(2200),('**bold** _italics_ __underline__ ~~strike~~ ||spoiler|| '+mention+' '+url+'\n').repeat(100),'```typescript\n'+('const a = "😀";\n').repeat(480)+'```', '**'+('word ').repeat(1800)+'**', '`'+('inline ').repeat(600)+'`']){
  const parts=E.splitMessage(text,{limit:2000,maxParts:15,numbers:true});assert.equal(parts.map(p=>p.raw).join(''),text);assert.ok(parts.every(p=>p.content.length<=2000));
  for(const p of parts){for(const token of [mention,url]){const at=text.indexOf(token,p.start);if(at>=p.start&&at<p.end)assert.ok(at+token.length<=p.end);}}
 }
 const parts=E.splitMessage('a'.repeat(1790)+'\n\n'+'b'.repeat(2200),{limit:2000,maxParts:15});assert.ok(parts[0].raw.endsWith('\n\n'));
});
test('oversized input and part limits fail atomically',()=>{assert.throws(()=>E.splitMessage('x'.repeat(31000),{limit:2000,maxParts:15}),/long.limit/);assert.throws(()=>E.splitMessage('x'.repeat(5000),{limit:2000,maxParts:2}),/long.limit/);});
const cfg={numbers:false,confirmLarge:false,maxParts:15};
const ok=(channel=C)=>({ok:true,status:200,body:{id:'300000000000000001',channel_id:channel}});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const req=(changes={})=>({accountId:A,channelId:C,text:'x'.repeat(5000),valid:()=>true,send:async()=>ok(),...changes});
test('sequential queue validates actual IDs, suppresses concurrent duplicates and preserves exact remaining source',async()=>{
 const calls=[],gate=deferred(),updates=[];const queue=new E.LongQueue(()=>cfg,()=>{});const request=req({send:async(content,index,nonce)=>{calls.push({content,index,nonce});if(index===0)await gate.promise;return ok();},delivered:(remaining,count)=>updates.push([remaining,count])});
 const run=queue.offer(request);assert.equal(calls.length,1);await assert.rejects(queue.offer(request),/long.busy/);gate.resolve();await run;assert.deepEqual(calls.map(c=>c.index),[0,1,2]);assert.equal(new Set(calls.map(c=>c.nonce)).size,3);assert.ok(calls.every(c=>/^\d{17,20}$/.test(c.nonce)));assert.equal(updates[0][0].length,3000);assert.equal(updates.at(-1)[0],'');assert.equal(queue.jobs.size,0);
 assert.equal(queue.offer(req({text:'short'})),undefined);
});
for(const [name,response]of [['missing ID',{ok:true}],['wrong channel',ok('9')],['429',{status:429,body:{retry_after:1}}],['empty',undefined]])test('unconfirmed delivery stops without automatic retry: '+name,async()=>{let sent=0;const q=new E.LongQueue(()=>cfg,()=>{});await assert.rejects(q.offer(req({send:async()=>++sent===1?ok():response})),/long.uncertain/);const job=[...q.jobs.values()][0];assert.equal(sent,2);assert.equal(job.sent,1);assert.equal(job.remaining.length,3000);q.dismiss(job);assert.equal(q.jobs.size,0);});
test('network loss and timeout retain the uncertain current part without retrying',async()=>{for(const send of [async()=>{throw Error('network');},()=>new Promise(()=>{})]){const q=new E.LongQueue(()=>cfg,()=>{},5);await assert.rejects(q.offer(req({send})),/long.uncertain/);const job=[...q.jobs.values()][0];assert.equal(job.sent,0);assert.equal(job.remaining.length,5000);}});
test('cancel/disable/account change do not retract an in-flight delivered message or send the next part',async()=>{for(const stop of ['cancel','disable','account']){const gate=deferred();let valid=true,calls=0;const q=new E.LongQueue(()=>cfg,()=>{});const run=q.offer(req({valid:()=>valid,send:async()=>{calls++;await gate.promise;return ok();}}));const job=[...q.jobs.values()][0];if(stop==='cancel')job.cancel();if(stop==='disable')q.stop();if(stop==='account'){valid=false;q.cancelOtherAccounts('other');}gate.resolve();await assert.rejects(run,/long.cancelled/);assert.equal(calls,1);assert.equal(job.sent,1);assert.equal(job.remaining.length,3000);}});
test('large confirmation is explicit and cancellable; max parts never starts a send',async()=>{let calls=0,job;const q=new E.LongQueue(()=>({...cfg,confirmLarge:true}),j=>job=j);const run=q.offer(req({text:'x'.repeat(12500),send:async()=>{calls++;return ok();}}));assert.equal(job.status,'confirm');assert.equal(calls,0);job.confirm();await run;assert.equal(calls,7);const q2=new E.LongQueue(()=>({...cfg,confirmLarge:true}),j=>job=j);const cancelled=q2.offer(req({text:'x'.repeat(12500)}));job.cancel();await assert.rejects(cancelled,/long.cancelled/);});
test('explicit shared entry point unregisters completely and does not hook scheduled native sends',async()=>{const request=req();assert.equal(E.offerLongMessage(request),undefined);let hits=0;const off=E.registerLongMessages(()=>{hits++;return Promise.resolve();});await E.offerLongMessage(request);off();assert.equal(E.offerLongMessage(request),undefined);assert.equal(hits,1);const scheduled=readFileSync('src/renderer/plugins/scheduledMessages/discord.ts','utf8');assert.ok(!scheduled.includes('offerLongMessage'));});
test('all 18 locales define the same messages and interpolation tokens',()=>{const en=E.longMessagesCatalog('en-US');for(const locale of ['en-US','tr','es-ES','de','ja','fr','pt-BR','ru','it','nl','pl','zh-CN','id','fa','cs','vi','ko','uk']){const rows=E.longMessagesCatalog(locale);assert.deepEqual(Object.keys(rows),Object.keys(en));for(const [key,value]of Object.entries(rows)){assert.ok(value?.length>0);assert.deepEqual([...value.matchAll(/\{\w+\}/g)].map(m=>m[0]).sort(),[...en[key].matchAll(/\{\w+\}/g)].map(m=>m[0]).sort());}}});

test('Canvas/Popout explicit send lane preserves first reply/media, suppresses continuation notifications, stops on permission loss',async()=>{
 let account=A,allowed=true;const calls=[],remaining=[];
 globalThis.window={Syncord:{common:{stores:{UserStore:{getCurrentUser:()=>({id:account})},ChannelStore:{getChannel:()=>({id:C,type:0,guild_id:'guild'})},PermissionStore:{computePermissions:()=>allowed?3072n:1024n}},actions:{MessageActions:{sendMessage:async(id,message,ready,options)=>{calls.push({id,message,options});return ok();}}}},webpack:{findByProps:()=>undefined}}};
 const queue=new E.LongQueue(()=>cfg,()=>{}),off=E.registerLongMessages(r=>queue.offer(r));
 try{
  await E.sendCanvasMessage(C,'x'.repeat(5000),{messageId:'300000000000000001'},{uploads:['file'],stickerIds:['sticker'],onRemaining:(text,sent)=>remaining.push([text,sent])});
  assert.equal(calls.length,3);assert.deepEqual(calls[0].options.attachmentsToUpload,['file']);assert.deepEqual(calls[0].options.stickerIds,['sticker']);assert.ok(calls[0].options.messageReference);assert.equal(calls[1].options.messageReference,undefined);assert.equal(calls[1].options.attachmentsToUpload,undefined);assert.deepEqual(calls[1].options.allowedMentions.parse,[]);assert.equal(remaining[0][0].length,3000);assert.equal(remaining.at(-1)[0],'');
  calls.length=0;await assert.rejects(E.sendCanvasMessage(C,'y'.repeat(5000),undefined,{onRemaining:()=>{allowed=false;}}));assert.equal(calls.length,1);allowed=true;
 }finally{off();queue.stop();}
 await E.sendCanvasMessage(C,'short');assert.equal(calls.length,2);
});
test('Markdown code fences reopen with language, numbering stays outside, and invalid limits fail early',()=>{
 const parts=E.splitMessage('```typescript\n'+('const x = 123;\n').repeat(400)+'```',{limit:2000,maxParts:15,numbers:true});
 for(let i=0;i<parts.length;i++){const p=parts[i];assert.ok(p.content.startsWith('```typescript\n'));assert.match(p.content,/```\n\(\d+\/\d+\)$/);assert.equal(p.content.match(/```/g).length,2);}
 assert.throws(()=>E.splitMessage('x'.repeat(5000),{limit:0,maxParts:15}),/long.limit/);
});

test('Scheduled Messages keeps its single-send contract and never enters the Long Messages lane',async()=>{
 const calls=[];let offers=0;globalThis.window={Syncord:{common:{stores:{ChannelStore:{getChannel:id=>({id,type:1,recipients:[]})}},actions:{MessageActions:{sendMessage:async(...args)=>{calls.push(args);return {ok:true,status:200,body:{id:'300000000000000001'}};}}}}}};
 const off=E.registerLongMessages(()=>{offers++;throw Error('scheduled send must not enter splitting');});
 try{await E.scheduledSend({channelId:C,content:'scheduled short'});assert.equal(calls.length,1);assert.equal(calls[0][1].content,'scheduled short');assert.ok(calls[0][3]);assert.equal(offers,0);}finally{off();}
});

test('long quoted/list lines carry only structural indentation while URLs do not leak emphasis',()=>{
 for(const text of ['> '+('quote ').repeat(1000),'- '+('list ').repeat(1000)]){
  const parts=E.splitMessage(text,{limit:2000,maxParts:15});assert.equal(parts.map(p=>p.raw).join(''),text);assert.ok(parts.every(p=>p.content.length<=2000));
  if(text.startsWith('>'))assert.ok(parts.every(p=>p.content.startsWith('> ')));else assert.ok(parts.slice(1).every(p=>p.content.startsWith('  ')));
 }
 const parts=E.splitMessage(('https://example.com/a_b '+ 'plain '.repeat(300)).repeat(3),{limit:2000,maxParts:15});assert.ok(!parts.some(p=>p.content.startsWith('_')));
});

test('disable does not write a late acknowledgement into a composer after listeners have been removed',async()=>{
 const gate=deferred();let writes=0;const q=new E.LongQueue(()=>cfg,()=>{});const run=q.offer(req({send:()=>gate.promise,delivered:()=>writes++}));q.stop();assert.equal(q.jobs.size,0);gate.resolve(ok());await assert.rejects(run,/long.cancelled/);assert.equal(writes,0);
});

test('late completion after A → B → A cannot remove a new job with the same channel key',async()=>{
 const oldLast=deferred(),reached=deferred(),newFirst=deferred();const q=new E.LongQueue(()=>cfg,()=>{});
 const old=q.offer(req({text:'x'.repeat(2100),send:async(_,index)=>{if(index===1){reached.resolve();return oldLast.promise;}return ok();}}));
 await reached.promise;q.cancelOtherAccounts('other');const next=q.offer(req({text:'y'.repeat(2100),send:()=>newFirst.promise}));const current=[...q.jobs.values()][0];
 oldLast.resolve(ok());await old;assert.equal(q.jobs.get(A+':'+C),current);q.stop();newFirst.resolve(ok());await assert.rejects(next,/long.cancelled/);
});

test('partial settlement recovers the full suffix once; editor failure cannot change confirmed delivery or retry it',async()=>{
 let recovered=[],calls=0;const q=new E.LongQueue(()=>cfg,()=>{});
 await assert.rejects(q.offer(req({send:async()=>++calls===1?ok():undefined,settled:(remaining,sent)=>{recovered.push([remaining,sent]);throw Error('editor disconnected');}})),/long.uncertain/);
 assert.equal(calls,2);assert.equal(recovered.length,1);assert.equal(recovered[0][0].length,3000);assert.equal(recovered[0][1],1);assert.equal([...q.jobs.values()][0].sent,1);q.stop();
 recovered=[];const done=new E.LongQueue(()=>cfg,()=>{});await done.offer(req({settled:()=>recovered.push('unexpected')}));assert.deepEqual(recovered,[]);
});
test('long recovery uses owned Slate operations and preserves complete text beyond the native persistence ceiling',()=>{
 const text=('Türkçe 👩🏽‍💻\n').repeat(900);let operation;
 const editor={children:[{children:[{text:'old '},{text:'draft'}]},{children:[{text:'last line'}]}],selection:null,apply:value=>operation=value,deleteFragment(){this.children=[{children:[{text:''}]}];},insertText(value){this.children=[{children:[{text:value}]}];}};
 assert.equal(E.replaceLongDraft(editor,text),true);assert.deepEqual(operation.newProperties,{anchor:{path:[0,0],offset:0},focus:{path:[1,0],offset:9}});assert.equal(editor.children[0].children[0].text,text);assert.ok(text.length>4500);
 let touched=false;const malformed={...editor,children:[{}],apply:()=>{touched=true;}};assert.equal(E.replaceLongDraft(malformed,text),false);assert.equal(touched,false);assert.equal(E.replaceLongDraft({},text),false);
});
