import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';
const dir=mkdtempSync(tmpdir()+'/syncord-emoji-');
await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/renderer/plugins/emojiFreedom/model';export * from './src/renderer/plugins/emojiFreedom/discord';export * from './src/renderer/chat/expressionDraft';export * from './src/renderer/plugins/emojiFreedom';export * from './src/renderer/i18n/emojiFreedom';`},bundle:true,platform:'node',format:'esm',outfile:dir+'/test.mjs',logLevel:'silent',plugins:[{name:'fixture',setup(b){b.onResolve({filter:/api\/plugin$/},()=>({path:'plugin',namespace:'fixture'}));b.onResolve({filter:/ui\/toast$/},()=>({path:'toast',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='plugin'?'export const definePlugin=p=>p;':'export const ToastType={FAILURE:"failure"};export const showToast=(text)=>globalThis.notices.push(text);'}));}}]});
const E=await import(dir+'/test.mjs');test.after(()=>rmSync(dir,{recursive:true,force:true}));
const A='100000000000000001',B='100000000000000002',C='200000000000000001',OTHER='200000000000000002',ID='300000000000000001',G='400000000000000001';
function fixture(){
 const hooks=new Map(),off=[];let user={id:A,premiumType:0},channel={id:C,type:1},emoji={id:ID,name:'wave',guildId:G,animated:false,available:true},sticker={id:ID,name:'wave',guild_id:G,format_type:1,type:2,available:true},reason=10,member=true,externalAllowed=true,stickerModule=true;
 const modules={getEmojiUnavailableReason:()=>reason,PREMIUM_LOCKED:10,DISALLOW_EXTERNAL:11,EmojiIntention:{CHAT:3}};
 const sendability={SENDABLE:0,SENDABLE_WITH_PREMIUM:1,NONSENDABLE:2,SENDABLE_WITH_BOOSTED_GUILD:3};
 // Same semantic calls/branches as Discord web build 643186, module 361670.
 const entitlement={canUseCustomStickersEverywhere:u=>u.premiumType===2};
 const members={getSelfMember:()=>member?{}:undefined},packs={getStickerPack:()=>({})};
 const stickerExports={obfuscatedEnum:sendability,obfuscatedCheck:(e,u,c)=>{
  if(!u)return 2;const premium=entitlement.canUseCustomStickersEverywhere(u);
  if(e.type===1)return packs.getStickerPack(e.pack_id)?0:2;
  if(e.type!==2||!c||!members.getSelfMember(e.guild_id))return 2;
  if(!e.available)return 3;
  if(c.guild_id&&c.guild_id===e.guild_id)return 0;
  return !c.guild_id||externalAllowed?+!premium:2;
 }};
 const stores={UserStore:{getCurrentUser:()=>user},ChannelStore:{getChannel:id=>id===channel.id?channel:undefined},GuildStore:{getGuild:()=>member?{}:undefined},EmojiStore:{getCustomEmojiById:id=>id===emoji?.id?emoji:undefined},StickersStore:{getStickerById:id=>id===sticker?.id?sticker:undefined}};
 globalThis.notices=[];globalThis.window={Syncord:{common:{stores},webpack:{findByStoreName:n=>stores[n],findByProps:(...keys)=>keys.every(k=>k in modules)?modules:undefined,find:predicate=>stickerModule&&predicate(stickerExports)?stickerExports:undefined}},addEventListener:(t,f)=>hooks.set(t,f),removeEventListener:(t,f)=>{if(hooks.get(t)===f)hooks.delete(t);}};
 const props={channel,type:{expressionPicker:{emojiIntention:3}},onSelectEmoji(){},onSelectSticker(){},onSelectGIF(){}};
 const cell={getAttribute:k=>k==='data-type'?'emoji':ID,hasAttribute:()=>true};
 const node={closest:()=>cell,__reactFiber$fixture:{memoizedProps:{emoji},return:{memoizedProps:props}}};
 const ctx={disposable:f=>off.push(f),log:{warn(){}},stop(){for(const f of off.splice(0).reverse())f();}};
 const s=(kind='emoji')=>({kind,id:ID,channelId:C,props});
 return {hooks,ctx,props,node,cell,modules,stores,s,get emoji(){return emoji;},get sticker(){return sticker;},set emoji(v){emoji=v;},set sticker(v){sticker=v;},set user(v){user=v;},set channel(v){channel=v;props.channel=v;},set reason(v){reason=v;},set member(v){member=v;},set externalAllowed(v){externalAllowed=v;},set stickerModule(v){stickerModule=v;}};
}
function event(target,type='click',values={}){return {target,type,button:0,key:'Enter',defaultPrevented:false,...values,preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){this.stopped=true;}};}

