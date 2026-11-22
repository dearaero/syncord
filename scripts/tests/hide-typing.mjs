import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';

// Verifies the typing-mode switch: the pure policy, the three runtime modes,
// the "always typing" driver, and the chat-input button. Runs the real plugin
// against stub stores; no account, no network, no gateway.
const dir = await mkdtemp(path.join(tmpdir(), 'Syncord-typing-'));

try {
  await build({stdin: {contents: `
    import { HideTypingPlugin, hideTypingChangeEvent, TYPING_MODES, effectiveMode, isTypingMode, shouldDropOutgoing, shouldDriveTyping, isOutgoingTypingAction, OUTGOING_TYPING_ACTION, ALWAYS_TYPING_INTERVAL_MS } from './src/renderer/plugins/hideTyping';
    import { kit } from './src/renderer/discordKit';
    import { settings } from './src/renderer/api/settings';
    window.api = {
      HideTypingPlugin, hideTypingChangeEvent, TYPING_MODES, effectiveMode, isTypingMode,
      shouldDropOutgoing, shouldDriveTyping, isOutgoingTypingAction,
      OUTGOING_TYPING_ACTION, ALWAYS_TYPING_INTERVAL_MS, settings, kit,
    };
  `,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',outfile:path.join(dir,'bundle.js')});

  // The real settings module reads through SyncordNative, so the fixture
  // provides one backed by a mutable object. That makes the plugin read and
  // write real settings rather than a stub.
  // A composer built from the live client's markup, hashed class names and all.
  // If the selectors ever stop matching Discord's real prefixes, this fails
  // rather than silently losing the button.
  const COMPOSER = `
    <div class="channelBottomBarArea_f75fb0">
      <div class="channelTextArea_f75fb0 channelTextArea__74017">
        <div class="scrollableContainer__74017 themedBackground__74017">
          <div class="inner__74017 sansAttachButton__74017">
            <div class="attachWrapper__0923f">
              <div class="attachButton__0923f attachButton__74017 button__24af7" role="button"></div>
            </div>
            <div class="textArea__74017 textAreaSlate__74017 slateContainer_ec4baf"></div>
            <div class="buttons__74017">
              <div class="container__5287f">
                <div class="buttonContainer__74017">
                  <div class="button__74017 button__24af7 stickerButton__74017" role="button" aria-label="Open sticker picker">
                    <div class="buttonWrapper__24af7 buttonWrapper__74017" style="opacity:1;transform:none;">
                      <div class="lottieIcon__5eb9b lottieIconColors__5eb9b" style="--__lottieIconColor: currentColor; display:flex; width:20px; height:20px;">
                        <svg viewBox="0 0 24 24" width="20" height="20"></svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div class="separator_aa63ab"></div>
              <div class="container_aa63ab">
                <div class="button__74017 button__24af7" role="button" aria-label="Send Message">
                  <svg class="sendIcon_aa63ab" viewBox="0 0 24 24"></svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  await writeFile(path.join(dir,'boot.js'), `
    window.__store = {};
    window.SyncordNative = {
      ping: async () => 'pong',
      getVersion: async () => 'test',
      getSettings: async () => window.__store,
      setSettings: async (data) => { Object.assign(window.__store, data); },
      httpFetch: async () => ({ ok: false, status: 0, text: '' }),
    };
    window.__composer = ${JSON.stringify(COMPOSER)};
    window.__mountComposer = () => {
      if (document.querySelector('[class*="channelBottomBarArea"]')) return;
      document.body.insertAdjacentHTML('beforeend', window.__composer);
    };
    window.__clearComposer = () => {
      document.querySelector('[class*="channelBottomBarArea"]')?.remove();
      document.getElementById('Syncord-typing-mode-button')?.remove();
      document.getElementById('fake-menu')?.remove();
      if (window.__dropAway) { window.__dropAway(); window.__dropAway = null; }
    };

    // Stand-in for Discord's own menu components. The composer must build a
    // real Menu/MenuRadioItem tree, so these record what they were given.
    window.__menuState = { opened: 0, closed: 0, items: [], groups: [], badProps: [] };
    // Mirrors the real MenuRadioItem: it reads "checked" and calls "action".
    // Anything else is ignored, exactly as React would ignore it, so a wrong
    // prop name shows up here as an unknown prop rather than passing silently.
    // 'key' is React's own and never reaches the component.
    const KNOWN_RADIO = new Set(['key', 'id', 'label', 'checked', 'action', 'disabled', 'subtext', 'color']);
    const record = (props) => {
      if (!props || !props.label) return;
      for (const k of Object.keys(props)) {
        if (!KNOWN_RADIO.has(k)) window.__menuState.badProps.push(k);
      }
      window.__menuState.items.push({ id: props.id, label: props.label, checked: props.checked === true });
    };
    const h = (tag) => (props, ...children) => {
      if (tag === 'MenuRadioItem') record(props);
      if (tag === 'MenuGroup' && props && props.label) window.__menuState.groups.push(props.label);
      return { tag, props: props || {}, children: children.flat().filter(Boolean) };
    };
    // A real click is pointerdown -> mousedown -> mouseup -> click. Programmatic
    // el.click() fires only the last one, which is how a capture-phase
    // pointerdown listener can tear the menu down mid-gesture without any test
    // noticing.
    window.__realClick = (el) => {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true }));
      }
    };

    window.__stubKit = () => {
      const kit = window.api && window.api.kit;
      if (!kit || kit.__stubbed) return;
      kit.__stubbed = true;
      // Enough React to model what Discord's menu does: a component is invoked
      // to produce the tree, and a state change makes it run again. Without the
      // re-render the moving radio tick could not be observed.
      let repaint = () => {};
      // The Menu element's own onClose, which is the one Discord calls.
      let menuNode = null;
      const cells = new Map();
      let cell = 0;
      kit.react = {
        createElement: (tag, props, ...kids) => h(tag)(props, ...kids),
        useState: (init) => {
          const key = cell++;
          if (!cells.has(key)) cells.set(key, init);
          return [cells.get(key), (next) => {
            cells.set(key, typeof next === 'function' ? next(cells.get(key)) : next);
            repaint();
          }];
        },
      };
      kit.menu = 'Menu';
      kit.menuGroup = 'MenuGroup';
      kit.menuRadio = 'MenuRadioItem';
      // Discord's own dismissal: the layer goes, and the Menu's onClose runs.
      kit.closeContextMenu = () => {
        window.__menuState.closed += 1;
        const host = document.getElementById('fake-menu');
        if (!host) return;
        if (window.__dropAway) { window.__dropAway(); window.__dropAway = null; }
        document.body.removeChild(host);
        const onClose = menuNode && menuNode.props && menuNode.props.onClose;
        if (typeof onClose === 'function') onClose();
      };
      kit.openContextMenu = (event, render) => {
        window.__menuState.opened += 1;
        const host = document.createElement('div');
        host.id = 'fake-menu';
        host.setAttribute('role', 'menu');
        const walk = (node) => {
          if (!node) return;
          if (typeof node === 'function') {
            // A bare function is NOT a valid React child. Only a component
            // *element* is callable, so this throws the way React would; it is
            // what stops the view being passed to Menu as a plain child.
            throw new Error('Functions are not valid as a React child');
          }
          if (typeof node !== 'object') return;
          if (Array.isArray(node)) { node.forEach(walk); return; }
          if (typeof node.tag === 'function') { walk(node.tag(node.props)); return; }
          if (node.tag === 'Menu') menuNode = node;
          if (node.tag === 'MenuRadioItem') {
            const el = document.createElement('button');
            el.type = 'button';
            el.setAttribute('role', 'menuitemradio');
            el.setAttribute('data-id', node.props.id || '');
            el.setAttribute('aria-checked', String(node.props.checked === true));
            el.dataset.label = node.props.label || '';
            el.addEventListener('click', () => node.props.action && node.props.action());
            host.appendChild(el);
          }
          walk(node.children);
        };
        cell = 0;
        repaint = () => { host.textContent = ''; menuNode = null; walk(render()); };
        repaint();
        // The real layer dismisses itself on a click outside; ours must cope
        // with that rather than implement it.
        const away = (e) => {
          if (host.contains(e.target)) return;
          kit.closeContextMenu();
        };
        document.addEventListener('pointerdown', away, true);
        window.__dropAway = () => document.removeEventListener('pointerdown', away, true);
        document.body.appendChild(host);
        return true;
      };
    };
  `);
  await writeFile(path.join(dir,'index.html'), `<!doctype html><meta charset="utf-8"><body><script src="boot.js"></script><script src="bundle.js"></script></body>`);

  const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    await page.goto(pathToFileURL(path.join(dir, 'index.html')).href);

    // ── the pure policy ───────────────────────────────────────────────
    const policy = await page.evaluate(() => {
      const { TYPING_MODES, effectiveMode, isTypingMode, shouldDropOutgoing, shouldDriveTyping, isOutgoingTypingAction } = window.api;
      const outgoing = { type: 'TYPING_START_LOCAL', channelId: 'c' };
      return {
        labels: TYPING_MODES.map((m) => m.label),
        values: TYPING_MODES.map((m) => m.value),
        outgoingName: window.api.OUTGOING_TYPING_ACTION,
        // Only the outgoing action is ever the outgoing action.
        exact: [
          isOutgoingTypingAction(outgoing),
          isOutgoingTypingAction({ type: 'TYPING_START' }),
          isOutgoingTypingAction({ type: 'TYPING_STOP_LOCAL' }),
          isOutgoingTypingAction({ type: 'BATCHED_TYPING_START_LOCAL' }),
          isOutgoingTypingAction({ type: 'typing_start_local' }),
          isOutgoingTypingAction({ channelId: 'c' }),
          isOutgoingTypingAction('TYPING_START_LOCAL'),
          isOutgoingTypingAction(null),
        ],
        // The switch gates the mode; with it off, hide is the only answer.
        modes: [
          effectiveMode(false, 'always'),
          effectiveMode(false, 'default'),
          effectiveMode(false, 'hide'),
          effectiveMode(true, 'always'),
          effectiveMode(true, 'default'),
          effectiveMode(true, 'hide'),
          effectiveMode(true, 'nonsense'),
        ],
        isMode: [isTypingMode('always'), isTypingMode('nope'), isTypingMode(7)],
        drops: [
          shouldDropOutgoing('hide', outgoing),
          shouldDropOutgoing('always', outgoing),
          shouldDropOutgoing('default', outgoing),
          shouldDropOutgoing('hide', { type: 'MESSAGE_CREATE' }),
        ],
        drives: [
          shouldDriveTyping('always', true),
          shouldDriveTyping('always', false),
          shouldDriveTyping('hide', true),
          shouldDriveTyping('default', true),
        ],
        interval: window.api.ALWAYS_TYPING_INTERVAL_MS,
      };
    });

    assert.deepEqual(policy.labels, ['Hide Typing', 'Always typing', 'No select'],
      'the three options must be exactly as specified');
    assert.deepEqual(policy.values, ['hide', 'always', 'default']);
    assert.equal(policy.outgoingName, 'TYPING_START_LOCAL');
    assert.deepEqual(policy.exact, [true, false, false, false, false, false, false, false],
      'only the exact outgoing action may match');
    // Switch off: always/default/hide all collapse to hide.
    assert.deepEqual(policy.modes, ['hide', 'hide', 'hide', 'always', 'default', 'hide', 'hide'],
      'the switch must gate the mode, and unknown values fall back to hide');
    assert.deepEqual(policy.isMode, [true, false, false]);
    assert.deepEqual(policy.drops, [true, false, false, false],
      'only Hide Typing drops the action, and only that action');
    assert.deepEqual(policy.drives, [true, false, false, false],
      'only Always typing drives, and never while hidden');
    // TypingStore refuses a repeat inside 0.8 * 10s, so the driver must beat
    // that window without hammering it.
    assert.ok(policy.interval > 0 && policy.interval <= 8000,
      `the driver interval must stay inside the store's 8s window, got ${policy.interval}`);
    console.log(`PASS: mode policy — ${policy.labels.join(' / ')}, driver every ${policy.interval / 1000}s`);

    // ── the three modes at runtime ────────────────────────────────────
    const runtime = await page.evaluate(async () => {
      // boot() initialises settings before any plugin starts. Without this,
      // settings.get() ignores everything written to it and returns the schema
      // default, so the plugin would read "hide" in every run.
      window.__store = {};
      await window.api.settings.init();

      const run = async (easyChange, mode) => {
        window.__mountComposer();
        const sent = [];
        const flux = {
          dispatch(a) { sent.push(a); return a; },
          subscribe() {}, unsubscribe() {},
        };
        const typing = { getTypingUsers: () => ({ u: Date.now() }), isTyping: () => true, emitChange() {} };

        window.__store = {};
        window.Syncord = {
          settings: window.api.settings,
          common: { stores: { TypingStore: typing, SelectedChannelStore: { getChannelId: () => 'chan-1' } }, flux: { FluxDispatcher: flux } },
          webpack: { getRequire: () => undefined, find: () => undefined, findByStoreName: () => undefined, findByProps: () => undefined },
        };

        window.api.settings.set('plugins.hide-typing.data.easyChange', easyChange);
        if (mode) window.api.settings.set('plugins.hide-typing.data.typingMode', mode);

        const log = [];
        const ctx = {
          plugin: { id: 'hide-typing', name: 'Hide Typing' },
          log: Object.fromEntries(['log', 'info', 'warn', 'error'].map((l) => [l, (...a) => log.push([l, ...a.map(String)])])),
          disposable: (fn) => (window.__c ||= []).push(fn),
          patch: {
            instead(obj, method, hook) {
              const original = obj[method];
              obj[method] = function (...args) { return hook(args, original.bind(this)); };
              return () => { obj[method] = original; };
            },
            before: () => () => {}, after: () => () => {},
          },
          css: { inject: () => {} },
          settings: window.api.settings,
        };

        await window.api.HideTypingPlugin.start(ctx);
        await new Promise((r) => setTimeout(r, 60));

        // What happens to the user's own typing action?
        const before = sent.length;
        flux.dispatch({ type: 'TYPING_START_LOCAL', channelId: 'chan-1' });
        const ownActionReached = sent.length - before;

        // The driver only exists in Always typing; give it one cycle and count
        // only what was emitted after the manual dispatch.
        const mark = sent.length;
        await new Promise((r) => setTimeout(r, 500));
        const driven = sent.slice(mark).filter((a) => a.type === 'TYPING_START_LOCAL').length;

        await new Promise((r) => setTimeout(r, 120));
        const hidden = typing.getTypingUsers('chan-1');
        const hasButton = !!document.getElementById('Syncord-typing-mode-button');

        for (const fn of window.__c ?? []) { try { fn(); } catch {} }
        window.__c = [];
        window.__clearComposer();
        return { ownActionReached, driven, hidden, hasButton, log };
      };

      return {
        hide: await run(true, 'hide'),
        always: await run(true, 'always'),
        none: await run(true, 'default'),
        off: await run(false, 'always'),
      };
    });

    assert.equal(runtime.hide.ownActionReached, 0, 'Hide Typing must swallow the action');
    assert.equal(runtime.always.ownActionReached, 1, 'Always typing must let it through');
    assert.equal(runtime.none.ownActionReached, 1, 'No select must let it through');
    assert.equal(runtime.off.ownActionReached, 0, 'with the switch off, the mode is fixed to hide');
    console.log('PASS: Hide Typing drops it, Always typing and No select pass it through');

    assert.ok(runtime.always.driven >= 1, 'Always typing must emit typing by itself');
    assert.equal(runtime.hide.driven, 0, 'Hide Typing must not drive anything');
    assert.equal(runtime.none.driven, 0, 'No select must not drive anything');
    assert.equal(runtime.off.driven, 0, 'with the switch off, nothing is driven');
    console.log('PASS: only Always typing keeps the indicator lit by itself');

    for (const key of ['hide', 'always', 'none', 'off']) {
      assert.deepEqual(runtime[key].hidden, {}, 'incoming typing stays hidden in every mode');
    }
    assert.equal(runtime.hide.hasButton, true, 'the chat input button appears when the switch is on');
    assert.equal(runtime.off.hasButton, false, 'the button is absent when the switch is off');
    console.log('PASS: incoming stays hidden, and the button follows the switch');

    // ── the button and the native menu ────────────────────────────────
    const button = await page.evaluate(async () => {
      window.__clearComposer();
      window.__stubKit();
      window.__store = {};
      window.api.settings.set('plugins.hide-typing.data.easyChange', true);
      window.api.settings.set('plugins.hide-typing.data.typingMode', 'hide');
      window.__mountComposer();
      window.__menuState = { opened: 0, closed: 0, items: [], groups: [], badProps: [] };

      const flux = { dispatch(a) { return a; }, subscribe() {}, unsubscribe() {} };
      const typing = { getTypingUsers: () => ({}), isTyping: () => false, emitChange() {} };
      window.Syncord = {
        settings: window.api.settings,
        common: { stores: { TypingStore: typing, SelectedChannelStore: { getChannelId: () => 'c' } }, flux: { FluxDispatcher: flux } },
        webpack: { getRequire: () => undefined, find: () => undefined, findByStoreName: () => undefined, findByProps: () => undefined },
      };

      const cleanups = [];
      const ctx = {
        plugin: { id: 'hide-typing', name: 'Hide Typing' },
        log: Object.fromEntries(['log', 'info', 'warn', 'error'].map((l) => [l, () => {}])),
        disposable: (fn) => cleanups.push(fn),
        patch: {
          instead(obj, method, hook) {
            const original = obj[method];
            obj[method] = function (...args) { return hook(args, original.bind(this)); };
            return () => { obj[method] = original; };
          },
          before: () => () => {}, after: () => () => {},
        },
        css: { inject: () => {} },
        settings: window.api.settings,
      };

      await window.api.HideTypingPlugin.start(ctx);
      await new Promise((r) => setTimeout(r, 200));

      const node = document.getElementById('Syncord-typing-mode-button');
      const out = { exists: !!node, native: true };
      if (node) {
        out.inBar = !!node.closest('[class*="channelBottomBarArea"]');
        out.classes = node.className;
        out.borrowsClasses = node.className.includes('button');
        // The nested wrapper and icon holder are what make it look native.
        out.hasWrapper = !!node.querySelector('[class*="buttonWrapper"]');
        out.hasIconHolder = !!node.querySelector('[class*="lottieIcon"]');
        out.hasIcon = !!node.querySelector('svg path');
        out.role = node.getAttribute('role');
        out.ariaLabel = node.getAttribute('aria-label');
        out.liveWhenHidden = node.dataset.live;

        const sendRow = node.parentElement;
        const sendButton = document.querySelector('[class*="sendIcon"]')?.closest('[class*="container"]');
        out.beforeSend = !!sendButton && sendButton.parentElement === sendRow &&
          sendRow.children[sendRow.children.length - 1] === sendButton;

        window.__realClick(node);
        await new Promise((r) => setTimeout(r, 60));
        out.opened = window.__menuState.opened;
        out.items = window.__menuState.items.map((i) => ({ ...i }));
        out.groups = [...window.__menuState.groups];
        out.badProps = [...new Set(window.__menuState.badProps)];
        out.menuInDom = !!document.getElementById('fake-menu');
        out.menuRole = document.getElementById('fake-menu')?.getAttribute('role');
        out.menuItemRoles = [...document.querySelectorAll('#fake-menu button')]
          .map((b) => b.getAttribute('role'));
        out.expanded = node.getAttribute('aria-expanded');

        // Pick "Always typing" and confirm it applied, live.
        const always = [...document.querySelectorAll('#fake-menu button')]
          .find((b) => b.dataset.label === 'Always typing');
        // The whole gesture, so a listener that swallows the click is caught.
        window.__realClick(always);
        await new Promise((r) => setTimeout(r, 120));
        out.stored = window.api.settings.get('plugins.hide-typing.data.typingMode');
        // An exclusive choice leaves the menu up, with the tick moved, so the
        // other options stay reachable.
        out.stillOpen = !!document.getElementById('fake-menu');
        out.closedOnPick = window.__menuState.closed;
        out.ticked = [...document.querySelectorAll('#fake-menu button')]
          .filter((b) => b.getAttribute('aria-checked') === 'true')
          .map((b) => b.dataset.label);
        out.expandedAfter = node.getAttribute('aria-expanded');
        out.liveWhenAlways = node.dataset.live;

        // Clicking away is what dismisses it.
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
        await new Promise((r) => setTimeout(r, 60));
        out.closed = window.__menuState.closed;
        out.menuGone = !document.getElementById('fake-menu');
        out.expandedDismissed = node.getAttribute('aria-expanded');

        // And the button must still open a menu afterwards. If the open flag
        // outlives the menu, every later click just tries to close one that is
        // no longer there, and the button looks dead.
        out.openedBefore = window.__menuState.opened;
        window.__realClick(node);
        await new Promise((r) => setTimeout(r, 60));
        out.reopened = window.__menuState.opened - out.openedBefore;
        out.reopenedInDom = !!document.getElementById('fake-menu');
        out.tickedAgain = [...document.querySelectorAll('#fake-menu button')]
          .filter((b) => b.getAttribute('aria-checked') === 'true')
          .map((b) => b.dataset.label);
      }

      for (const fn of cleanups) { try { fn(); } catch {} }
      window.__clearComposer();
      return out;
    });

    assert.equal(button.exists, true, 'the button must be created');
    assert.equal(button.native, true);
    assert.equal(button.inBar, true, 'the button must live inside the chat input bar');
    assert.equal(button.borrowsClasses, true, `it must borrow Discord's button classes, got "${button.classes}"`);
    assert.equal(button.hasWrapper, true, 'it must reuse Discord inner wrapper structure');
    assert.equal(button.hasIconHolder, true, 'the icon must sit in Discord icon holder, for size and colour');
    assert.equal(button.hasIcon, true, 'it must render an icon');
    assert.equal(button.role, 'button');
    assert.equal(button.beforeSend, true, 'it must sit immediately before the send button');
    assert.match(button.ariaLabel ?? '', /Hide Typing/);
    assert.equal(button.liveWhenHidden, 'false', 'the button is not marked live for Hide Typing');
    console.log('PASS: the button reuses Discord wrapper, icon holder and button classes');

    // The menu must be Discord's, not a lookalike.
    assert.equal(button.opened, 1, 'opening must go through CONTEXT_MENU_OPEN');
    assert.equal(button.menuInDom, true, 'Discord must render the menu');
    assert.equal(button.menuRole, 'menu');
    assert.deepEqual(button.menuItemRoles, ['menuitemradio', 'menuitemradio', 'menuitemradio'],
      'every option must be a native radio item');
    assert.deepEqual(button.items.map((i) => i.label), ['Hide Typing', 'Always typing', 'No select'],
      'the three options, in order');
    assert.deepEqual(button.badProps, [], `only real MenuRadioItem props, got extra: ${button.badProps.join(', ')}`);
    assert.deepEqual(button.items.map((i) => i.checked), [true, false, false],
      'the tick follows `checked`, and it must start on the current mode');
    assert.deepEqual(button.groups, ['Typing indicator'], 'the options sit in a labelled group');
    assert.equal(button.expanded, 'true', 'aria-expanded must follow the menu');
    console.log("PASS: the options menu is Discord's own Menu and MenuRadioItem");

    assert.equal(button.stored, 'always', 'choosing an option must persist it');
    assert.equal(button.stillOpen, true, 'an exclusive choice keeps the menu open');
    assert.equal(button.closedOnPick, 0, 'picking must not dismiss the menu');
    assert.deepEqual(button.ticked, ['Always typing'], 'the tick must move to the chosen option');
    assert.equal(button.expandedAfter, 'true', 'aria-expanded stays true while the menu is up');
    assert.equal(button.liveWhenAlways, 'true', 'Always typing marks the button live');
    console.log('PASS: choosing an option applies live and moves the tick');

    assert.equal(button.closed >= 1, true, 'clicking away must close the native menu');
    assert.equal(button.menuGone, true, 'the menu must leave the DOM');
    assert.equal(button.expandedDismissed, 'false', 'aria-expanded must reset on dismissal');

    assert.equal(button.reopened, 1, 'the button must open a fresh menu after one was dismissed');
    assert.equal(button.reopenedInDom, true, 'the reopened menu must be in the DOM');
    assert.deepEqual(button.tickedAgain, ['Always typing'],
      'the reopened menu must show the mode that was chosen, not the old one');
    console.log('PASS: the button stays usable after the menu is dismissed');

    assert.deepEqual(errors, [], `no page errors, got: ${errors.join(', ')}`);
    console.log('\nAll hide-typing checks passed.');
  } finally {
    await browser.close();
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
