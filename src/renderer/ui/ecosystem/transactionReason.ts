import {t} from '../../i18n';
const reasons:Readonly<Record<string,string>>={
 'Badge purchase':'ui.badge_purchase',
 'Discord verification reward':'ui.discord_verification_reward',
 'Verified community contribution':'ui.verified_community_contribution',
};
/** Only the service's built-in ledger reasons are messages; custom rule names remain literal. */
export function transactionReason(reason:string):string {
 const key=Object.hasOwn(reasons,reason)?reasons[reason]:undefined;
 return key?t(key):reason;
}
