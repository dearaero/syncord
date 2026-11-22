export type LocalDrag={source:string};
export type DragState={drag?:LocalDrag};
type DragEventLike={currentTarget:HTMLElement;clientY:number;dataTransfer:DataTransfer|null;preventDefault:()=>void;stopPropagation:()=>void};
/** Chromium drag-and-drop scoped to our rows; external payloads are never read. */
export function rowDrag(state:DragState,id:string,enabled:boolean,reorder:(source:string,target:string,after:boolean)=>void):Record<string,unknown> {
 const clear=():void=>{state.drag=undefined;};
 const edge=(event:DragEventLike):boolean=>{const rect=event.currentTarget.getBoundingClientRect();return event.clientY>rect.top+rect.height/2;};
 return {draggable:enabled,
  onDragStart:(event:DragEventLike)=>{
   if(!enabled||!event.dataTransfer){event.preventDefault();return;}
   event.stopPropagation();state.drag={source:id};event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-syncord-virtual-channel',id);
  },
  onDragOver:(event:DragEventLike)=>{
   if(!enabled||!state.drag||state.drag.source===id)return;
   event.preventDefault();event.stopPropagation();if(event.dataTransfer)event.dataTransfer.dropEffect='move';
   event.currentTarget.dataset.virtualDrop=edge(event)?'after':'before';
  },
  onDragLeave:(event:DragEventLike)=>{delete event.currentTarget.dataset.virtualDrop;},
  onDrop:(event:DragEventLike)=>{
   const source=state.drag?.source;delete event.currentTarget.dataset.virtualDrop;
   if(!enabled||!source)return;
   event.preventDefault();event.stopPropagation();clear();if(source!==id)reorder(source,id,edge(event));
  },
  onDragEnd:(event:DragEventLike)=>{clear();for(const node of event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[data-virtual-drop]')??[])delete node.dataset.virtualDrop;},
 };
}