test('media links preserve GIF/APNG formats, reject Lottie conversion and never accept arbitrary URLs',()=>{
 const media={id:ID,name:'https://evil.test/x',animated:false};
 assert.match(E.mediaAlternative('emoji',media,true).url,/^https:\/\/cdn\.discordapp\.com\/emojis\/\d+\.png/);
 assert.match(E.mediaAlternative('emoji',{...media,animated:true},true).url,/\.gif\?/);
 for(const format_type of [1,2])assert.match(E.mediaAlternative('sticker',{...media,format_type},true).url,/\.png\?.*passthrough=true/);
 assert.match(E.mediaAlternative('sticker',{...media,format_type:4},true).url,/\.gif\?/);
 assert.equal(E.mediaAlternative('sticker',{...media,format_type:3},true).kind,'unsupported');
 for(const m of [{...media,id:'../../a'},{...media,available:false}])assert.equal(E.mediaAlternative('emoji',m,true).kind,'native');
 assert.equal(E.mediaAlternative('emoji',media,false).kind,'native');assert.equal(E.mediaAlternative('sticker',{...media,format_type:99},true).kind,'native');
});

test('native ownership: only CHAT ExpressionPicker selections are recognized; Unicode, favorites and other surfaces stay untouched',()=>{
 const f=fixture();assert.equal(E.selectionFrom(f.node).channelId,C);
 f.props.type.expressionPicker.emojiIntention=0;assert.equal(E.selectionFrom(f.node),undefined);
 f.props.type.expressionPicker.emojiIntention=3;delete f.props.onSelectGIF;assert.equal(E.selectionFrom(f.node),undefined);
 f.props.onSelectGIF=()=>{};f.cell.getAttribute=k=>k==='data-type'?'emoji':'😀';f.node.__reactFiber$fixture.memoizedProps={emoji:{surrogates:'😀'}};assert.equal(E.selectionFrom(f.node),undefined);
 f.cell.getAttribute=k=>k==='data-type'?'emoji':ID;const favorite={hasAttribute:()=>false};f.node.closest=selector=>selector==='button'?favorite:f.cell;assert.equal(E.selectionFrom(f.node),undefined);
});

test('native availability is read only: allowed and Nitro emoji flows pass through; inaccessible or unknown restrictions fail closed',()=>{
 const f=fixture();assert.equal(E.alternative(f.s()).kind,'link');f.emoji.animated=true;assert.match(E.alternative(f.s()).url,/\.gif/);
 for(const r of [null,undefined,0,999]){f.reason=r;assert.equal(E.alternative(f.s()).kind,'native');}
 f.user={id:A,premiumType:2};f.reason=null;assert.equal(E.alternative(f.s()).kind,'native');
 f.reason=10;f.member=false;assert.equal(E.alternative(f.s()).kind,'native');f.member=true;f.emoji.available=false;assert.equal(E.alternative(f.s()).kind,'native');f.emoji.available=true;
 delete f.modules.PREMIUM_LOCKED;assert.equal(E.alternative(f.s()).kind,'native');assert.equal(f.stores.UserStore.getCurrentUser().premiumType,2);
 f.emoji=undefined;assert.equal(E.alternative(f.s()).kind,'native');
});

test('keyboard active-descendant resolves the exact native grid item; ordinary composer typing never scans fibers',()=>{
 const f=fixture();let fiberRead=false;
 const outside={closest:()=>null,getAttribute:()=>null,get __reactFiber$typing(){fiberRead=true;throw Error('must not inspect ordinary typing');}};
 assert.equal(E.selectionFrom(outside),undefined);assert.equal(fiberRead,false);
 const grid={closest:()=>null,getAttribute:()=> 'active-emoji',ownerDocument:{getElementById:id=>id==='active-emoji'?f.node:null},contains:n=>n===f.node};
 assert.equal(E.selectionFrom(grid).id,ID);
 grid.contains=()=>false;assert.equal(E.selectionFrom(grid),undefined);
});

