import {t} from '../../i18n';
import type {NativeReact} from '../dmFilters/native';
import {channelFor,channelLabel,channelIcon,guildName,unread,type channelChoices} from './discord';
import {rowDrag,type LocalDrag} from './drag';
import type {LocalMenuItem} from './menu';
import type {Trial,ChannelRef} from './model';
export type WorkspaceState={adding:boolean;editing:boolean;name:string;query:string;choices:ReturnType<typeof channelChoices>;drag?:LocalDrag;focus?:'search'|'add'|'edit'};
export type WorkspaceActions={menu:(event:unknown,label:string,items:LocalMenuItem[])=>void;reorder:(source:string,target:string,after:boolean)=>void;open:(ref:ChannelRef)=>void;exit:()=>void;refresh:()=>void;add:()=>void;rename:(name:string)=>boolean;remove:(id:string)=>void;move:(id:string,delta:number)=>void;select:(ref:ChannelRef)=>void};
const PICKER_ID='Syncord-virtual-channel-picker';
export function closePicker(state:WorkspaceState,restoreFocus=true):void {
 state.adding=false;state.drag=undefined;state.choices=[];state.query='';state.focus=restoreFocus?'add':undefined;
}
export function workspace(r:NativeReact,current:Trial,selected:string|undefined,state:WorkspaceState,actions:WorkspaceActions):unknown {
 const button=(label:unknown,fn:()=>void,props:Record<string,unknown>={})=>r.createElement('button',{type:'button',onClick:fn,...props},label);
 // Focus only after an explicit open/close action; store updates must not steal it.
 const focus=(target:WorkspaceState['focus'])=>(node:HTMLElement|null):void=>{if(node&&state.focus===target){state.focus=undefined;node.focus();}};
 const query=state.query.trim().toLocaleLowerCase(),matches=state.adding?state.choices.filter(c=>(c.name+' '+c.guild).toLocaleLowerCase().includes(query)).slice(0,50):[];
 const edit=():void=>{state.editing=!state.editing;state.drag=undefined;state.name=current.name;closePicker(state,false);actions.refresh();};
 const icon=(ref:ChannelRef,key:string):unknown=>{const group=channelFor(ref)?.type===3;const avatar=group?undefined:channelIcon(ref);if(group)return r.createElement('svg',{key,width:20,height:20,viewBox:'0 0 24 24','data-virtual-channel-icon':'','aria-hidden':true},r.createElement('path',{fill:'currentColor',d:'M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-1a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM1 20v-2c0-3 4-5 8-5s8 2 8 5v2H1Zm17 0v-2c0-2-1-3-2-4 4 0 7 2 7 4v2h-5Z'}));return avatar?r.createElement('img',{key,src:avatar,alt:'',width:24,height:24,draggable:false,'data-virtual-avatar':''}):r.createElement('span',{key,'data-virtual-channel-icon':'','aria-hidden':true},ref.guildId==='@me'?'@':'#');};
 const dismiss=():void=>{closePicker(state);actions.refresh();};
 const chevron=r.createElement('svg',{key:'chevron',width:14,height:14,viewBox:'0 0 24 24','aria-hidden':true,'data-virtual-chevron':''},r.createElement('path',{fill:'none',stroke:'currentColor',strokeWidth:2,strokeLinecap:'round',strokeLinejoin:'round',d:'m6 9 6 6 6-6'}));
 return r.createElement('div',{'data-syncord-virtual-sidebar':'',role:'navigation','aria-label':current.name,
  onKeyDown:(event:{key:string;preventDefault:()=>void;stopPropagation:()=>void})=>{
   if(event.key!=='Escape'||(!state.adding&&!state.editing))return;
   event.preventDefault();event.stopPropagation();
   if(state.adding)closePicker(state);else{state.editing=false;state.drag=undefined;state.focus='edit';}
   actions.refresh();
  }},
  r.createElement('header',null,button([r.createElement('span',{key:'title','data-virtual-title':'',title:current.name},current.name),chevron],()=>{}, {'aria-label':t('virtual.trial'),'aria-haspopup':'menu','data-virtual-options':'',onClick:(event:unknown)=>actions.menu(event,current.name,[{id:'add',label:t('virtual.add'),action:actions.add},{id:'edit',label:t('virtual.edit'),action:edit},{id:'close',label:t('ui.close'),action:actions.exit}])}),button('×',actions.exit,{'aria-label':t('ui.close'),'data-virtual-exit':''})),
  r.createElement('div',{'data-virtual-toolbar':''},
   button([r.createElement('span',{key:'label'},t('virtual.add')),chevron],actions.add,{'data-virtual-add':'','aria-expanded':state.adding,'aria-controls':PICKER_ID,ref:focus('add'),title:t('virtual.add')}),
   button(t('virtual.edit'),edit,{'aria-pressed':state.editing,'data-virtual-edit':'',ref:focus('edit')})),
  state.editing?r.createElement('form',{onSubmit:(event:{preventDefault:()=>void})=>{event.preventDefault();if(actions.rename(state.name)){state.editing=false;state.focus='edit';actions.refresh();}}},
   r.createElement('label',null,t('virtual.name'),r.createElement('input',{maxLength:48,value:state.name,'data-virtual-rename':'',autoFocus:true,onChange:(event:{target:{value:string}})=>{state.name=event.target.value;actions.refresh();}})),r.createElement('button',{type:'submit'},t('ui.save'))):null,
  r.createElement('div',{id:PICKER_ID,'data-virtual-picker':'','data-open':state.adding,'aria-hidden':!state.adding,inert:!state.adding},
   r.createElement('div',{'data-virtual-picker-clip':''},r.createElement('div',{'data-virtual-picker-panel':''},
    r.createElement('div',{'data-virtual-picker-heading':''},r.createElement('span',null,t('virtual.search')),button('×',dismiss,{'aria-label':t('ui.close'),'data-virtual-picker-close':''})),
    r.createElement('input',{type:'search',value:state.query,'aria-label':t('virtual.search'),placeholder:t('virtual.search'),ref:focus('search'),onChange:(event:{target:{value:string}})=>{state.query=event.target.value;actions.refresh();}}),
    r.createElement('div',{'data-virtual-picker-results':''},...matches.map(choice=>button([
     icon(choice.ref,'icon'),r.createElement('span',{key:'text','data-virtual-choice-text':''},r.createElement('span',{'data-virtual-choice-name':''},choice.name),r.createElement('small',null,choice.guild)),
    ],()=>actions.select(choice.ref),{key:choice.ref.channelId,'data-virtual-choice':choice.ref.channelId,'aria-label':`${choice.name} · ${choice.guild}`,title:`${choice.name} · ${choice.guild}`,disabled:current.channels.some(c=>c.channelId===choice.ref.channelId)||current.channels.length>=100})),
    state.adding&&!matches.length?r.createElement('p',{role:'status'},t('ui.no_matching_entries_on_this_page')):null)))),
  r.createElement('section',{'data-virtual-channel-list':'','aria-label':current.name},current.channels.length?null:r.createElement('p',{'data-virtual-empty':''},t('virtual.empty')),...current.channels.map((ref,index)=>{
   const channel=channelFor(ref),label=channelLabel(ref),status=unread(ref),heading=index===0||current.channels[index-1].guildId!==ref.guildId;
   return r.createElement('div',{key:ref.channelId,'data-virtual-row':'',title:state.editing?t('virtual.reorder'):undefined,...rowDrag(state,ref.channelId,state.editing,actions.reorder),onContextMenu:(event:{preventDefault:()=>void;stopPropagation:()=>void})=>{event.preventDefault();event.stopPropagation();actions.menu(event,label,[{id:'up',label:t('virtual.up'),action:()=>actions.move(ref.channelId,-1),disabled:index===0},{id:'down',label:t('virtual.down'),action:()=>actions.move(ref.channelId,1),disabled:index===current.channels.length-1},{id:'remove',label:t('virtual.remove'),action:()=>actions.remove(ref.channelId),danger:true}]);}},heading?r.createElement('h3',null,guildName(ref.guildId)):null,
    button([icon(ref,'icon'),r.createElement('span',{key:'name','data-virtual-channel-name':''},label)],()=>actions.open(ref),{'data-channel-id':ref.channelId,disabled:!channel,title:label,'aria-current':selected===ref.channelId?'page':undefined}),
    status.mentions?r.createElement('small',{'data-virtual-mentions':''},status.mentions):null,
    state.editing?r.createElement('div',{'data-virtual-row-actions':''},r.createElement('span',{'data-virtual-grip':'',title:t('virtual.reorder'),'aria-hidden':true},'⠿'),button('↑',()=>actions.move(ref.channelId,-1),{'aria-label':t('virtual.up'),disabled:index===0}),button('↓',()=>actions.move(ref.channelId,1),{'aria-label':t('virtual.down'),disabled:index===current.channels.length-1}),button(t('virtual.remove'),()=>actions.remove(ref.channelId))):null);
  })));
}
