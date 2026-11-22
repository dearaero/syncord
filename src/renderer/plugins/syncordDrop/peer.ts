import {DROP_BLOCK,DROP_FRAME,DROP_WINDOW,dropSdp,type DropBridge,type DropInvite} from '../../../shared/drop';
export type DropProgress={phase:'connecting'|'transferring'|'verifying'|'complete';bytes:number;speed:number;eta:number};
type Options={bridge:DropBridge;session:string;invite:DropInvite;sender:boolean;signal:AbortSignal;progress:(state:DropProgress)=>void;peerFactory?:()=>RTCPeerConnection};
/** Reliable ordered SCTP + cumulative disk ACKs. The sender never outruns disk
 * by more than 2 MiB; neither side holds a file-sized buffer. */
export async function transfer(o:Options):Promise<void>{
 const pc=o.peerFactory?.()??new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}],iceCandidatePoolSize:0});
 let channel:RTCDataChannel|undefined,failed:Error|undefined,finished=false,opened=false,bytes=0,sent=0,acked=0,lastData=Date.now(),lastPaint=0,lastBytes=0,lastTime=Date.now();
 let verified=false,committing=false;
 let incoming=0,queued=0,frames:Uint8Array[]=[],draining=false,finishHash:string|undefined;
 const waiters=new Set<()=>void>(),notify=():void=>{for(const fn of [...waiters])fn();waiters.clear();};
 let resolveDone:()=>void=()=>{},rejectDone:(e:Error)=>void=()=>{};
 const done=new Promise<void>((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
 const check=():void=>{if(failed)throw failed;if(o.signal.aborted)throw Error('drop.cancelled');if(finished)throw Error('drop.state');};
 const fail=(e:unknown):void=>{
  if(failed||finished)return;
  // Main has atomically published the exact-size, SHA-256-verified file.
  // A subsequent SCTP abort/error from the sender closing cannot undo it.
  if(verified&&!o.sender){success();return;}
  // Electron prefixes invoke rejections; preserve the vetted native disk/hash
  // code instead of relabeling those failures as a network/NAT problem.
  const code=e instanceof Error?/\bdrop\.[a-z_]+\b/.exec(e.message)?.[0]:undefined;
  failed=Error(code??'drop.nat');notify();rejectDone(failed);
 };
 const paint=(phase:DropProgress['phase'],force=false):void=>{const now=Date.now();if(!force&&now-lastPaint<250)return;const speed=(bytes-lastBytes)*1000/Math.max(1,now-lastTime);lastPaint=now;lastBytes=bytes;lastTime=now;o.progress({phase,bytes,speed,eta:speed>0?(o.invite.size-bytes)/speed:0});};
 const success=():void=>{if(finished||failed)return;finished=true;bytes=o.invite.size;paint('complete',true);notify();resolveDone();};
 const wait=async(condition:()=>boolean):Promise<void>=>{while(!condition()){check();await new Promise<void>(resolve=>waiters.add(resolve));}check();};
 const control=(value:unknown):void=>{check();if(channel?.readyState!=='open')throw Error('drop.nat');channel.send(JSON.stringify(value));};
 const abort=():void=>{if(channel?.readyState==='open')try{channel.send(JSON.stringify({kind:'cancel'}));}catch{}fail(Error('drop.cancelled'));};
 o.signal.addEventListener('abort',abort,{once:true});
 const setupTimeout=setTimeout(()=>fail(Error('drop.nat')),120000);
 const watchdog=setInterval(()=>{if(opened&&!finished&&Date.now()-lastData>90000)fail(Error('drop.nat'));},1000);
 const send=async():Promise<void>=>{
  while(sent<o.invite.size){
   await wait(()=>sent-acked<DROP_WINDOW);check();const block=await o.bridge.read(o.session);check();
   if(!(block instanceof Uint8Array)||!block.byteLength||block.byteLength>DROP_BLOCK||sent+block.byteLength>o.invite.size)throw Error('drop.file_error');
   const frame=Math.min(DROP_FRAME,pc.sctp?.maxMessageSize||DROP_FRAME);if(frame<1024)throw Error('drop.nat');
   for(let at=0;at<block.byteLength;at+=frame){await wait(()=>!!channel&&channel.bufferedAmount<=512*1024&&sent-acked<DROP_WINDOW);
    const slice=block.subarray(at,Math.min(at+frame,block.byteLength));if(!(slice.buffer instanceof ArrayBuffer))throw Error('drop.invalid');channel!.send(new Uint8Array(slice.buffer,slice.byteOffset,slice.byteLength));sent+=slice.byteLength;
   }
  }
  const digest=await o.bridge.hash(o.session);check();await wait(()=>acked>=Math.floor(o.invite.size/DROP_BLOCK)*DROP_BLOCK);paint('verifying',true);control({kind:'finish',size:o.invite.size,digest});
 };
 const drain=async():Promise<void>=>{
  if(draining)return;draining=true;
  try{
   while(queued>=DROP_BLOCK||finishHash&&queued){
    check();const length=Math.min(DROP_BLOCK,queued),block=new Uint8Array(length);let at=0;
    while(at<length){const head=frames[0];if(!head)throw Error('drop.invalid');const n=Math.min(length-at,head.byteLength);block.set(head.subarray(0,n),at);at+=n;if(n===head.byteLength)frames.shift();else frames[0]=head.subarray(n);}
    const written=await o.bridge.write(o.session,block);check();queued-=length;
    if(written!==bytes+length)throw Error('drop.integrity');bytes=written;lastData=Date.now();paint('transferring');control({kind:'ack',offset:bytes});
   }
   if(finishHash&&queued===0){check();paint('verifying',true);committing=true;try{await o.bridge.finish(o.session,finishHash);verified=true;}finally{committing=false;}control({kind:'done'});for(let i=0;i<100&&channel&&channel.bufferedAmount>0;i++){await sleep(10);check();}await sleep(100);check();success();}
  }finally{draining=false;}
 };
 const attach=(dc:RTCDataChannel):void=>{
  if(channel||dc.label!=='syncord-drop-v1'||dc.protocol!=='syncord-drop-v1'||!dc.ordered||dc.maxRetransmits!==null||dc.maxPacketLifeTime!==null){dc.close();fail(Error('drop.invalid'));return;}
  channel=dc;dc.binaryType='arraybuffer';dc.bufferedAmountLowThreshold=256*1024;
  dc.onbufferedamountlow=notify;dc.onerror=()=>{if(!committing)fail(Error('drop.nat'));};dc.onclose=()=>{if(!committing&&!finished)fail(Error('drop.nat'));};
  dc.onmessage=event=>{
   try{
    check();lastData=Date.now();
    if(typeof event.data==='string'){
     if(event.data.length>1024)throw Error('drop.invalid');const value=JSON.parse(event.data) as Record<string,unknown>;
     if(value.kind==='cancel'){fail(Error('drop.cancelled'));return;}
     if(o.sender&&value.kind==='ack'){
      if(!Number.isSafeInteger(value.offset)||Number(value.offset)<acked||Number(value.offset)>sent)throw Error('drop.invalid');acked=Number(value.offset);bytes=acked;paint('transferring');notify();return;
     }
     if(o.sender&&value.kind==='done'){if(sent!==o.invite.size||acked!==sent)throw Error('drop.invalid');success();return;}
     if(!o.sender&&value.kind==='finish'){
      if(finishHash||value.size!==o.invite.size||incoming!==o.invite.size||typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest))throw Error('drop.integrity');finishHash=value.digest;void drain().catch(fail);return;
     }
     throw Error('drop.invalid');
    }
    if(o.sender||finishHash||!(event.data instanceof ArrayBuffer)||!event.data.byteLength||event.data.byteLength>DROP_FRAME)throw Error('drop.invalid');
    const data=new Uint8Array(event.data);incoming+=data.byteLength;queued+=data.byteLength;
    if(incoming>o.invite.size||queued>DROP_WINDOW+DROP_BLOCK)throw Error('drop.invalid');frames.push(data);void drain().catch(fail);
   }catch(e){fail(e);}
  };
  dc.onopen=()=>{opened=true;clearTimeout(setupTimeout);lastData=Date.now();paint('transferring',true);notify();if(o.sender)void send().catch(fail);};
 };
 pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState)&&!finished){if(!committing)fail(Error('drop.nat'));}};
 pc.ondatachannel=event=>{if(o.sender){event.channel.close();fail(Error('drop.invalid'));}else attach(event.channel);};
 const sleep=(ms:number):Promise<void>=>new Promise((resolve,reject)=>{const timer=setTimeout(finish,ms);function cancel():void{clearTimeout(timer);o.signal.removeEventListener('abort',cancel);reject(Error('drop.cancelled'));}function finish():void{o.signal.removeEventListener('abort',cancel);resolve();}o.signal.addEventListener('abort',cancel,{once:true});if(o.signal.aborted)cancel();});
 const local=async(description:RTCSessionDescriptionInit):Promise<string>=>{
  await pc.setLocalDescription(description);check();
  const end=Date.now()+15000;while(pc.iceGatheringState!=='complete'&&Date.now()<end){await sleep(100);check();}
  // Full SDP carries gathered ICE candidates: no per-candidate HTTP polling.
  return dropSdp(pc.localDescription?.sdp);
 };
 const signalSetup=async():Promise<void>=>{
  paint('connecting',true);check();
  if(o.sender){attach(pc.createDataChannel('syncord-drop-v1',{ordered:true,protocol:'syncord-drop-v1'}));const sdp=await local(await pc.createOffer());check();await o.bridge.action(o.session,o.invite.id,'offer',sdp);}
  let remote=false;
  while(!remote){
   check();const state=await o.bridge.view(o.session,o.invite.id);check();if(['declined','cancelled'].includes(state.state))throw Error('drop.cancelled');
   const sdp=o.sender?state.answer:state.offer;
   if(sdp){await pc.setRemoteDescription({type:o.sender?'answer':'offer',sdp:dropSdp(sdp)});check();remote=true;
    if(!o.sender){const answer=await local(await pc.createAnswer());check();await o.bridge.action(o.session,o.invite.id,'answer',answer);}
   }else await sleep(2000);
  }
  await wait(()=>opened);void o.bridge.action(o.session,o.invite.id,'connected').catch(()=>{});
 };
 try{
  void signalSetup().catch(fail);await done;
 }finally{
  clearTimeout(setupTimeout);clearInterval(watchdog);o.signal.removeEventListener('abort',abort);
  frames=[];queued=0;notify();pc.ondatachannel=null;pc.onconnectionstatechange=null;
  if(channel){channel.onmessage=null;channel.onopen=null;channel.onerror=null;channel.onclose=null;channel.onbufferedamountlow=null;channel.close();}pc.close();
 }
}
