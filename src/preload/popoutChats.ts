/** Chat utility UI runs in the isolated preload world. No page-world bridge is exposed. */
import {ipcRenderer} from "electron";
import {POPOUT_IPC,isPopoutAsset,chatStickerUrl,type ChatAction,type ChatState} from "../shared/popoutChats";
import {MULTICHAT_CSS} from "../renderer/plugins/multiChatCanvas/styles";
const CSS=`
:root{color-scheme:dark;font:14px system-ui;background:#313338;color:#dbdee1}*{box-sizing:border-box}body{margin:0;height:100vh;overflow:hidden}button,textarea,input{font:inherit}button{cursor:pointer;border:0;color:inherit;background:transparent;border-radius:5px;padding:7px}button:hover{background:#80848e33}button:focus-visible,textarea:focus-visible{outline:2px solid #5865f2}button:disabled{opacity:.5;cursor:default}
#Syncord-popout-root{position:static!important;inset:auto!important;width:100%;height:100vh;display:flex!important;flex-direction:column!important;background:var(--mc-bg)!important;border:0!important;border-radius:0!important;padding:0!important;box-shadow:none!important;z-index:auto!important;--mc-bg:#313338;--mc-text:#dbdee1;--mc-header:#f2f3f5;--mc-muted:#949ba4;--mc-input:#383a40}
html.light{color-scheme:light;background:#fff;color:#313338}html.light #Syncord-popout-root{--mc-bg:#fff;--mc-text:#313338;--mc-header:#060607;--mc-muted:#5c5e66;--mc-input:#ebedef;--mc-bg-secondary:#f2f3f5;--mc-hover:#00000008}
#popout-header{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid #80848e33;min-height:40px}#popout-header button{padding:5px;flex-shrink:0}#popout-avatar{width:26px;height:26px;border-radius:50%;object-fit:cover}#popout-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--mc-header)}#pin[aria-pressed=true]{color:#5865f2}
#history{display:flex;justify-content:space-between;align-items:center;padding:0 10px}#history-status{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mc-muted);font-size:12px}#chat-messages{min-height:0;flex:1;overflow:auto;overflow-anchor:none;overscroll-behavior:contain;padding:8px 0;scrollbar-width:thin}#messages-list{list-style:none;margin:0;padding:0 0 12px}#composer{padding:8px 10px;flex:none}#draft{border:0;resize:none;width:100%;min-height:48px;max-height:150px;background:var(--mc-input);color:var(--mc-text);border-radius:8px;padding:10px;display:block}#composer-tools{display:flex;align-items:center;gap:2px;padding-top:5px}#send{margin-inline-start:auto;background:#5865f2;color:white;padding:6px 13px}#reply-strip,#attachment-strip{display:flex;align-items:center;gap:5px;color:var(--mc-muted);font-size:12px;padding:3px 0}#reply-text,#attachment-text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#error{color:#f27e88;font-size:12px;white-space:pre-wrap;margin:4px 0}#error:empty{display:none}video{max-width:100%}a{color:#00a8fc}#chat-messages .dion-mc-message{min-width:0}#chat-messages img{max-width:100%}

/* Utility-only refinements leave the shared Canvas message layout intact. */
#Syncord-popout-root{--mc-bg-secondary:#2b2d31;--mc-border:#80848e29;--mc-hover:#80848e14;--popout-accent:#5865f2;--popout-chrome:#2b2d31}
html.light #Syncord-popout-root{--mc-bg-secondary:#f2f3f5;--mc-border:#06060714;--mc-hover:#06060708;--popout-chrome:#f9f9fb}
button{border-radius:8px;transition:background-color 120ms ease,color 120ms ease,box-shadow 120ms ease}button:focus-visible,textarea:focus-visible{outline-offset:2px}
#popout-header{min-height:50px;padding:9px 14px;gap:10px;background:var(--popout-chrome);border-bottom:1px solid var(--mc-border)}
#popout-avatar{width:30px;height:30px;box-shadow:0 0 0 1px var(--mc-border)}#popout-title{font-size:14px;letter-spacing:.1px}
#popout-header button{display:grid;place-items:center;width:30px;height:30px;color:var(--mc-muted)}#pin[aria-pressed=true]{color:var(--popout-accent);background:#5865f21f}
#history{min-height:32px;gap:8px;padding:3px 14px}#latest{flex-shrink:0;font-size:11px;font-weight:600;color:var(--mc-muted);padding:4px 9px;border:1px solid var(--mc-border);border-radius:20px}#latest:hover{color:var(--mc-header)}
#chat-messages{scrollbar-color:var(--mc-bg-secondary) transparent;padding-top:6px}#chat-messages:focus-visible{outline:2px solid var(--popout-accent);outline-offset:-2px}
#chat-messages .dion-mc-message-actions{border-color:var(--mc-border);border-radius:8px;box-shadow:0 2px 8px #00000026}
#chat-messages .dion-mc-message-action{width:28px;height:28px;padding:4px;display:grid;place-items:center}#chat-messages .dion-mc-message-action svg{width:18px;height:18px}
#composer{margin:6px 10px 10px;padding:0;background:var(--mc-input);border:1px solid var(--mc-border);border-radius:12px;box-shadow:0 2px 6px #0000000a;transition:border-color 120ms ease}
#composer:focus-within{border-color:#5865f280}#draft{background:transparent;border-radius:12px 12px 0 0;padding:12px;min-height:60px;font-size:14px;line-height:20px}#draft:focus-visible{outline:0}#draft::placeholder{color:var(--mc-muted);opacity:1}
#composer-tools{gap:3px;padding:6px 8px;border-top:1px solid var(--mc-border)}#composer-tools button:not(#send){width:30px;height:30px;display:grid;place-items:center;padding:5px;color:var(--mc-muted)}#composer-tools button:not(#send):hover{color:var(--mc-header)}
#composer-tools svg{width:20px;height:20px;display:block;flex-shrink:0}#send{font-size:12px;font-weight:600;min-height:30px;padding:6px 12px;max-width:50%;white-space:normal;overflow-wrap:anywhere}#send:hover:not(:disabled){background:#4752c4;box-shadow:0 2px 6px #00000026}
#reply-strip,#attachment-strip{margin:0 10px;padding:6px 0;border-bottom:1px solid var(--mc-border)}#reply-strip[hidden],#attachment-strip[hidden]{display:none}#error:not(:empty){margin:8px 10px;padding:8px;border-radius:6px;background:#f27e8812}
#sticker-previews{display:flex;gap:6px;flex-shrink:0;max-width:50%;overflow:hidden}#sticker-previews img{width:48px;height:48px;object-fit:contain}#sticker-previews span{max-width:96px;overflow:hidden;text-overflow:ellipsis}
@media(prefers-reduced-motion:reduce){button,#composer{transition:none}}
`; 
export function bootstrapPopoutChats():void {
  window.addEventListener('DOMContentLoaded',()=>{void boot();},{once:true});
}
async function boot():Promise<void>{
  const root=document.getElementById('Syncord-popout-root');if(!root)return;
  const style=document.createElement('style');style.textContent=MULTICHAT_CSS.replaceAll('#Syncord-multichat-root','#Syncord-popout-root')+CSS;document.head.append(style);
  root.innerHTML=`<header id="popout-header"><img id="popout-avatar" alt="" hidden><span id="popout-title"></span><button id="pin" aria-pressed="false">♧</button></header><nav id="history"><span id="history-status" role="status"></span><button id="latest"></button></nav><section id="chat-messages" role="log" aria-live="off" tabindex="0"><ol id="messages-list"></ol></section><form id="composer"><div id="reply-strip" hidden><span id="reply-text"></span><button id="cancel-reply" type="button">×</button></div><div id="attachment-strip" hidden><span id="attachment-text"></span><button id="clear-files" type="button">×</button></div><p id="error" role="alert"></p><textarea id="draft" maxlength="4000" rows="2"></textarea><div id="composer-tools"><button id="attach" type="button">＋</button><button id="emoji" type="button">☺</button><button id="gif" type="button">GIF</button><button id="sticker" type="button">▧</button><button id="send" type="submit"></button></div><input id="file" type="file" multiple hidden></form>`;
  const get=<T extends HTMLElement>(id:string):T=>{const el=document.getElementById(id);if(!el)throw Error('Missing chat element');return el as T;};
  const stickerPreviews=document.createElement('span');stickerPreviews.id='sticker-previews';get('attachment-strip').prepend(stickerPreviews);
  const input=get<HTMLTextAreaElement>('draft'),list=get('messages-list'),scroller=get('chat-messages'),error=get('error'),files=get<HTMLInputElement>('file');
  let state:ChatState|undefined,version=-1,composing=false,closed=false,submitting=false,lastHtml='',lastStickers='',olderPending=false,olderAccepted=false,olderRequestHtml='',previousScrollTop=0,forceBottom=false;
  const send=(action:ChatAction):Promise<unknown>=>ipcRenderer.invoke(POPOUT_IPC.ACTION,action);
  const run=(action:ChatAction):void=>{void send(action).catch(()=>{if(state)error.textContent=state.labels.failed;});};
  const requestOlder=():void=>{
    if(closed||!state?.older||state.historyLoading||olderPending||scroller.scrollTop>120)return;
    olderPending=true;olderAccepted=false;olderRequestHtml=lastHtml;get<HTMLButtonElement>('latest').disabled=true;
    void send({kind:'older'}).catch(()=>{olderPending=false;get<HTMLButtonElement>('latest').disabled=false;if(state)error.textContent=state.labels.failed;});
  };
  const nearBottom=():boolean=>scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop<90;
  const updateButtons=():void=>{get<HTMLButtonElement>('send').disabled=Boolean(submitting||state?.busy);input.disabled=Boolean(submitting||state?.busy);for(const id of ['attach','emoji','gif','sticker','clear-files'])get<HTMLButtonElement>(id).disabled=input.disabled;};
  const sanitize=(html:string):DocumentFragment=>{
    const template=document.createElement('template');template.innerHTML=html;
    const allowed=new Set(['LI','ARTICLE','DIV','SPAN','TIME','H3','BUTTON','SVG','PATH','IMG','A','VIDEO','SOURCE','AUDIO','BR','STRONG','EM','S','DEL','CODE','PRE','BLOCKQUOTE']);
    for(const el of [...template.content.querySelectorAll('*')]){
      if(!allowed.has(el.tagName.toUpperCase())){el.remove();continue;}
      for(const a of [...el.attributes])if(a.name.startsWith('on')||['id','style','srcset','formaction','download','autofocus'].includes(a.name))el.removeAttribute(a.name);
      if(el instanceof HTMLButtonElement)el.type='button';
      if(el.hasAttribute('href')){const href=el.getAttribute('href')??'';if(!/^https?:\/\//i.test(href))el.removeAttribute('href');}
      if(el.hasAttribute('src')){try{const url=new URL(el.getAttribute('src')??'');if(!isPopoutAsset(url.href))el.removeAttribute('src');}catch{el.removeAttribute('src');}}
    }
    return template.content;
  };
  const paint=(next:ChatState):void=>{
    if(closed)return;if(next.historyLoading&&olderPending)olderAccepted=true;state=next;submitting=next.busy;
    document.documentElement.classList.toggle('light',next.light);document.documentElement.lang=next.locale;document.documentElement.dir=next.locale==='fa'?'rtl':'ltr';document.title=next.title;
    get('popout-title').textContent=next.title;
    const avatar=get<HTMLImageElement>('popout-avatar');avatar.hidden=!next.avatar;if(next.avatar&&isPopoutAsset(next.avatar))avatar.src=next.avatar;
    for(const id of ['pin','latest','attach','emoji','gif','sticker','send','cancel-reply','clear-files']){
      const label=next.labels[id];if(label){get(id).title=label;get(id).setAttribute('aria-label',label);if(['latest','send'].includes(id))get(id).textContent=label;}
    }
    input.placeholder=next.labels.message??'';input.setAttribute('aria-label',next.labels.message??next.title);
    if(next.draftVersion!==version&&!composing){input.value=next.draft;version=next.draftVersion;}
    if(next.html!==lastHtml){
      const bottom=forceBottom||(!olderPending&&!next.historyLoading&&nearBottom()),oldTop=scroller.scrollTop,anchor=[...list.querySelectorAll<HTMLElement>(':scope > [data-mc-message-id]')].find(el=>el.getBoundingClientRect().bottom>scroller.getBoundingClientRect().top),id=anchor?.getAttribute('data-mc-message-id'),offset=anchor?.getBoundingClientRect().top;
      list.replaceChildren(sanitize(next.html));lastHtml=next.html;
      // Static/animated image stickers share the same bounded CDN path. Lottie has a readable fallback.
      for(const placeholder of list.querySelectorAll<HTMLElement>('[data-mc-sticker-preview]')){
        const id=placeholder.dataset.mcStickerPreview;if(!id||!/^\d{5,22}$/.test(id))continue;
        if(placeholder.dataset.stickerFormat==='3'){placeholder.textContent=placeholder.dataset.stickerName??'';continue;}
        const image=document.createElement('img');image.src=`https://media.discordapp.net/stickers/${id}.${placeholder.dataset.stickerFormat==='4'?'gif':'png'}?size=160`;image.alt=placeholder.dataset.stickerName??'';image.loading='lazy';image.style.maxHeight='160px';placeholder.append(image);
      }
      const same=id?[...list.children].find(el=>el.getAttribute('data-mc-message-id')===id):undefined;
      if(bottom)scroller.scrollTop=scroller.scrollHeight;else if(same&&offset!==undefined)scroller.scrollTop=oldTop+same.getBoundingClientRect().top-offset;
    }
    get('reply-strip').hidden=!next.reply;get('reply-text').textContent=next.reply;
    get('attachment-strip').hidden=!next.attachments&&!next.stickers?.length;get('attachment-text').textContent=next.attachments;
    const stickerSignature=JSON.stringify(next.stickers??[]);
    if(stickerSignature!==lastStickers){
      lastStickers=stickerSignature;stickerPreviews.replaceChildren();
      for(const sticker of next.stickers??[]){
        const preview=document.createElement('span'),url=chatStickerUrl(sticker);preview.title=sticker.name;
        if(url){const image=document.createElement('img');image.src=url;image.alt=sticker.name;image.addEventListener('error',()=>{preview.textContent=sticker.name;},{once:true});preview.append(image);}else preview.textContent=sticker.name;
        stickerPreviews.append(preview);
      }
    }
    error.textContent=next.error;
    if(olderPending&&!next.historyLoading&&(olderAccepted||next.html!==olderRequestHtml||!next.older)){olderPending=false;olderAccepted=false;}
    scroller.setAttribute('aria-busy',String(Boolean(next.historyLoading)));
    get('history-status').textContent=next.historyLoading?(next.labels.loading??''):'';
    get<HTMLButtonElement>('latest').disabled=Boolean(next.historyLoading||olderPending);
    if(forceBottom){scroller.scrollTop=scroller.scrollHeight;forceBottom=false;}
    previousScrollTop=scroller.scrollTop;updateButtons();
  };
  const listener=(_e:unknown,next:ChatState):void=>paint(next);ipcRenderer.on(POPOUT_IPC.STATE,listener);
  for(const kind of ['cancel-reply','clear-files'] as const)get(kind).onclick=()=>run({kind});
  const pinIcon=document.createElementNS('http://www.w3.org/2000/svg','svg');pinIcon.setAttribute('viewBox','0 0 24 24');pinIcon.setAttribute('width','16');pinIcon.setAttribute('height','16');pinIcon.setAttribute('aria-hidden','true');const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('fill','currentColor');path.setAttribute('d','M16 9V4h1V2H7v2h1v5l-3 3v2h6v8h2v-8h6v-2l-3-3Z');pinIcon.append(path);get('pin').replaceChildren(pinIcon);
  const icons:Record<string,string>={
    attach:'<path d="M12 5v14M5 12h14"/>',
    emoji:'<circle cx="12" cy="12" r="9"/><path d="M8 14a4 4 0 0 0 8 0M8 9h.01M16 9h.01"/>',
    gif:'<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M8 9H5v6h3v-3H6M11 9v6M15 15V9h4M15 12h3"/>',
    sticker:'<path d="M14 21H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8Z"/><path d="M14 21v-4a3 3 0 0 1 3-3h4M8 8h.01M15 8h.01M8 11a4 4 0 0 0 6 1"/>',
  };
  for(const [id,markup] of Object.entries(icons)){const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('fill','none');icon.setAttribute('stroke','currentColor');icon.setAttribute('stroke-width','1.8');icon.setAttribute('stroke-linecap','round');icon.setAttribute('stroke-linejoin','round');icon.setAttribute('aria-hidden','true');icon.innerHTML=markup;get(id).replaceChildren(icon);}
  get('pin').onclick=()=>{void send({kind:'pin'}).then(on=>get('pin').setAttribute('aria-pressed',String(on))).catch(()=>undefined);};
  get('latest').onclick=()=>{forceBottom=true;scroller.scrollTop=scroller.scrollHeight;previousScrollTop=scroller.scrollTop;run({kind:'latest'});};
  input.addEventListener('compositionstart',()=>{composing=true;});input.addEventListener('compositionend',()=>{composing=false;run({kind:'draft',text:input.value});});
  input.oninput=()=>run({kind:'draft',text:input.value});
  input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!composing){e.preventDefault();get<HTMLFormElement>('composer').requestSubmit();}};
  get<HTMLFormElement>('composer').onsubmit=e=>{e.preventDefault();if(submitting||state?.busy||composing)return;submitting=true;updateButtons();void send({kind:'send',text:input.value}).catch(()=>{submitting=false;updateButtons();if(state)error.textContent=state.labels.failed;});};
  const add=async(selected:File[]):Promise<void>=>{for(const file of selected.slice(0,10)){try{if(file.size===0||file.size>25*1024*1024)throw Error('File limit');await send({kind:'file',file:{name:file.name,type:file.type,bytes:await file.arrayBuffer()}});}catch(reason){console.warn('[Syncord] Popout attachment rejected:',String(reason));if(state)error.textContent=state.labels['file-limit'];break;}}};
  get('attach').onclick=()=>files.click();files.onchange=()=>{void add([...files.files??[]]);files.value='';};
  input.onpaste=e=>{const selected=[...e.clipboardData?.files??[]];if(selected.length){e.preventDefault();void add(selected);}};
  root.ondragover=e=>{e.preventDefault();};root.ondrop=e=>{e.preventDefault();if(e.dataTransfer?.files.length)void add([...e.dataTransfer.files]);};
  for(const [id,picker] of [['emoji','Emoji'],['gif','GIF'],['sticker','Stickers']] as const)get(id).onclick=()=>run({kind:'picker',picker});
  list.onclick=e=>{const target=e.target instanceof Element?e.target:undefined;const reply=target?.closest<HTMLElement>('[data-mc-reply-message]');if(reply?.dataset.mcReplyMessage)run({kind:'reply',messageId:reply.dataset.mcReplyMessage});};
  document.addEventListener('click',e=>{const link=e.target instanceof Element?e.target.closest('a'):null;if(link?.href){e.preventDefault();run({kind:'link',url:link.href});}},true);
  let bottomOnImage=false;
  scroller.addEventListener('scroll',()=>{const top=scroller.scrollTop,upward=top<previousScrollTop;previousScrollTop=top;bottomOnImage=nearBottom();if(upward)requestOlder();});
  // Wheel also works when a short page has no scroll range yet. Programmatic
  // anchor restoration never starts a new request or drains the whole history.
  scroller.addEventListener('wheel',event=>{if(event.deltaY<0)requestOlder();},{passive:true});
  scroller.addEventListener('keydown',event=>{if(['ArrowUp','PageUp','Home'].includes(event.key))requestOlder();});
  list.addEventListener('load',()=>{if(bottomOnImage&&!olderPending&&!state?.historyLoading){scroller.scrollTop=scroller.scrollHeight;previousScrollTop=scroller.scrollTop;}},true);
  window.addEventListener('beforeunload',()=>{closed=true;ipcRenderer.removeListener(POPOUT_IPC.STATE,listener);},{once:true});
  const initial=await ipcRenderer.invoke(POPOUT_IPC.INIT) as ChatState|undefined;if(initial)paint(initial);
}
