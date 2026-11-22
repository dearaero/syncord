import {definePluginSettings} from '../../api/plugin/settingsDef';
import {t} from '../../i18n';
export const LONG_ID='long-messages';
export const longSettings=definePluginSettings({
 numbers:{type:'boolean',default:false,get title(){return t('long.numbers');}},
 confirmLarge:{type:'boolean',default:true,get title(){return t('long.confirmLarge');}},
 maxParts:{type:'number',default:15,get title(){return t('long.maxParts');}},
});
export function options(){const s=longSettings.bind(LONG_ID).snapshot();return {numbers:s.numbers===true,confirmLarge:s.confirmLarge!==false,maxParts:typeof s.maxParts==='number'&&Number.isInteger(s.maxParts)?Math.max(2,Math.min(30,s.maxParts)):15};}
