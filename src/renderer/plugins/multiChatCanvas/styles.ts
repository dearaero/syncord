import {NATIVE_PICKER_CSS} from "../../chat/nativePickerStyles";
export const MULTICHAT_CSS = `
  #Syncord-multichat-root {
    --mc-bg:
      var(
        --background-base-lower,
        var(--background-primary, #1a1a1e)
      );

    --mc-bg-secondary:
      var(
        --background-surface-high,
        var(--background-secondary, #151518)
      );

    --mc-bg-tertiary:
      var(
        --background-base-lowest,
        var(--background-tertiary, #111214)
      );

    --mc-text:
      var(
        --text-default,
        var(--text-normal, #dbdee1)
      );

    --mc-header:
      var(
        --text-strong,
        var(--header-primary, #f2f3f5)
      );

    --mc-muted:
      var(
        --text-muted,
        #949ba4
      );

    --mc-interactive:
      var(
        --interactive-icon-default,
        var(--interactive-normal, #b5bac1)
      );

    --mc-border:
      var(
        --border-subtle,
        var(
          --background-modifier-accent,
          rgba(255, 255, 255, 0.06)
        )
      );

    --mc-hover:
      var(
        --background-message-hover,
        rgba(2, 2, 2, 0.06)
      );

    --mc-input:
      var(
        --chat-background-default,
        var(--channeltextarea-background, var(--input-background, #383a40))
      );

    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 1;
    isolation: isolate;

    display: flex;
    flex-direction: column;

    min-width: 0;
    min-height: 0;

    overflow: hidden;

    background:
      var(--mc-bg);

    color:
      var(--mc-text);

    font-family:
      var(
        --font-primary,
        "gg sans",
        "Noto Sans",
        "Helvetica Neue",
        Helvetica,
        Arial,
        sans-serif
      );
  }

  #Syncord-multichat-root *,
  #Syncord-multichat-root *::before,
  #Syncord-multichat-root *::after {
    box-sizing: border-box;
  }

  #Syncord-multichat-root button,
  #Syncord-multichat-root input {
    font: inherit;
  }

  /* ---------- MultiChat top bar ---------- */

  .dion-mc-topbar {
    height: 48px;
    min-height: 48px;

    flex: 0 0 48px;

    display: flex;
    align-items: center;

    gap: 12px;

    padding: 0 10px 0 16px;

    border-bottom:
      1px solid
      var(--mc-border);

    background:
      var(--mc-bg);
  }

  .dion-mc-native-title {
    min-width: 0;
    flex: 1;

    display: flex;
    align-items: center;

    gap: 8px;
  }

  .dion-mc-native-title-icon {
    width: 20px;
    height: 20px;

    display: grid;
    place-items: center;

    color:
      var(--mc-interactive);
  }

  .dion-mc-native-title h2 {
    margin: 0;

    color:
      var(--mc-header);

    font-size: 15px;
    font-weight: 650;

    line-height: 20px;
  }

  .dion-mc-native-divider {
    width: 1px;
    height: 20px;

    background:
      var(--mc-border);
  }

  .dion-mc-native-subtitle {
    color:
      var(--mc-muted);

    font-size: 12px;

    line-height: 16px;
  }

  .dion-mc-toolbar {
    display: flex;
    align-items: center;

    gap: 6px;
  }

  .dion-mc-segment {
    height: 32px;

    display: flex;
    align-items: center;

    gap: 1px;

    padding: 2px;

    border-radius: 6px;

    background:
      var(--mc-bg-secondary);
  }

  .dion-mc-segment button,
  .dion-mc-icon-btn {
    border: 0;

    background:
      transparent;

    color:
      var(--mc-interactive);

    cursor: pointer;
  }

  .dion-mc-segment button {
    min-width: 28px;
    height: 28px;

    padding: 0 7px;

    border-radius: 4px;

    font-size: 12px;
    font-weight: 600;
  }

  .dion-mc-segment button:hover,
  .dion-mc-icon-btn:hover {
    background:
      var(
        --background-modifier-hover,
        rgba(79, 84, 92, 0.16)
      );

    color:
      var(
        --interactive-hover,
        #fff
      );
  }

  .dion-mc-segment button.is-active {
    background:
      var(
        --background-modifier-selected,
        rgba(79, 84, 92, 0.32)
      );

    color:
      var(
        --interactive-active,
        #fff
      );
  }

  .dion-mc-icon-btn {
    width: 32px;
    height: 32px;

    display: grid;
    place-items: center;

    padding: 0;

    border-radius: 4px;
  }

  /* ---------- Grid ---------- */

  .dion-mc-canvas {
    min-width: 0;
    min-height: 0;

    flex: 1;

    display: grid;

    gap: 1px;

    overflow: hidden;

    background:
      var(--mc-border);
  }

  .dion-mc-canvas[data-count="2"] {
    grid-template-columns:
      repeat(2, minmax(0, 1fr));
    grid-template-rows: minmax(260px, 1fr);
  }

  .dion-mc-canvas[data-count="3"] {
    grid-template-columns:
      minmax(0, 1.15fr)
      minmax(0, 0.85fr);

    grid-template-rows:
      repeat(2, minmax(320px, 1fr));
  }

  .dion-mc-canvas[data-count="3"]
  .dion-mc-pane:first-child {
    grid-row: 1 / span 2;
  }

  .dion-mc-canvas[data-count="4"] {
    grid-template-columns:
      repeat(2, minmax(0, 1fr));

    grid-template-rows:
      repeat(2, minmax(320px, 1fr));
  }

  .dion-mc-canvas:not(.is-single) { overflow-y: auto; overscroll-behavior: contain; }

  .dion-mc-canvas.is-single {
    display: flex;
    background: var(--mc-bg);
  }
  .dion-mc-canvas.is-single > .dion-mc-pane { flex: 1; }
  #Syncord-multichat-root [hidden] { display: none !important; }
  .dion-mc-surface-host { position: relative; }
  .dion-mc-native-surface-host { isolation: isolate; }
  /* Inert blocks input, not painting. Native headers/account panels can have
     their own high z-indices; hide the covered base content without reflow. */
  .dion-mc-covered-content, .dion-mc-covered-content * { visibility: hidden !important; }
  .dion-mc-native-overlay-path { z-index: 2; pointer-events: none; }
  .dion-mc-native-overlay-static-path { position: relative; }
  .dion-mc-exposed-native-overlay, .dion-mc-exposed-native-overlay * { visibility: visible !important; }
  .dion-mc-exposed-native-overlay { position: absolute; z-index: 2; }
  /* Fake Voice is a body portal, outside the account panel being covered. */
  body:has(#Syncord-multichat-root) #Syncord-fake-voice-host { display: none !important; }
  #Syncord-multichat-root[data-surface="fallback"] { position: fixed; }
  .dion-mc-tabs {
    display: flex; flex: 0 0 44px; min-width: 0; gap: 4px;
    padding: 4px 8px; overflow-x: auto; overscroll-behavior: contain;
    background: var(--mc-bg); border-bottom: 1px solid var(--mc-border);
  }
  .dion-mc-tabs button {
    display: flex; align-items: center; gap: 8px;
    flex: 1 0 64px; max-width: 240px; min-width: 0;
    padding: 0 10px; border: 0; border-radius: 8px;
    background: transparent; color: var(--mc-muted); cursor: pointer;
  }
  .dion-mc-tabs button > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dion-mc-tabs button:hover { background: var(--mc-hover); color: var(--mc-text); }
  .dion-mc-tabs button[aria-selected="true"] { background: var(--background-modifier-selected, var(--mc-bg-secondary)); color: var(--mc-header); }
  .dion-mc-tab-index { font-size: 11px; opacity: .7; }

  .dion-mc-pane {
    display: none;
  }

  .dion-mc-canvas.is-focused
  .dion-mc-pane.is-focused {
    width: 100%;
    height: 100%;

    display: flex;
  }

  .dion-mc-pane {
    container-type: size;
    container-name: multichat-pane;
    position: relative;

    min-width: 0;
    min-height: 0;

    display: flex;
    flex-direction: column;

    overflow: hidden;

    background:
      var(--mc-bg);
  }

  /* ---------- Pane header ---------- */

  .dion-mc-pane-head {
    height: 48px;
    min-height: 48px;

    flex: 0 0 48px;

    display: flex;
    align-items: center;

    gap: 8px;

    padding: 0 8px 0 16px;

    border-bottom:
      1px solid
      var(--mc-border);

    background:
      var(--mc-bg);

    box-shadow:
      var(
        --elevation-low,
        0 1px 0 rgba(0, 0, 0, 0.05)
      );
  }

  .dion-mc-channel-button {
    min-width: 0;
    flex: 1;

    height: 40px;

    display: flex;
    align-items: center;

    gap: 10px;

    padding: 0;

    border: 0;

    background:
      transparent;

    text-align: left;

    cursor: pointer;
  }

  .dion-mc-channel-icon {
    width: 28px;
    height: 28px;

    flex: 0 0 28px;

    display: grid;
    place-items: center;

    overflow: hidden;

    color:
      var(
        --channel-icon,
        var(--mc-interactive)
      );
  }

  .dion-mc-channel-icon.is-dm {
    border-radius: 50%;

    background:
      var(--mc-bg-secondary);
  }

  .dion-mc-channel-icon img {
    width: 100%;
    height: 100%;

    display: block;

    object-fit: cover;
  }

  .dion-mc-channel-name {
    min-width: 0;

    overflow: hidden;

    color:
      var(--mc-header);

    font-size: 16px;
    font-weight: 650;

    line-height: 20px;

    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dion-mc-head-actions {
    display: flex;
    align-items: center;

    gap: 2px;
  }

  .dion-mc-head-actions
  .dion-mc-icon-btn {
    width: 32px;
    height: 32px;
  }

  .dion-mc-unread-dot {
    width: 7px;
    height: 7px;

    flex: 0 0 7px;

    border-radius: 50%;

    background:
      var(
        --status-danger,
        #f23f43
      );
  }

  /* ---------- Messages ---------- */

  .dion-mc-messages-wrap {
    position: relative;

    min-width: 0;
    min-height: 0;

    flex: 1;

    overflow: hidden;

    background:
      var(--mc-bg);
  }

  .dion-mc-messages {
    position: absolute;
    inset: 0;

    overflow-x: hidden;
    overflow-y: auto;

    overscroll-behavior: contain;

    scrollbar-gutter: stable;

    background:
      var(--mc-bg);
  }

  .dion-mc-scroller-content {
    min-height: 100%;

    display: flex;
    flex-direction: column;
    justify-content: flex-end;
  }

  .dion-mc-message-list {
    width: 100%;

    margin: 0;
    padding: 16px 0 4px;

    list-style: none;
  }

  .dion-mc-message-list-item {
    width: 100%;
    display: block;
    margin: 0;
    padding: 0;
  }

  .dion-mc-message {
    position: relative;

    width: 100%;

    min-height: 22px;

    padding:
      0.125rem
      48px
      0.125rem
      72px;

    color:
      var(--mc-text);

    font-size: 16px;

    line-height: 22px;

    overflow: visible;

    transition:
      background-color
      70ms ease;
  }

  .dion-mc-message:hover {
    background:
      var(--mc-hover);
  }

  .dion-mc-message.is-group-start {
    min-height: 44px;

    margin-top: 17px;

    padding-top: 0;
  }

  .dion-mc-message-list-item:first-child .dion-mc-message.is-group-start {
    margin-top: 0;
  }

  .dion-mc-message-avatar {
    position: absolute;

    left: 16px;
    top: 0;

    width: 40px;
    height: 40px;

    display: grid;
    place-items: center;

    overflow: hidden;

    border: 0;
    border-radius: 50%;

    background:
      var(--mc-bg-secondary);

    color:
      var(--mc-header);

    object-fit: cover;

    cursor: pointer;
  }

  .dion-mc-avatar-fallback {
    font-size: 12px;
    font-weight: 700;
  }

  .dion-mc-message-header {
    min-width: 0;

    height: 22px;

    display: flex;
    align-items: baseline;

    gap: 5px;

    margin: 0;

    line-height: 22px;
  }

  .dion-mc-author {
    min-width: 0;

    max-width: 60%;

    padding: 0;

    overflow: hidden;

    border: 0;

    background:
      transparent;

    color:
      var(--mc-header);

    font-size: 16px;
    font-weight: 600;

    line-height: 22px;

    text-overflow: ellipsis;
    white-space: nowrap;

    cursor: pointer;
  }

  .dion-mc-author:hover {
    text-decoration: underline;
  }

  .dion-mc-inline-time,
  .dion-mc-edited {
    color:
      var(--mc-muted);

    font-size: 12px;
    font-weight: 400;

    line-height: 22px;

    white-space: nowrap;
  }

  .dion-mc-bot-badge {
    height: 15px;

    display: inline-flex;
    align-items: center;

    flex: 0 0 auto;

    padding: 0 4px;

    border-radius: 3px;

    background:
      var(
        --brand-500,
        #5865f2
      );

    color: #fff;

    font-size: 9px;
    font-weight: 700;

    line-height: 15px;
  }

  .dion-mc-content {
    min-width: 0;

    color:
      var(--mc-text);

    font-size: 16px;
    font-weight: 400;

    line-height: 22px;

    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .dion-mc-content a {
    color:
      var(
        --text-link,
        #00a8fc
      );

    text-decoration: none;
  }

  .dion-mc-content a:hover {
    text-decoration: underline;
  }

  .dion-mc-content code {
    padding: 1px 4px;

    border-radius: 3px;

    background:
      var(
        --background-code,
        rgba(0, 0, 0, 0.18)
      );

    font-family:
      var(
        --font-code,
        ui-monospace,
        SFMono-Regular,
        Menlo,
        Monaco,
        Consolas,
        monospace
      );

    font-size: 0.9em;
  }

  .dion-mc-compact-time {
    position: absolute;

    left: 0;
    top: 2px;

    width: 64px;

    padding-right: 8px;

    color:
      var(--mc-muted);

    font-size: 10px;
    font-weight: 400;

    line-height: 18px;

    text-align: right;

    opacity: 0;

    pointer-events: none;
  }

  .dion-mc-message.is-compact:hover
  .dion-mc-compact-time {
    opacity: 1;
  }

  .dion-mc-reply-preview {
    position: relative;

    min-width: 0;

    height: 18px;

    display: flex;
    align-items: center;

    gap: 5px;

    margin-bottom: 2px;

    color:
      var(--mc-muted);

    font-size: 12px;

    line-height: 16px;
  }

  .dion-mc-reply-preview::before {
    content: "";

    position: absolute;

    left: -24px;
    top: 8px;

    width: 16px;
    height: 10px;

    border-top:
      2px solid
      var(
        --interactive-muted,
        #4e5058
      );

    border-left:
      2px solid
      var(
        --interactive-muted,
        #4e5058
      );

    border-radius:
      7px 0 0 0;
  }

  .dion-mc-reply-author {
    flex: 0 0 auto;

    color:
      var(--mc-interactive);

    font-weight: 600;
  }

  .dion-mc-reply-text {
    min-width: 0;

    overflow: hidden;

    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dion-mc-mention {
    display: inline;

    padding: 0 2px;

    border-radius: 3px;

    background:
      color-mix(
        in srgb,
        var(--brand-500, #5865f2)
        25%,
        transparent
      );

    color:
      var(
        --brand-360,
        #c9cdfb
      );

    font-weight: 500;
  }

  .dion-mc-mention:hover {
    background:
      var(
        --brand-500,
        #5865f2
      );

    color: #fff;
  }

  .dion-mc-message-actions {
    position: absolute;

    top: -16px;
    right: 14px;
    z-index: 3;

    display: flex;

    padding: 2px;

    border:
      1px solid
      var(--mc-border);

    border-radius: 8px;

    background:
      var(
        --background-surface-high,
        var(--mc-bg-secondary)
      );

    box-shadow:
      0 4px 16px
      rgba(0, 0, 0, 0.24);

    opacity: 0;
    pointer-events: none;

    transform:
      translateY(2px);

    transition:
      opacity 80ms ease,
      transform 80ms ease;
  }

  .dion-mc-message:hover
  .dion-mc-message-actions,
  .dion-mc-message:focus-within
  .dion-mc-message-actions {
    opacity: 1;
    pointer-events: auto;

    transform:
      translateY(0);
  }

  .dion-mc-message-action {
    width: 30px;
    height: 30px;

    display: grid;
    place-items: center;

    padding: 0;

    border: 0;
    border-radius: 5px;

    background:
      transparent;

    color:
      var(--mc-interactive);

    cursor: pointer;
  }

  .dion-mc-message-action:hover {
    background:
      var(
        --background-modifier-hover,
        rgba(79, 84, 92, 0.16)
      );

    color:
      var(
        --interactive-hover,
        #fff
      );
  }

  .dion-mc-date-separator {
    width: 100%;

    display: grid;

    grid-template-columns:
      minmax(10px, 1fr)
      auto
      minmax(10px, 1fr);

    align-items: center;

    gap: 8px;

    margin: 18px 0 8px;

    padding: 0 16px;
  }

  .dion-mc-date-line {
    height: 1px;

    background:
      var(--mc-border);
  }

  .dion-mc-date-label {
    color:
      var(--mc-muted);

    font-size: 12px;
    font-weight: 600;

    line-height: 16px;

    white-space: nowrap;
  }

  /* ---------- Attachments ---------- */

  .dion-mc-accessories {
    margin-top: 4px;
  }

  .dion-mc-attachments {
    display: flex;
    flex-wrap: wrap;

    gap: 4px;
  }

  .dion-mc-image {
    display: block;

    max-width:
      min(
        100%,
        520px
      );

    max-height: 420px;

    overflow: hidden;

    border-radius: 8px;

    background:
      var(--mc-bg-secondary);
  }

  .dion-mc-image img {
    display: block;

    max-width: 100%;
    max-height: 420px;

    object-fit: contain;
  }

  .dion-mc-file {
    max-width: min(100%, 360px);
    overflow-wrap: anywhere;

    display: inline-flex;
    align-items: center;

    gap: 8px;

    padding: 10px 12px;

    border:
      1px solid
      var(--mc-border);

    border-radius: 8px;

    background:
      var(--mc-bg-secondary);

    color:
      var(
        --text-link,
        #00a8fc
      );

    font-size: 12px;

    text-decoration: none;
  }

  .dion-mc-embed {
    max-width: 420px;

    margin-top: 4px;

    padding: 10px 12px;

    border-left:
      4px solid
      var(
        --brand-500,
        #5865f2
      );

    border-radius: 4px;

    background:
      var(--mc-bg-secondary);

    color:
      var(--mc-muted);

    font-size: 12px;

    line-height: 17px;
  }

  .dion-mc-embed-title {
    color:
      var(--mc-header);

    font-weight: 600;
  }

  .dion-mc-inline-emoji { width: 22px; height: 22px; vertical-align: bottom; object-fit: contain; }
  .dion-mc-gif-video { display: block; max-width: 100%; max-height: 320px; border-radius: 8px; }
  .dion-mc-message-sticker img { width: 100%; height: 100%; object-fit: contain; }
  .dion-mc-sticker-thumb { width: 40px; height: 40px; flex: 0 0 40px; overflow: hidden; }
  .dion-mc-message-sticker { display: block; width: 160px; max-width: 100%; height: 160px; object-fit: contain; }

  .dion-mc-media-draft {
    display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 16px;
    max-height: 160px; overflow: auto;
  }
  .dion-mc-media-draft[hidden] { display: none; }
  .dion-mc-draft-item {
    display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%;
    background: var(--mc-bg-secondary); border: 1px solid var(--mc-border); border-radius: 6px; padding: 6px;
  }
  .dion-mc-draft-item img { width: 40px; height: 40px; object-fit: contain; }
  .dion-mc-draft-item span { overflow-wrap: anywhere; font-size: 12px; }
  .dion-mc-draft-item button {
    cursor: pointer; border: 0; border-radius: 5px; color: var(--mc-text); background: var(--mc-bg-secondary);
  }
  .dion-mc-draft-item button { width: 28px; height: 28px; flex: 0 0 28px; font-size: 20px; }
  .dion-mc-draft-status { width: 100%; font-size: 12px; overflow-wrap: anywhere; }
  .dion-mc-draft-status[role="alert"] { color: var(--text-danger, #ff8585); }
  ${NATIVE_PICKER_CSS}

  /* ---------- Composer ---------- */

  .dion-mc-composer-wrap {
    width: 100%;

    flex: 0 0 auto;

    margin: 0;
    padding: 0;

    background:
      var(--mc-bg);
  }

  .dion-mc-channel-bottom {
    width: 100%;

    display: block;
  }

  .dion-mc-channel-text-area {
    width:
      calc(
        100% - 32px
      );

    margin:
      0 16px
      16px;

    display: block;
  }

  .dion-mc-scrollable-container {
    width: 100%;

    overflow: hidden;

    border-radius: 8px;

    background:
      var(--mc-input);
  }

  .dion-mc-composer {
    width: 100%;

    min-height: 56px;

    display: flex;
    align-items: flex-end;

    overflow: hidden;
  }

  .dion-mc-composer-btn,
  .dion-mc-send {
    width: 44px;
    height: 56px;

    flex: 0 0 44px;

    display: grid;
    place-items: center;

    padding: 0;

    border: 0;

    background:
      transparent;

    color:
      var(--mc-interactive);

    cursor: pointer;
  }

  .dion-mc-composer-btn:hover,
  .dion-mc-send:hover:not(:disabled) {
    color:
      var(
        --interactive-hover,
        #fff
      );
  }

  .dion-mc-composer-btn:disabled,
  .dion-mc-send:disabled {
    opacity: 0.35;

    cursor: default;
  }

  .dion-mc-gif-btn span {
    min-width: 22px;
    height: 16px;

    display: inline-flex;
    align-items: center;
    justify-content: center;

    padding: 0 2px;

    border:
      1.5px solid
      currentColor;

    border-radius: 3px;

    font-size: 8px;
    font-weight: 800;

    line-height: 1;
  }

  .dion-mc-native-text-area {
    min-width: 0;

    flex: 1 1 auto;

    min-height: 56px;
    max-height: 176px;

    overflow-y: auto;
  }

  .dion-mc-editor-shell {
    position: relative;

    width: 100%;
    min-height: 56px;
  }

  .dion-mc-editor {
    position: relative;
    z-index: 1;

    width: 100%;

    min-height: 22px;
    max-height: 144px;

    padding: 17px 0;

    overflow-y: auto;

    outline: none;

    color:
      var(--mc-text);

    font-size: 16px;
    font-weight: 400;

    line-height: 22px;

    white-space: pre-wrap;
    overflow-wrap: break-word;

    caret-color:
      var(--mc-text);
  }

  #Syncord-multichat-root .dion-mc-composer-emoji {
    display: inline-block; width: 22px; height: 22px; max-width: 22px;
    vertical-align: bottom; object-fit: contain; margin: 0 1px;
    padding: 0; border: 0; border-radius: 0;
  }

  .dion-mc-native-placeholder {
    position: absolute;

    top: 17px;
    left: 0;
    right: 0;
    z-index: 0;

    overflow: hidden;

    color:
      var(--mc-muted);

    font-size: 16px;
    font-weight: 400;

    line-height: 22px;

    text-overflow: ellipsis;
    white-space: nowrap;

    pointer-events: none;
  }

  .dion-mc-native-text-area.has-content
  .dion-mc-native-placeholder {
    display: none;
  }

  .dion-mc-composer-tools {
    flex: 0 0 auto;

    display: flex;
    align-items: flex-end;

    min-height: 56px;
  }

  .dion-mc-send-separator {
    width: 1px;
    height: 24px;

    flex: 0 0 1px;

    align-self: center;

    margin: 0 2px;

    background:
      var(--mc-border);
  }

  .dion-mc-send {
    width: 44px;

    flex-basis: 44px;
  }

  .dion-mc-reply-strip {
    min-height: 36px;

    display: none;
    align-items: center;

    gap: 8px;

    width:
      calc(
        100% - 32px
      );

    margin: 0 16px;

    padding: 0 12px;

    border-bottom:
      1px solid
      var(--mc-border);

    border-radius:
      8px 8px 0 0;

    background:
      var(--mc-bg-secondary);

    color:
      var(--mc-muted);

    font-size: 11px;
  }

  .dion-mc-reply-strip.is-visible {
    display: flex;
  }

  .dion-mc-reply-strip.is-visible
  + .dion-mc-channel-bottom
  .dion-mc-channel-text-area {
    margin-top: 0;

    border-radius:
      0 0 8px 8px;
  }

  .dion-mc-reply-strip strong {
    color:
      var(--mc-header);

    font-weight: 600;
  }

  .dion-mc-reply-copy {
    min-width: 0;
    flex: 1;

    overflow: hidden;

    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dion-mc-reply-strip button {
    width: 24px;
    height: 24px;

    display: grid;
    place-items: center;

    padding: 0;

    border: 0;
    border-radius: 4px;

    background:
      transparent;

    color:
      var(--mc-interactive);

    cursor: pointer;
  }

  /* ---------- Empty / loading / new ---------- */

  .dion-mc-load-row {
    min-height: 20px;

    display: flex;
    align-items: center;
    justify-content: center;

    padding: 2px 16px 4px;
  }

  .dion-mc-load-button {
    min-height: 26px;

    padding: 0 10px;

    border: 0;
    border-radius: 4px;

    background:
      var(
        --background-modifier-hover,
        rgba(79, 84, 92, 0.16)
      );

    color:
      var(--mc-interactive);

    font-size: 10px;
    font-weight: 600;

    cursor: pointer;
  }

  .dion-mc-native-bottom-spacer {
    height: 16px;

    flex: 0 0 auto;
  }

  .dion-mc-new-pill {
    position: absolute;

    left: 50%;
    bottom: 10px;
    z-index: 2;

    min-height: 28px;

    display: none;
    align-items: center;

    gap: 5px;

    padding: 0 10px;

    border: 0;
    border-radius: 14px;

    background:
      var(
        --brand-500,
        #5865f2
      );

    color: #fff;

    box-shadow:
      0 3px 8px
      rgba(0, 0, 0, 0.24);

    font-size: 10px;
    font-weight: 600;

    cursor: pointer;

    transform:
      translateX(-50%);
  }

  .dion-mc-new-pill.is-visible {
    display: inline-flex;
  }

  .dion-mc-empty {
    min-height: 100%;

    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: flex-end;

    gap: 6px;

    padding: 28px 16px;

    color:
      var(--mc-muted);

    text-align: left;
  }

  .dion-mc-empty-icon {
    width: 52px;
    height: 52px;

    display: grid;
    place-items: center;

    margin-bottom: 6px;

    border-radius: 50%;

    background:
      var(--mc-bg-secondary);

    color:
      var(--mc-interactive);
  }

  .dion-mc-empty strong {
    color:
      var(--mc-header);

    font-size: 18px;
    font-weight: 700;
  }

  .dion-mc-empty span {
    max-width: 320px;

    font-size: 12px;

    line-height: 17px;
  }

  /* ---------- Picker ---------- */

  .dion-mc-picker-backdrop {
    position: absolute;
    inset: 0;
    z-index: 20;

    display: grid;
    place-items: center;

    padding: 24px;

    background:
      rgba(0, 0, 0, 0.72);
  }

  .dion-mc-picker {
    width:
      min(
        480px,
        100%
      );

    max-height:
      min(
        620px,
        calc(
          100% - 24px
        )
      );

    display: flex;
    flex-direction: column;

    overflow: hidden;

    border-radius: 8px;

    background:
      var(
        --modal-background,
        var(--mc-bg)
      );

    box-shadow:
      var(
        --elevation-high,
        0 8px 24px rgba(0, 0, 0, 0.5)
      );
  }

  .dion-mc-picker-head {
    display: flex;
    align-items: center;
    justify-content: space-between;

    gap: 12px;

    padding: 14px 16px 10px;
  }

  .dion-mc-picker-head h3 {
    margin: 0;

    color:
      var(--mc-header);

    font-size: 16px;
    font-weight: 650;
  }

  .dion-mc-picker-head p {
    margin: 2px 0 0;

    color:
      var(--mc-muted);

    font-size: 11px;
  }

  .dion-mc-search-shell {
    height: 40px;

    display: flex;
    align-items: center;

    gap: 8px;

    margin: 0 16px 12px;

    padding: 0 10px;

    border-radius: 4px;

    background:
      var(
        --input-background,
        #1e1f22
      );

    color:
      var(--mc-muted);
  }

  .dion-mc-search-shell input {
    min-width: 0;
    width: 100%;
    height: 100%;

    padding: 0;

    border: 0;
    outline: 0;

    background:
      transparent;

    color:
      var(--mc-text);

    font-size: 13px;
  }

  .dion-mc-picker-list {
    min-height: 0;

    overflow-y: auto;

    padding: 0 8px 12px;
  }

  .dion-mc-picker-group {
    padding: 10px 8px 5px;

    color:
      var(--mc-muted);

    font-size: 10px;
    font-weight: 700;

    text-transform: uppercase;
  }

  .dion-mc-choice {
    width: 100%;
    min-height: 42px;

    display: flex;
    align-items: center;

    gap: 9px;

    padding: 5px 8px;

    border: 0;
    border-radius: 4px;

    background:
      transparent;

    color: inherit;

    text-align: left;

    cursor: pointer;
  }

  .dion-mc-choice:hover,
  .dion-mc-choice.is-current {
    background:
      var(
        --background-modifier-hover,
        rgba(79, 84, 92, 0.16)
      );
  }

  .dion-mc-choice-icon {
    position: relative;
    width: 30px;
    height: 30px;

    flex: 0 0 30px;

    display: grid;
    place-items: center;

    border-radius: 50%;

    background:
      var(--mc-bg-secondary);

    color:
      var(--mc-interactive);
  }

  .dion-mc-choice-icon img { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: inherit; object-fit: cover; }

  .dion-mc-choice-copy {
    min-width: 0;
    flex: 1;
  }

  .dion-mc-choice-title {
    display: block;

    overflow: hidden;

    color:
      var(--mc-header);

    font-size: 12px;
    font-weight: 500;

    line-height: 16px;

    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dion-mc-choice-sub {
    display: block;

    margin-top: 1px;

    overflow: hidden;

    color:
      var(--mc-muted);

    font-size: 10px;

    line-height: 13px;

    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dion-mc-picker-empty {
    padding: 32px;

    color:
      var(--mc-muted);

    font-size: 12px;

    text-align: center;
  }

  #Syncord-multichat-toolbar-btn {
    position: relative;
  }

  #Syncord-multichat-toolbar-btn::after {
    content: "";

    position: absolute;

    right: 2px;
    bottom: 2px;

    width: 5px;
    height: 5px;

    border-radius: 50%;

    background:
      var(
        --status-positive,
        #23a55a
      );

    opacity: 0;
  }

  #Syncord-multichat-toolbar-btn[data-open="true"]::after {
    opacity: 1;
  }

  @media (max-width: 1100px) {
    .dion-mc-composer-btn {
      width: 38px;
      flex-basis: 38px;
    }

    .dion-mc-send {
      width: 40px;
      flex-basis: 40px;
    }
  }

  #Syncord-multichat-root[data-compact="true"] .dion-mc-native-divider,
  #Syncord-multichat-root[data-compact="true"] .dion-mc-native-subtitle { display: none; }

  /* Defend the composer against host button/contenteditable rules. These are
     scoped to Canvas; picker controls and Discord's original composer keep theirs. */
  #Syncord-multichat-root .dion-mc-composer-btn,
  #Syncord-multichat-root .dion-mc-send {
    appearance: none; background: transparent; background-image: none;
    color: var(--mc-interactive); border: 0; box-shadow: none;
    padding: 0; border-radius: 6px;
  }
  #Syncord-multichat-root .dion-mc-composer-btn svg,
  #Syncord-multichat-root .dion-mc-send svg {
    display: block; width: 20px; height: 20px; min-width: 20px; max-width: 20px;
    min-height: 20px; max-height: 20px; flex: none; background: transparent;
    color: inherit; transform: none;
  }
  #Syncord-multichat-root .dion-mc-editor {
    color: var(--mc-text); -webkit-text-fill-color: var(--mc-text);
    caret-color: var(--mc-text); opacity: 1; visibility: visible;
    outline: none; box-shadow: none;
    background: transparent; text-indent: 0;
  }

  /* Shared production styles: the fixture and injected plugin use the same sheet. */
  #Syncord-multichat-root [data-mc-native-tool] { display: none; }
  .dion-mc-composer-btn svg, .dion-mc-send svg { width: 20px; height: 20px; flex: none; }
  .dion-mc-scrollable-container { border: 1px solid var(--mc-border); border-radius: 12px; }
  .dion-mc-scrollable-container:focus-within { border-color: var(--border-normal, var(--mc-interactive)); }
  .dion-mc-composer-tools { flex-wrap: nowrap; }
  .dion-mc-media-draft { flex-wrap: nowrap; max-height: 88px; flex-shrink: 0; }
  .dion-mc-draft-item { flex: 0 0 auto; max-width: 220px; }
  .dion-mc-draft-status { min-width: 100px; flex: 1 0 100px; }
  .dion-mc-composer-wrap { max-height: min(55%, calc(100% - 144px)); overflow-y: auto; overscroll-behavior: contain; }
  .dion-mc-picker-backdrop { padding: 12px; }
  .dion-mc-picker { max-height: 100%; min-height: 0; border: 1px solid var(--mc-border); border-radius: 12px; }
  .dion-mc-picker-head, .dion-mc-search-shell { flex-shrink: 0; }
  .dion-mc-search-shell { background: var(--mc-input); }

  /* Each pane can be narrow even on a large monitor. Keep every tool reachable. */
  @container multichat-pane (max-width: 480px) {
    .dion-mc-composer {
      display: grid;
      grid-template-columns: 40px minmax(0, 1fr);
      align-items: end;
    }
    .dion-mc-native-text-area { grid-column: 1 / -1; grid-row: 1; margin: 0 12px; }
    .dion-mc-attach-btn { grid-column: 1; grid-row: 2; }
    .dion-mc-composer-tools { grid-column: 2; grid-row: 2; justify-content: flex-end; min-width: 0; }
    .dion-mc-composer-btn, .dion-mc-send { width: 32px; height: 36px; flex-basis: 32px; }
    .dion-mc-composer-tools { min-height: 36px; }
  }

  @container multichat-pane (max-width: 600px) {
    .dion-mc-message { padding-left: 56px; padding-right: 12px; }
    .dion-mc-message-avatar { left: 12px; width: 32px; height: 32px; }
    .dion-mc-compact-time { width: 50px; padding-right: 4px; }
    .dion-mc-channel-text-area { width: calc(100% - 16px); margin: 0 8px 8px; }
    .dion-mc-pane-head { padding-left: 8px; }
    .dion-mc-head-actions { gap: 0; }
    .dion-mc-head-actions .dion-mc-icon-btn { width: 28px; }
  }

  @container multichat-pane (max-height: 360px) {
    .dion-mc-editor { max-height: 56px; }
    .dion-mc-native-text-area { max-height: 56px; }
    .dion-mc-media-draft { max-height: 48px; padding: 4px 8px; }
    .dion-mc-draft-item { padding: 2px 6px; }
    .dion-mc-draft-item img, .dion-mc-sticker-thumb { width: 28px; height: 28px; }
  }

  @container multichat-pane (max-width: 340px) {
    .dion-mc-composer-tools { flex-wrap: wrap; }
    .dion-mc-composer-btn, .dion-mc-send { width: 28px; flex-basis: 28px; }
    .dion-mc-inline-time { font-size: 10px; }
  }

  #Syncord-multichat-root :is(button, input):focus-visible {
    outline: 2px solid var(--text-link, #00a8fc);
    outline-offset: -2px;
  }

  @media (prefers-reduced-motion: reduce) {
    #Syncord-multichat-root *,
    #Syncord-multichat-root *::before,
    #Syncord-multichat-root *::after {
      scroll-behavior: auto !important;
      transition: none !important;
      animation: none !important;
    }
  }
`;
