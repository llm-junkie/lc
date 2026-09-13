/**
 * Accepted lc_whiteboard contract fixtures.
 *
 * Keep this module dependency-free. Phase 0 freezes the public and persisted
 * shapes before the implementation modules exist. Later phase tests consume
 * these values as inputs instead of inventing narrower local examples.
 */

export const WHITEBOARD_MAX_BYTES = 32 * 1024;
export const WHITEBOARD_MAX_IMPORT_BYTES = 128 * 1024;
export const WHITEBOARD_MAX_IMPORT_OUTPUT_BYTES = 64 * 1024;

export const WHITEBOARD_TURN_REFS_FIXTURE = Object.freeze({
  user_board: 'u_0822142950012',
  model_initial_board: 'm_0822143055123',
  model_latest_board: 'm_0822143119048',
});

export const WHITEBOARD_UNCHANGED_TURN_REFS_FIXTURE = Object.freeze({
  user_board: 'u_0822142950012',
  model_initial_board: 'm_0822143055123',
  model_latest_board: 'm_0822143055123',
});

export const WHITEBOARD_VALID_INPUT_FIXTURES = Object.freeze([
  { label: 'read', input: { action: 'read' } },
  { label: 'replace', input: { action: 'replace', content: '# Current model notes\n\nNext step.' } },
  { label: 'clear', input: { action: 'replace', content: '' } },
  { label: 'whitespace document', input: { action: 'replace', content: ' \n\t' } },
  { label: 'edit', input: { action: 'edit', old_string: 'Next step.', new_string: 'Done.' } },
  { label: 'delete', input: { action: 'edit', old_string: 'Delete me', new_string: '' } },
  { label: 'whitespace match', input: { action: 'edit', old_string: '  ', new_string: '\t' } },
  { label: 'unchanged edit', input: { action: 'edit', old_string: 'same', new_string: 'same' } },
]);

export const WHITEBOARD_INVALID_INPUT_FIXTURES = Object.freeze([
  { label: 'missing action', input: {} },
  { label: 'unknown action', input: { action: 'append', content: 'x' } },
  { label: 'read content', input: { action: 'read', content: 'unexpected' } },
  { label: 'read edit fields', input: { action: 'read', old_string: 'x', new_string: 'y' } },
  { label: 'replace missing content', input: { action: 'replace' } },
  { label: 'replace edit field', input: { action: 'replace', content: 'x', new_string: 'y' } },
  { label: 'edit missing old string', input: { action: 'edit', new_string: 'y' } },
  { label: 'edit missing new string', input: { action: 'edit', old_string: 'x' } },
  { label: 'edit empty old string', input: { action: 'edit', old_string: '', new_string: 'y' } },
  { label: 'edit content field', input: { action: 'edit', content: 'x', old_string: 'x', new_string: 'y' } },
  { label: 'unknown field', input: { action: 'read', owner: 'user' } },
]);

export const WHITEBOARD_READ_OUTPUT_FIXTURE = Object.freeze({
  refs: WHITEBOARD_TURN_REFS_FIXTURE,
  user_markdown: '# User priorities\n\nPreserve the public API.',
  model_markdown: '# Model notes\n\nFocused tests passed.',
});

export const WHITEBOARD_MUTATION_OUTPUT_FIXTURE = Object.freeze({
  refs: WHITEBOARD_TURN_REFS_FIXTURE,
  changed: true,
  model_bytes: 36,
});

