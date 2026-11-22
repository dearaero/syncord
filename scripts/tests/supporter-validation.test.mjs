import test from'node:test';import assert from'node:assert/strict';import{build}from'esbuild';import{mkdtempSync,rmSync}from'node:fs';import path from'node:path';import{tmpdir}from'node:os';import{pathToFileURL}from'node:url';import{PNG}from'pngjs';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-supporter-validation-')),out=path.join(dir,'test.mjs');await build({stdin:{resolveDir:process.cwd(),contents:`export * from './services/ecosystem/src/supporter/images';export * from './src/shared/supporter';export * from './src/renderer/i18n/supporter';`},bundle:true,platform:'node',format:'esm',outfile:out,logLevel:'silent'});const M=await import(pathToFileURL(out));test.after(()=>rmSync(dir,{recursive:true,force:true}));
function chunk(type,data){const body=Buffer.concat([Buffer.from(type),data]),result=Buffer.alloc(body.length+8);result.writeUInt32BE(data.length);body.copy(result,4);let crc=0xffffffff;for(const b of body){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}result.writeUInt32BE((crc^0xffffffff)>>>0,result.length-4);return result;}
const p=new PNG({width:128,height:128});p.data[0]=220;p.data[3]=73;const png=PNG.sync.write(p);
test('only supported static signatures pass and source/output budgets are independent',()=>{
 assert.equal(M.rasterSignature(png),'png');for(const bytes of [Buffer.from('<svg/>'),Buffer.from('GIF89a'),Buffer.alloc(1048577),Buffer.from('not a picture')])assert.throws(()=>M.rasterSignature(bytes));
 const apng=Buffer.concat([png.subarray(0,33),chunk('acTL',Buffer.alloc(8)),png.subarray(33)]);assert.throws(()=>M.rasterSignature(apng));const anim=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WEBP'),chunk('ANIM',Buffer.alloc(6))]);anim.writeUInt32LE(anim.length-8,4);assert.throws(()=>M.rasterSignature(anim));
 const big=new PNG({width:2049,height:1});assert.throws(()=>M.rasterSignature(PNG.sync.write(big)));assert.throws(()=>M.cleanBadgePng(PNG.sync.write(new PNG({width:64,height:64}))));
});
test('post-encode metadata is stripped without flattening alpha',()=>{
 const source=Buffer.concat([png.subarray(0,33),chunk('tEXt',Buffer.from('Private\0file-system-location')),png.subarray(33)]),clean=M.cleanBadgePng(source);assert.ok(!Buffer.from(clean).includes(Buffer.from('file-system-location')));const image=PNG.sync.read(Buffer.from(clean));assert.deepEqual([...image.data.slice(0,4)],[220,0,0,73]);
});
test('missing or disabled private storage/processor is fail-closed, never a passthrough upload',async()=>{
 let touched=0;for(const env of [{},{BADGE_ASSETS:{put:()=>touched++}},{BADGE_IMAGES:{input:()=>touched++}},{BADGE_ASSETS:{},BADGE_IMAGES:{}}]){assert.equal(M.imageConfigured(env),false);await assert.rejects(M.processBadge(env,png),e=>e.code==='supporter.unconfigured');}assert.equal(touched,0);
});
test('names are literal normalized text with blank/control/bidi protection and all 18 locales cover states and errors',()=>{
 for(const name of ['', '  ','\u200b\u200d','A\u202eB','A\u0000B','\u0301\u0300'])assert.throws(()=>M.badgeInput({name,description:''}));assert.equal(M.badgeInput({name:'Ｆｉｘ <Badge>',description:'Literal <img>'}).name,'Fix <Badge>');assert.throws(()=>M.badgeInput({name:'Valid',description:'x'.repeat(161)}));
 for(const locale of ['en-US','tr','es-ES','de','fr','pt-BR','it','nl','pl','ru','uk','ja','zh-CN','ko','id','fa','cs','vi']){const catalog=M.supporterCatalog(locale);for(const key of ['title','capacity','suspended','unconfigured',...M.CUSTOM_BADGE_STATES])assert.ok(catalog['supporter.'+key]?.trim(),locale+' '+key);}
});
