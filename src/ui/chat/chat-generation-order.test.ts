import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./ChatView.tsx', import.meta.url), 'utf8');
const lifecycleSource = readFileSync(new URL('./generation-lifecycle.ts', import.meta.url), 'utf8');
const composerSource = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8');
const messageBubbleSource = readFileSync(new URL('./MessageBubble.tsx', import.meta.url), 'utf8');
const reasoningBodySource = readFileSync(new URL('./ReasoningBody.tsx', import.meta.url), 'utf8');
const chunkedMarkdownSource = readFileSync(new URL('./ChunkedMarkdown.tsx', import.meta.url), 'utf8');
const transcriptScrollSource = readFileSync(
  new URL('./useTranscriptScroll.ts', import.meta.url),
  'utf8',
);
const sidebarSource = readFileSync(new URL('../layout/Sidebar.tsx', import.meta.url), 'utf8');
const modelPickerSource = readFileSync(new URL('./ModelPicker.tsx', import.meta.url), 'utf8');
const shortcutsSource = readFileSync(
  new URL('../../modules/chat-pipeline/shortcuts.ts', import.meta.url),
  'utf8',
);
const styles = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

function callbackBody(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing callback boundary: ${start}`);
  assert.notEqual(to, -1, `missing callback boundary: ${end}`);
  return source.slice(from, to);
}

function assertOrdered(body: string, earlier: string, later: string): void {
  const earlierAt = body.indexOf(earlier);
  const laterAt = body.indexOf(later);
  assert.notEqual(earlierAt, -1, `missing expected preflight step: ${earlier}`);
  assert.notEqual(laterAt, -1, `missing expected commit step: ${later}`);
  assert.ok(earlierAt < laterAt, `${earlier} must precede ${later}`);
}

test('Retry completes async preflight before replacing persisted history', () => {
  const retry = callbackBody(
    'const retry = useCallback',
    'const editAndResend = useCallback',
  );
  assertOrdered(retry, 'acquireChatGenerationAdmission', 'await resolveGenerationPreflight');
  assertOrdered(retry, 'await resolveGenerationPreflight', 'replaceFromMessage(latest.id');
  assertOrdered(retry, 'acquireChatGenerationAdmission', 'replaceFromMessage(latest.id');
  assertOrdered(retry, 'commitChatGenerationAdmission', 'replaceFromMessage(latest.id');
  assert.match(retry, /await replaceFromMessage\(latest\.id/);
  assertOrdered(retry, 'await replaceFromMessage(latest.id', 'appendMessage(latest.id');
  assertOrdered(retry, 'appendMessage(latest.id', 'handoffAndRegisterGenerationSession');
});

test('Edit delegates attachment cleanup to the awaited branch replacement', () => {
  const edit = callbackBody(
    'const editAndResend = useCallback',
    'const onParamsChange =',
  );
  assertOrdered(edit, 'acquireChatGenerationAdmission', 'await resolveGenerationPreflight');
  assertOrdered(edit, 'await resolveGenerationPreflight', 'replaceFromMessage(latest.id');
  assertOrdered(edit, 'acquireChatGenerationAdmission', 'replaceFromMessage(latest.id');
  assertOrdered(edit, 'commitChatGenerationAdmission', 'replaceFromMessage(latest.id');
  assert.match(edit, /await replaceFromMessage\(latest\.id/);
  assertOrdered(edit, 'await replaceFromMessage(latest.id', 'appendMessage(latest.id');
  assertOrdered(edit, 'appendMessage(latest.id', 'handoffAndRegisterGenerationSession');
  assert.doesNotMatch(
    edit,
    /removeAttachmentBlob/,
    'the store branch boundary owns cleanup before this callback can append',
  );
});

test('Send holds one admission lease across durable user append and streaming handoff', () => {
  const send = callbackBody('const send = async', 'const currentConvId =');
  assertOrdered(send, 'acquireChatGenerationAdmission', 'resolveChatCredential');
  assertOrdered(send, 'resolveChatCredential', 'await appendUserMessage');
  assertOrdered(send, 'acquireChatGenerationAdmission', 'await appendUserMessage');
  assertOrdered(send, 'commitChatGenerationAdmission', 'await appendUserMessage');
  assertOrdered(send, 'await appendUserMessage', 'appendMessage(convId');
  assertOrdered(send, 'appendMessage(convId', 'handoffAndRegisterGenerationSession');
});

test('Transcript scrolling is limited to restore, Send, and successful turn completion', () => {
  const restoreStart = transcriptScrollSource.indexOf(
    '// Stored scroll state is a conversation-switch restore point',
  );
  const sendJumpStart = transcriptScrollSource.indexOf('// One explicit post-Send jump');
  assert.notEqual(restoreStart, -1);
  assert.notEqual(sendJumpStart, -1);

  const restore = transcriptScrollSource.slice(restoreStart, sendJumpStart);
  assert.match(restore, /useLayoutEffect\(\(\) =>/);
  assert.match(restore, /get\(conversationId\)\.scrollTop/);
  assert.match(restore, /\}, \[captureResizeAnchor, conversationId\]\);/);
  assert.doesNotMatch(
    restore,
    /presentationUi\.scrollTop/,
    'active onScroll updates must not be fed back into the DOM',
  );

  assert.doesNotMatch(transcriptScrollSource, /useEffect/);
  assert.doesNotMatch(transcriptScrollSource, /requestAnimationFrame/);
  assert.doesNotMatch(transcriptScrollSource, /latestVisibleContent|\bbusy\b/);
  assert.doesNotMatch(source, /latestVisibleContent:/);
  assert.match(source, /NON_COMPLETION_SCROLL_REASONS/);
  assert.match(source, /'disconnected'/);
  assert.match(source, /'error'/);
  assert.match(source, /completedAssistantMessageId: completedAssistantMessageId\(conv\?\.messages\)/);
  assert.match(transcriptScrollSource, /new ResizeObserver/);
  assert.match(transcriptScrollSource, /container\.scrollTop \+= offsetDelta/);
  assert.match(transcriptScrollSource, /\.messages-inner > \.bubble/);
  assert.equal(
    transcriptScrollSource.match(/\.scrollTo\(/g)?.length,
    3,
    'only conversation restore, Send, and successful completion may move the transcript',
  );
  assert.match(
    transcriptScrollSource.slice(sendJumpStart),
    /behavior: 'instant' as ScrollBehavior/,
  );
  assert.match(transcriptScrollSource, /behavior: 'smooth'/);
  assert.match(
    transcriptScrollSource,
    /observed\.assistantMessageId !== completedAssistantMessageId/,
  );

  const messagesRule = styles.slice(
    styles.indexOf('.messages {'),
    styles.indexOf('/* Quarter-circle button', styles.indexOf('.messages {')),
  );
  assert.doesNotMatch(
    messagesRule,
    /overflow-anchor:\s*none/,
    'native anchoring must keep visible transcript content stable during resize reflow',
  );
  assert.doesNotMatch(messagesRule, /scroll-behavior:\s*smooth/);
  const bottomSpacerRule = styles.slice(
    styles.indexOf('.messages-bottom-spacer {'),
    styles.indexOf('.messages-empty {', styles.indexOf('.messages-bottom-spacer {')),
  );
  assert.match(bottomSpacerRule, /overflow-anchor:\s*none/);
});

test('committed manager registration failure retires the handed-off store owner', () => {
  const from = lifecycleSource.indexOf('export async function handoffAndRegisterGenerationSession');
  const to = lifecycleSource.indexOf('export interface GenerationExitTarget', from);
  assert.notEqual(from, -1);
  assert.notEqual(to, -1);
  const helper = lifecycleSource.slice(from, to);
  assertOrdered(helper, 'handoffGenerationBlockingOperationToStreaming', 'startCommittedGenerationSession');
  assertOrdered(helper, 'startCommittedGenerationSession', 'finalizeStreamingOwner');
  assertOrdered(helper, 'finalizeStreamingOwner', 'releaseStreamingOwnerWhenDurable');
  assertOrdered(helper, 'releaseStreamingOwnerWhenDurable', 'unmarkStreaming');
});

test('Composer takes and restores the draft through conversation-scoped ownership', () => {
  // Draft state moved out of component-local `useState` into `conversation-ui`
  // so a switch no longer destroys it. The send path must take the draft
  // without releasing its attachment blobs — an accepted send transfers their
  // ownership to the message — and put it back when the boundary is rejected.
  const submitAt = composerSource.indexOf('const submit = async () =>');
  const keyHandlerAt = composerSource.indexOf('const onKey =', submitAt);
  assert.notEqual(submitAt, -1);
  assert.notEqual(keyHandlerAt, -1);
  const submit = composerSource.slice(submitAt, keyHandlerAt);
  assert.match(submit, /takeDraft\(conversationId\)/);
  assert.match(submit, /await onSend\(trimmed, submittedAttachments\)/);
  assert.match(submit, /if \(!accepted\)/);
  assert.match(
    submit,
    /restoreDraft\(conversationId, submittedText, submittedAttachments, uiLifetime\)/s,
  );
  assert.doesNotMatch(
    submit,
    /removeAttachmentBlob/,
    'an accepted send must not delete the blobs it just handed to the message',
  );
});

test('Composer is no longer remounted per conversation', () => {
  // The `key` was what destroyed drafts on every switch and orphaned their
  // staged attachment blobs.
  assert.doesNotMatch(source, /<Composer[\s\S]{0,40}?key=/);
  assert.match(source, /conversationId=\{conv\.id\}/);
});

test('generation capacity refusal keeps its specific user-facing reason', () => {
  assert.match(
    source,
    /const reason = generationAdmissionBlockReason\(conversationId\);[\s\S]*?toast\.info\(reason\)/,
  );
  assert.match(
    source,
    /All \\d\+ generation slots are in use/,
  );
  assert.match(source, /disabled=\{loadingMessages \|\| !messageHistoryComplete\}/);
  assert.match(source, /sendDisabled=\{generationAdmissionLocked\}/);
  assert.match(composerSource, /disabled=\{disabled \|\| sendDisabled \|\|/);
  assert.match(composerSource, /<textarea[\s\S]*?disabled=\{disabled\}/);
  const textareaStart = composerSource.indexOf('<textarea');
  const textareaEnd = composerSource.indexOf('/>', textareaStart);
  assert.doesNotMatch(composerSource.slice(textareaStart, textareaEnd), /sendDisabled/);
});

test('sidebar and keyboard controls target the addressed conversation session', () => {
  assert.match(sidebarSource, /requestGenerationStop\(item\.id\)/);
  assert.match(sidebarSource, /Retry final conversation storage write/);
  assert.match(sidebarSource, /generationPhase === 'finalizing'/);
  assert.match(sidebarSource, /disabled=\{generationPhase === 'stopping' \|\| generationPhase === 'finalizing'\}/);
  assert.match(shortcutsSource, /useConversations\.getState\(\)\.activeId/);
  assert.match(shortcutsSource, /ui\.setSidePanel\(conversationId/);
  assert.doesNotMatch(shortcutsSource, /useSettings\.getState\(\)\.toggleSidePanel/);
});

test('message edits keep their complete draft and async blob ownership outside the bubble', () => {
  assert.doesNotMatch(messageBubbleSource, /useState\(message\.content\)/);
  assert.match(messageBubbleSource, /beginEdit\(/);
  assert.match(messageBubbleSource, /setEditDraftText\(/);
  assert.match(messageBubbleSource, /addEditAttachments\(/);
  assert.match(messageBubbleSource, /beginConversationUiWork\(conversationId\)/);
  assert.match(messageBubbleSource, /cancelEdit\(/);
  assert.match(source, /finishEdit\(latest\.id, messageId, editSessionId\)/);
  assert.match(messageBubbleSource, /startEditSubmission\(/);
  assert.match(messageBubbleSource, /disabled=\{editSubmitting\}/);
  assert.match(source, /m\.role === 'user' && !busy && !editSubmitting/);
  assert.match(source, /conversationId=\{conv\.id\}/);
});

test('Composer progressively collapses action labels below 600px and 470px', () => {
  assert.match(styles, /\.chat-view\s*{[^}]*container:\s*chat\s*\/\s*inline-size/s);
  assert.match(
    styles,
    /@container\s+chat\s*\(width\s*<\s*600px\)\s*{[\s\S]*?\.attach-action-btn \.composer-action-label,[\s\S]*?\.whiteboard-action-btn \.composer-action-label\s*{\s*display:\s*none;/,
  );
  const firstStep = styles.slice(
    styles.indexOf('@container chat (width < 600px)'),
    styles.indexOf('/* At the second', styles.indexOf('@container chat (width < 600px)')),
  );
  assert.doesNotMatch(firstStep, /\.tools-action-btn \.composer-action-label/);
  assert.match(
    styles,
    /@container\s+chat\s*\(width\s*<\s*470px\)\s*{[\s\S]*?\.composer-action-row \.composer-action-btn\s*{[\s\S]*?\.composer-action-label\s*{\s*display:\s*none;/,
  );
  assert.match(composerSource, /className="composer-action-btn attach-action-btn"/);
  assert.equal(
    composerSource.match(/className="composer-action-label"/g)?.length,
    4,
  );
  assert.match(
    composerSource,
    /aria-label={`Active preset: \$\{presetLabel\(presetName, presetParams\)\} — open the params panel`}/,
  );
});

test('Preview tabs progressively fold labels below 550px and counts below 350px', () => {
  assert.match(
    styles,
    /@container\s+chat\s*\(width\s*<\s*550px\)\s*{[\s\S]*?\.preview-overlay-tab-label\s*{\s*display:\s*none;/,
  );
  assert.match(
    styles,
    /@container\s+chat\s*\(width\s*<\s*350px\)\s*{\s*\.preview-overlay-tab-badge\s*{\s*display:\s*none;/,
  );
  assert.ok(
    styles.indexOf('.preview-overlay-tab-badge {')
      < styles.indexOf('@container chat (width < 350px)'),
    'the second-step override must follow the default badge display rule',
  );
});

test('Tool preview drops row timestamps and right-aligns duration below a 500px chat width', () => {
  assert.match(
    styles,
    /@container\s+chat\s*\(width\s*<\s*500px\)\s*{\s*\.tools-body-time\s*{\s*display:\s*none;/,
  );
  assert.match(
    styles,
    /@container\s+chat\s*\(width\s*<\s*500px\)\s*{[\s\S]*?\.tools-body-duration\s*{\s*margin-left:\s*auto;/,
    'the duration must take over the hidden timestamp as the right-aligned row metadata',
  );
  assert.doesNotMatch(
    styles,
    /@container\s+chat\s*\(width\s*<\s*500px\)\s*{[\s\S]*?\.tools-body-duration\s*{\s*display:\s*none;/,
    'the compact tool row must retain execution duration',
  );
});

test('Sidebar navigation is unblocked while structural actions stay target-scoped', () => {
  // Phase 2 split one blanket guard into two. Navigation no longer waits for a
  // response — it belongs to its conversation, not to the visible pane — while
  // renaming, archiving, cloning, or deleting still refuses a target that owns
  // a live generation.
  assert.match(
    sidebarSource,
    /const conversationNavigationLocked = \(\) => isConversationCorpusMutationActive\(\)/,
  );
  assert.doesNotMatch(
    sidebarSource,
    /isAnyStreaming\(\)/,
    'no Sidebar guard may ask whether *any* conversation is streaming',
  );

  const bodyOf = (handler: string): string => {
    const handlerAt = sidebarSource.indexOf(`const ${handler} =`);
    assert.notEqual(handlerAt, -1, `missing Sidebar handler: ${handler}`);
    const nextHandlerAt = sidebarSource.indexOf('\n  const ', handlerAt + 8);
    return sidebarSource.slice(
      handlerAt,
      nextHandlerAt === -1 ? sidebarSource.length : nextHandlerAt,
    );
  };

  // Navigation: refused only by a corpus mutation that is about to invalidate
  // every row, and by the foreground Whiteboard discard guard.
  for (const handler of ['cycleUp', 'cycleDown', 'handleNewChat', 'switchToTab']) {
    assert.match(bodyOf(handler), /conversationNavigationLocked\(\)/, handler);
  }
  assert.match(bodyOf('handleSelect'), /isConversationCorpusMutationActive\(\)/);
  for (const handler of ['cycleUp', 'cycleDown', 'handleSelect', 'handleNewChat']) {
    assert.match(
      bodyOf(handler),
      /requestWhiteboardOverlayExit\(/,
      `${handler} must still consult the foreground discard guard`,
    );
  }

  // Structure and configuration: scoped to the conversation being acted on.
  for (const handler of [
    'handleRenameStart',
    'handleRenameCommit',
    'handleArchive',
    'handleUnarchive',
    'handleClone',
    'handleDelete',
  ]) {
    assert.match(
      bodyOf(handler),
      /isConversationStructurallyLocked\(id\)/,
      `${handler} must refuse only a target that owns a live generation`,
    );
  }

  const shortcutNewAt = shortcutsSource.indexOf('const onNew = async () =>');
  const shortcutFocusAt = shortcutsSource.indexOf('const onFocus =', shortcutNewAt);
  assert.notEqual(shortcutNewAt, -1);
  assert.notEqual(shortcutFocusAt, -1);
  const shortcutNew = shortcutsSource.slice(shortcutNewAt, shortcutFocusAt);
  assert.match(shortcutNew, /isConversationCorpusMutationActive\(\)/);
  assert.doesNotMatch(shortcutNew, /isAnyStreaming|isGenerationBlockingOperationActive/);
});

test('Sidebar status and actions are scoped to their own conversation row', () => {
  assert.match(sidebarSource, /className="conv-status"/);
  assert.match(sidebarSource, /hasRowStatus && 'has-status'/);
  assert.doesNotMatch(
    sidebarSource,
    /data-streaming/,
    'one running conversation must not put the whole list into a read-only visual state',
  );
  assert.doesNotMatch(
    styles,
    /\[data-streaming\]\s+\.conv-actions/,
    'one running conversation must not hide actions on sibling rows',
  );
  assert.match(
    styles,
    /\.conv-item\.streaming \.conv-actions\s*{\s*display:\s*none !important;/,
    'only the row that owns a live generation suppresses structural actions',
  );
  assert.match(
    styles,
    /\.conv-attention-dot\.overlaid\s*{[^}]*top:\s*50%;[^}]*left:\s*50%;[^}]*transform:\s*translate\(-50%,\s*-50%\);/,
    'a permission-attention badge must be centered inside the running spinner',
  );
  assert.match(
    styles,
    /\.conv-attention-dot\s*{[^}]*font-size:\s*11px;/,
    'the permission-attention exclamation mark keeps its chosen size',
  );
  assert.match(
    styles,
    /\.conv-status\s*{[^}]*width:\s*49px;/,
    'the status slot must be exactly as wide as the 2x2 action grid',
  );
  assert.match(
    styles,
    /\.conv-item\.has-status\s*{[^}]*padding-right:\s*51px;/,
    'the row reserves only the action-grid width and its two-pixel inset',
  );
  assert.match(
    styles,
    /\.conv-meta\s*{[^}]*overflow:\s*hidden;[^}]*white-space:\s*nowrap;/,
    'timestamp and model metadata must remain on one clipped row',
  );
  assert.match(
    styles,
    /\.conv-model\s*{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/,
    'a long model id must ellipsize instead of wrapping the row',
  );
  assert.match(sidebarSource, /className="conv-complete-check"/);
  assert.match(
    styles,
    /\.conv-terminal-attention\s*{[^}]*width:\s*16px;[^}]*height:\s*16px;[^}]*border-radius:\s*50%;[^}]*background:\s*var\(--accent\);/,
    'completion must use a true accent-colored circle instead of a font-sized green badge',
  );
  assert.match(
    styles,
    /\.conv-terminal-attention\.failed\s*{[^}]*background:\s*var\(--danger\);/,
    'the existing exclamation failure state keeps its danger treatment',
  );
  assert.match(
    styles,
    /\.conv-item:hover:not\(\.streaming\) \.conv-status,[\s\S]*?display:\s*none;/,
    'an idle status must yield its reserved slot to the row action grid on hover',
  );
  assert.match(
    sidebarSource,
    /\(\) => activeGenerationCount\(\) > \(getGenerationSessionView\(activeConvId\) \? 1 : 0\)/,
    'the compact tab switch must observe whether another conversation is generating',
  );
  assert.match(
    sidebarSource,
    /filterTab === 'active'[\s\S]*?&& hasOtherActiveGenerations[\s\S]*?&& 'has-active-generations'/,
    'the compact tab switch must expose background generation only from the Inbox tab',
  );
  assert.match(
    styles,
    /\.sidebar-tab-switch-compact\.has-active-generations::before\s*{[^}]*padding:\s*1\.5px;[^}]*animation:\s*bubble-border-spin 2s linear infinite;/,
    'the compact tab switch must reuse the active assistant bubble animation with a 1.5px ring',
  );
  assert.match(
    styles,
    /\.sidebar-tab-switch-compact\s*{[^}]*border:\s*1\.5px solid transparent;/,
    'the compact tab switch must reserve its full hover-border width at rest',
  );
  assert.match(
    styles,
    /\.sidebar-tab-switch-compact:hover\s*{[^}]*border-color:\s*var\(--accent\);/,
    'hover must recolor the reserved border without changing its width',
  );
  assert.doesNotMatch(
    styles,
    /\.sidebar-tab-switch-compact:hover\s*{[^}]*\bborder:\s*/,
    'hover must not resize the compact switch border and shift its contents',
  );
  assert.match(
    styles,
    /\.bubble-assistant\.is-writing::before\s*{[^}]*padding:\s*1\.5px;[^}]*animation:\s*bubble-border-spin 2s linear infinite;/,
    'the active assistant bubble must use the same 1.5px animated ring',
  );
});

test('Collapsed tab badge opens its displayed list and reserves switching for Shift+click', () => {
  const handlerStart = sidebarSource.indexOf('const handleCompactTabClick =');
  const handlerEnd = sidebarSource.indexOf(
    '// The collapsed tab switch doubles as the background-work indicator.',
    handlerStart,
  );
  assert.notEqual(handlerStart, -1);
  assert.notEqual(handlerEnd, -1);
  const handler = sidebarSource.slice(handlerStart, handlerEnd);

  assert.match(
    handler,
    /if \(event\.shiftKey\)\s*{[\s\S]*?void switchToTab\(filterTab === 'active' \? 'archive' : 'active'\);[\s\S]*?return;/,
    'Shift+click must retain the old compact list-switch action',
  );
  assert.match(
    handler,
    /if \(filterTab !== currentCategory\) setFilterTab\(currentCategory\);[\s\S]*?toggleSidebar\(true\);/,
    'a plain click must align the expanded tab with the displayed badge before opening the sidebar',
  );
  assert.match(sidebarSource, /onClick={handleCompactTabClick}/);
  assert.match(
    sidebarSource,
    /title={`Open \$\{currentCategoryLabel\}\. Shift\+click to switch lists\.`}/,
    'the compact control must disclose its modifier shortcut',
  );
});

test('Model selection cannot split server and model during provisional admission', () => {
  // Phase 2 changed *which* guard runs, not whether one does. Configuration
  // now follows the selected conversation — a chat the user switched to during
  // another conversation's run is configurable — but the guard must still
  // precede both writes, or a provisional admission on this conversation could
  // land between them and leave the server and model disagreeing.
  assert.match(
    modelPickerSource,
    /const generationLocked = useConversations\(\(s\) => \(\s*s\.activeId \? isConversationStructurallyLocked\(s\.activeId\) : false\s*\)\);/,
  );
  const selectionStart = modelPickerSource.indexOf('const selectModel = useCallback');
  const loadStart = modelPickerSource.indexOf('const onLoad = useCallback', selectionStart);
  assert.notEqual(selectionStart, -1);
  assert.notEqual(loadStart, -1);
  const selection = modelPickerSource.slice(selectionStart, loadStart);
  assertOrdered(
    selection,
    'isSelectedConversationLocked()',
    'patchConversation(cid, { serverId: entry.profileId })',
  );
  assertOrdered(
    selection,
    'isSelectedConversationLocked()',
    'setModel(cid, modelId)',
  );
});

test('application-wide model operations keep their blanket guard', () => {
  // Loading, unloading, hiding, and refreshing reach past the selected
  // conversation: they can invalidate an execution snapshot in any of them,
  // so these deliberately still refuse while *any* generation is live.
  for (const handler of ['onUnload', 'onHide', 'onRefreshProfile']) {
    const at = modelPickerSource.indexOf(`const ${handler} = useCallback`);
    assert.notEqual(at, -1, `missing ModelPicker handler: ${handler}`);
    const nextAt = modelPickerSource.indexOf('\n  const ', at + 8);
    const body = modelPickerSource.slice(at, nextAt === -1 ? modelPickerSource.length : nextAt);
    assert.match(body, /isAnyStreaming\(\)/, `${handler} must stay application-exclusive`);
  }

  assert.match(
    modelPickerSource,
    /const applicationOperationLocked = useConversations\(\(\) => \([\s\S]*?isAnyStreaming\(\)/,
  );
  assert.match(
    modelPickerSource,
    /disabled=\{storeLoading \|\| applicationOperationLocked\}/,
    'the direct all-server refresh button uses the application-wide lock',
  );
  assert.match(
    modelPickerSource,
    /storeError[\s\S]*?disabled=\{applicationOperationLocked\}/,
    'the direct error retry uses the application-wide lock',
  );
});

test('Workspace root edits use the selected conversation lock', () => {
  const managerAt = source.indexOf('<WorkspaceManager');
  assert.notEqual(managerAt, -1);
  const manager = source.slice(managerAt, source.indexOf('/>', managerAt));
  assert.match(manager, /isConversationStructurallyLocked\(conv\.id\)/);
  const onChangeAt = manager.indexOf('onChange={(next) =>');
  const addKnownAt = manager.indexOf('onAddKnownDir=', onChangeAt);
  const onChange = manager.slice(onChangeAt, addKnownAt);
  assert.doesNotMatch(onChange, /isAnyStreaming\(\)/);
});

test('generation render subscriptions stay conversation-scoped', () => {
  assert.match(source, /subscribeToGenerationSession\(selectedConversationId, listener\)/);
  assert.doesNotMatch(source, /subscribeToGenerationSessions/);
  assert.match(sidebarSource, /subscribeToGenerationSession\(item\.id, listener\)/);
  assert.match(
    messageBubbleSource,
    /if \(!activeAssistant\) \{[\s\S]*?return;[\s\S]*?onPhaseChange\(conversationId/,
    'historical bubbles must not subscribe to active response phases',
  );
});

test('live Markdown keeps settled chunks and bounds only the growing tail', () => {
  assert.match(messageBubbleSource, /liveSurface="response"/);
  assert.match(reasoningBodySource, /liveSurface=\{streaming \? 'reasoning' : undefined\}/);
  assert.match(chunkedMarkdownSource, /selectLiveMarkdownChunkWindow\(chunks\)/);
  assert.match(chunkedMarkdownSource, /chunk\.mode === 'plain-tail'/);
  assert.match(styles, /\.streaming-markdown-plain\s*{[^}]*overflow-wrap:\s*anywhere;/);
});

test('shared Markdown styles align task lists and separate footnotes', () => {
  assert.match(
    styles,
    /\.md ul\.contains-task-list,[\s\S]*?\.md \.task-list-item\s*{[^}]*list-style:\s*none;/,
  );
  assert.match(
    styles,
    /\.md \.task-list-item > input\[type='checkbox'\]\s*{[^}]*margin:\s*0 0\.45em 0\.25em -1\.4em;[^}]*vertical-align:\s*middle;/,
  );
  assert.match(
    styles,
    /\.md section\[data-footnotes\]\s*{[^}]*border-top:\s*1px solid var\(--border\);/,
  );
});

test('to-do snapshot indexing follows transcript structure instead of token deltas', () => {
  const indexBuildAt = source.indexOf('() => buildTodoSnapshotIndex(conv?.messages ?? [])');
  assert.notEqual(indexBuildAt, -1);
  const indexBuild = source.slice(indexBuildAt, indexBuildAt + 700);
  assert.match(indexBuild, /\[conv\?\.id, loadedVersion\]/);
  assert.doesNotMatch(indexBuild, /\[conv\?\.messages\]/);
});

test('file-change indexing follows transcript structure instead of token deltas', () => {
  const indexBuildAt = source.indexOf('const lineChangesByAssistantId = useMemo');
  assert.notEqual(indexBuildAt, -1);
  const indexBuild = source.slice(indexBuildAt, indexBuildAt + 3_500);
  assert.match(indexBuild, /\[conv\?\.id, loadedVersion\]/);
  assert.doesNotMatch(indexBuild, /\}, \[conv\]\);/);
});
