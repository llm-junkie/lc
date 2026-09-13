import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  applyWhiteboardToolsConfigChange,
  createWhiteboardToolsConfigChangeCoordinator,
} from './whiteboard-toggle.ts';
import { whiteboardExportNotice } from './whiteboard-ui-text.ts';

const overlaySource = readFileSync(new URL('./WhiteboardOverlay.tsx', import.meta.url), 'utf8');
const iconSource = readFileSync(new URL('./WhiteboardIcon.tsx', import.meta.url), 'utf8');
const previewSource = readFileSync(new URL('./PreviewOverlay.tsx', import.meta.url), 'utf8');
const askUserSource = readFileSync(new URL('./AskUserModal.tsx', import.meta.url), 'utf8');
const permissionSource = readFileSync(new URL('./ToolPermissionModal.tsx', import.meta.url), 'utf8');
const composerSource = readFileSync(new URL('../chat/Composer.tsx', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('../chat/ChatView.tsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../layout/Sidebar.tsx', import.meta.url), 'utf8');
const shortcutSource = readFileSync(
  new URL('../../modules/chat-pipeline/shortcuts.ts', import.meta.url),
  'utf8',
);
const globalShortcutSource = readFileSync(new URL('../../utils/shortcuts.ts', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../../../src/index.css', import.meta.url), 'utf8');
const solidCssSource = readFileSync(new URL('../../../src/themes/solid.css', import.meta.url), 'utf8');

test('overlay is a labelled single-board modal with accessible owner tabs', () => {
  assert.match(overlaySource, /role="dialog"/);
  assert.match(overlaySource, /aria-modal="true"/);
  assert.match(overlaySource, /aria-labelledby="whiteboard-title"/);
  assert.match(overlaySource, /className="conv-filter-tabs whiteboard-owner-tabs"[^]*role="tablist"/);
  assert.match(overlaySource, /id="whiteboard-model-tab"[^]*role="tab"[^]*aria-selected=\{activeOwner === 'model'\}/);
  assert.match(overlaySource, /id="whiteboard-user-tab"[^]*role="tab"[^]*aria-selected=\{activeOwner === 'user'\}/);
  assert.match(overlaySource, /role="tabpanel"[^]*aria-labelledby=\{`whiteboard-\$\{activeOwner\}-tab`\}/);
  assert.match(overlaySource, /event\.key === 'Home'[^]*event\.key === 'End'[^]*'ArrowLeft'[^]*'ArrowRight'/);
  assert.equal(overlaySource.match(/onKeyDown=\{handleOwnerTabKeyDown\}/g)?.length, 2);
  assert.match(overlaySource, /ownerScrollTopRef\.current\[activeOwner\]/);
  assert.match(overlaySource, /ownerScrollTopRef\.current\.model = event\.currentTarget\.scrollTop/);
  assert.match(overlaySource, /ownerScrollTopRef\.current\.user = event\.currentTarget\.scrollTop/);
  assert.match(overlaySource, /aria-label=\{WHITEBOARD_UI_TEXT\.modelMarkdown\}/);
  assert.match(overlaySource, /whiteboard-history[^]*whiteboardPreviousVersionLabel\(owner\)/);
  assert.match(overlaySource, /whiteboard-history[^]*whiteboardNextVersionLabel\(owner\)/);
  assert.equal(overlaySource.match(/className="whiteboard-history-chevron"/g)?.length, 2);
  assert.match(overlaySource, /<polyline points="15 18 9 12 15 6" \/>/);
  assert.match(overlaySource, /<polyline points="9 18 15 12 9 6" \/>/);
  assert.doesNotMatch(overlaySource, /[‹›]/);
  assert.match(overlaySource, /useOverlayEscape\(\(\) => \{ void attemptCloseRef\.current\('escape'\); \}\)/);
});

test('modal chrome uses the LC header and Conversations-style footer actions', () => {
  const header = overlaySource.slice(
    overlaySource.indexOf('<header className="whiteboard-header"'),
    overlaySource.indexOf('</header>') + '</header>'.length,
  );
  const footer = overlaySource.slice(
    overlaySource.indexOf('<footer className="whiteboard-footer"'),
    overlaySource.indexOf('</footer>') + '</footer>'.length,
  );
  assert.match(
    overlaySource,
    /<h3 id="whiteboard-title" title=\{WHITEBOARD_UI_TEXT\.description\}>[^]*\{WHITEBOARD_UI_TEXT\.title\}[^]*<\/h3>/,
  );
  assert.doesNotMatch(overlaySource, /whiteboard-header-summary/);
  assert.equal(overlaySource.match(/className="ghost-btn small"/g)?.length, 2);
  assert.doesNotMatch(header, /handleImport|handleExport|ghost-btn/);
  assert.match(footer, /handleExport[^]*<ExportIcon \/>/);
  assert.match(footer, /handleImport[^]*<ImportIcon \/>/);
  assert.match(overlaySource, /function ExportIcon\(\)[^]*M12 4v10[^]*M7 9l5 5 5-5/);
  assert.match(overlaySource, /function ImportIcon\(\)[^]*M12 14V4[^]*M7 9l5-5 5 5/);
  assert.match(
    overlaySource,
    /aria-label=\{WHITEBOARD_UI_TEXT\.closeWhiteboard\}[^]*<svg[^>]*width="18"[^>]*height="18"[^>]*aria-hidden[^]*?<path[^>]*fill="currentColor"/,
  );
  assert.doesNotMatch(overlaySource, /<span aria-hidden>×<\/span>/);
  assert.match(cssSource, /\.whiteboard-dialog \{[^}]*border-radius: 12px;/s);
  assert.match(cssSource, /\.whiteboard-header \{[^}]*min-height: 50px;[^}]*padding: 0 12px 0 16px;/s);
  assert.match(cssSource, /\.whiteboard-header h3 \{[^}]*font-size: 15px;[^}]*font-weight: 600;/s);
  assert.match(cssSource, /\.whiteboard-footer \{[^}]*display: flex;[^}]*min-height: 48px;/s);
  assert.match(cssSource, /\.whiteboard-footer-actions \{[^}]*display: flex;[^}]*gap: 8px;/s);
});

