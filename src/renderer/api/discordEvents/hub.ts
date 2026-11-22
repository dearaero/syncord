import {around} from "../patcher";
export type Action = Record<string, unknown> & {type?: string};
export type Dispatch = (action: Action) => unknown;
export type Flux = {dispatch: Dispatch};
export type Listener = (action: Action) => void;
export type Interceptor = (action: Action, next: Dispatch) => unknown;

/** A single dispatch hook. No action history; before-store consumers can preserve deletions. */
export class EventHub {
  private listeners = new Map<string, Set<Listener>>();
  private interceptors = new Set<Interceptor>();
  private undo: (() => void) | undefined;
  constructor(private readonly report: (error:unknown)=>void) {}
  attach(flux:Flux, before:Listener, after:Listener): boolean {
    if (this.undo) return true;
    const hub=this;
    const wrapper=function(this:unknown,action:Action,original:Dispatch) {
      if (!action || typeof action.type !== "string") return original.call(this,action);
      try {before(action);} catch(error) {hub.report(error);}
      const hooks=[...hub.interceptors];
      const invoke=(index:number,current:Action):unknown => {
        const handler=hooks[index];
        if(!handler)return original.call(this,current);
        let called=false,value:unknown,failure:unknown,failed=false;
        const next:Dispatch=action=>{
          if(called){if(failed)throw failure;return value;}
          called=true;try{value=invoke(index+1,action);return value;}catch(error){failed=true;failure=error;throw error;}
        };
        try{return handler(current,next);}catch(error){
          if(failed)throw failure;
          hub.report(error);return called?value:next(current);
        }
      };
      const result=invoke(0,action);
      // Native stores have processed the event before ordinary consumers receive it.
      const callbacks=hub.listeners.get(action.type);
      if (callbacks) for (const callback of [...callbacks]) {
        if (!callbacks.has(callback)) continue;
        try {callback(action);} catch(error) {hub.report(error);}
      }
      try {after(action);} catch(error) {hub.report(error);}
      return result;
    };
    try {this.undo=around(flux,"dispatch",(args,next)=>wrapper.call(flux,args[0] as Action,action=>next(action,...args.slice(1))));}
    catch{return false;}
    return true;
  }
  listen(type:string,listener:Listener):()=>void {
    let set=this.listeners.get(type);if(!set){set=new Set();this.listeners.set(type,set);}set.add(listener);
    return ()=>{set.delete(listener);if(!set.size)this.listeners.delete(type);};
  }
  intercept(handler:Interceptor):()=>void {this.interceptors.add(handler);return ()=>{this.interceptors.delete(handler);};}
  detach():void {this.undo?.();this.undo=undefined;}
  counts():{listeners:number;interceptors:number;attached:boolean} {
    return {listeners:[...this.listeners.values()].reduce((n,set)=>n+set.size,0),interceptors:this.interceptors.size,attached:!!this.undo};
  }
}
