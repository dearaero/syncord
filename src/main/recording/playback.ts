/** Bounded file-backed WebM playback through sender-bound IPC, no network/CSP override. */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import type { WebContents } from "electron";
import type { RecordingPlayback } from "../../shared/recording";
import { getRecording } from "./store";
const CHUNK = 2 * 1024 * 1024;
const HEADER_LIMIT = 256 * 1024;
const MAX_FILE = 32 * 1024 * 1024 * 1024;
const MAX_POINTS = 65536;
type Reader = { owner: WebContents; token: string; file: fs.FileHandle; size: number; busy: boolean;
  closed: boolean; cleanup: () => void };
const readers = new Map<number, Reader>();
const openings = new Map<number, symbol>();

type Element = { id: number; data: number; end: number; unknown: boolean };
function vintLength(value: number, max: number): number { for(let n=1;n<=max;n++)if(value&(1<<(8-n)))return n;return 0; }
class WebmIndex {
  private cache = new Uint8Array(0);
  private start = -1;
  constructor(private reader: Reader) {}
  async bytes(offset: number, count: number): Promise<Uint8Array> {
    if(this.reader.closed)throw new Error("Recording preview closed.");
    if(offset<0||count<0||offset+count>this.reader.size)throw new Error("Invalid WebM structure.");
    if(offset<this.start || offset+count>this.start+this.cache.length){
      this.start=offset;this.cache=new Uint8Array(Math.min(Math.max(16*1024,count),this.reader.size-offset));
      const read=await this.reader.file.read(this.cache,0,this.cache.length,offset);this.cache=this.cache.subarray(0,read.bytesRead);
    }
    if(offset+count>this.start+this.cache.length)throw new Error("Truncated WebM file.");
    return this.cache.subarray(offset-this.start,offset-this.start+count);
  }
  async element(offset: number): Promise<Element> {
    const b=await this.bytes(offset,Math.min(12,this.reader.size-offset));
    const idLength=vintLength(b[0],4);if(!idLength)throw new Error("Invalid WebM element.");
    const sizeLength=vintLength(b[idLength],8);if(!sizeLength||idLength+sizeLength>b.length)throw new Error("Invalid WebM size.");
    let id=0;for(let i=0;i<idLength;i++)id=id*256+b[i];
    let size=b[idLength]&((1<<(8-sizeLength))-1);let unknown=size===((1<<(8-sizeLength))-1);
    for(let i=1;i<sizeLength;i++){size=size*256+b[idLength+i];unknown=unknown&&b[idLength+i]===255;}
    const data=offset+idLength+sizeLength;const end=unknown?Infinity:data+size;
    if(!unknown&&(!Number.isSafeInteger(end)||end>this.reader.size))throw new Error("Truncated WebM element.");
    return{id,data,end,unknown};
  }
  async number(e: Element): Promise<number> {
    if(e.end-e.data>8)throw new Error("Invalid WebM integer.");
    let n=0;for(const byte of await this.bytes(e.data,e.end-e.data))n=n*256+byte;
    if(!Number.isSafeInteger(n))throw new Error("Invalid WebM timestamp.");return n;
  }
  async build(durationMs: number): Promise<Omit<RecordingPlayback,"token">> {
    let offset=0;let segment:Element|undefined;
    while(offset<HEADER_LIMIT){const e=await this.element(offset);if(e.id===0x18538067){segment=e;break;}offset=e.end;}
    if(!segment)throw new Error("This recording is not a supported WebM file.");
    offset=segment.data;let scale=1_000_000;let headerEnd=0;let videoTrack=0;const codecs:string[]=[];
    while(offset<HEADER_LIMIT){const e=await this.element(offset);if(e.id===0x1f43b675){headerEnd=offset;break;}
      if(e.unknown||e.end>HEADER_LIMIT)throw new Error("WebM header is too large.");
      if(e.id===0x1549a966){let p=e.data;while(p<e.end){const c=await this.element(p);if(c.id===0x2ad7b1)scale=await this.number(c);p=c.end;}}
      if(e.id===0x1654ae6b){let p=e.data;while(p<e.end){const track=await this.element(p);if(track.id===0xae){let q=track.data,number=0,type=0,codec="";
        while(q<track.end){const c=await this.element(q);if(c.id===0xd7)number=await this.number(c);if(c.id===0x83)type=await this.number(c);
          if(c.id===0x86){if(c.end-c.data>64)throw new Error("Invalid WebM codec.");codec=new TextDecoder().decode(await this.bytes(c.data,c.end-c.data));}q=c.end;}
        const name:Record<string,string>={V_VP8:"vp8",V_VP9:"vp9",A_OPUS:"opus",A_VORBIS:"vorbis"};if(!name[codec])throw new Error("This recording's codec is not supported in the client player.");
        codecs.push(name[codec]);if(type===1)videoTrack=number;
      }p=track.end;}}
      offset=e.end;
    }
    if(!headerEnd||!videoTrack||!codecs.length||scale<=0)throw new Error("WebM video tracks are missing.");
    const points:RecordingPlayback["points"]=[];let clusterOffset=headerEnd,clusterEnd=Infinity,clusterTime=0;
    let firstKeyframe:number|undefined;let lastTime=0;let scanned=0;
    const flush=():void=>{if(firstKeyframe!==undefined){points.push({offset:clusterOffset,time:firstKeyframe});if(points.length>MAX_POINTS)throw new Error("This recording has too many seek points.");}firstKeyframe=undefined;};
    offset=headerEnd;
    while(offset<this.reader.size){
      if(++scanned>4_000_000)throw new Error("This recording is too complex to index.");
      // Async disk reads yield; also bound the scan if a local file was malformed.
      if(scanned%4096===0)await new Promise(resolve=>setImmediate(resolve));
      const e=await this.element(offset);
      if(e.id===0x1f43b675){if(offset!==headerEnd)flush();clusterOffset=offset;clusterEnd=e.end;clusterTime=0;offset=e.data;continue;}
      if(e.id===0xe7){clusterTime=(await this.number(e))*scale/1e9;lastTime=Math.max(lastTime,clusterTime);}
      let block:Element|undefined;let keyframe=false;
      if(e.id===0xa3)block=e;
      if(e.id===0xa0){let p=e.data;let referenced=false;
        while(p<e.end){const child=await this.element(p);if(child.unknown||child.end>e.end)throw new Error("Invalid WebM block group.");
          if(child.id===0xa1)block=child;if(child.id===0xfb)referenced=true;p=child.end;}keyframe=!referenced;
      }
      if(block){const bytes=await this.bytes(block.data,Math.min(12,block.end-block.data));const trackLength=vintLength(bytes[0],8);
        if(!trackLength||bytes.length<trackLength+3)throw new Error("Invalid WebM block.");
        let track=bytes[0]&((1<<(8-trackLength))-1);for(let i=1;i<trackLength;i++)track=track*256+bytes[i];
        const relative=(bytes[trackLength]*256+bytes[trackLength+1]<<16)>>16;
        const time=clusterTime+relative*scale/1e9;lastTime=Math.max(lastTime,time);
        if(e.id===0xa3)keyframe=(bytes[trackLength+2]&0x80)!==0;
        if(track===videoTrack&&keyframe&&firstKeyframe===undefined)firstKeyframe=Math.max(0,time);
      }
      if(e.unknown)throw new Error("Unsupported WebM element with unknown size.");
      offset=e.end;if(offset===clusterEnd)clusterEnd=Infinity;
    }
    flush();if(!points.length)throw new Error("This recording has no decodable video keyframes.");
    // Preserve the initialization bytes and expose only small seek metadata.
    const header=new Uint8Array(headerEnd);const read=await this.reader.file.read(header,0,header.length,0);
    if(read.bytesRead!==header.length)throw new Error("Recording changed while opening.");
    return{header:header.buffer,size:this.reader.size,mimeType:`video/webm;codecs=${codecs.join(",")}`,
      duration:Math.max(durationMs/1000,lastTime+1/30),points};
  }
}
export async function openRecordingPlayback(owner:WebContents,id:unknown):Promise<RecordingPlayback>{
  if(openings.size>=4&&!openings.has(owner.id))throw new Error("Close another recording preview first.");
  const opening=Symbol();openings.set(owner.id,opening);
  try {
  await closeRecordingPlayback(owner,undefined,true);
  if(openings.get(owner.id)!==opening)throw new Error("Recording preview closed.");
  if(readers.size>=4)throw new Error("Close another recording preview first.");
  const {file,item}=await getRecording(id);
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const stat=await handle.stat();
  if(!stat.isFile()||stat.size<=0||stat.size>MAX_FILE){await handle.close();throw new Error("Recording is empty or too large.");}
  if(owner.isDestroyed()||openings.get(owner.id)!==opening){await handle.close();throw new Error("Recording preview closed.");}
  const token=randomBytes(24).toString("hex");
  const onDestroyed=():void=>{void closeRecordingPlayback(owner);};
  const onNavigate=(_event:unknown,_url:string,_inPlace:boolean,isMainFrame:boolean):void=>{if(isMainFrame)void closeRecordingPlayback(owner);};
  const reader:Reader={owner,token,file:handle,size:stat.size,busy:true,closed:false,cleanup:()=>{owner.removeListener("destroyed",onDestroyed);owner.removeListener("did-start-navigation",onNavigate);}};
  readers.set(owner.id,reader);owner.once("destroyed",onDestroyed);owner.on("did-start-navigation",onNavigate);
  try{const descriptor=await new WebmIndex(reader).build(item.durationMs);if(reader.closed)throw new Error("Recording preview closed.");return{...descriptor,token};}
  catch(error){if(readers.get(owner.id)===reader)await closeRecordingPlayback(owner);throw error;}
  finally{reader.busy=false;}
  } finally { if(openings.get(owner.id)===opening)openings.delete(owner.id); }
}
export async function readRecordingPlayback(owner:WebContents,token:unknown,offset:unknown):Promise<ArrayBuffer>{
  const reader=readers.get(owner.id);
  if(!reader||reader.closed||reader.owner!==owner||token!==reader.token)throw new Error("Recording preview is not authorized.");
  if(typeof offset!=="number"||!Number.isSafeInteger(offset)||offset<0||offset>=reader.size)throw new Error("Invalid recording offset.");
  if(reader.busy)throw new Error("Another recording read is pending.");reader.busy=true;
  try{const bytes=new Uint8Array(Math.min(CHUNK,reader.size-offset));const read=await reader.file.read(bytes,0,bytes.length,offset);
    if(reader.closed)throw new Error("Recording preview closed.");return bytes.slice(0,read.bytesRead).buffer;
  }finally{reader.busy=false;}
}
export async function closeRecordingPlayback(owner?:WebContents,token?:unknown,preserveOpening=false):Promise<void>{
  if(token===undefined&&!preserveOpening){if(owner)openings.delete(owner.id);else openings.clear();}
  const targets=owner?[readers.get(owner.id)].filter((r):r is Reader=>!!r&&r.owner===owner):Array.from(readers.values());
  for(const reader of targets){if(token!==undefined&&token!==reader.token)continue;readers.delete(reader.owner.id);reader.closed=true;reader.cleanup();await reader.file.close().catch(()=>undefined);}
}