test('user editing is bounded, persistent, previewed, and fail-closed on exit', () => {
  assert.match(overlaySource, /const draftMarkdown = state\.userEditor\.draftMarkdown/);
  assert.match(overlaySource, /savePendingUserWhiteboard\(conversationId, draftMarkdown\)/);
  assert.match(overlaySource, /saveInFlightRef\.current/);
  assert.match(overlaySource, /commit-user-edit', markdown: draftMarkdown/);
  assert.match(overlaySource, /whiteboardByteCounter\(state\.userEditor\.draftMarkdown\)/);
  assert.match(overlaySource, /WHITEBOARD_UI_TEXT\.save/);
  assert.match(overlaySource, /WHITEBOARD_UI_TEXT\.cancel/);
  assert.match(overlaySource, /dispatch\(\{ type: 'cancel-user-edit' \}\)/);
  assert.doesNotMatch(overlaySource, /WHITEBOARD_UI_TEXT\.saveAndPreview/);
  assert.match(
    overlaySource,
    /savePendingUserWhiteboard\(conversationId, draftMarkdown\)[^]*commit-user-edit', markdown: draftMarkdown[^]*await refresh\(\)/,
  );
  assert.match(overlaySource, /registerWhiteboardOverlayExitGuard/);
  assert.match(overlaySource, /pendingExitRef\.current\?\.resolve\(false\)/);
  assert.match(overlaySource, /WHITEBOARD_UI_TEXT\.discardTitle/);
  assert.doesNotMatch(overlaySource, /safeConfirm|window\.confirm/);
});

test('export captures visible strings before awaiting and import uses the gated transaction', () => {
  const exportAt = overlaySource.indexOf('const handleExport = async');
  const importAt = overlaySource.indexOf('const handleImport = async');
  assert.notEqual(exportAt, -1);
  assert.notEqual(importAt, -1);
  const exportBody = overlaySource.slice(exportAt, importAt);
  assert.match(exportBody, /captureWhiteboardVisibleExport\(state, documents\)/);
  assert.match(exportBody, /const modelMarkdown = capture\.entries\['model\.md'\]/);
  assert.match(exportBody, /const userMarkdown = capture\.entries\['user\.md'\]/);
  assert.match(exportBody, /createWhiteboardPackage\(\{ modelMarkdown, userMarkdown \}\)/);
  assert.match(exportBody, /saveBlobFile\(filename, archive/);
  assert.match(overlaySource, /snapshot\.provisionalModel\?\.updatedAt \?\? snapshot\.modelHead\?\.createdAt/);
  assert.match(overlaySource, /snapshot\.pendingUser\?\.updatedAt \?\? snapshot\.userHead\?\.createdAt/);
  assert.match(overlaySource, /owner === 'user' && userEditing[^]*WHITEBOARD_UI_TEXT\.unsavedDraft/);
  assert.match(overlaySource, /<span>\{exportNotice\}<\/span>/);

  const importBody = overlaySource.slice(importAt);
  assert.match(importBody, /pickWhiteboardPackageFile\(\)/);
  assert.match(importBody, /readWhiteboardPackage\(\{ name: file\.name, data: file \}\)/);
  assert.match(importBody, /importWhiteboardPackageIntoEmptyConversation\(conversationId, contents\)/);
  assert.match(overlaySource, /snapshot\?\.importEligible[^]*&& !runtimeBusy[^]*&& state\.userEditor\.mode === 'rendered'/);
});

test('export notice names both selected owner versions', () => {
  assert.equal(
    whiteboardExportNotice('Aug 23, 2026, 10:42:30 PM', 'Aug 22, 2026, 9:15:00 AM'),
    "Export model's board (Aug 23, 2026, 10:42:30 PM) and user's board (Aug 22, 2026, 9:15:00 AM).",
  );
});

test('composer action-row launch control, preview exclusion, and first-enable initialization are wired', () => {
  const actionsAt = composerSource.indexOf('className="composer-action-row"');
  const attachAt = composerSource.indexOf('aria-label="Attach file(s) or image(s)"', actionsAt);
  const launcherAt = composerSource.indexOf("'whiteboard-action-btn'", attachAt);
  const actionsEnd = composerSource.indexOf('</div>', launcherAt);
  assert.ok(actionsAt >= 0 && actionsAt < attachAt && attachAt < launcherAt && launcherAt < actionsEnd);
  assert.doesNotMatch(chatSource, /whiteboard-toggle-area|whiteboard-toggle-btn/);
  assert.match(chatSource, /conv\.tools\?\.enabled && conv\.tools\.whiteboard_enabled/);
  assert.match(composerSource, /aria-label=\{WHITEBOARD_UI_TEXT\.open\}/);
  assert.match(composerSource, /composer-action-label[^]*WHITEBOARD_UI_TEXT\.title/);
  const launcherBlock = composerSource.slice(launcherAt, actionsEnd);
  assert.doesNotMatch(launcherBlock, /tabIndex/);
  assert.match(chatSource, /open=\{overlayOpen && !whiteboardOpen\}/);
  assert.match(chatSource, /await initializeWhiteboard\(whiteboardTargetConversationId\)/);
  assert.match(chatSource, /window\.addEventListener\('lc:open-whiteboard', onOpenWhiteboard\)/);
  assert.match(
    globalShortcutSource,
    /mod\(e\) && e\.key\.toLowerCase\(\) === 'b'[^]*dispatchEvent\(new CustomEvent\('lc:open-whiteboard'\)\)/,
  );
  assert.match(chatSource, /conv\.tools\?\.enabled && conv\.tools\.whiteboard_enabled/);
  assert.match(previewSource, /useOverlayEscape\(onClose, open\)/);
});

test('closing Whiteboard does not reveal an unpinned composer action row through focus', () => {
  assert.match(
    chatSource,
    /const focusTarget = pinComposer[^]*whiteboard-action-btn[^]*\.messages[^]*focusTarget\?\.focus\(\)/,
  );
});

test('controlled navigation and shortcuts route through the discard guard', () => {
  for (const reason of [
    'conversation-switch',
    'conversation-delete',
    'new-conversation',
    'settings-open',
  ]) {
    assert.match(sidebarSource, new RegExp(`requestWhiteboardOverlayExit\\('${reason}'\\)`));
  }
  assert.match(shortcutSource, /requestWhiteboardOverlayExit\('new-conversation'\)/);
  assert.match(shortcutSource, /requestWhiteboardOverlayExit\('settings-open'\)/);
  assert.match(shortcutSource, /requestWhiteboardOverlayExit\('reload'\)/);
  assert.match(chatSource, /requestWhiteboardOverlayExit\('preview-open'\)/);
});

test('responsive, focus, hidden-launch, and solid surfaces are explicit', () => {
  assert.match(cssSource, /\.composer-wrap \{[^}]*display: flex;[^}]*flex-direction: column;/s);
  assert.doesNotMatch(cssSource, /composer-whiteboard-row/);
  assert.doesNotMatch(cssSource, /whiteboard-toggle-area|whiteboard-toggle-btn/);
  assert.match(
    cssSource,
    /\.whiteboard-action-icon \{[^}]*width: 14px;[^}]*height: 14px;/s,
  );
  assert.match(cssSource, /\.whiteboard-header \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\)/s);
  assert.match(cssSource, /\.whiteboard-owner-tabs \{[^}]*justify-self: center;[^}]*width: 164px;/s);
  assert.match(cssSource, /\.whiteboard-board \{[^}]*display: flex;[^}]*background: var\(--bg\);/s);
  assert.match(cssSource, /\.whiteboard-pane \{[^}]*background: transparent;[^}]*border: 0;[^}]*border-radius: 0;/s);
  assert.match(cssSource, /\.whiteboard-board-toolbar \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\);[^}]*min-height: 44px;/s);
  assert.match(cssSource, /\.whiteboard-history \{[^}]*grid-column: 2;[^}]*justify-self: center;/s);
  assert.match(cssSource, /\.whiteboard-user-action-group \{[^}]*grid-column: 3;[^}]*justify-self: end;/s);
  assert.match(overlaySource, /\{activeOwner === 'user' && \([^]*whiteboard-user-action-group/);
  assert.match(overlaySource, /ghost-btn small whiteboard-user-action[^]*WHITEBOARD_UI_TEXT\.cancel/);
  assert.match(overlaySource, /primary-btn small whiteboard-user-action[^]*WHITEBOARD_UI_TEXT\.save/);
  assert.doesNotMatch(overlaySource, /whiteboard-user-actions/);
  assert.match(cssSource, /\.whiteboard-board-toolbar\.is-editing \{[^}]*grid-template-rows: auto auto;/s);
  assert.doesNotMatch(cssSource, /\.whiteboard-panes/);
  assert.doesNotMatch(solidCssSource, /:root\.solid \.whiteboard-pane,/);
  assert.match(cssSource, /\.whiteboard-pane-body:focus-visible/);
  assert.match(overlaySource, /a\[href\][^]*button:not\(:disabled\)/);
  assert.match(overlaySource, /confirmReturnFocusRef/);
  assert.match(overlaySource, /inert=\{confirmOpen\}/);
  assert.match(solidCssSource, /:root\.solid \.whiteboard-dialog/);
  assert.match(solidCssSource, /:root\.solid \.whiteboard-confirm/);
  assert.match(askUserSource, /className="modal-backdrop ask-user-backdrop"/);
  assert.match(permissionSource, /className="modal-backdrop tool-permission-backdrop"/);
  assert.match(askUserSource, /useOrderedOverlayLayer\(Boolean\(request\)\)/);
  assert.match(permissionSource, /useOverlayKeys\(\{ Escape: \(\) => \{\} \}, Boolean\(call\)\)/);
  assert.match(permissionSource, /useOrderedOverlayLayer\(Boolean\(call\)\)/);
  assert.match(
    cssSource,
    /\.modal-backdrop\.ask-user-backdrop,[^]*\.modal-backdrop\.tool-permission-backdrop \{[^}]*z-index: 10200;/,
  );
});

