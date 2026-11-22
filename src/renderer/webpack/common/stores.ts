import { type ModuleRef, resolveStore } from "./resolve";

/**
 * Flux stores — keyed by Discord's constructor.displayName.
 * Aliases cover renames Discord ships occasionally.
 */
export type CommonStores = {
  UserStore: ModuleRef;
  UserProfileStore: ModuleRef;
  AuthenticationStore: ModuleRef;
  ApplicationStore: ModuleRef;
  ChannelStore: ModuleRef;
  SelectedChannelStore: ModuleRef;
  GuildStore: ModuleRef;
  SelectedGuildStore: ModuleRef;
  GuildChannelStore: ModuleRef;
  GuildMemberStore: ModuleRef;
  GuildMemberCountStore: ModuleRef;
  GuildRoleStore: ModuleRef;
  GuildScheduledEventStore: ModuleRef;
  MessageStore: ModuleRef;
  RelationshipStore: ModuleRef;
  PresenceStore: ModuleRef;
  TypingStore: ModuleRef;
  VoiceStateStore: ModuleRef;
  PermissionStore: ModuleRef;
  ReadStateStore: ModuleRef;
  EmojiStore: ModuleRef;
  StickersStore: ModuleRef;
  ThemeStore: ModuleRef;
  WindowStore: ModuleRef;
  DraftStore: ModuleRef;
  MediaEngineStore: ModuleRef;
  NotificationSettingsStore: ModuleRef;
  SpellCheckStore: ModuleRef;
  AccessibilityStore: ModuleRef;
  PendingReplyStore: ModuleRef;
  StreamerModeStore: ModuleRef;
  SpotifyStore: ModuleRef;
  UploadAttachmentStore: ModuleRef;
  OverridePremiumTypeStore: ModuleRef;
  RunningGameStore: ModuleRef;
  ActiveJoinedThreadsStore: ModuleRef;
  UserGuildSettingsStore: ModuleRef;
  UserSettingsProtoStore: ModuleRef;
  CallStore: ModuleRef;
  ChannelRTCStore: ModuleRef;
  FriendsStore: ModuleRef;
  InstantInviteStore: ModuleRef;
  InviteStore: ModuleRef;
  LocaleStore: ModuleRef;
  RTCConnectionStore: ModuleRef;
  SoundboardStore: ModuleRef;
  PopoutWindowStore: ModuleRef;
  ApplicationCommandIndexStore: ModuleRef;
  EditMessageStore: ModuleRef;
  ExperimentStore: ModuleRef;
  UserAffinitiesStore: ModuleRef;
  ApplicationStreamingStore: ModuleRef;
  ApplicationStreamPreviewStore: ModuleRef;
};

type StoreSpec = {
  key: keyof CommonStores;
  name: string;
  aliases?: string[];
};

const STORE_SPECS: StoreSpec[] = [
  { key: "UserStore", name: "UserStore" },
  { key: "UserProfileStore", name: "UserProfileStore" },
  { key: "AuthenticationStore", name: "AuthenticationStore" },
  { key: "ApplicationStore", name: "ApplicationStore" },
  { key: "ChannelStore", name: "ChannelStore" },
  { key: "SelectedChannelStore", name: "SelectedChannelStore" },
  { key: "GuildStore", name: "GuildStore" },
  { key: "SelectedGuildStore", name: "SelectedGuildStore" },
  { key: "GuildChannelStore", name: "GuildChannelStore" },
  { key: "GuildMemberStore", name: "GuildMemberStore" },
  { key: "GuildMemberCountStore", name: "GuildMemberCountStore" },
  { key: "GuildRoleStore", name: "GuildRoleStore" },
  { key: "GuildScheduledEventStore", name: "GuildScheduledEventStore" },
  { key: "MessageStore", name: "MessageStore" },
  { key: "RelationshipStore", name: "RelationshipStore" },
  { key: "PresenceStore", name: "PresenceStore" },
  { key: "TypingStore", name: "TypingStore" },
  { key: "VoiceStateStore", name: "VoiceStateStore" },
  { key: "PermissionStore", name: "PermissionStore" },
  { key: "ReadStateStore", name: "ReadStateStore" },
  { key: "EmojiStore", name: "EmojiStore" },
  { key: "StickersStore", name: "StickersStore" },
  { key: "ThemeStore", name: "ThemeStore" },
  { key: "WindowStore", name: "WindowStore" },
  { key: "DraftStore", name: "DraftStore" },
  { key: "MediaEngineStore", name: "MediaEngineStore" },
  { key: "NotificationSettingsStore", name: "NotificationSettingsStore" },
  {
    key: "SpellCheckStore",
    name: "SpellcheckStore",
    aliases: ["SpellCheckStore"],
  },
  { key: "AccessibilityStore", name: "AccessibilityStore" },
  { key: "PendingReplyStore", name: "PendingReplyStore" },
  { key: "StreamerModeStore", name: "StreamerModeStore" },
  { key: "SpotifyStore", name: "SpotifyStore" },
  { key: "UploadAttachmentStore", name: "UploadAttachmentStore" },
  { key: "OverridePremiumTypeStore", name: "OverridePremiumTypeStore" },
  { key: "RunningGameStore", name: "RunningGameStore" },
  { key: "ActiveJoinedThreadsStore", name: "ActiveJoinedThreadsStore" },
  { key: "UserGuildSettingsStore", name: "UserGuildSettingsStore" },
  { key: "UserSettingsProtoStore", name: "UserSettingsProtoStore" },
  { key: "CallStore", name: "CallStore" },
  { key: "ChannelRTCStore", name: "ChannelRTCStore" },
  { key: "FriendsStore", name: "FriendsStore" },
  { key: "InstantInviteStore", name: "InstantInviteStore" },
  { key: "InviteStore", name: "InviteStore" },
  { key: "LocaleStore", name: "LocaleStore" },
  { key: "RTCConnectionStore", name: "RTCConnectionStore" },
  { key: "SoundboardStore", name: "SoundboardStore" },
  { key: "PopoutWindowStore", name: "PopoutWindowStore" },
  { key: "ApplicationCommandIndexStore", name: "ApplicationCommandIndexStore" },
  { key: "EditMessageStore", name: "EditMessageStore" },
  { key: "ExperimentStore", name: "ExperimentStore" },
  {
    key: "UserAffinitiesStore",
    name: "UserAffinitiesV2Store",
    aliases: ["UserAffinitiesStore"],
  },
  { key: "ApplicationStreamingStore", name: "ApplicationStreamingStore" },
  {
    key: "ApplicationStreamPreviewStore",
    name: "ApplicationStreamPreviewStore",
  },
];

export function resolveStores(): CommonStores {
  const stores = {} as CommonStores;
  for (const spec of STORE_SPECS) {
    stores[spec.key] = resolveStore(
      `stores.${spec.key}`,
      spec.name,
      spec.aliases ?? [],
    );
  }
  return stores;
}
