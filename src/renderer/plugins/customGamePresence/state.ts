import type {Game} from '../../api/gameSimulation';
export type GameState={running:boolean;status:string;game?:Game;start?:number};
let state:GameState={running:false,status:'game.disabled'};const listeners=new Set<()=>void>();
export const gameState=():GameState=>state;
export function publish(value:GameState):void{if(state.running===value.running&&state.status===value.status&&state.start===value.start&&state.game?.id===value.game?.id&&state.game?.name===value.game?.name)return;state=value;for(const fn of listeners)try{fn();}catch{}}
export function onGameState(fn:()=>void):()=>void{listeners.add(fn);return()=>listeners.delete(fn);}