test('Whiteboard icon embeds the selected board.svg artwork with theme-aware fill', () => {
  assert.match(iconSource, /viewBox="0 0 24 24"/);
  assert.match(iconSource, /M17\.8944 5\.44721C18\.1414/);
  assert.match(iconSource, /M23 4C23 2\.34315/);
  assert.match(iconSource, /fill="currentColor"/);
  assert.match(iconSource, /fillRule="evenodd" clipRule="evenodd"/);
  assert.doesNotMatch(iconSource, /508\.023|M493\.911/);
});

test('first enable never overwrites a newer Workspace-off or sibling config change', async () => {
  type Config = {
    enabled: boolean;
    whiteboard_enabled: boolean;
    web_access_enabled: boolean;
  };
  let releaseInitialization!: () => void;
  const initialization = new Promise<void>((resolve) => { releaseInitialization = resolve; });
  let current: Config = {
    enabled: true,
    whiteboard_enabled: false,
    web_access_enabled: true,
  };
  const commits: Config[] = [];
  const pending = applyWhiteboardToolsConfigChange({
    next: { ...current, whiteboard_enabled: true },
    getCurrent: () => current,
    initialize: () => initialization,
    commit: (next) => {
      commits.push(next);
      current = next;
    },
  });
  current = { ...current, enabled: false };
  releaseInitialization();
  assert.equal(await pending, false);
  assert.equal(commits.length, 0);
  assert.equal(current.enabled, false);

  current = { ...current, enabled: true, web_access_enabled: true };
  let releaseSecond!: () => void;
  const secondInitialization = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const rebased = applyWhiteboardToolsConfigChange({
    next: { ...current, whiteboard_enabled: true },
    getCurrent: () => current,
    initialize: () => secondInitialization,
    commit: (next) => {
      commits.push(next);
      current = next;
    },
  });
  current = { ...current, web_access_enabled: false };
  releaseSecond();
  assert.equal(await rebased, true);
  assert.equal(current.whiteboard_enabled, true);
  assert.equal(current.web_access_enabled, false);

  const preservedOff: Config = {
    enabled: false,
    whiteboard_enabled: true,
    web_access_enabled: false,
  };
  current = preservedOff;
  let initialized = false;
  const reenabled = await applyWhiteboardToolsConfigChange({
    next: { ...preservedOff, enabled: true },
    getCurrent: () => current,
    initialize: async () => { initialized = true; },
    commit: (next) => {
      commits.push(next);
      current = next;
    },
  });
  assert.equal(initialized, true);
  assert.equal(reenabled, true);
  assert.equal(current.enabled, true);
  assert.equal(current.whiteboard_enabled, true);
});

