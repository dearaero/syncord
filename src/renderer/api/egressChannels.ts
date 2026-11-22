/**
 * Egress IPC channel names, kept in one place so the renderer-side reporter and
 * the preload cannot drift apart.
 */
export const IPC_CHANNELS = {
  /** Renderer → main: "a direct egress attempt was refused". */
  REPORT_EGRESS: "Syncord_REPORT_EGRESS",
} as const;
