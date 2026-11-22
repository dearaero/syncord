type Point={path:number[];offset:number};
type Editor={children:unknown[];selection:unknown;apply:(operation:unknown)=>void;deleteFragment:()=>void;insertText:(text:string)=>void};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object';
/** Use the bound native editor for long recovery; DraftStore truncates long strings. */
export function replaceLongDraft(value:unknown,text:string):boolean {
  if(!object(value)||!Array.isArray(value.children)||typeof value.apply!=='function'||typeof value.deleteFragment!=='function'||typeof value.insertText!=='function')return false;
  let first:Point|undefined,last:Point|undefined,visited=0;
  const walk=(nodes:unknown[],path:number[]):boolean=>{
    if(path.length>48)return false;
    for(let i=0;i<nodes.length;i++){
      if(++visited>50_000)return false;
      const node=nodes[i];if(!object(node))return false;
      const next=[...path,i];
      if(typeof node.text==='string'){first??={path:next,offset:0};last={path:next,offset:node.text.length};}
      else if(!Array.isArray(node.children)||!walk(node.children,next))return false;
    }
    return true;
  };
  if(!walk(value.children,[])||!first||!last)return false;
  const editor=value as unknown as Editor;
  editor.apply({type:'set_selection',properties:editor.selection,newProperties:{anchor:first,focus:last}});
  editor.deleteFragment();editor.insertText(text);
  // Slate operations are synchronous; React/DraftStore persistence need not be.
  const plain=(node:unknown,depth=0):string|undefined=>{
    if(depth>48||!object(node))return;
    if(typeof node.text==='string')return node.text;
    if(!Array.isArray(node.children))return;
    const values=node.children.map(n=>plain(n,depth+1));return values.every(v=>v!==undefined)?values.join(''):undefined;
  };
  const blocks=editor.children.map(node=>plain(node));
  return blocks.every(v=>v!==undefined)&&blocks.join('\n')===text;
}