test('stickers: own guild, premium and usable standard packs remain native; restricted guild sticker formats use links',()=>{
 const f=fixture();for(const format of [1,2,4]){f.sticker.format_type=format;assert.equal(E.alternative(f.s('sticker')).kind,'link');}
 f.sticker.format_type=3;assert.equal(E.alternative(f.s('sticker')).kind,'unsupported');
 f.channel={id:C,type:11,guild_id:G};assert.equal(E.alternative(f.s('sticker')).kind,'native');f.channel={id:C,type:3};f.user={id:A,premiumType:2};assert.equal(E.alternative(f.s('sticker')).kind,'native');
 f.user={id:A};assert.equal(E.alternative(f.s('sticker')).kind,'unsupported');f.user={id:A,premiumType:null};assert.equal(E.alternative(f.s('sticker')).kind,'unsupported');f.user={id:A,premiumType:0};f.member=false;assert.equal(E.alternative(f.s('sticker')).kind,'native');f.member=true;
 f.sticker={id:ID,type:1,format_type:4};assert.equal(E.alternative(f.s('sticker')).kind,'native');
 f.sticker.available=false;assert.equal(E.alternative(f.s('sticker')).kind,'native');
});

test('current native composer default CHAT is honored without enabling reactions or non-chat inputs',()=>{
 const f=fixture();
 f.props.type={analyticsName:'normal',permissions:{requireSendMessages:true}};
 assert.equal(E.selectionFrom(f.node).channelId,C);
 f.props.type.expressionPicker={onlyEmojis:true};assert.equal(E.selectionFrom(f.node).id,ID);
 f.props.type.expressionPicker.emojiIntention=0;assert.equal(E.selectionFrom(f.node),undefined);
 delete f.props.type.expressionPicker;f.props.type.permissions.requireSendMessages=false;assert.equal(E.selectionFrom(f.node),undefined);
});

test('native sticker sendability honors permission failures, boost restrictions, real Nitro state and missing modules',()=>{
 const f=fixture();f.user={id:A,premiumType:null};
 assert.equal(E.alternative(f.s('sticker')).kind,'link');
 f.channel={id:C,type:0,guild_id:OTHER};f.externalAllowed=false;assert.equal(E.alternative(f.s('sticker')).kind,'native');
 f.externalAllowed=true;assert.equal(E.alternative(f.s('sticker')).kind,'link');
 f.user={id:A,premiumType:2};assert.equal(E.alternative(f.s('sticker')).kind,'native');
 f.user={id:A,premiumType:null};f.member=false;assert.equal(E.alternative(f.s('sticker')).kind,'native');f.member=true;
 f.sticker.available=false;assert.equal(E.alternative(f.s('sticker')).kind,'native');f.sticker.available=true;
 f.stickerModule=false;assert.equal(E.alternative(f.s('sticker')).kind,'native');
});

function nativeDraft(f){
 let text='Selam nasılsın?',position=6;const files=['existing.png'];
 const editor={children:[{}],selection:{anchor:{offset:6}},insertText(value){text=text.slice(0,position)+value+text.slice(position);position+=value.length;}};
 const fiber={memoizedProps:{editor},return:{memoizedProps:{channelId:C}}};
 const editable={isConnected:true,__reactFiber$fixture:fiber};const root={querySelector:()=>editable};f.props.positionTargetRef={current:{closest:()=>root}};
 return {editor,editable,fiber,files,get text(){return text;}};
}
test('native Slate insertion retains mixed text/caret and attachments; wrong thread, account, recycled editor and missing selection are refused',()=>{
 const f=fixture(),d=nativeDraft(f);let closed=0;f.props.onClose=()=>closed++;let insert=E.draftInsertion(f.s());assert.equal(insert(' link ',true),true);assert.equal(closed,1);assert.equal(d.text,'Selam  link nasılsın?');assert.deepEqual(d.files,['existing.png']);
 insert=E.draftInsertion(f.s());f.user={id:B,premiumType:0};assert.equal(insert('bad',true),false);f.user={id:A,premiumType:0};
 insert=E.draftInsertion(f.s());d.fiber.return.memoizedProps.channelId=OTHER;assert.equal(insert('bad',true),false);assert.equal(E.draftInsertion(f.s()),undefined);d.fiber.return.memoizedProps.channelId=C;
 insert=E.draftInsertion(f.s());d.fiber.memoizedProps.editor={...d.editor};assert.equal(insert('bad',true),false);d.fiber.memoizedProps.editor=d.editor;
 d.editor.selection=null;assert.equal(E.draftInsertion(f.s()),undefined);assert.ok(!d.text.includes('bad'));
});

