import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'syncord-notes-model-'));
await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`export * from './src/renderer/plugins/notes/store'; export * from './src/renderer/plugins/notes/editor'; export {safeLink} from './src/renderer/plugins/notes/markdown';`},bundle:true,platform:'node',format:'esm',outfile:dir+'/model.mjs',logLevel:'silent'});
const api = await import(pathToFileURL(dir+'/model.mjs'));
after(()=>rmSync(dir,{recursive:true,force:true}));
test('notes: validation rejects malformed documents and bounds UTF-8 bytes without truncation',()=>{
 const note=api.createNote('Başlık','Merhaba 👋');assert.deepEqual(api.validateNote(note),note);
 for(const change of [{content:'😀'.repeat(140000)},{id:'../path'},{tags:['x'.repeat(41)]},{tags:new Array(13).fill('tag')},{updatedAt:NaN},{deletedAt:'now'},{title:'a'.repeat(201)}])assert.throws(()=>api.validateNote({...note,...change}));
 assert.equal(api.summarize(note).bytes,Buffer.byteLength(note.content));assert.equal('content' in api.summarize(note),false);
});
test('notes: metadata excerpts remain bounded even for long single-line documents',()=>{
 const note=api.createNote('A','x'.repeat(200000));const metadata=api.summarize(note);
 assert.equal(metadata.excerpt.length,180);assert.equal(metadata.bytes,200000);
});
test('notes: formatting preserves surrounding text and selects the formatted content',()=>{
 assert.deepEqual(api.formatSelection('one two three',4,7,'bold'),{text:'one **two** three',start:6,end:9});
 assert.deepEqual(api.formatSelection('a\nb\nc',0,3,'task'),{text:'- [ ] a\n- [ ] b\nc',start:0,end:15});
 assert.equal(api.formatSelection('  a\n\tb',0,6,'outdent').text,'a\nb');
 assert.match(api.formatSelection('',0,0,'table').text,/\| --- \| --- \|/);
 assert.equal(api.formatSelection('',0,0,'bold').text,'**bold text**');
 assert.equal(api.formatSelection('',0,0,'link').text,'[link](https://example.com)');
 assert.match(api.formatSelection('',0,0,'table').text,/\| Heading \| Heading \|/);
});
test('notes: undo/redo branches correctly after a new edit and cannot cross documents',()=>{
 const history=new api.EditHistory();const edit=text=>({text,start:text.length,end:text.length});
 history.reset(edit('a'));history.record(edit('ab'));history.record(edit('abc'));
 assert.equal(history.move(-1).text,'ab');assert.equal(history.move(1).text,'abc');
 history.move(-1);history.record(edit('abd'));assert.equal(history.move(1),undefined);
 history.reset(edit('another document'));assert.equal(history.move(-1),undefined);
});
test('notes: rapid input groups undo operations while keeping the original document',()=>{
 const history=new api.EditHistory();const edit=text=>({text,start:0,end:0});
 history.reset(edit(''));history.record(edit('a'),true);history.record(edit('ab'),true);history.record(edit('abc'),true);
 assert.equal(history.move(-1).text,'');assert.equal(history.move(1).text,'abc');
});
test('notes: preview links reject script/file/data protocols and embedded credentials',()=>{
 for(const url of ['javascript:alert(1)','javascript&#58;alert(1)','data:text/html,a','file:///tmp/a','https://user:pass@example.com','//example.com','vbscript:foo'])assert.equal(api.safeLink(url),undefined,url);
 assert.equal(api.safeLink('https://example.com/?a=1&b=2'),'https://example.com/?a=1&b=2');assert.equal(api.safeLink('mailto:test@example.com'),'mailto:test@example.com');assert.equal(api.safeLink('#section'),'#section');
});
