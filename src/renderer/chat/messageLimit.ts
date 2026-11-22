/** Read real entitlements without changing them. Unknown native shapes use 2000. */
export function accountLimit():number {
  const users=window.Syncord?.common?.stores.UserStore as {getCurrentUser?:()=>unknown}|undefined;
  const user=users?.getCurrentUser?.();
  const entitlement=window.Syncord?.webpack?.findByProps?.('canUseIncreasedMessageLength') as {canUseIncreasedMessageLength?:(user:unknown)=>boolean}|undefined;
  try{return user&&entitlement?.canUseIncreasedMessageLength?.(user)===true?4000:2000;}catch{return 2000;}
}
