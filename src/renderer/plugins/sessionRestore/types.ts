export type SessionScrollState = {
    /** Absolute scrollTop at capture time. Used only as a fallback. */
    top: number;
  
    /** Distance from the bottom at capture time. */
    bottom: number;
  
    /** Whether the user was effectively at the newest message. */
    atBottom: boolean;
  
    /** First visible message at capture time. */
    anchorMessageId?: string;
  
    /**
     * Pixel offset between the anchor message's top edge and the chat
     * scroller's top edge. This lets restore reproduce the exact viewport
     * position instead of merely centering the message.
     */
    anchorOffset?: number;
  };
  
  export type SessionSnapshot = {
    version: 1;
    savedAt: number;
  
    /** Discord route, e.g. /channels/<guild>/<channel>. */
    route: string;
  
    guildId?: string;
    guildName?: string;
  
    channelId?: string;
    channelName?: string;
  
    /** Best-effort unsent composer text. */
    draft?: string;
  
    /** Best-effort message scroller state. */
    scroll?: SessionScrollState;
  };
  