export const WHITEBOARD_MODEL_VISIBLE_TEXT_FIXTURE = Object.freeze({
  description:
    'Read both conversation boards or change only the model board.\n' +
    'Send one whiteboard call per batch and wait for its result.\n' +
    'Read before mutation only when you do not know the current exact model content.\n' +
    'The user board is fixed for this turn.\n' +
    'Model reads include your latest applied change in this turn.\n' +
    'Each board has a 32 KiB UTF-8 limit.',
  schemaDescriptions: Object.freeze({
    action: 'Select one form. Read uses action only. Replace adds content. Edit adds old_string and new_string.',
    content: 'For replace only, send the complete model-board Markdown. An empty string clears the board.',
    old_string: 'For edit only, send one non-empty exact string that occurs once in the model board.',
    new_string: 'For edit only, send the exact replacement. An empty string deletes the matched text.',
  }),
  systemPrompt: Object.freeze([
    'Use lc_whiteboard to read the conversation boards and change only the model board.',
    'The user board is fixed for this turn. User edits made now appear in the next turn.',
    'Model board reads show your latest applied change in the current turn.',
  ]),
  skillWorkflow:
    'Use `lc_whiteboard` to record durable handoff context. Verify recorded paths and claims again after a transfer.',
});

export const WHITEBOARD_ISSUE_FIXTURES = Object.freeze({
  invalid_arguments: {
    retryable: false,
    message: 'The action and supplied fields do not form one valid whiteboard operation.',
    remedy: 'Send one valid read, replace, or edit input. Do not send fields from another action.',
  },
  whiteboard_not_initialized: {
    retryable: true,
    message: 'The enabled conversation has no valid initial board records.',
    remedy: 'Retry once after LC repairs initialization. If it repeats, continue without the board.',
  },
  whiteboard_version_missing: {
    retryable: false,
    message: 'A pinned or current whiteboard version is unavailable.',
    remedy: 'Do not retry the missing ID. Report that the retained version is unavailable.',
  },
  whiteboard_read_failed: {
    retryable: true,
    message: 'LC could not read the pinned or current board record.',
    remedy: 'Retry the read once. Continue without the board if the read fails again.',
  },
  whiteboard_write_failed: {
    retryable: true,
    message: 'LC could not save the new model-board content.',
    remedy: 'Retry after LC storage is available. Read the board before a later exact edit.',
  },
  whiteboard_old_string_not_found: {
    retryable: false,
    message: 'old_string does not occur in the current model board.',
    remedy: 'Call lc_whiteboard with action read before you retry the edit.',
  },
  whiteboard_old_string_not_unique: {
    retryable: false,
    message: 'old_string occurs more than once in the current model board.',
    remedy: 'Use a longer exact string that occurs once.',
  },
  whiteboard_too_large: {
    retryable: false,
    message: 'The resulting model board exceeds 32 KiB of UTF-8 text.',
    remedy: 'Reduce the resulting Markdown to 32 KiB or less.',
  },
  whiteboard_batch_conflict: {
    retryable: false,
    message: 'The batch declares more than one lc_whiteboard call.',
    remedy: 'Send one intended whiteboard call in a later batch and wait for its result.',
  },
  aborted: {
    retryable: false,
    message: 'The owning generation ended before the whiteboard operation completed.',
    remedy: 'Read the current boards in a later turn before you continue.',
  },
});

export const WHITEBOARD_VERSION_ID_FIXTURES = Object.freeze({
  controlledNow: 1_787_401_790_012,
  user: 'u_0822142950012',
  model: 'm_0822142950012',
  shape: /^[um]_\d{13}$/,
  sameMillisecondCandidates: [
    'm_0822142950012',
    'm_0822142950013',
    'm_0822142950014',
  ],
  rollbackCandidates: [
    'u_0822142950012',
    'u_0822142950013',
  ],
  collision: Object.freeze({
    errorName: 'ConstraintError',
    existingId: 'm_0822142950012',
    existingContent: '# Immutable existing content',
    retryId: 'm_0822142950013',
    expectedExistingContent: '# Immutable existing content',
  }),
});

