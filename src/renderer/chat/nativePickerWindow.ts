/** Native virtualized pickers must measure after their styles are available. */
export async function copyNativePickerStyles(source:Document,target:Document,signal:AbortSignal):Promise<void>{
  if(signal.aborted)throw new DOMException('Picker closed','AbortError');
  const origin=source.location.origin;
  const pending:Promise<void>[]=[];
  for(const sheet of source.querySelectorAll('style,link[rel="stylesheet"]')){
    if(sheet instanceof HTMLLinkElement){
      const url=new URL(sheet.href);if(url.origin!==origin||!url.pathname.startsWith('/assets/'))continue;
      const clone=sheet.cloneNode(true) as HTMLLinkElement;
      pending.push(new Promise((resolve,reject)=>{
        const finish=(ok:boolean)=>{signal.removeEventListener('abort',failed);clearTimeout(timer);clone.removeEventListener('load',loaded);clone.removeEventListener('error',failed);ok?resolve():reject(Error('Native picker stylesheet unavailable'));};
        const loaded=()=>finish(true),failed=()=>finish(false),timer=setTimeout(failed,1500);
        signal.addEventListener('abort',failed,{once:true});clone.addEventListener('load',loaded,{once:true});clone.addEventListener('error',failed,{once:true});target.head.append(clone);if(clone.sheet)finish(true);
      }));
    }else target.head.append(sheet.cloneNode(true));
  }
  await Promise.all(pending);
  // Font loading must not retain a closed popup or delay native startup forever.
  if(signal.aborted)throw new DOMException('Picker closed','AbortError');
  await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();},timer=setTimeout(finish,250);signal.addEventListener('abort',finish,{once:true});void target.fonts.ready.then(finish);});
}