test('Canvas/popout insertion is bound to input identity, live channel and lifecycle; listeners are fully released',()=>{
 const f=fixture(),calls=[];let live=true;const type=f.props.type;
 const off=E.registerExpressionDraft(type,{channelId:C,valid:()=>live,insertText:(text,close)=>calls.push([text,close])});
 const insert=E.draftInsertion(f.s());assert.equal(insert('gif link',false),true);assert.deepEqual(calls,[['gif link',false]]);live=false;assert.equal(insert('stale',true),false);off();assert.equal(E.expressionDraft(type),undefined);
 const host=new EventTarget();let hits=0;const stop=E.onExpressionSelection(()=>hits++),unbind=E.bindExpressionSurface(host);host.dispatchEvent(new Event('click'));assert.equal(hits,1);stop();host.dispatchEvent(new Event('click'));assert.equal(hits,1);unbind();
});

test('plugin intercepts only restricted selection and never sends; modifiers, repeat, allowed emoji and disable preserve native flow',()=>{
 const f=fixture(),d=nativeDraft(f);E.EmojiFreedomPlugin.start(f.ctx);assert.equal(f.hooks.size,2);
 const click=event(f.node);f.hooks.get('click')(click);assert.equal(click.defaultPrevented,true);assert.match(d.text,/cdn\.discordapp\.com/);assert.deepEqual(notices,[]);
 for(const values of [{ctrlKey:true},{altKey:true},{metaKey:true},{button:2}]){const e=event(f.node,'click',values);f.hooks.get('click')(e);assert.equal(e.defaultPrevented,false);}
 for(const values of [{key:'Escape'},{repeat:true},{isComposing:true}]){const e=event(f.node,'keydown',values);f.hooks.get('keydown')(e);assert.equal(e.defaultPrevented,false);}
 f.reason=null;const normal=event(f.node);f.hooks.get('click')(normal);assert.equal(normal.defaultPrevented,false);f.reason=10;
 const saved=f.hooks.get('click');f.ctx.stop();assert.equal(f.hooks.size,0);const disabled=event(f.node);saved(disabled);assert.equal(disabled.defaultPrevented,false);
 assert.equal(E.EmojiFreedomPlugin.enabledByDefault,false);assert.equal(E.EmojiFreedomPlugin.permissions.network,undefined);
});

test('missing editor leaves draft untouched and reports failure; Lottie never becomes JSON or a pretend image',()=>{
 const f=fixture();E.EmojiFreedomPlugin.start(f.ctx);const e=event(f.node);f.hooks.get('click')(e);assert.equal(e.defaultPrevented,true);assert.equal(notices.length,1);
 f.cell.getAttribute=k=>k==='data-type'?'sticker':ID;f.sticker.format_type=3;f.hooks.get('click')(event(f.node));assert.match(notices.at(-1),/Lottie/);f.ctx.stop();
});

test('three minimal user-facing messages exist in all 18 locales; no network, upload bypass, new picker or global premium patch is installed',()=>{
 const locales=['en-US','es-ES','de','ja','fr','pt-BR','ru','it','nl','pl','tr','zh-CN','id','fa','cs','vi','ko','uk'];for(const locale of locales){const catalog=E.emojiFreedomCatalog(locale);assert.equal(Object.keys(catalog).length,3);for(const value of Object.values(catalog))assert.ok(value.length>12);}
 const source=readFileSync('src/renderer/plugins/emojiFreedom/index.ts','utf8');for(const token of ['fetch(','sendMessage(','setInterval(','new MutationObserver','patch.instead','createElement('])assert.ok(!source.includes(token),token);
});
