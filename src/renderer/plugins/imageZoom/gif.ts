/** WebCodecs owns GIF disposal/compositing. Only one decoded frame is retained
 * for drawing, and every VideoFrame is immediately closed, including stale work. */
type Frame = CanvasImageSource & { displayWidth:number; displayHeight:number; duration:number|null; close():void };
type Decoder = { tracks:{ready:Promise<void>;selectedTrack:{frameCount:number}|null};decode(options:{frameIndex:number;completeFramesOnly:boolean}):Promise<{image:Frame}>;close():void };
type DecoderType = { new(options:{data:ArrayBuffer;type:string;preferAnimation:boolean}):Decoder;isTypeSupported(type:string):Promise<boolean> };
export type GifOptions={autoplay:boolean;loop:boolean;speed:number;maxPixels:number};
export type GifState={frame:number;count:number;playing:boolean};
export async function readGif(url:string,limit:number,signal:AbortSignal):Promise<ArrayBuffer> {
  const response=await fetch(url,{signal,credentials:'omit',referrerPolicy:'no-referrer'});
  if (!response.ok) throw Error("The original GIF could not be downloaded.");
  if (Number(response.headers.get('content-length'))>limit) {await response.body?.cancel().catch(()=>{});throw Error("GIF exceeds the file budget.");}
  if (!response.body) throw Error("GIF data is unavailable.");
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0,done=false;
  try {
    while(true){const part=await reader.read();if(part.done){done=true;break;}size+=part.value.byteLength;if(size>limit||parts.length>=8192)throw Error("GIF exceeds the file budget.");parts.push(part.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes.buffer;
  } finally {if(!done)await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function gifDimensions(bytes:ArrayBuffer):{width:number;height:number} {
  const data=new Uint8Array(bytes);
  if(data.length<13 || !['GIF87a','GIF89a'].includes(String.fromCharCode(...data.subarray(0,6))))throw Error("This preview is not an original GIF file.");
  const view=new DataView(bytes),width=view.getUint16(6,true),height=view.getUint16(8,true);
  if(!width||!height)throw Error("The GIF has invalid dimensions.");return {width,height};
}
export class GifPlayback {
  private decoder:Decoder;
  private context:CanvasRenderingContext2D;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private closed=false;
  private busy=false;
  private desired:number|undefined;
  private decoding:number|undefined;
  private revision=0;
  private delay=100;
  private current=0;
  private count=0;
  private playing=false;
  private readonly abort=():void=>this.close();
  private constructor(decoder:Decoder,context:CanvasRenderingContext2D,private readonly config:GifOptions,private readonly signal:AbortSignal,private readonly changed:(state:GifState)=>void,private readonly failed:(error:unknown)=>void) {
    this.decoder=decoder;this.context=context;signal.addEventListener('abort',this.abort,{once:true});
  }
  static async create(bytes:ArrayBuffer,canvas:HTMLCanvasElement,config:GifOptions,signal:AbortSignal,changed:(state:GifState)=>void,failed:(error:unknown)=>void):Promise<GifPlayback> {
    signal.throwIfAborted();
    const {width,height}=gifDimensions(bytes);if(width*height>config.maxPixels)throw Error("GIF exceeds the frame resolution budget.");
    const Type=(globalThis as unknown as {ImageDecoder?:DecoderType}).ImageDecoder;
    if(!Type || !await Type.isTypeSupported('image/gif'))throw Error("GIF frame decoding is unavailable in this Discord version.");
    signal.throwIfAborted();
    const context=canvas.getContext('2d');if(!context)throw Error("The GIF drawing surface is unavailable.");
    const player=new GifPlayback(new Type({data:bytes,type:'image/gif',preferAnimation:true}),context,config,signal,changed,failed);
    try {
      await player.decoder.tracks.ready;signal.throwIfAborted();
      player.count=player.decoder.tracks.selectedTrack?.frameCount??0;
      if(!player.count)throw Error("The GIF has no readable frames.");
      const frame=await player.decoder.decode({frameIndex:0,completeFramesOnly:true});
      try {signal.throwIfAborted();player.draw(frame.image,0);}finally{frame.image.close();}
      if(config.autoplay)player.play();else player.emit();return player;
    }catch(error){player.close();throw error;}
  }
  private draw(frame:Frame,index:number):void {
    if(frame.displayWidth*frame.displayHeight>this.config.maxPixels)throw Error("GIF exceeds the frame resolution budget.");
    const canvas=this.context.canvas;
    if(canvas.width!==frame.displayWidth || canvas.height!==frame.displayHeight){canvas.width=frame.displayWidth;canvas.height=frame.displayHeight;}
    this.context.clearRect(0,0,canvas.width,canvas.height);this.context.drawImage(frame,0,0);
    this.current=index;this.delay=Math.max(20,Math.min(10000,(frame.duration??100000)/1000));this.emit();
  }
  snapshot():GifState{return {frame:this.current,count:this.count,playing:this.playing};}
  private emit():void {if(!this.closed)this.changed(this.snapshot());}
  private clearTimer():void {if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;}
  private schedule():void {
    this.clearTimer();if(!this.playing||this.closed||this.busy||this.count<2)return;
    if(!this.config.loop&&this.current===this.count-1){this.pause();return;}
    this.timer=setTimeout(()=>{this.timer=undefined;this.desired=(this.current+1)%this.count;void this.pump();},this.delay/this.config.speed);
  }
  play():void {if(this.closed)return;this.playing=this.count>1;this.emit();this.schedule();}
  pause():void {this.playing=false;this.revision++;this.desired=undefined;this.clearTimer();this.emit();}
  toggle():void {if(this.playing)this.pause();else this.play();}
  step(delta:number):void {const origin=this.desired??this.decoding??this.current;this.pause();if(this.closed)return;this.desired=((origin+delta)%this.count+this.count)%this.count;void this.pump();}
  private async pump():Promise<void> {
    if(this.busy||this.closed)return;this.busy=true;
    try {
      while(this.desired!==undefined&&!this.closed){
        const index=this.desired,revision=this.revision;this.desired=undefined;this.decoding=index;
        const result=await this.decoder.decode({frameIndex:index,completeFramesOnly:true});
        try{if(!this.closed&&revision===this.revision&&this.desired===undefined)this.draw(result.image,index);}finally{result.image.close();this.decoding=undefined;}
      }
    }catch(error){if(!this.closed){this.close();this.failed(error);}}
    finally{this.decoding=undefined;this.busy=false;this.schedule();}
  }
  close():void {if(this.closed)return;this.closed=true;this.playing=false;this.revision++;this.desired=undefined;this.clearTimer();this.signal.removeEventListener('abort',this.abort);this.decoder.close();this.context.canvas.width=this.context.canvas.height=0;}
}