test('a stale first-visible completion cannot discard a later sibling setting', async () => {
  type Config = {
    enabled: boolean;
    whiteboard_enabled: boolean;
    web_access_enabled: boolean;
  };
  const coordinator = createWhiteboardToolsConfigChangeCoordinator();
  const initial: Config = {
    enabled: false,
    whiteboard_enabled: true,
    web_access_enabled: true,
  };
  let current = initial;
  const commits: Config[] = [];
  let releaseOlder!: () => void;
  let releaseLater!: () => void;
  const olderInitialization = new Promise<void>((resolve) => { releaseOlder = resolve; });
  const laterInitialization = new Promise<void>((resolve) => { releaseLater = resolve; });
  const apply = (
    next: Config,
    initialize: () => Promise<void>,
  ) => coordinator.apply({
    next,
    getCurrent: () => current,
    initialize,
    commit: (accepted) => {
      commits.push(accepted);
      current = accepted;
    },
  });

  const older = apply(
    { ...initial, enabled: true },
    () => olderInitialization,
  );
  const later = apply(
    { ...initial, enabled: true, web_access_enabled: false },
    () => laterInitialization,
  );

  releaseOlder();
  assert.equal(await older, false);
  assert.deepEqual(commits, []);
  releaseLater();
  assert.equal(await later, true);
  assert.deepEqual(commits, [{
    enabled: true,
    whiteboard_enabled: true,
    web_access_enabled: false,
  }]);
  assert.equal(current.web_access_enabled, false);
});

