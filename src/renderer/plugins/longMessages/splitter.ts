/** Original slices and structural Markdown wrappers stay separate for exact recovery. */
export type Part = {raw:string;content:string;start:number;end:number};
export type SplitOptions = {limit:number;maxParts:number;numbers?:boolean};
type Markdown = {fence:string;inline:string;styles:string[]};
const empty = ():Markdown=>({fence:'',inline:'',styles:[]});
function scan(text:string,initial:Markdown):Markdown {
  const state={...initial,styles:[...initial.styles]};
  const links=[...text.matchAll(/https?:\/\/[^\s<>]+|<[^>\n]+>|\[[^\]\n]*\]\([^\s)]*\)/g)].map(m=>[m.index,m.index+m[0].length]);
  const tokens=/^ {0,3}(`{3,}|~{3,})([^\n]*)|`+|\*\*|__|~~|\|\||\*|_/gm;
  for(const match of text.matchAll(tokens)){
    const token=match[0],at=match.index;
    if(at>0&&text[at-1]==='\\'||links.some(([a,b])=>a<=at&&at<b))continue;
    if(match[1]){
      if(state.inline)continue;
      if(state.fence){if(match[1][0]===state.fence.trimStart()[0]&&match[1].length>=(/^[`~]+/.exec(state.fence)?.[0].length??3))state.fence='';}
      else if((match[2]?.length??0)<=64)state.fence=token.trimStart();
    }else if(!state.fence){
      if(token[0]==='`'){if(!state.inline)state.inline=token;else if(state.inline===token)state.inline='';}
      else if(!state.inline){const i=state.styles.lastIndexOf(token);if(i<0)state.styles.push(token);else state.styles.splice(i,1);}
    }
  }
  return state;
}
function wrappers(s:Markdown):[string,string] {
  if(s.fence){const ticks=/^[`~]+/.exec(s.fence)?.[0]??'```';return [`${s.fence}\n`,`\n${ticks}`];}
  return [s.styles.join('')+s.inline,s.inline+[...s.styles].reverse().join('')];
}
function continuationLead(text:string,offset:number):string {
  const line=text.slice(text.lastIndexOf('\n',offset-1)+1,offset);
  if(!line)return '';
  return /^(?:> ?)+/.exec(line)?.[0]??(/^(\s*)(?:[-*+] |\d+[.)] )/.exec(line)?.[0].replace(/\S/g,' ')??'');
}
/** UTF-16 budgets are conservative for Discord. Grapheme boundaries protect ZWJ/combining sequences. */
export function splitMessage(text:string,options:SplitOptions):Part[] {
  const {limit,maxParts,numbers=false}=options;
  if(!Number.isInteger(limit)||limit<128||limit>4000||!Number.isInteger(maxParts)||maxParts<1||maxParts>30)throw Error('long.limit');
  if(text.length>limit*maxParts)throw Error('long.limit');
  if(text.length<=limit)return [{raw:text,content:text,start:0,end:text.length}];
  const ends=[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].map(s=>s.index+s.segment.length);
  const protectedRanges=[...text.matchAll(/https?:\/\/[^\s<>]+|<(?:(?:@!?|@&|#)\d+|a?:\w+:\d+|t:\d+(?::\w)?)>|\[[^\]\n]*\]\([^\s)]*\)|`{2,}|\*\*|__|~~|\|\|/g)].map(m=>[m.index,m.index+m[0].length]);
  let start=0,state=empty(),prefix='',cursor=0;
  const parts:Part[]=[];
  // Reserve the maximum index width; no iterative numbering can overflow a part.
  const label=numbers?` (${maxParts}/${maxParts})`.length:0;
  while(start<text.length){
    if(parts.length>=maxParts)throw Error('long.limit');
    let budget=limit-prefix.length-label,end=start,next=state,suffix='';
    for(let attempt=0;attempt<16;attempt++){
      let i=cursor;while(i<ends.length&&ends[i]!<=start+budget)i++;
      end=ends[i-1]??start;if(end<=start)throw Error('long.grapheme');
      for(const [a,b]of protectedRanges){if(a>=end)break;if(a<end&&b>end&&a>start&&b-a<=limit-prefix.length-label)end=a;}
      if(end<text.length){
        const floor=start+Math.floor(budget*.65);let best=-1,rank=0;
        const region=text.slice(start,end);
        for(const m of region.matchAll(/\n\s*\n|\n|[.!?。！？][ \t]+|[ \t]+/g)){
          const boundary=start+m.index+m[0].length;if(boundary<floor)continue;
          const r=m[0].includes('\n')?(m[0].match(/\n/g)!.length>1?4:3):/[.!?。！？]/.test(m[0])?2:1;
          if(r>=rank){best=boundary;rank=r;}
        }
        if(best>start&&ends.includes(best)&&!protectedRanges.some(([a,b])=>a<best&&b>best))end=best;
      }
      next=scan(text.slice(start,end),state);suffix=end<text.length?wrappers(next)[1]:'';
      if(prefix.length+end-start+suffix.length+label<=limit)break;
      budget-=suffix.length+1;if(attempt===15)throw Error('long.grapheme');
    }
    const raw=text.slice(start,end);parts.push({raw,content:prefix+raw+suffix,start,end});
    state=next;prefix=(state.fence?'':continuationLead(text,end))+wrappers(state)[0];start=end;while(cursor<ends.length&&ends[cursor]!<=start)cursor++;
  }
  if(numbers)for(let i=0;i<parts.length;i++)parts[i]!.content+=`\n(${i+1}/${parts.length})`;
  if(parts.some(p=>!p.content.trim()))throw Error('long.grapheme');
  return parts;
}
