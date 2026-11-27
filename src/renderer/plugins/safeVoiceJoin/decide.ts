/** Pure decision for one click on a channel-list row; kept separate so it is testable without a DOM. */
export type ClickFacts={detail:number;voice:boolean;connected:boolean;onControl:boolean};
/**
 * `detail` 0 is a keyboard/synthetic activation (Enter), which is deliberate; 2+ is the second click of a double-click.
 * Clicking the channel you are already in only opens its view, and inner controls (invite, settings, chat) never join.
 */
export const shouldBlock=({detail,voice,connected,onControl}:ClickFacts):boolean=>voice&&!connected&&!onControl&&detail===1;
export const channelIdFromRow=(raw:string|null):string|undefined=>raw?.match(/^channels___(\d{15,22})$/)?.[1];