test('shared Markdown reports a committed value only after its updated DOM exists', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const globalKeys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Node',
    'MutationObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
  ] as const;
  const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const key of globalKeys) {
    originalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const requestFrame = (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    callbacks.set(id, callback);
    return id;
  };
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: (id: number) => { callbacks.delete(id); },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.assign(dom.window, {
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: (id: number) => { callbacks.delete(id); },
  });

  const container = dom.window.document.getElementById('root')!;
  const root = createRoot(container);
  const commits: Array<{ markdown: string; dom: string }> = [];
  try {
    const { useRafCommittedValue } = await import('../../utils/raf-committed-value.ts');
    const Probe = ({ markdown }: { markdown: string }) => {
      const committed = useRafCommittedValue(markdown, (value) => {
        commits.push({ markdown: value, dom: container.textContent ?? '' });
      });
      return createElement('div', null, committed);
    };
    const render = (markdown: string) => createElement(Probe, { markdown });
    await act(async () => root.render(render('# First')));
    await act(async () => root.render(render('# Second')));
    assert.equal(commits.some((entry) => entry.markdown === '# Second'), false);

    await act(async () => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(16);
      await Promise.resolve();
    });
    const finalCommit = commits.at(-1);
    assert.equal(finalCommit?.markdown, '# Second');
    assert.match(finalCommit?.dom ?? '', /Second/);
    assert.doesNotMatch(finalCommit?.dom ?? '', /First/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of globalKeys) {
      const descriptor = originalDescriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
