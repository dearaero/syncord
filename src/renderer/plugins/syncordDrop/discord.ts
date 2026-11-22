import {getChannel,currentUserId,channelTitle,channelSendError} from '../multiChatCanvas/discord';
import {ecoAccount} from '../../../shared/ecosystem';
/** The selected channel is never a fallback: the menu's pinned channel ID owns
 * the recipient, including menus opened from Canvas or another conversation. */
export function dm(channelId:string,account:string):{id:string;name:string}{
 if(currentUserId()!==account)throw Error('drop.cancelled');const channel=getChannel(channelId);
 if(!channel||channel.type!==1||!Array.isArray(channel.recipients)||channel.recipients.length!==1||channelSendError(channelId))throw Error('drop.dm_only');
 const recipient=ecoAccount(channel.recipients[0]);if(recipient===account)throw Error('drop.dm_only');return{id:recipient,name:channelTitle(channelId).title};
}
