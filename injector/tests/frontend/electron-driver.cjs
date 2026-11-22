/* Test-only Chromium host: wait for the real async harness to finish instead
 * of racing Chrome's virtual-time budget while local images are decoding. */
const {app,BrowserWindow}=require('electron');
const url=new URL(process.argv[2]);
if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw Error('Only the local frontend harness may be loaded');
app.whenReady().then(async()=>{
 const window=new BrowserWindow({show:false,width:1060,height:720,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
 try{
  await window.loadURL(url.href);
  const until=Date.now()+30000;
  while(Date.now()<until){
   const complete=await window.webContents.executeJavaScript('/\\d+\\/\\d+ passed/.test(document.getElementById("harness-out")?.textContent??"")');
   if(complete){console.log(await window.webContents.executeJavaScript('document.documentElement.outerHTML'));window.destroy();app.exit(0);return;}
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  console.error('Frontend harness did not finish');console.log(await window.webContents.executeJavaScript('document.documentElement.outerHTML'));window.destroy();app.exit(1);
 }catch(error){console.error(error.stack);window.destroy();app.exit(1);}
});
