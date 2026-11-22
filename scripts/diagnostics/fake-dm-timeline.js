// Read-only: run in Discord DevTools while a normal DM is open.
// Reports structural types/method names only. No store calls, message values,
// account/channel IDs, content, URLs, credentials or function bodies are read.
(() => {
  const roots=[...document.querySelectorAll('[data-list-id="chat-messages"],[data-list-id^="chat-messages-"],ol[role="list"],li[id^="chat-messages-"]')].slice(0,4);
  const keys=['sections','items','rows','messages','renderRow','renderItem','renderSection','rowHeight','itemHeight','getItemHeight','getItemKey','children','channel','channelId','listId','scrollerRef','scrollToIndex','getRows','getRowHeight'];
  const describe=(v)=>{
    if(Array.isArray(v))return {type:'array',length:v.length,firstType:typeof v[0],firstKeys:v[0]&&typeof v[0]==='object'?Object.keys(v[0]).filter(k=>/^(?:type|kind|id|key|message|content|timestamp|item|row|index|height)$/.test(k)):[]};
    if(v===null)return 'null';
    return typeof v;
  };
  const nodes=[],seen=new Set();
  for(const root of roots){
    const fiberKey=Object.keys(root).find(k=>k.startsWith('__reactFiber$')||k.startsWith('__reactInternalInstance$'));
    let fiber=fiberKey?root[fiberKey]:null;
    for(let depth=0;fiber&&depth<45;depth++,fiber=fiber.return){
      if(seen.has(fiber))continue;seen.add(fiber);
      const props=fiber.memoizedProps,state=fiber.stateNode;
      const shape={};
      for(const k of keys){const descriptor=props&&Object.getOwnPropertyDescriptor(props,k);if(descriptor&&'value'in descriptor)shape[k]=describe(descriptor.value);}
      const methods=new Set();let proto=state&&typeof state==='object'?state:null;
      for(let n=0;proto&&n<3;n++,proto=Object.getPrototypeOf(proto))for(const k of Object.getOwnPropertyNames(proto)){
        if(!/^(?:render|getRow|getItem|getSection|scroll|measure|recompute|invalidate|handleResize|forceUpdate|reset)/.test(k))continue;
        const d=Object.getOwnPropertyDescriptor(proto,k);if(d&&typeof d.value==='function')methods.add(k);
      }
      if(!Object.keys(shape).length&&!methods.size)continue;
      nodes.push({depth,kind:typeof fiber.type,props:shape,methods:[...methods]});
    }
  }
  const report={format:'syncord-fake-dm-structure-v1',anchors:roots.length,nodes};
  console.log(JSON.stringify(report,null,2));return report;
})();
