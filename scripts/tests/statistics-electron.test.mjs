/** Real Electron process metrics and CDP traffic; all requests stay on loopback. */
import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,existsSync,mkdirSync} from 'node:fs';
import path from 'node:path';import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';import {build} from 'esbuild';
const executable=path.resolve('node_modules/electron/dist',process.platform==='darwin'?'Electron.app/Contents/MacOS/Electron':process.platform==='win32'?'electron.exe':'electron');
test('statistics in real Electron: native process metrics, cache, fixed storage and real HTTPS/WebSocket traffic',{skip:!existsSync(executable),timeout:60000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-statistics-native-'));
 try {
  for(const folder of ['data/Syncord','videos/Syncord Recordings'])mkdirSync(path.join(dir,folder),{recursive:true});
  writeFileSync(path.join(dir,'data/Syncord/test.json'),'123456');writeFileSync(path.join(dir,'videos/Syncord Recordings/test.webm'),'1234');
  writeFileSync(path.join(dir,'integrity.manifest.json'),'{}');
  writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'statistics-native-test',main:'main.cjs'}));
  const cert=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem'),'-subj','/CN=127.0.0.1','-days','1'],{encoding:'utf8'});assert.equal(cert.status,0,cert.stderr);
  await build({stdin:{resolveDir:process.cwd(),contents:`
   import {app,BrowserWindow,session,net} from 'electron';
   import fs from 'node:fs';import https from 'node:https';import crypto from 'node:crypto';
   import {installStatistics,statisticsSnapshot,statisticsStorage} from './src/main/statistics';
   import {networkStatistics,measureSubmittedUpload} from './src/main/statistics/network';
   app.setPath('userData',${JSON.stringify(path.join(dir,'data'))});app.setPath('videos',${JSON.stringify(path.join(dir,'videos'))});
   process.on('uncaughtException',error=>{console.error('STATISTICS_UNCAUGHT',error);app.exit(1);});
   app.on('window-all-closed',()=>{});
   app.commandLine.appendSwitch('no-proxy-server');installStatistics();installStatistics();
   app.whenReady().then(async()=>{
    const ses=session.defaultSession;
    ses.setCertificateVerifyProc((r,cb)=>cb(r.hostname==='127.0.0.1'?0:-3));
    const sockets=new Set();let requests=0;
    const server=https.createServer({key:fs.readFileSync(${JSON.stringify(path.join(dir,'key.pem'))}),cert:fs.readFileSync(${JSON.stringify(path.join(dir,'cert.pem'))})},(req,res)=>{
     requests++;req.resume();res.writeHead(200,{'access-control-allow-origin':'https://discord.com','cache-control':'no-store','content-type':'text/plain'});res.end('x'.repeat(8192));
    });
    server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
    server.on('upgrade',(req,socket)=>{
     const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
     socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');
     socket.on('error',()=>{});socket.on('data',()=>{});
     const text=Buffer.from('hello🙂');socket.write(Buffer.concat([Buffer.from([0x81,text.length]),text]));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
    ses.protocol.handle('https',req=>new URL(req.url).hostname==='discord.com'?new Response('<!doctype html><title>Statistics fixture</title>',{headers:{'content-type':'text/html'}}):net.fetch(req,{bypassCustomProtocolHandlers:true}));
    ses.webRequest.onBeforeRequest((details,cb)=>{measureSubmittedUpload(details.webContentsId,details.uploadData);cb({});});
    const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,backgroundThrottling:false}});
    await win.loadURL('https://discord.com/channels/@me');
    await new Promise(r=>setTimeout(r,50));
    const renderer=await win.webContents.executeJavaScript('('+async function(port){
     const response=await fetch('https://127.0.0.1:'+port+'/bytes',{method:'POST',body:'upload-test'});const text=await response.text();
     const ws=await new Promise((resolve,reject)=>{const ws=new WebSocket('wss://127.0.0.1:'+port+'/socket');ws.onmessage=()=>{ws.send('hello');resolve(ws);};ws.onerror=()=>reject(Error('WebSocket failed'));});
     globalThis.statisticsSocket=ws;return text.length;
    }.toString()+')('+port+')');
    await new Promise(r=>setTimeout(r,100));
    let bodyMetadataBytes=0,bodyEntryBytes=0;
    const inspect=(_event,method,p)=>{if(method!=='Network.requestWillBeSent'||p.request?.method!=='POST')return;bodyMetadataBytes+=p.request.postData?.length??0;bodyEntryBytes+=(p.request.postDataEntries??[]).reduce((n,row)=>n+(row.bytes?.length??0),0);};
    win.webContents.debugger.on('message',inspect);
    const largeBytes=4*1024*1024;
    const largeResponse=await win.webContents.executeJavaScript('fetch("https://127.0.0.1:'+port+'/large",{method:"POST",body:"x".repeat('+largeBytes+')}).then(r=>r.text()).then(s=>s.length)');
    await new Promise(r=>setTimeout(r,50));
    win.webContents.debugger.removeListener('message',inspect);
    await win.webContents.executeJavaScript('('+async function(port){for(let i=0;i<520;i+=4)await Promise.all(Array.from({length:4},(_,j)=>fetch('https://127.0.0.1:'+port+'/small/'+(i+j)).then(r=>r.text())));await new Promise(r=>setTimeout(r,50));globalThis.statisticsSocket.send('after');}.toString()+')('+port+')');
    await new Promise(r=>setTimeout(r,50));
    const traffic=networkStatistics(),first=statisticsSnapshot(),same=statisticsSnapshot();
    await new Promise(r=>setTimeout(r,1050));const end=performance.now()+50;while(performance.now()<end){}const second=statisticsSnapshot();
    const a=statisticsStorage(),b=statisticsStorage(),shared=a===b,storage=await a,cached=await statisticsStorage();
    const contents=win.webContents;win.destroy();
    await new Promise(r=>setTimeout(r,60));
    const retired=networkStatistics();
    const splash=new BrowserWindow({show:false});await splash.loadURL('about:blank');splash.destroy();
    await new Promise(r=>setTimeout(r,60));
    console.log('STATISTICS_NATIVE '+JSON.stringify({renderer,requests,largeBytes,largeResponse,bodyMetadataBytes,bodyEntryBytes,traffic,first,second,cache:first===same,storage,shared,storageCache:storage===cached,destroyed:contents.isDestroyed(),retired,afterSplash:networkStatistics()}));
    for(const socket of sockets)socket.destroy();server.close();app.exit(0);
   }).catch(error=>{console.error(error);app.exit(1);});
  `},outfile:path.join(dir,'main.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],logLevel:'silent'});
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result=spawnSync(executable,[dir,'--no-sandbox'],{env,encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024});const output=result.stdout+result.stderr;
  assert.equal(result.error,undefined,output);assert.equal(result.status,0,output);const match=output.match(/STATISTICS_NATIVE (.+)/);assert.ok(match,output);const r=JSON.parse(match[1]);
  assert.equal(r.renderer,8192);assert.equal(r.requests,522);assert.equal(r.largeResponse,8192);assert.equal(r.bodyMetadataBytes,0);assert.equal(r.bodyEntryBytes,0);assert.equal(r.traffic.activeTargets,1);assert.ok(r.traffic.httpReceived>=8192,JSON.stringify(r.traffic));assert.equal(r.traffic.httpSubmitted,11+r.largeBytes);assert.equal(r.traffic.wsReceived,9);assert.equal(r.traffic.wsSent,10);assert.ok(r.traffic.gaps>=1);assert.equal(r.traffic.activeSockets,1);
  assert.ok(r.first.resources.available);assert.ok(r.first.resources.memoryBytes>0);assert.ok(r.first.resources.processes.some(p=>p.pid>0&&p.kind==='Browser'));assert.equal(r.cache,true);assert.ok(r.second.uptimeSeconds>r.first.uptimeSeconds);assert.ok(r.second.resources.cpuPercent>=0);assert.equal(r.first.build.id,cryptoHash('{}'));
  assert.equal(r.shared,true);assert.equal(r.storageCache,true);assert.equal(r.destroyed,true);assert.equal(r.retired.activeTargets,0);assert.equal(r.retired.httpReceived,r.traffic.httpReceived);assert.equal(r.afterSplash.httpReceived,r.retired.httpReceived);
  assert.equal(r.storage.syncord.bytes,6);assert.equal(r.storage.recordings.bytes,4);assert.ok(!JSON.stringify(r.storage).includes(dir));
 } finally {rmSync(dir,{recursive:true,force:true});}
});
function cryptoHash(value){return (crypto.createHash('sha256').update(value).digest('hex')).slice(0,12);}
