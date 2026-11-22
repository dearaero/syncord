import {test,after} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {readReleaseConfiguration} from '../lib/release-config.mjs';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-release-config-'));
mkdirSync(path.join(dir,'src/shared'),{recursive:true});
mkdirSync(path.join(dir,'config'));
writeFileSync(path.join(dir,'src/shared/release.ts'),'export const DEFAULT_RELEASE_REPO = "owner/public-releases";');
const pair=crypto.generateKeyPairSync('ed25519');
const publicB64=pair.publicKey.export({format:'der',type:'spki'}).toString('base64');
after(()=>rmSync(dir,{recursive:true,force:true}));
test('the public update target is independent of the source git remote',()=>{
  mkdirSync(path.join(dir,'.git'));
  writeFileSync(path.join(dir,'.git/config'),'[remote "origin"]\nurl = https://github.com/owner/private-source.git\n');
  assert.equal(readReleaseConfiguration(dir,{}).repository,'owner/public-releases');
});
test('a stored public trust anchor is compiled without needing private secrets',()=>{
  writeFileSync(path.join(dir,'config/release-public-key.base64'),publicB64+'\n');
  const config=readReleaseConfiguration(dir,{});
  assert.equal(config.integrityKey,publicB64);
  assert.equal(config.signingKey,'');
});
test('uppercase CI variables and legacy local variables resolve to the same config',()=>{
  const upper={SYNCORD_INTEGRITY_KEY:publicB64,SYNCORD_SIGNING_KEY:'test-private-value',SYNCORD_RELEASE_REPO:'fork/releases'};
  const legacy=Object.fromEntries(Object.entries(upper).map(([key,value])=>[key.replace('SYNCORD','Syncord'),value]));
  assert.deepEqual(readReleaseConfiguration(dir,upper),readReleaseConfiguration(dir,legacy));
});
test('conflicting alias values are refused rather than silently using a different signer',()=>{
  assert.throws(()=>readReleaseConfiguration(dir,{SYNCORD_RELEASE_REPO:'owner/a',Syncord_RELEASE_REPO:'owner/b'}),/disagree/);
});
test('environment overrides local aliases without reading unrelated .env secrets',()=>{
  writeFileSync(path.join(dir,'.env'),'Syncord_RELEASE_REPO=local/releases\nAPI_KEY=irrelevant\n');
  assert.equal(readReleaseConfiguration(dir,{SYNCORD_RELEASE_REPO:'ci/releases'}).repository,'ci/releases');
});
test('invalid and non-Ed25519 public keys are refused before compiling',()=>{
  assert.throws(()=>readReleaseConfiguration(dir,{SYNCORD_INTEGRITY_KEY:'broken'}),/SPKI Ed25519/);
  const rsa=crypto.generateKeyPairSync('rsa',{modulusLength:1024});
  assert.throws(()=>readReleaseConfiguration(dir,{SYNCORD_INTEGRITY_KEY:rsa.publicKey.export({format:'der',type:'spki'}).toString('base64')}),/SPKI Ed25519/);
});
