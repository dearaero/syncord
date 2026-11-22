import {settings} from '../../api/settings';
import type {Game} from '../../api/gameSimulation';
export const GAME_ID='custom-game-presence',GAME_CHANGE='Syncord-custom-game-settings';
export type Config={selected?:Game;initialSeconds:number;timeUnit:'seconds'|'minutes'|'hours';recent:Game[];favorites:Game[];realPriority:boolean};
export const gameId=(value:unknown):value is string=>typeof value==='string'&&/^\d{17,20}$/.test(value);
export function gameValue(v:unknown):Game|undefined {if(!v||typeof v!=='object')return;const r=v as Record<string,unknown>;if(!gameId(r.id)||typeof r.name!=='string'||!r.name.trim()||r.name.length>128||/[\x00-\x1f\x7f]/.test(r.name))return;const icon=[r.icon,r.icon_hash].find((value):value is string=>typeof value==='string'&&/^(?:a_)?[a-f0-9]{32}$/.test(value));return{id:r.id,name:r.name.trim(),...(icon?{icon}:{})};}
export function seconds(value:number,unit:Config['timeUnit'],now=Date.now()):number {const n=value*({seconds:1,minutes:60,hours:3600}[unit]);if(!Number.isFinite(value)||value<0||!Number.isSafeInteger(n)||n>Math.floor(now/1000))throw Error('game.invalid_time');return n;}
export function config(account:string):Config {const raw=settings.get<Record<string,unknown>>('plugins.'+GAME_ID+'.data.accounts',{})?.[account];const r=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};
 const list=(v:unknown):Game[]=>{const map=new Map<string,Game>();for(const item of (Array.isArray(v)?v:[]).slice(0,24)){const game=gameValue(item);if(game)map.set(game.id,game);}return[...map.values()];};
 let initialSeconds=0;try{initialSeconds=seconds(Number(r.initialSeconds??0),'seconds');}catch{}
 return{selected:gameValue(r.selected),initialSeconds,timeUnit:r.timeUnit==='hours'||r.timeUnit==='minutes'?r.timeUnit:'seconds',recent:list(r.recent),favorites:list(r.favorites),realPriority:r.realPriority!==false};}
export function saveConfig(account:string,change:Partial<Config>):void {if(!gameId(account))return;const accounts=settings.get<Record<string,unknown>>('plugins.'+GAME_ID+'.data.accounts',{})??{};const next={...config(account),...change};seconds(next.initialSeconds,'seconds');settings.set('plugins.'+GAME_ID+'.data.accounts',{...accounts,[account]:next});window.dispatchEvent(new Event(GAME_CHANGE));}
