import { t as i18nText } from "../../i18n";
import { getChannel } from "./discord";
import type { StickerLike } from "./types";

export type EmojiChoice = { id?: string; name: string; surrogates?: string; animated?: boolean; names?: string[] };
export type NativeUpload = {
  on(event: string, listener: (...args: number[]) => void): void;
  cancel(): void;
};
type UploadConstructor = new (item: { file: File; platform: number; isThumbnail: boolean }, channelId: string) => NativeUpload;
export function mediaError(error: unknown): string {
  if (error instanceof Error) return error.message;
  const value = error as { body?: { message?: string }; message?: string; status?: number } | undefined;
  return value?.body?.message ?? value?.message ?? (value?.status ? i18nText("ui.discord_returned_http_value_please_try_again", {v0: value.status}) : i18nText("ui.could_not_complete_the_request_please_try_again"));
}

export function safeMediaUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { const url = new URL(value); return url.protocol === "https:" ? url.href : undefined; } catch { return undefined; }
}

export function emojiText(emoji: EmojiChoice): string {
  return emoji.id ? `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>` : emoji.surrogates ?? "";
}

export function stickerUrl(sticker: StickerLike): string {
  // Lottie is rendered separately with Discord's native canvas component.
  const extension = sticker.format_type === 4 ? "gif" : "png";
  if (sticker.format_type === 3) return `https://discord.com/stickers/${encodeURIComponent(sticker.id)}.json`;
  return `https://media.discordapp.net/stickers/${encodeURIComponent(sticker.id)}.${extension}?size=160`;
}

export function createUploads(files: File[], channelId: string, progress: (index: number, percent: number) => void): NativeUpload[] {
  if (!files.length) return [];
  const Upload = window.Syncord?.webpack.find(mod => {
    const proto = (mod as { prototype?: Record<string, unknown> } | null)?.prototype;
    return typeof mod === "function" && typeof proto?.trackUploadFinished === "function" && typeof proto?.upload === "function";
  }) as UploadConstructor | undefined;
  if (!Upload) throw new Error("Discord's uploader is not ready. Open a chat in Discord, then try again.");
  // WEB=1 is Discord's CloudUploadPlatform; these uploads never enter the native draft store.
  return files.map((file, index) => {
    const upload = new Upload({ file, platform: 1, isThumbnail: false }, channelId);
    upload.on("progress", (loaded, total) => progress(index, total > 0 ? Math.min(100, Math.round(loaded / total * 100)) : 0));
    return upload;
  });
}

export function validateCustomEmojis(channelId: string, content: string): EmojiChoice[] {
  const ids = [...content.matchAll(/<a?:\w+:(\d+)>/g)].map(match => match[1]);
  if (!ids.length) return [];
  const store = window.Syncord?.common?.stores?.EmojiStore as { getCustomEmojiById?: (id: string) => EmojiChoice } | undefined;
  const availability = window.Syncord?.webpack.findByProps("getEmojiUnavailableReason") as {
    getEmojiUnavailableReason?: (options: Record<string, unknown>) => unknown;
  } | undefined;
  const constants = window.Syncord?.webpack.findByProps("EmojiIntention") as { EmojiIntention?: { CHAT: number } } | undefined;
  if (!availability?.getEmojiUnavailableReason || constants?.EmojiIntention?.CHAT == null) throw new Error("Discord's emoji permissions are not ready. Please try again.");
  return [...new Set(ids)].map(id => {
    const emoji = store?.getCustomEmojiById?.(id);
    if (!emoji || availability.getEmojiUnavailableReason!({emoji, channel:getChannel(channelId), intention:constants.EmojiIntention!.CHAT}) != null) {
      throw new Error("A custom emoji is unavailable in this chat. Check your emoji permissions or Nitro access.");
    }
    return emoji;
  });
}
