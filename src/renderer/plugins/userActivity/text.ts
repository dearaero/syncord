import {localizeKnown,t} from '../../i18n';
import type {ActivityNotice} from './types';

const summaries:Readonly<Record<string,string>>={
 'Server profile photo changed':'activity.server_photo_changed',
 'Profile photo changed':'activity.photo_changed',
 'Activity / custom status changed':'activity.status_changed',
 'Activity ended':'activity.ended',
 'Left voice channel':'activity.voice_left',
 'Joined / moved voice channel':'activity.voice_joined',
 'Voice, camera or stream state changed':'activity.voice_state_changed',
 'Deleted a message':'activity.message_deleted',
 'Edited a message':'activity.message_edited',
 'Sent a message':'activity.message_sent',
};
/** Stored summaries belong to Syncord; message content and names remain literal. */
export function formatActivityText(notice:Pick<ActivityNotice,'kind'|'text'>):string {
 const source=notice.text;
 if(notice.kind==='presence')return source.split(' → ').map(localizeKnown).join(' → ');
 const key=Object.hasOwn(summaries,source)?summaries[source]:undefined;
 if(key)return t(key);
 if(notice.kind==='profile'){
  for(const [prefix,message]of [['Username changed to ','activity.username_changed'],['Display name changed to ','activity.display_name_changed']] as const){
   if(source.startsWith(prefix))return t(message,{name:source.slice(prefix.length)});
  }
 }
 return localizeKnown(source);
}
