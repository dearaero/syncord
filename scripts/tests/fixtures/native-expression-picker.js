// This fixture represents a cached native component. The production adapter must
// pass callbacks/state to it, rather than render its own media search/results.
export function installNativePickerFixture(emojiStore) {
  let state={activeView:null,activeViewType:null,activeChannelId:null,lastActiveView:null,searchQuery:''};
  const listeners=new Set();
  const store={getState:()=>state,setState:patch=>{state={...state,...patch};for(const listener of [...listeners])listener(state)},subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)}};
  window.nativePickerStore=store;
  window.nativePickerListeners=()=>listeners.size;
  window.nativePickerProps=undefined;
  window.nativeUnmounts=0;
  let layerContainer=null;
  const NativeExpressionPicker=({positionTargetRef,onSelectGIF,onSelectEmoji,onSelectSticker,hideGifFavorites,channel,type,positionLayerClassName})=>{
    // Discord App Layer's context defaults to [null, noop]; no provider/container
    // means the native picker silently renders nothing, rather than throwing.
    if (!layerContainer || window.nativeBlank) return null;
    window.nativePickerProps={positionTargetRef,onSelectGIF,onSelectEmoji,onSelectSticker,hideGifFavorites,channel,type};
    const layer=document.createElement('div');layer.className=positionLayerClassName??'fixture-native-position-layer';
    // Model Discord's positioning contract: the default alignment supplies
    // the opposite edge. Overriding the class drops it and collapses width.
    layer.style.cssText='position:absolute;right:8px;bottom:72px;height:min(200px,calc(100% - 90px));pointer-events:none';
    if(!positionLayerClassName)layer.style.left='8px';
    if(window.nativeDialogOffset)Object.assign(layer.style,{transform:'translateX(-12px)',translate:'-4px 0',marginLeft:'8px'});
    const dialog=document.createElement('section');dialog.setAttribute('role','dialog');dialog.dataset.nativeExpressionPicker='true';dialog.setAttribute('aria-label','Native Expression Picker');
    dialog.style.cssText='width:100%;height:100%;pointer-events:none';
    // Native PositionLayer may also position the dialog, not just its wrapper.
    // Leaving this composer gutter in a standalone child clips its left edge.
    if(window.nativeDialogOffset)Object.assign(dialog.style,{position:'absolute',inset:'0 24px 8px -24px',transform:'translateX(-8px)',translate:'-4px 0',marginLeft:'12px'});
    const drawer=document.createElement('div');drawer.dataset.nativeDrawer='true';
    drawer.style.cssText='position:absolute;right:0;top:0;width:min(440px,100%);height:100%;max-width:100%;pointer-events:auto;overflow:auto;background:#222;padding:10px;border-radius:8px';
    if(window.nativePanelWidth)drawer.style.width=`min(${window.nativePanelWidth}px,100%)`;
    const tabs=document.createElement('div');tabs.setAttribute('role','tablist');
    const search=document.createElement('input');search.type='search';search.setAttribute('aria-label','Native media search');
    const results=document.createElement('div');
    const button=(name,callback)=>{const el=document.createElement('button');el.type='button';el.textContent=name;el.setAttribute('aria-label',name);el.onclick=callback;return el};
    const render=()=>{
      results.replaceChildren();
      const view=store.getState().activeView;
      if(view==='emoji')for(const emoji of emojiStore.searchWithoutFetchingLatest({channel,query:search.value}).unlocked)results.append(button(emoji.name,()=>onSelectEmoji({emoji,willClose:!window.keepNativeEmojiOpen})));
      if(view==='gif'){
        if(window.nativeMediaAssets){
          const image=document.createElement('img');image.dataset.nativeGif='true';image.src='//static.klipy.com/fixture.gif';results.append(image);
          // Trending category tiles use Discord's media proxies, unlike the
          // direct Klipy URL used by the trending-video tile.
          for(const index of [1,2]){const category=document.createElement('img');category.dataset.nativeGifCategory=String(index);category.src=`//images-ext-${index}.discordapp.net/external/fixture/https/static.klipy.com/category.gif?format=webp&animated=true`;results.append(category);}
          const video=document.createElement('video');video.preload='auto';video.src='//c.tenor.com/fixture.webm';results.append(video);
        }
        results.append(button('Trending GIF',()=>onSelectGIF({url:'https://example.com/fast',id:'native-gif',provider:1})));
      }
      if(view==='sticker')for(const sticker of [{id:window.nativeStickerIds?.[0]??'222',name:'Wave',format_type:1},{id:window.nativeStickerIds?.[1]??'444',name:'Dance',format_type:3}])results.append(button(sticker.name,()=>onSelectSticker(sticker,0)));
    };
    for(const [view,label]of [['gif','GIF'],['sticker','Stickers'],['emoji','Emoji']])tabs.append(button(label,()=>{store.setState({activeView:view});render()}));
    search.oninput=()=>{store.setState({searchQuery:search.value});render()};
    drawer.append(tabs,search,results);
    const shell=window.nativeNestedOffset?document.createElement('div'):dialog;
    if(shell!==dialog)shell.style.cssText='position:absolute;inset:0;pointer-events:none;transform:translateX(-24px)';
    if(window.nativeSplitHeader){const header=document.createElement('div');header.dataset.nativeHeader='true';header.style.cssText='position:absolute;top:0;right:0;height:48px;pointer-events:auto;background:#222';header.style.width=drawer.style.width;drawer.style.top='48px';drawer.style.height='calc(100% - 48px)';shell.append(header);}
    shell.append(drawer);if(shell!==dialog)dialog.append(shell);layer.append(dialog);render();
    layer.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();store.setState({activeView:null,activeViewType:null,activeChannelId:null})}});
    queueMicrotask(()=>search.focus());
    layerContainer.append(layer);
    return null;
  };
  const component={type:{render:NativeExpressionPicker}};
  const LayerProvider=({children})=>children;
  LayerProvider.displayName='AppLayerProvider';
  const LayerContainer=({className})=>{layerContainer=document.createElement('div');layerContainer.className='fixture-app-layer-container '+className;return layerContainer};
  LayerContainer.displayName='AppLayerContainer';
  const layers={arbitraryProviderKey:LayerProvider,arbitraryContainerKey:LayerContainer};
  const React={useState:()=>{},createElement:(type,props,...children)=>({type,props:{...props,children:children.length>1?children:children[0]}}),Component:class{constructor(props){this.props=props}}};
  const createRoot=host=>({render:node=>{
    if(window.nativeRenderError)throw new Error('Native picker changed');
    layerContainer=null;
    const renderNode=value=>{
      if(Array.isArray(value))return value.flatMap(renderNode);
      if(value instanceof Node)return [value];
      if(!value?.type)return [];
      let type=value.type;
      if(type.prototype?.render)return renderNode(new type(value.props).render());
      while(type&&typeof type==='object')type=type.render??type.type;
      return renderNode(type(value.props));
    };
    host.replaceChildren(...renderNode(node));
  },unmount:()=>{host.replaceChildren();window.nativeUnmounts++}});
  return {component,store,layers,React,ReactDOM:{createRoot}};
}
