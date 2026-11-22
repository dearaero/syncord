import {loadBadgeImage,type BadgeImageResolver} from '../../api/ecosystem/art';
const loading=new WeakSet<HTMLImageElement>();
/** Only Syncord-owned image placeholders are hydrated, with no global observer. */
export function hydrateBadgeImages(root:ParentNode,resolve?:BadgeImageResolver):void{
 if(!resolve)return;
 for(const node of root.querySelectorAll<HTMLImageElement>('img[data-syncord-badge-image]')){
  const image=node.dataset.syncordBadgeImage;if(!image||loading.has(node)||node.dataset.syncordBadgeLoaded===image)continue;
  loading.add(node);
  void loadBadgeImage(image,resolve).then(data=>{if(node.isConnected&&node.dataset.syncordBadgeImage===image){node.src=data;node.dataset.syncordBadgeLoaded=image;}},()=>{}).finally(()=>loading.delete(node));
 }
}