export const WHITEBOARD_STORAGE_FIXTURES = Object.freeze({
  initialUser: {
    conversationId: 'conv-whiteboard',
    id: 'u_0822142950012',
    owner: 'user',
    content: '',
    createdAt: 1_787_401_790_012,
    sequence: 1,
    sourceMessageId: null,
    sourceToolCallId: null,
  },
  initialModel: {
    conversationId: 'conv-whiteboard',
    id: 'm_0822142950012',
    owner: 'model',
    content: '',
    createdAt: 1_787_401_790_012,
    sequence: 2,
    sourceMessageId: null,
    sourceToolCallId: null,
  },
  pendingUser: {
    conversationId: 'conv-whiteboard',
    owner: 'user',
    content: '# Pending user copy',
  },
  provisionalModel: {
    conversationId: 'conv-whiteboard',
    owner: 'model',
    id: 'm_0822143119048',
    content: '# Provisional model copy',
    generationId: 'generation-1',
    assistantMessageId: 'assistant-1',
    latestToolCallId: 'whiteboard-call-2',
  },
  retainedUser: {
    conversationId: 'conv-whiteboard',
    id: 'u_0822143020000',
    owner: 'user',
    content: '# Retained user copy',
    createdAt: 1_787_401_820_000,
    sequence: 3,
    sourceMessageId: 'user-1',
    sourceToolCallId: null,
  },
  retainedModel: {
    conversationId: 'conv-whiteboard',
    id: 'm_0822143119048',
    owner: 'model',
    content: '# Retained model copy',
    createdAt: 1_787_401_879_048,
    sequence: 4,
    sourceMessageId: 'assistant-1',
    sourceToolCallId: 'whiteboard-call-2',
  },
});

/** Exact pre-whiteboard measurements. Phase 2 replaces the live fixture. */
export const WHITEBOARD_BEFORE_CHANGE_TOKEN_FIXTURE = Object.freeze({
  toolPayload: 6_456,
  schemaPayload: 2_407,
  schemaPayloadWithoutDescriptions: 2_099,
  systemPromptOneRoot: 496,
  systemPromptTwoRoots: 500,
  systemPromptLinux: 434,
  completeFixedSurface: 6_956,
  lcToolsSkill: 676,
  builtInToolCount: 20,
  categoryCount: 7,
});

export const WHITEBOARD_LIFECYCLE_FIXTURES = Object.freeze([
  { name: 'no mutation', terminal: 'success', mutations: [], retained: 0 },
  { name: 'one mutation', terminal: 'success', mutations: ['A'], retained: 1 },
  { name: 'many mutations', terminal: 'success', mutations: ['A', 'B', 'C'], retained: 1 },
  { name: 'same content', terminal: 'success', mutations: [''], retained: 0 },
  { name: 'provider failure', terminal: 'provider_error', mutations: ['A'], retained: 1 },
  { name: 'user interruption', terminal: 'aborted', mutations: ['A'], retained: 1 },
  { name: 'timeout', terminal: 'timeout', mutations: ['A'], retained: 1 },
  { name: 'cutoff', terminal: 'cutoff', mutations: ['A'], retained: 1 },
  { name: 'late worker', terminal: 'settled_before_write', mutations: ['A'], retained: 0 },
]);

export const WHITEBOARD_BRANCH_FIXTURES = Object.freeze([
  {
    name: 'retry',
    survivingMessageIds: ['user-1'],
    removedMessageIds: ['assistant-1', 'tool-1'],
    removedVersionIds: ['m_0822143119048'],
    preservedVersionIds: ['u_0822142950012', 'm_0822142950012', 'u_0822143020000'],
    promotePendingUser: false,
  },
  {
    name: 'edit-and-resend with pending copy',
    survivingMessageIds: ['user-1'],
    removedMessageIds: ['assistant-1', 'tool-1'],
    removedVersionIds: ['u_0822143020000', 'm_0822143119048'],
    preservedVersionIds: ['u_0822142950012', 'm_0822142950012'],
    promotePendingUser: true,
  },
]);

