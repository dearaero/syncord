/** Insert a duration into MediaRecorder's small EBML header; video data stays streamed. */
type Element = { id: number; start: number; data: number; end: number; sizeBytes: number; unknown: boolean };
function element(bytes: Uint8Array, start: number): Element | null {
  if(start>=bytes.length)return null;
  const length=(value:number,max:number):number=>{for(let n=1;n<=max;n++)if(value&(1<<(8-n)))return n;return 0;};
  const idLength=length(bytes[start],4);if(!idLength||start+idLength>=bytes.length)return null;
  let id=0;for(let i=0;i<idLength;i++)id=id*256+bytes[start+i];
  const sizeStart=start+idLength;const sizeBytes=length(bytes[sizeStart],8);if(!sizeBytes||sizeStart+sizeBytes>bytes.length)return null;
  let size=bytes[sizeStart]&((1<<(8-sizeBytes))-1);let unknown=size===((1<<(8-sizeBytes))-1);
  for(let i=1;i<sizeBytes;i++){size=size*256+bytes[sizeStart+i];unknown=unknown&&bytes[sizeStart+i]===255;}
  const data=sizeStart+sizeBytes;return{id,start,data,end:unknown?Infinity:data+size,sizeBytes,unknown};
}
export function prepareWebmHeader(input: Uint8Array): { bytes: Uint8Array; duration?: { offset: number; length: 4 | 8; scale: number } } {
  // Never scan encoded clusters or retain a chunk beyond the current disk write.
  let offset=0;let segment:Element|null=null;
  while(offset<Math.min(input.length,256*1024)){const e=element(input,offset);if(!e)break;if(e.id===0x18538067){segment=e;break;}if(!Number.isFinite(e.end)||e.end>input.length)break;offset=e.end;}
  if(!segment)return{bytes:input};
  offset=segment.data;let seekHead=false;
  while(offset<Math.min(input.length,256*1024)){
    const e=element(input,offset);if(!e||!Number.isFinite(e.end)||e.end>input.length)break;
    if(e.id===0x114d9b74)seekHead=true;
    if(e.id===0x1549a966){
      let child=e.data;let scale=1_000_000;let existing:{offset:number;length:4|8}|undefined;let crc=false;
      while(child<e.end){const c=element(input,child);if(!c||c.end>e.end||!Number.isFinite(c.end))return{bytes:input};
        if(c.id===0x2ad7b1){let value=0;for(let i=c.data;i<c.end;i++)value=value*256+input[i];if(Number.isSafeInteger(value)&&value>0)scale=value;}
        if(c.id===0xbf)crc=true;
        if(c.id===0x4489&&(c.end-c.data===4||c.end-c.data===8))existing={offset:c.data,length:(c.end-c.data) as 4|8};
        child=c.end;
      }
      if(existing)return{bytes:input,duration:{...existing,scale}};
      // Inserting cannot invalidate fixed segment sizes, a CRC or seek offsets.
      if(!segment.unknown||seekHead||crc)return{bytes:input};
      const newSize=e.end-e.data+11;
      if(newSize>=2**(7*e.sizeBytes)-1)return{bytes:input};
      const bytes=new Uint8Array(input.length+11);bytes.set(input.subarray(0,e.end));bytes.set([0x44,0x89,0x88],e.end);bytes.set(input.subarray(e.end),e.end+11);
      let value=newSize;for(let i=e.sizeBytes-1;i>=0;i--){bytes[e.data-e.sizeBytes+i]=value%256;value=Math.floor(value/256);}bytes[e.data-e.sizeBytes]|=1<<(8-e.sizeBytes);
      return{bytes,duration:{offset:e.end+3,length:8,scale}};
    }
    if(e.id===0x1f43b675)break;offset=e.end;
  }
  return{bytes:input};
}
