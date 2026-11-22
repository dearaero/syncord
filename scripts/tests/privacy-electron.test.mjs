/** Real Electron: no mock can prove that native crash methods are writable or
 * that canceled requests actually never reach the wire. All traffic is local. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
const executable = path.resolve("node_modules/electron/dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron");
test("privacy in real Electron: crash startup is suppressed; telemetry never reaches loopback while messages do", { skip: !existsSync(executable), timeout: 60000 }, async () => {
 const dir = mkdtempSync(path.join(tmpdir(), "syncord-privacy-electron-"));
 try {
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "syncord-privacy-probe", main: "main.cjs" }));
  const certificate = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"), "-subj", "/CN=discord.com", "-days", "1"], { encoding: "utf8" });
  assert.equal(certificate.status, 0, certificate.stderr);
  await build({ stdin: { resolveDir: process.cwd(), contents: `
   import { app, session } from 'electron';
   import https from 'node:https';
   import fs from 'node:fs';
   import { installCrashPrivacy, privacyStatus } from './src/main/security/privacy';
   import { attachSession } from './src/main/security/session';
   app.setPath('userData', ${JSON.stringify(path.join(dir, "data"))});
   app.commandLine.appendSwitch('host-resolver-rules', 'MAP discord.com 127.0.0.1');
   app.commandLine.appendSwitch('no-proxy-server');
   installCrashPrivacy(); installCrashPrivacy();
   const crashReporter = require('electron').crashReporter;
   const guardInstalled = privacyStatus(false).nativeCrashGuard;
   crashReporter.start({submitURL:'http://127.0.0.1:1/upload',uploadToServer:true});
   crashReporter.setUploadToServer(true);
   const parameters = crashReporter.getParameters();
   app.whenReady().then(async () => {
    session.defaultSession.setCertificateVerifyProc((request,callback)=>callback(request.hostname==='discord.com'?0:-3));
    let hits=[];
    const server=https.createServer({key:fs.readFileSync(${JSON.stringify(path.join(dir, "key.pem"))}),cert:fs.readFileSync(${JSON.stringify(path.join(dir, "cert.pem"))})},(req,res)=>{hits.push(req.url);res.writeHead(200,{'cache-control':'public, max-age=3600'});res.end('local');});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=server.address().port;
    // Prime a telemetry SDK resource before installing the filter: upgrades
    // must also stop a reporter that was cached by an older client.
    const cachedScript='https://discord.com:'+port+'/assets/sentry.cached.js';
    await (await session.defaultSession.fetch(cachedScript)).text();
    ${process.env.SYNCORD_PRIVACY_NEGATIVE_CONTROL ? "" : "attachSession(session.defaultSession); attachSession(session.defaultSession);"}
    let blocked=0;
    try { await session.defaultSession.fetch(cachedScript); } catch { blocked++; }
    for(const route of ['/api/v9/science','/api/v9/beaker','/api/v9/metrics/v2','/error-reporting-proxy/web','/assets/sentry.abc.js']) {
     try { await session.defaultSession.fetch('https://discord.com:'+port+route); } catch { blocked++; }
    }
    const response=await session.defaultSession.fetch('https://discord.com:'+port+'/api/v9/channels/123/messages');
    // A different real session uses the same policy without replacing its protocol handler.
    const alternate=session.fromPartition('privacy-test'); alternate.setCertificateVerifyProc((request,callback)=>callback(request.hostname==='discord.com'?0:-3)); ${process.env.SYNCORD_PRIVACY_NEGATIVE_CONTROL ? "" : "attachSession(alternate);"}
    try { await alternate.fetch('https://discord.com:'+port+'/api/v9/science'); } catch { blocked++; }
    console.log('PRIVACY_RESULT '+JSON.stringify({guardInstalled,flag:process.env.ELECTRON_ENABLE_STACK_DUMPING,parameters,blocked,hits,status:response.status,privacy:privacyStatus(true)}));
    server.close(); app.exit(0);
   }).catch(error=>{console.error(error);app.exit(1);});
  ` }, outfile: path.join(dir, "main.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "silent" });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(executable, [dir, "--no-sandbox"], { env, encoding: "utf8", timeout: 45000, maxBuffer: 1024 * 1024 });
  const output = result.stdout + result.stderr;
  assert.equal(result.error, undefined, output); assert.equal(result.status, 0, output);
  const match = output.match(/PRIVACY_RESULT (.+)/); assert.ok(match, output);
  const r = JSON.parse(match[1]); assert.equal(r.guardInstalled, true); assert.equal(r.flag, "true");
  assert.equal(r.blocked, 7); assert.deepEqual(r.hits, ["/assets/sentry.cached.js", "/api/v9/channels/123/messages"]); assert.equal(r.status, 200);
  assert.equal(r.privacy.blocked.analytics, 3); assert.equal(r.privacy.blocked.metrics, 1);
  assert.equal(r.privacy.blocked.crashReports, 1); assert.equal(r.privacy.blocked.sentryScript, 2);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
