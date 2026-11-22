import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-dm-filters-model-'));
await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`export * from './src/renderer/plugins/dmFilters/model';export * from './src/renderer/plugins/dmFilters/native';`},bundle:true,format:'esm',platform:'neutral',outfile:path.join(dir,'model.mjs'),logLevel:'warning'});
const M=await import(pathToFileURL(path.join(dir,'model.mjs')).href);rmSync(dir,{recursive:true,force:true});
const R={createElement(type,props,...children){return Object.freeze({type,key:props?.key,props:Object.freeze({...props,...(children.length?{children:children.length===1?children[0]:children}:{})})});},cloneElement(node,props){return Object.freeze({...node,props:Object.freeze({...node.props,...props})});},isValidElement:node=>!!node&&typeof node==='object'&&'type'in node&&'props'in node};
const ids=Object.freeze(['dm-1','group-1','dm-2','group-2','unknown']);const channels=Object.freeze({'dm-1':{type:1},'group-1':{type:3},'dm-2':{type:1},'group-2':{type:3}});
test('DM filters: exact types, original order, all returns original reference, and unknown types never guessed from recipients/name',()=>{
 assert.equal(M.parseFilter(undefined),'all');assert.equal(M.parseFilter('groups'),'groups');assert.equal(M.parseFilter('dm'),'dm');assert.equal(M.parseFilter('tampered'),'all');
 assert.equal(M.filterPrivateIds(ids,channels,'all'),ids);assert.deepEqual(M.filterPrivateIds(ids,channels,'dm'),['dm-1','dm-2']);assert.deepEqual(M.filterPrivateIds(ids,channels,'groups'),['group-1','group-2']);
 assert.deepEqual(M.filterPrivateIds(['missing','voice','fake'],{voice:{type:2},fake:{type:'1',recipients:['one']}},'dm',()=>{throw Error('missing');}),[]);
 assert.deepEqual(M.filterPrivateIds(['missing'],{},'groups',()=>({type:3})),['missing']);assert.equal(ids.length,5);
});
function view(mode='groups'){
 const receiver={token:42},nativeCalls=[];
 const instance={props:Object.freeze({privateChannelIds:ids,channels,padding:8}),state:{preRenderedChildren:2},forceUpdate(){},render(){},renderRow(){},renderSection(){},getRowHeight:(section)=>section===0?40:44,getSectionHeight:section=>section===0?0:24};
 const props={sections:[2,5],paddingTop:8,selection:'unchanged',renderRow:function(row){assert.equal(this,receiver);nativeCalls.push(row);return R.createElement('a',{key:row.section===1?ids[row.row]:'native-child-'+row.row,channelId:ids[row.row],'aria-setsize':7},'native');},renderSection:function(row){assert.equal(this,receiver);return row.section===1?R.createElement('h2',{key:1},'Direct Messages'):null;},rowHeight:instance.getRowHeight,sectionHeight:instance.getSectionHeight};
 const original=R.createElement('provider',{children:function(a){assert.equal(this,receiver);assert.equal(a,'keep argument');return R.createElement('provider2',{children:()=>R.createElement('virtual',props)});}});
 let selected,enabled=true;
 const result=M.decorateListTree(original,instance,R,()=>mode,next=>{selected=next;},()=>enabled);
 const resolve=()=>result.props.children.call(receiver,'keep argument').props.children().props;
 return{instance,receiver,original,resolve,nativeCalls,selected:()=>selected,disable:()=>{enabled=false;}};
}
test('DM filters: frozen native render tree and callbacks keep their receiver; virtual sections/indices/aria count are rebuilt without holes',()=>{
 const f=view(),v=f.resolve();assert.deepEqual(v.sections,[2,2]);assert.equal(v.selection,'unchanged');assert.equal(v.paddingTop,8);
 const first=v.renderRow.call(f.receiver,{section:1,row:0}),second=v.renderRow.call(f.receiver,{section:1,row:1});
 assert.equal(first.props.channelId,'group-1');assert.equal(second.props.channelId,'group-2');assert.equal(first.key,'group-1');assert.equal(first.props['aria-posinset'],3);assert.equal(first.props['aria-setsize'],4);
 assert.equal(v.renderRow.call(f.receiver,{section:0,row:1}).props['aria-setsize'],4);assert.deepEqual(f.instance.props.privateChannelIds,ids);
 assert.equal(v.sectionHeight(0),0);assert.equal(v.sectionHeight(1),60);assert.equal(v.rowHeight(1,0),44);
 const section=v.renderSection.call(f.receiver,{section:1});assert.equal(section.props.children[0].type,'h2');const bar=section.props.children[1];assert.deepEqual(bar.props.children.map(b=>b.props.children),['All','Groups','DM']);
 assert.equal(bar.props.children[1].props['aria-pressed'],true);let stopped=false;bar.props.children[2].props.onClick({preventDefault(){},stopPropagation(){stopped=true;}});assert.equal(f.selected(),'dm');assert.equal(stopped,true);
 f.disable();assert.deepEqual(f.resolve().sections,[2,5]);
});
test('DM filters: empty filtered lists are compact, all preserves native empty view, unknown native trees remain unchanged',()=>{
 const ids=Object.freeze([]),instance={props:{privateChannelIds:ids,channels:{}},render(){},forceUpdate(){},renderRow(){},renderSection(){},getRowHeight(){},getSectionHeight(){}};
 const props={sections:[0,1],renderRow:()=>R.createElement('native-empty',null),renderSection:()=>null,rowHeight:()=>428,sectionHeight:()=>24};
 const decorate=mode=>M.decorateListTree(R.createElement('virtual',props),instance,R,()=>mode,()=>{},()=>true).props;
 const empty=decorate('groups');assert.deepEqual(empty.sections,[0,1]);assert.equal(empty.rowHeight(1,0),64);assert.equal(empty.renderRow({section:1,row:0}).props.role,'status');
 const all=decorate('all');assert.equal(all.renderRow({section:1,row:0}).type,'native-empty');assert.equal(all.rowHeight(1,0),428);
 const unknown=R.createElement('other',{children:'untouched'});assert.equal(M.mapListTree(unknown,R,()=>{throw Error('not a list');}),unknown);
 assert.equal(M.isNativeDmList(instance),true);assert.equal(M.isNativeDmList({...instance,props:{privateChannelIds:'bad',channels:{}}}),false);assert.equal(M.isNativeReact({createElement(){}}),false);
});
test('DM filters: selected conversation scrolling includes compact/comfortable rows and filter header; missing items scroll to top without navigation',()=>{
 const scrolls=[],rects=[];const instance={props:{privateChannelIds:ids,channels,padding:8},state:{preRenderedChildren:2},getRowHeight:(section)=>section===0?40:50,getSectionHeight:()=>24,_list:{scrollTo:value=>scrolls.push(value),scrollIntoViewRect:value=>rects.push(value)}};
 assert.equal(M.scrollFiltered(instance,'groups','group-2'),true);assert.deepEqual(rects,[{start:190,end:256}]);
 assert.equal(M.scrollFiltered(instance,'dm','group-2'),true);assert.deepEqual(scrolls,[{to:0}]);assert.equal(M.scrollFiltered({...instance,_list:{}},'dm','dm-1'),false);
});
