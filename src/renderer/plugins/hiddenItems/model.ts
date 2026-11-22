export const KINDS=['guild','dm','group'] as const;
export type HiddenKind=typeof KINDS[number];
export type HiddenData=Record<HiddenKind,string[]>;
export function validId(value:unknown):value is string{return typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value)&&BigInt(value)<(1n<<64n);}
export function normalize(value:unknown):HiddenData {
  const raw=value&&typeof value==='object'?value as Record<string,unknown>:{};
  const read=(key:string):string[]=>Array.isArray(raw[key])?[...new Set((raw[key] as unknown[]).filter(validId))]:[];
  return {guild:read('guild'),dm:read('dm'),group:read('group')};
}
export function change(data:HiddenData,kind:HiddenKind,id:string,hide:boolean):HiddenData {
  if(!KINDS.includes(kind)||!validId(id))throw new Error('Invalid hidden item.');
  const ids=new Set(data[kind]);hide?ids.add(id):ids.delete(id);
  return {...data,[kind]:[...ids]};
}
/** A read projection: never edit the native guild tree, folders or membership. */
export function projectGuildTree(value:unknown,hidden:ReadonlySet<string>):unknown {
  if(!hidden.size||!value||typeof value!=='object')return value;
  const tree=value as {root?:{children?:unknown};nodes?:unknown;version?:unknown;getRoots?:()=>unknown};
  if(!Array.isArray(tree.root?.children)||!tree.nodes||typeof tree.nodes!=='object'||typeof tree.version!=='number'||typeof tree.getRoots!=='function')return value;
  const original=tree.nodes as Record<string,unknown>,nodes:Record<string,unknown>=Object.create(null),seen=new Set<unknown>();let changed=false,budget=20000;
  const walk=(raw:unknown,depth:number):unknown=>{
    if(--budget<0||depth>64||!raw||typeof raw!=='object'||seen.has(raw))throw new Error('Unsupported guild tree.');
    seen.add(raw);const node=raw as Record<string,unknown>;
    if(node.type==='guild'&&typeof node.id==='string'&&hidden.has(node.id)){changed=true;return undefined;}
    if(!Array.isArray(node.children)||!['guild','folder','root'].includes(String(node.type)))throw new Error('Unsupported guild tree node.');
    const children=node.children.map(child=>walk(child,depth+1)).filter(child=>child!==undefined);
    if(node.type==='folder'&&node.children.length>0&&!children.length){changed=true;return undefined;}
    const clone={...node,children};if(typeof node.id==='string'&&Object.hasOwn(original,node.id))nodes[node.id]=clone;
    return clone;
  };
  try {
    const root=walk(tree.root,0);if(!changed)return value;
    const copy=Object.assign(Object.create(Object.getPrototypeOf(value)),value,{root,nodes});
    return copy.getRoots()===copy.root.children?copy:value;
  }catch{return value;}
}