export const WHITEBOARD_TERMINAL_REPAIR_FIXTURES = Object.freeze([
  {
    name: 'committed mutation without result',
    receipt: 'whiteboard-call-2',
    expectedStatus: 'ok',
    expectedWarning: 'LC applied this whiteboard change before the generation ended.',
  },
  {
    name: 'accepted call without mutation receipt',
    receipt: null,
    expectedStatus: 'aborted',
    expectedWarning: null,
  },
]);

export const WHITEBOARD_REQUEST_PROJECTION_FIXTURES = Object.freeze([
  {
    toolHistoryEnabled: false,
    historicalArguments: { action: 'replace', content: '# Full historical model content' },
    historicalResult: {
      refs: WHITEBOARD_TURN_REFS_FIXTURE,
      user_markdown: '# Full historical user content',
      model_markdown: '# Full historical model content',
    },
    expectedProjection: 'full',
  },
  {
    toolHistoryEnabled: true,
    historicalArguments: { action: 'replace', content: '# Hidden from the request stub' },
    historicalResult: { model_markdown: '# Hidden from the request stub' },
    expectedProjection: 'generic-stub',
  },
]);

export const WHITEBOARD_UI_STATE_FIXTURES = Object.freeze([
  { name: 'wide current', width: 1200, layout: 'tabbed', model: 'current', user: 'current' },
  { name: 'narrow current', width: 640, layout: 'tabbed', model: 'current', user: 'current' },
  { name: 'independent history', width: 1200, layout: 'tabbed', model: 'historical', user: 'current' },
  { name: 'editing saved', width: 1200, layout: 'tabbed', model: 'current', user: 'editing' },
  { name: 'live anchored', width: 1200, layout: 'tabbed', model: 'live-anchored', user: 'current' },
  { name: 'live unanchored', width: 1200, layout: 'tabbed', model: 'live-unanchored', user: 'current' },
  { name: 'older selection with update', width: 1200, layout: 'tabbed', model: 'historical-newer-available', user: 'current' },
  { name: 'missing model version', width: 1200, layout: 'tabbed', model: 'unavailable', user: 'current' },
  { name: 'missing user version', width: 1200, layout: 'tabbed', model: 'current', user: 'unavailable' },
]);

export const WHITEBOARD_OVERLAY_EXIT_FIXTURES = Object.freeze([
  { path: 'close button', dirty: true, confirmed: false, closes: false },
  { path: 'Escape', dirty: true, confirmed: false, closes: false },
  { path: 'backdrop', dirty: true, confirmed: false, closes: false },
  { path: 'conversation switch', dirty: true, confirmed: false, closes: false },
  { path: 'Preview Overlay opening', dirty: true, confirmed: false, closes: false },
  { path: 'conversation deletion', dirty: true, confirmed: false, closes: false },
  { path: 'parent unmount', dirty: true, confirmed: false, closes: false },
  { path: 'confirmation UI failure', dirty: true, confirmed: null, closes: false },
  { path: 'saved close', dirty: false, confirmed: null, closes: true },
]);

export const WHITEBOARD_PREVIEW_EXCLUSION_FIXTURES = Object.freeze([
  { whiteboardOpen: true, previewPinned: true, previewAutoOpen: true, previewVisible: false },
  { whiteboardOpen: false, previewPinned: true, previewAutoOpen: false, previewVisible: true },
  { whiteboardOpen: false, previewPinned: false, previewAutoOpen: true, previewVisible: true },
  { whiteboardOpen: false, previewPinned: false, previewAutoOpen: false, previewVisible: false },
]);

export const WHITEBOARD_EXPORT_SOURCE_FIXTURES = Object.freeze([
  { model: 'retained-current', user: 'retained-current' },
  { model: 'historical', user: 'historical' },
  { model: 'historical', user: 'pending-rendered' },
  { model: 'live-provisional', user: 'retained-current' },
  { model: 'live-provisional', user: 'raw-editor' },
]);

