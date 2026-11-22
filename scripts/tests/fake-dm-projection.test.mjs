import test,{after} from 'node:test';import assert from 'node:assert/strict';import{build}from'esbuild';import{mkdtempSync,rmSync,readFileSync}from'node:fs';import{tmpdir}from'node:os';import path from'node:path';import{pathToFileURL}from'node:url';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-fd-projection-'));await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/renderer/plugins/fakeDM/projection';export {isNativeHeader,isNativeTimestamp} from './src/renderer/plugins/fakeDM/headers';export {nativeStream} from './src/renderer/plugins/fakeDM/timeline';export {fakeDMCatalog} from './src/renderer/i18n/fakeDM';export {SUPPORTED_LOCALES} from './src/shared/i18nLocale';`},bundle:true,platform:'neutral',format:'esm',outfile:path.join(dir,'test.mjs'),logLevel:'silent'});const M=await import(pathToFileURL(path.join(dir,'test.mjs')));after(()=>rmSync(dir,{recursive:true,force:true}));
const R={createElement:(type,props,...children)=>({type,props:{...props,...(children.length?{children:children.length===1?children[0]:children}:{})}}),cloneElement:(n,p)=>({...n,props:{...n.props,...p}}),isValidElement:n=>!!n&&typeof n==='object'&&'type'in n&&'props'in n};
const native=(id,time)=>Object.freeze(R.createElement('NativeMessage',{message:Object.freeze({id,timestamp:new Date(time)})}));
const local=(id,time)=>({id,timestamp:time,kind:'message',authorId:'same'});const render=row=>R.createElement('li',{'data-local':row.id});
test('presentation merge retains frozen native rows/arrays, orders locals chronologically and uses stable same-time local order',()=>{
 const a=native('a','2026-10-30T10:00:00Z'),b=native('b','2026-10-30T12:00:00Z'),rows=Object.freeze([a,b]),records=Object.freeze([local('x','2026-10-30T11:00:00Z'),local('y','2026-10-30T11:00:00Z')]);const merged=M.mergeMarkup(rows,records,R,render,{before:false,after:false});assert.equal(merged[0],a);assert.equal(merged[3],b);assert.deepEqual(merged.slice(1,3).map(n=>n.props['data-local']),['x','y']);assert.deepEqual(rows,[a,b]);assert.equal(merged.some(n=>n.props.message?.id==='x'),false);
});
test('truncated native history does not pretend unloaded historical/future records belong to its loaded window',()=>{
 const rows=[native('a','2026-10-30T10:00:00Z'),native('b','2026-10-30T12:00:00Z')],records=[local('old','2020-01-01T00:00:00Z'),local('inside','2026-10-30T11:00:00Z'),local('future','2030-01-01T00:00:00Z')];const full=M.mergeMarkup(rows,records,R,render,{before:false,after:false});assert.equal(full.filter(n=>n.props['data-local']).length,3);const window=M.mergeMarkup(rows,records,R,render,{before:true,after:true});assert.deepEqual(window.filter(n=>n.props['data-local']).map(n=>n.props['data-local']),['inside']);assert.equal(M.mergeMarkup([],records,R,render,{before:true,after:false}).length,0);
});
test('native markup must have the observed ol layout inside a measured scroller; unsupported shapes remain unchanged',()=>{
 const nav=R.createElement('span',{id:'messagesNavigationDescription'}),spacer=R.createElement('div',{}),real=native('a','2026-10-30T12:00:00Z'),tree=R.createElement('NativeScroller',{onResize(){},children:R.createElement('ol',{children:[nav,[real],spacer]})});const changed=M.projectTree(tree,[local('x','2026-10-30T11:00:00Z')],R,render,{before:false,after:false});assert.equal(changed.found,true);const children=changed.tree.props.children.props.children;assert.equal(children[0],nav);assert.equal(children[2],spacer);assert.equal(children[1][1],real);assert.equal(tree.props.children.props.children[1].length,1);
 const unmeasured=M.projectTree(tree.props.children,[],R,render,{before:false,after:false});assert.equal(unmeasured.found,false);assert.equal(M.projectTree(R.createElement('ol',{children:[real]}),[],R,render,{before:false,after:false}).found,false);
});
test('native function signature requires multiple observed semantic signals instead of a minified name or CSS class',()=>{
 assert.equal(M.nativeStream(function(){const channelStream=0,messageGroupSpacing=0,messagesNavigationDescription=0,showNewMessagesBar=0;return channelStream+messageGroupSpacing+messagesNavigationDescription+showNewMessagesBar;}),true);assert.equal(M.nativeStream(function(){return 'channelStream';}),false);
});
test('Fake DM catalogs contain the same complete translated fields in all 18 languages',()=>{
 const keys=Object.keys(M.fakeDMCatalog('en-US'));assert.equal(M.SUPPORTED_LOCALES.length,18);for(const locale of M.SUPPORTED_LOCALES){const catalog=M.fakeDMCatalog(locale);assert.deepEqual(Object.keys(catalog),keys);assert.ok(Object.values(catalog).every(v=>v.trim()));}
});
test('runtime has no native message/call write, account token, Gateway transport or sending capability',()=>{
 for(const file of ['index','discord','timeline','projection','headers','ui']){const source=readFileSync('src/renderer/plugins/fakeDM/'+file+'.ts','utf8');assert.doesNotMatch(source,/MESSAGE_CREATE|MESSAGE_DELETE|CALL_CREATE|CALL_UPDATE|getToken|sendMessage|deleteMessage|receiveMessage|ReadStateStore|new WebSocket|ipcRenderer|localStorage|innerHTML|fetch\(/);}
 const source=readFileSync('src/renderer/plugins/fakeDM/index.ts','utf8');assert.match(source,/enabledByDefault:false/);assert.match(source,/webpackPatch:true/);assert.doesNotMatch(source,/discordActions:/);assert.equal(readFileSync('src/renderer/plugins/index.ts','utf8').split('".\/fakeDM"').length-1,1);
});

test('native header discovery requires the inspected semantic shape, not an export name or a lone guild-tag prop',()=>{
 const header=function(){return ['hideGuildTag','showTimestampOnHover','subscribeToGroupId','enableScheduledBadge'];};assert.equal(M.isNativeHeader(header),true);assert.equal(M.isNativeHeader({type:header}),true);assert.equal(M.isNativeHeader(function(){return 'hideGuildTag';}),false);assert.equal(M.isNativeHeader({type:'header'}),false);
});

test('native timestamp guard recognizes only the inspected presentation contract',()=>{
 assert.equal(M.isNativeTimestamp({type:function(){return ['timestampFormat','isVisibleOnlyOnHover','cozyAlt','isEdited','tooltipPosition'];}}),true);assert.equal(M.isNativeTimestamp(function(){return 'timestamp';}),false);
});
