import {object,type LocalRecord} from './model';
export type ElementNode={type:unknown;key?:string|null;props:Record<string,unknown>};
export type ReactAdapter={createElement:(type:unknown,props:Record<string,unknown>|null,...children:unknown[])=>unknown;cloneElement:(node:unknown,props:Record<string,unknown>)=>unknown;isValidElement:(node:unknown)=>boolean};
function at(node:unknown,r:ReactAdapter):number|undefined{
 if(!r.isValidElement(node))return;const message=(node as ElementNode).props.message;if(!object(message))return;const timestamp=message.timestamp;
 let value:unknown;try{value=object(timestamp)&&typeof timestamp.getTime==='function'?(timestamp.getTime as ()=>unknown).call(timestamp):typeof timestamp==='string'?Date.parse(timestamp):undefined;}catch{return;}
 return typeof value==='number'&&Number.isFinite(value)?value:undefined;
}
/** Native stream markup is already in chronological order. Native elements are
 * retained by identity. Local records never become native messages/stream items. */
export function mergeMarkup(native:readonly unknown[],records:readonly LocalRecord[],r:ReactAdapter,render:(record:LocalRecord,previous?:LocalRecord,showDate?:boolean)=>unknown,bounds:{before:boolean;after:boolean;empty?:boolean}):unknown[]{
 const anchors=native.map((node,index)=>({index,at:at(node,r)})).filter((v):v is {index:number;at:number}=>v.at!==undefined);
 if(!anchors.length)return bounds.before||bounds.after||(!bounds.empty&&native.length>0)?[...native]:[...native,...records.map((row,i)=>render(row,records[i-1]))];
 if(anchors.some((v,i)=>i>0&&v.at<anchors[i-1]!.at))return [...native];
 const first=anchors[0]!.at,last=anchors[anchors.length-1]!.at;
 const locals=records.filter(v=>(!bounds.before||Date.parse(v.timestamp)>=first)&&(!bounds.after||Date.parse(v.timestamp)<=last));
 const slots=new Map<number,LocalRecord[]>();
 for(const row of locals){const time=Date.parse(row.timestamp),next=anchors.find(a=>a.at>time);let index=next?.index??anchors[anchors.length-1]!.index+1;
  // Keep the native day's divider with its next real message when inserting a
  // different local day immediately before it.
  if(next&&index>0&&r.isValidElement(native[index-1])){const p=(native[index-1] as ElementNode).props;if(typeof p.itemId==='string'&&p.itemId.startsWith('divider-')&&new Date(time).toDateString()!==new Date(next.at).toDateString())index--;}
  const group=slots.get(index)??[];group.push(row);slots.set(index,group);
 }
 const result:unknown[]=[];let previous:LocalRecord|undefined;
 for(let i=0;i<=native.length;i++){for(const row of slots.get(i)??[]){const day=new Date(row.timestamp).toDateString(),showDate=(!previous||new Date(previous.timestamp).toDateString()!==day)&&!anchors.some(a=>new Date(a.at).toDateString()===day);result.push(render(row,previous,showDate));previous=row;}if(i<native.length){result.push(native[i]);if(at(native[i],r)!==undefined)previous=undefined;}}
 return result;
}
/** The inspected native component renders ol children [navigation, markup, spacer]
 * inside a scroller with onResize. Unknown versions are left entirely unchanged. */
export function projectTree(tree:unknown,records:readonly LocalRecord[],r:ReactAdapter,render:(row:LocalRecord,previous?:LocalRecord,showDate?:boolean)=>unknown,bounds:{before:boolean;after:boolean;empty?:boolean}):{tree:unknown;found:boolean}{
 let found=false,visited=0;
 const walk=(node:unknown,depth:number,measured=false):unknown=>{
  if(++visited>800||depth>24)return node;if(Array.isArray(node))return node.map(v=>walk(v,depth+1,measured));if(!r.isValidElement(node))return node;
  const element=node as ElementNode,p=element.props;
  measured=measured||typeof p.onResize==='function';
  if(measured&&element.type==='ol'&&Array.isArray(p.children)&&p.children.length===3&&Array.isArray(p.children[1])){
   found=true;return r.cloneElement(element,{children:[p.children[0],mergeMarkup(p.children[1],records,r,render,bounds),p.children[2]]});
  }
  if(p.children===undefined)return node;return r.cloneElement(element,{children:walk(p.children,depth+1,measured)});
 };
 const result=walk(tree,0);return {tree:records.length?result:tree,found};
}