export const WHITEBOARD_EXPORT_FIXTURE = Object.freeze({
  requestedFilename: 'lc-whiteboard-2026-08-22-1430.zip',
  browserCollisionFilename: 'lc-whiteboard-2026-08-22-1430 (1).zip',
  entries: Object.freeze({
    'model.md': '# Visible model board',
    'user.md': '# Visible user board',
  }),
  notice: 'Export captures exactly what you see now.',
});

export const WHITEBOARD_IMPORT_ELIGIBILITY_FIXTURES = Object.freeze([
  { name: 'initial baselines', eligible: true },
  { name: 'changed model board', eligible: false },
  { name: 'changed then cleared', eligible: false },
  { name: 'pending user copy', eligible: false },
  { name: 'provisional model copy', eligible: false },
  { name: 'active generation in this conversation', eligible: false },
  { name: 'active generation in another conversation', eligible: true },
]);

export const WHITEBOARD_IMPORT_FILENAME_FIXTURES = Object.freeze([
  { name: 'lc-whiteboard-2026-08-22-1430.zip', accepted: true },
  { name: 'lc-whiteboard-2026-08-22-1430 (1).zip', accepted: true },
  { name: 'lc-whiteboard-2026-08-22-1430 (9999).zip', accepted: true },
  { name: 'lc-whiteboard-2026-02-29-1430.zip', accepted: false },
  { name: 'LC-whiteboard-2026-08-22-1430.zip', accepted: false },
  { name: 'lc-whiteboard-2026-08-22-1430 (0).zip', accepted: false },
  { name: 'lc-whiteboard-2026-08-22-1430 (10000).zip', accepted: false },
  { name: 'renamed.zip', accepted: false },
]);

export const WHITEBOARD_IMPORT_REJECTION_FIXTURES = Object.freeze([
  'compressed input above 128 KiB',
  'missing model.md',
  'missing user.md',
  'duplicate model.md',
  'unexpected root entry',
  'nested entry',
  'directory entry',
  'absolute entry',
  'traversal entry',
  'entry output above 32 KiB',
  'combined output above 64 KiB',
  'invalid UTF-8',
  'malformed compression',
  'both documents empty',
]);

export const WHITEBOARD_STREAMING_ZIP_FIXTURES = Object.freeze([
  { name: 'stored export round trip', compression: 'store', accepted: true },
  { name: 'deflate export round trip', compression: 'deflate', accepted: true },
  { name: 'undefined originalSize', originalSize: undefined, actualBytes: 8, accepted: true },
  { name: 'understated originalSize', originalSize: 1, actualBytes: 32_769, accepted: false },
  { name: 'duplicate local entry', entries: ['model.md', 'model.md', 'user.md'], accepted: false },
  { name: 'central-directory-only alias', entries: ['model.md', 'user.md'], centralAlias: '../model.md', accepted: true },
  { name: 'fatal UTF-8 decode', bytes: [0xc3, 0x28], accepted: false },
  { name: 'malformed deflate', bytes: [0x03, 0xff, 0x00], accepted: false },
]);

export const WHITEBOARD_CONSTRAINED_MODEL_FIXTURES = Object.freeze([
  {
    name: 'batch conflict recovery',
    observation: 'No whiteboard call in the rejected batch ran.',
    expectedNextAction: 'Send one intended lc_whiteboard call in a later batch and wait for its result.',
  },
  {
    name: 'read edit reread',
    observation: 'The exact current model text is not known.',
    expectedNextAction: 'Read, send one exact edit, wait, and read again only when verification is needed.',
  },
  {
    name: 'pinned user comprehension',
    observation: 'The user edits the user board during generation.',
    expectedNextAction: 'Keep using the pinned user version and the latest applied model version for this turn.',
  },
  {
    name: 'failure continuity',
    observation: 'A changed model board committed before the provider failed.',
    expectedNextAction: 'Treat the applied change as retained and read the current boards before a later exact edit.',
  },
]);
