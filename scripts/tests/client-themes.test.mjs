// Free Color Themes: the premium-perks factory adapter.
// Usage: node --test scripts/tests/client-themes.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
const stub={name:'stub',setup(b){
  b.onResolve({filter:/\/(webpack|api\/logger)$/},a=>({path:a.path,namespace:'stub'}));
  b.onLoad({filter:/.*/,namespace:'stub'},a=>({contents:a.path.endsWith('webpack')?'export const beforeWebpackReady=()=>{};':'export const createLogger=()=>({warn(){},info(){}});'}));
}};
const out=await build({entryPoints:['src/renderer/plugins/clientThemes/factory.ts'],bundle:true,format:'esm',platform:'neutral',write:false,logLevel:'silent',plugins:[stub]});
const m=await import('data:text/javascript,'+encodeURIComponent(out.outputFiles[0].text));

// Shape of Discord's module: a frozen perks object behind a read-only ESM getter.
const perksFactory=function(module,exports){
  const perks=Object.freeze({isPremiumAtLeast:function(){return false;},isPremium:function(u){return u.premium>0;},canUseClientThemes:function(u){return u.premium===2;},canUseBadges:function(){return 'native';}});
  Object.defineProperty(exports,'Ay',{enumerable:true,get:()=>perks});
  Object.defineProperty(exports,'other',{enumerable:true,get:()=>42});
};
const other=function(module,exports){exports.x=1;};
const run=(req,id)=>{const module={exports:{}};req.m[id].call(module.exports,module,module.exports,req);return module.exports;};

test('wraps only the perks factory and toggles the theme gate',()=>{
  const req={m:{1:perksFactory,2:other},c:{}};
  m.installClientThemeFactory(req);
  m.installClientThemeFactory(req);
  assert.equal(m.clientThemeFactoryReport(),'installed');
  assert.notEqual(req.m[1],perksFactory);
  assert.equal(req.m[2],other);
  const {Ay,other:value}=run(req,1);
  assert.equal(value,42);
  assert.ok(Object.isFrozen(Ay));
  assert.equal(Ay.canUseBadges(),'native');
  m.setClientThemesUnlocked(false);
  assert.equal(Ay.canUseClientThemes({premium:0}),false);
  assert.equal(Ay.canUseClientThemes({premium:2}),true);
  m.setClientThemesUnlocked(true);
  assert.equal(Ay.canUseClientThemes({premium:0}),true);
  // Real Nitro is still reported natively, so sync is only changed for non-Nitro accounts.
  assert.equal(m.nativeThemeAccess({premium:0}),false);
  assert.equal(m.nativeThemeAccess({premium:2}),true);
  m.setClientThemesUnlocked(false);
});

test('leaves an already-executed module alone',()=>{
  const factory=function(module,exports){exports.Ay=Object.freeze({isPremiumAtLeast:function(){},isPremium:function(){},canUseClientThemes:function(){return false;}});};
  const req={m:{9:factory},c:{9:{exports:{}}}};
  m.installClientThemeFactory(req);
  assert.equal(req.m[9],factory);
  assert.equal(m.clientThemeFactoryReport(),'late');
});

test('exports without the gate pass through unchanged',()=>{
  const exports={a:1};
  assert.equal(m.wrapPerksExports(exports),exports);
  assert.equal(m.unlockedPerks({isPremium(){}}),undefined);
});
