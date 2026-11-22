import { type ModuleRef, resolveProps } from "./resolve";

export type CommonActions = {
  MessageActions: ModuleRef;
  InviteActions: ModuleRef;
  ChannelActionCreators: ModuleRef;
  UserProfileActions: ModuleRef;
  PopoutActions: ModuleRef;
  UploadManager: ModuleRef;
};

export function resolveActions(): CommonActions {
  return {
    MessageActions: resolveProps(
      "actions.MessageActions",
      "editMessage",
      "sendMessage",
    ),
    InviteActions: resolveProps("actions.InviteActions", "resolveInvite"),
    ChannelActionCreators: resolveProps(
      "actions.ChannelActionCreators",
      "openPrivateChannel",
    ),
    UserProfileActions: resolveProps(
      "actions.UserProfileActions",
      "openUserProfileModal",
    ),
    PopoutActions: resolveProps(
      "actions.PopoutActions",
      "setAlwaysOnTop",
      "open",
      "close",
    ),
    UploadManager: resolveProps(
      "actions.UploadManager",
      "clearAll",
      "addFile",
    ),
  };
}
