import {SUPPORTER_IPC,badgeBytes,type SupporterBridge} from '../shared/supporter';
/** Private constructor; only the fixed typed methods below reach the page bridge. */
export function supporterBridge(invoke:(channel:string,...args:unknown[])=>Promise<unknown>):SupporterBridge {
 return {
  status:account=>invoke(SUPPORTER_IPC.STATUS,account) as ReturnType<SupporterBridge['status']>,
  create:(account,input,key)=>invoke(SUPPORTER_IPC.CREATE,account,input,key) as ReturnType<SupporterBridge['create']>,
  edit:(account,m,input)=>invoke(SUPPORTER_IPC.EDIT,account,m,input) as ReturnType<SupporterBridge['edit']>,
  upload:(account,m,bytes)=>invoke(SUPPORTER_IPC.UPLOAD,account,m,badgeBytes(bytes).slice()) as ReturnType<SupporterBridge['upload']>,
  submit:(account,m)=>invoke(SUPPORTER_IPC.SUBMIT,account,m) as ReturnType<SupporterBridge['submit']>,
  remove:(account,m)=>invoke(SUPPORTER_IPC.DELETE,account,m) as ReturnType<SupporterBridge['remove']>,
  activate:(account,ids,key)=>invoke(SUPPORTER_IPC.ACTIVE,account,ids,key) as ReturnType<SupporterBridge['activate']>,
  preview:(account,id)=>invoke(SUPPORTER_IPC.PREVIEW,account,id) as ReturnType<SupporterBridge['preview']>,
 };
}
