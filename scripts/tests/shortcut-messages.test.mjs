// Shortcut Messages: whole-word, case-sensitive matching and settings normalization.
// Usage: node --test scripts/tests/shortcut-messages.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
const out=await build({entryPoints:['src/renderer/plugins/shortcutMessages/model.ts'],bundle:true,format:'esm',platform:'neutral',write:false,logLevel:'silent'});
const m=await import('data:text/javascript,'+encodeURIComponent(out.outputFiles[0].text));
const list=[{key:'adres',value:'istanbul taksim'},{key:'mail',value:'a@b.c'}];
const at=(text,caret=text.length)=>m.matchShortcut(text,caret,list)?.key;

test('matches the key only as a whole word ending at the caret',()=>{
  assert.equal(at('adres'),'adres');
  assert.equal(at('evim adres'),'adres');
  assert.equal(at('evim\tadres'),'adres');
  assert.equal(at('adres bu','adres'.length),'adres');
  assert.equal(at('adresim'),undefined);
  assert.equal(at('yadres'),undefined);
  assert.equal(at('adresim','adres'.length),undefined);
  assert.equal(at('adres '),undefined);
  assert.equal(at(''),undefined);
});

test('is case-sensitive',()=>{
  assert.equal(at('Adres'),undefined);
  assert.equal(at('ADRES'),undefined);
  assert.equal(at('mail'),'mail');
});

test('normalizes stored shortcuts: drops invalid entries and duplicate keys',()=>{
  assert.deepEqual(m.normalizeShortcuts(null),[]);
  assert.deepEqual(m.normalizeShortcuts([
    {key:'adres',value:'istanbul taksim'},
    {key:'adres',value:'second'},
    {key:'iki kelime',value:'x'},
    {key:'',value:'x'},
    {key:'bos',value:'   '},
    {key:'satir',value:'a\nb'},
    {key:'x'.repeat(33),value:'x'},
    'junk',
    {key:'ok',value:'fine'},
  ]),[{key:'adres',value:'istanbul taksim'},{key:'ok',value:'fine'}]);
});
