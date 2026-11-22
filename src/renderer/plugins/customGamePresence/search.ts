import type {Game} from '../../api/gameSimulation';
/** Fold accents/punctuation without locale-dependent casing (including Turkish I). */
export function gameSearchText(value:string):string {
 return value.slice(0,160).normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'i').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}
/** Bounded edit distance; unrelated lengths/rows exit early. No full matrices. */
function distance(a:string,b:string,max:number):number {
 if(Math.abs(a.length-b.length)>max)return max+1;
 let previous=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){
  const row=new Array<number>(b.length+1).fill(max+1);row[0]=i;let best=max+1;
  for(let j=Math.max(1,i-max);j<=Math.min(b.length,i+max);j++){
   row[j]=Math.min(previous[j]+1,row[j-1]+1,previous[j-1]+(a[i-1]===b[j-1]?0:1));best=Math.min(best,row[j]);
  }
  if(best>max)return max+1;previous=row;
 }
 return previous[b.length];
}
function score(game:Game,query:string,words:string[]):number {
 if(game.id===query)return -1;
 const name=gameSearchText(game.name);if(name===query)return 0;if(name.startsWith(query))return 10+(name.length-query.length)/1000;
 const tokens=name.split(' ');if(tokens.some(word=>word.startsWith(query)))return 20;
 const compact=query.replaceAll(' ','');
 if(compact.length>=3&&tokens.map(word=>word[0]).join('').startsWith(compact))return 25;
 const index=name.indexOf(query);if(index>=0)return 30+index/160;
 if(words.length>1&&words.every(word=>tokens.some(token=>token.startsWith(word))))return 40;
 const joined=name.replaceAll(' ','');if(joined.includes(compact))return 45;
 // Short fragments already have exact/prefix matching. Do not turn one or two
 // letters into arbitrary fuzzy results, or compute edits for huge phrases.
 if(compact.length<3||compact.length>48||words.length>6)return Infinity;
 const tolerance=compact.length<=5?1:compact.length<=9?2:3;
 let edits=distance(joined,compact,tolerance);
 if(words.length===1)for(const token of tokens)edits=Math.min(edits,distance(token,query,tolerance));
 else if(words.length<=tokens.length){
  let sum=0;for(const word of words){const max=word.length<3?0:word.length<=5?1:2;let best=max+1;for(const token of tokens)best=Math.min(best,distance(token,word,max));sum+=best;if(best>max||sum>tolerance){sum=tolerance+1;break;}}edits=Math.min(edits,sum);
 }
 return edits<=tolerance?60+edits*5:Infinity;
}
/** Stable top matches; a typed query outranks favorite/recent ordering. */
export function searchGames(games:readonly Game[],input:string,limit=30):Game[]{
 const query=gameSearchText(input),bound=Math.max(0,Math.min(30,Math.floor(limit)||0));if(!bound)return[];
 const unique=[...new Map(games.map(game=>[game.id,game])).values()];if(!query)return unique.slice(0,bound);
 const words=query.split(' ');
 return unique.map((game,index)=>({game,index,score:score(game,query,words)})).filter(row=>Number.isFinite(row.score)).sort((a,b)=>a.score-b.score||a.index-b.index).slice(0,bound).map(row=>row.game);
}
