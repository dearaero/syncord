import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
const out=await build({entryPoints:['src/renderer/plugins/safeVoiceJoin/decide.ts'],bundle:true,format:'esm',platform:'neutral',write:false,logLevel:'silent'});
const m=await import('data:text/javascript,'+encodeURIComponent(out.outputFiles[0].text));

test('only a lone mouse click on a voice channel you are not in is swallowed',()=>{
  const base={detail:1,voice:true,connected:false,onControl:false};
  assert.equal(m.shouldBlock(base),true);
  assert.equal(m.shouldBlock({...base,detail:2}),false,'second click of a double-click joins');
  assert.equal(m.shouldBlock({...base,detail:0}),false,'keyboard Enter stays deliberate');
  assert.equal(m.shouldBlock({...base,voice:false}),false,'text channels untouched');
  assert.equal(m.shouldBlock({...base,connected:true}),false,'already in: just opens the view');
  assert.equal(m.shouldBlock({...base,onControl:true}),false,'invite/settings/chat buttons work');
});
test('row ids: only channel rows with a snowflake count',()=>{
  assert.equal(m.channelIdFromRow('channels___123456789012345678'),'123456789012345678');
  assert.equal(m.channelIdFromRow('guildsnav___123456789012345678'),undefined);
  assert.equal(m.channelIdFromRow('channels___abc'),undefined);
  assert.equal(m.channelIdFromRow(null),undefined);
});
