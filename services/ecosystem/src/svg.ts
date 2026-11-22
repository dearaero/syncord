import {SaxesParser} from 'saxes';
import {MAX_BADGE_SVG_BYTES} from '../../../src/shared/ecosystem';
import {ApiError} from './types';

const SVG='http://www.w3.org/2000/svg';
const elements=new Set('svg g defs symbol use path rect circle ellipse line polyline polygon linearGradient radialGradient stop clipPath mask pattern title desc text tspan filter feGaussianBlur feOffset feBlend feColorMatrix feComposite feFlood feMerge feMergeNode style'.split(' '));
const presentation=new Set('fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stroke-opacity opacity color stop-color stop-opacity clip-path clip-rule mask mask-type filter flood-color flood-opacity color-interpolation color-interpolation-filters display visibility vector-effect paint-order shape-rendering text-rendering font-family font-size font-style font-weight text-anchor dominant-baseline letter-spacing word-spacing isolation mix-blend-mode'.split(' '));
const attributes=new Set([...presentation,...'id class viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points transform gradientTransform gradientUnits spreadMethod offset fx fy fr clipPathUnits maskUnits maskContentUnits patternUnits patternContentUnits patternTransform preserveAspectRatio href dx dy rotate textLength lengthAdjust filterUnits primitiveUnits in in2 result stdDeviation edgeMode mode type values operator k1 k2 k3 k4'.split(' ')]);
const identifier=/^[A-Za-z_][\w.-]{0,79}$/;
const numeric=new Set('viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points transform gradientTransform offset fx fy fr patternTransform dx dy rotate textLength stdDeviation values k1 k2 k3 k4 stroke-width stroke-miterlimit stroke-dasharray stroke-dashoffset font-size letter-spacing word-spacing'.split(' '));
type Node={name:string;attrs:Map<string,string>;inline:Map<string,string>;children:(Node|string)[]};
type Rule={selectors:string[];attrs:Map<string,string>};
function invalid():never{throw new ApiError(400,'admin_invalid_svg');}
const escape=(text:string):string=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
function value(name:string,raw:string):string{
 const v=raw.trim();if(v.length>32768||/[\u0000-\u001f\u007f\\<>@]/.test(v)||/(?:javascript|data|https?|file|vbscript)\s*:/i.test(v))invalid();
 if(name==='id'&&!identifier.test(v))invalid();
 if(name==='href'&&!/^#[A-Za-z_][\w.-]{0,79}$/.test(v))invalid();
 if(/url\s*\(/i.test(v)&&!/^url\(\s*["']?#[A-Za-z_][\w.-]{0,79}["']?\s*\)$/.test(v))invalid();
 if(/(?:var|expression)\s*\(/i.test(v))invalid();
 if(numeric.has(name))for(const token of v.matchAll(/[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?/gi)){const n=Number(token[0]);if(!Number.isFinite(n)||Math.abs(n)>1000000)invalid();}
 if(name==='stdDeviation'&&v.split(/[ ,]+/).some(n=>!Number.isFinite(Number(n))||Number(n)<0||Number(n)>32))invalid();
 return v;
}
function declarations(source:string):Map<string,string>{
 const result=new Map<string,string>();for(const declaration of source.split(';')){if(!declaration.trim())continue;const colon=declaration.indexOf(':');if(colon<1)invalid();const name=declaration.slice(0,colon).trim();if(!presentation.has(name))invalid();result.set(name,value(name,declaration.slice(colon+1)));}return result;
}
function stylesheet(source:string):Rule[]{
 const text=source.replace(/\/\*[\s\S]*?\*\//g,''),rules:Rule[]=[];let end=0;
 for(const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
  if(text.slice(end,match.index).trim())invalid();end=match.index!+match[0].length;
  const selectors=match[1]!.split(',').map(s=>s.trim());if(selectors.length>16||selectors.some(s=>! /^(?:[.#][A-Za-z_][\w.-]{0,79}|[A-Za-z][A-Za-z0-9]*)$/.test(s)))invalid();
  rules.push({selectors,attrs:declarations(match[2]!)});if(rules.length>64)invalid();
 }if(text.slice(end).trim())invalid();return rules;
}

/** A bounded static SVG profile. Parse XML, resolve harmless presentation CSS,
 * then reserialize a new document; never store or serve the uploaded markup. */
export function sanitizeBadgeSvg(input:unknown):string{
 if(typeof input!=='string')invalid();
 if(new TextEncoder().encode(input).length>MAX_BADGE_SVG_BYTES)throw new ApiError(413,'admin_svg_too_large');
 if(!input.trim())invalid();
 const stack:Node[]=[],nodes:Node[]=[],rules:Rule[]=[];let root:Node|undefined,skipped=0,totalNodes=0;
 const parser=new SaxesParser({xmlns:true});
 parser.on('error',invalid);parser.on('doctype',invalid);parser.on('processinginstruction',invalid);
 parser.on('opentag',tag=>{
  if(stack.length+skipped>=32||++totalNodes>1024)invalid();
  if(skipped){skipped++;return;}
  if((tag.local==='metadata'&&(tag.uri===SVG||tag.uri===''))||['http://www.inkscape.org/namespaces/inkscape','http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd'].includes(tag.uri)){if(!root)invalid();skipped=1;return;}
  if(!elements.has(tag.local)||(tag.uri!==SVG&&tag.uri!==''))invalid();
  if(!root&&tag.local!=='svg')invalid();
  const node:Node={name:tag.local,attrs:new Map(),inline:new Map(),children:[]};
  if(stack.at(-1)?.name==='style')invalid();
  for(const attr of Object.values(tag.attributes)){
   if(attr.uri==='http://www.w3.org/2000/xmlns/')continue;
   if(attr.local.toLowerCase().startsWith('on'))invalid();
   if(attr.uri&&attr.uri!=='http://www.w3.org/1999/xlink'){
    if(attr.uri==='http://www.w3.org/XML/1998/namespace'&&attr.local==='space')continue;
    // Editor metadata is not part of the rendered SVG vocabulary.
    if(attr.uri!==SVG)continue;
    invalid();
   }
   const name=attr.local;
   if(attr.uri&&name!=='href')invalid();
   if(name==='style'){node.inline=declarations(attr.value);continue;}
   if(node.name==='style'&&name==='type'&&attr.value==='text/css')continue;
   if(name==='version'||name==='role'||name.startsWith('aria-')||name.startsWith('data-'))continue;
   if(!attributes.has(name))invalid();node.attrs.set(name,value(name,attr.value));
  }
  if(stack.length)stack.at(-1)!.children.push(node);else{if(root)invalid();root=node;}
  nodes.push(node);stack.push(node);
 });
 const text=(text:string):void=>{if(skipped)return;if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))invalid();const node=stack.at(-1);if(!node){if(text.trim())invalid();return;}if(['text','tspan','title','desc','style'].includes(node.name))node.children.push(text);else if(text.trim())invalid();};
 parser.on('text',text);parser.on('cdata',text);
 parser.on('closetag',()=>{if(skipped){skipped--;return;}const node=stack.pop()!;if(node.name==='style'){rules.push(...stylesheet(node.children.join('')));if(rules.length>64)invalid();}});
 try{parser.write(input).close();}catch(error){if(error instanceof ApiError)throw error;invalid();}
 if(!root||stack.length)invalid();const document=root as Node;
 const ids=new Map<string,Node>();
 for(const node of nodes){
  const id=node.attrs.get('id');if(id){if(ids.has(id))invalid();ids.set(id,node);}
  const classes=(node.attrs.get('class')??'').split(/\s+/);const matching: {specificity:number;order:number;attrs:Map<string,string>}[]=[];
  rules.forEach((rule,order)=>{const scores=rule.selectors.filter(s=>s[0]==='#'?s.slice(1)===id:s[0]==='.'?classes.includes(s.slice(1)):s===node.name).map(s=>s[0]==='#'?100:s[0]==='.'?10:1);if(scores.length)matching.push({specificity:Math.max(...scores),order,attrs:rule.attrs});});
  matching.sort((a,b)=>a.specificity-b.specificity||a.order-b.order);for(const rule of matching)for(const [name,v]of rule.attrs)node.attrs.set(name,v);for(const [name,v]of node.inline)node.attrs.set(name,v);node.attrs.delete('class');
 }
 if(!document.attrs.has('viewBox')){
  const dimensions=['width','height'].map(k=>Number((document.attrs.get(k)??'').replace(/px$/,'')));if(dimensions.some(n=>!Number.isFinite(n)||n<=0||n>4096))invalid();document.attrs.set('viewBox','0 0 '+dimensions.join(' '));
 }
 const box=document.attrs.get('viewBox')!.split(/[ ,]+/).map(Number);if(box.length!==4||box.some(n=>!Number.isFinite(n))||box[2]!<=0||box[3]!<=0)invalid();
 // Badge images are square viewports; retain the author's coordinate system
 // while avoiding unbounded intrinsic dimensions and editor-specific units.
 document.attrs.set('width','32');document.attrs.set('height','32');
 let references=0;const visiting=new Set<Node>(),costs=new Map<Node,number>();
 const cost=(node:Node):number=>{
  if(visiting.has(node))invalid();const cached=costs.get(node);if(cached!==undefined)return cached;visiting.add(node);let n=1;
  for(const child of node.children)if(typeof child!=='string'&&child.name!=='style')n+=cost(child);
  for(const [name,v]of node.attrs){const id=name==='href'?v.slice(1):/^url\(/i.test(v)?v.match(/#([A-Za-z_][\w.-]{0,79})/)?.[1]:undefined;if(id){if(++references>128||!ids.has(id))invalid();n+=cost(ids.get(id)!);}}
  if(n>10000)invalid();visiting.delete(node);costs.set(node,n);return n;
 };cost(document);
 const chunks:string[]=[];let bytes=0;
 const write=(text:string):void=>{bytes+=new TextEncoder().encode(text).length;if(bytes>MAX_BADGE_SVG_BYTES)throw new ApiError(413,'admin_svg_too_large');chunks.push(text);};
 const serialize=(node:Node):void=>{
  if(node.name==='style')return;write('<'+node.name+(node===document?' xmlns="'+SVG+'"':''));
  for(const [k,v]of [...node.attrs].sort(([a],[b])=>a<b?-1:a>b?1:0))write(' '+k+'="'+escape(v)+'"');write('>');
  for(const child of node.children)if(typeof child==='string')write(escape(child));else serialize(child);write('</'+node.name+'>');
 };serialize(document);return chunks.join('');
}
