import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  WHITEBOARD_BEFORE_CHANGE_TOKEN_FIXTURE,
  WHITEBOARD_BRANCH_FIXTURES,
  WHITEBOARD_CONSTRAINED_MODEL_FIXTURES,
  WHITEBOARD_EXPORT_FIXTURE,
  WHITEBOARD_EXPORT_SOURCE_FIXTURES,
  WHITEBOARD_IMPORT_ELIGIBILITY_FIXTURES,
  WHITEBOARD_IMPORT_FILENAME_FIXTURES,
  WHITEBOARD_IMPORT_REJECTION_FIXTURES,
  WHITEBOARD_INVALID_INPUT_FIXTURES,
  WHITEBOARD_LIFECYCLE_FIXTURES,
  WHITEBOARD_MAX_BYTES,
  WHITEBOARD_MAX_IMPORT_BYTES,
  WHITEBOARD_MAX_IMPORT_OUTPUT_BYTES,
  WHITEBOARD_MUTATION_OUTPUT_FIXTURE,
  WHITEBOARD_MODEL_VISIBLE_TEXT_FIXTURE,
  WHITEBOARD_ISSUE_FIXTURES,
  WHITEBOARD_OVERLAY_EXIT_FIXTURES,
  WHITEBOARD_PREVIEW_EXCLUSION_FIXTURES,
  WHITEBOARD_READ_OUTPUT_FIXTURE,
  WHITEBOARD_REQUEST_PROJECTION_FIXTURES,
  WHITEBOARD_STORAGE_FIXTURES,
  WHITEBOARD_STREAMING_ZIP_FIXTURES,
  WHITEBOARD_TERMINAL_REPAIR_FIXTURES,
  WHITEBOARD_TURN_REFS_FIXTURE,
  WHITEBOARD_UI_STATE_FIXTURES,
  WHITEBOARD_UNCHANGED_TURN_REFS_FIXTURE,
  WHITEBOARD_VALID_INPUT_FIXTURES,
  WHITEBOARD_VERSION_ID_FIXTURES,
} from './contract-fixtures.ts';

describe('lc_whiteboard Phase 0 contract fixtures', () => {
  test('freezes exact limits, turn references, and output shapes', () => {
    assert.equal(WHITEBOARD_MAX_BYTES, 32_768);
    assert.equal(WHITEBOARD_MAX_IMPORT_BYTES, 131_072);
    assert.equal(WHITEBOARD_MAX_IMPORT_OUTPUT_BYTES, 65_536);
    assert.deepEqual(Object.keys(WHITEBOARD_TURN_REFS_FIXTURE), [
      'user_board', 'model_initial_board', 'model_latest_board',
    ]);
    assert.equal(
      WHITEBOARD_UNCHANGED_TURN_REFS_FIXTURE.model_initial_board,
      WHITEBOARD_UNCHANGED_TURN_REFS_FIXTURE.model_latest_board,
    );
    assert.deepEqual(Object.keys(WHITEBOARD_READ_OUTPUT_FIXTURE), [
      'refs', 'user_markdown', 'model_markdown',
    ]);
    assert.deepEqual(Object.keys(WHITEBOARD_MUTATION_OUTPUT_FIXTURE), [
      'refs', 'changed', 'model_bytes',
    ]);
  });

  test('covers every strict operation form and invalid field combination', () => {
    assert.deepEqual(WHITEBOARD_VALID_INPUT_FIXTURES.map((fixture) => fixture.label), [
      'read', 'replace', 'clear', 'whitespace document', 'edit', 'delete',
      'whitespace match', 'unchanged edit',
    ]);
    assert.deepEqual(WHITEBOARD_INVALID_INPUT_FIXTURES.map((fixture) => fixture.label), [
      'missing action', 'unknown action', 'read content', 'read edit fields',
      'replace missing content', 'replace edit field', 'edit missing old string',
      'edit missing new string', 'edit empty old string', 'edit content field',
      'unknown field',
    ]);
  });

  test('pins owner-prefixed IDs, storage rows, and collision candidates', () => {
    const controlled = new Date(WHITEBOARD_VERSION_ID_FIXTURES.controlledNow);
    const stamp = [
      String(controlled.getMonth() + 1).padStart(2, '0'),
      String(controlled.getDate()).padStart(2, '0'),
      String(controlled.getHours()).padStart(2, '0'),
      String(controlled.getMinutes()).padStart(2, '0'),
      String(controlled.getSeconds()).padStart(2, '0'),
      String(controlled.getMilliseconds()).padStart(3, '0'),
    ].join('');
    assert.equal(WHITEBOARD_VERSION_ID_FIXTURES.user, `u_${stamp}`);
    assert.equal(WHITEBOARD_VERSION_ID_FIXTURES.model, `m_${stamp}`);
    assert.match(WHITEBOARD_VERSION_ID_FIXTURES.user, WHITEBOARD_VERSION_ID_FIXTURES.shape);
    assert.match(WHITEBOARD_VERSION_ID_FIXTURES.model, WHITEBOARD_VERSION_ID_FIXTURES.shape);
    assert.equal(new Set(WHITEBOARD_VERSION_ID_FIXTURES.sameMillisecondCandidates).size, 3);
    assert.equal(WHITEBOARD_STORAGE_FIXTURES.initialUser.sequence, 1);
    assert.equal(WHITEBOARD_STORAGE_FIXTURES.initialModel.sequence, 2);
    assert.equal(WHITEBOARD_STORAGE_FIXTURES.pendingUser.owner, 'user');
    assert.equal(WHITEBOARD_STORAGE_FIXTURES.provisionalModel.owner, 'model');
    assert.equal(WHITEBOARD_STORAGE_FIXTURES.retainedModel.sourceToolCallId, 'whiteboard-call-2');
    assert.deepEqual(WHITEBOARD_VERSION_ID_FIXTURES.collision, {
      errorName: 'ConstraintError',
      existingId: 'm_0822142950012',
      existingContent: '# Immutable existing content',
      retryId: 'm_0822142950013',
      expectedExistingContent: '# Immutable existing content',
    });
  });

  test('freezes model-visible text and every stable issue remedy', () => {
    assert.equal(WHITEBOARD_MODEL_VISIBLE_TEXT_FIXTURE.systemPrompt.length, 3);
    assert.match(WHITEBOARD_MODEL_VISIBLE_TEXT_FIXTURE.description, /one whiteboard call per batch/);
    assert.deepEqual(Object.keys(WHITEBOARD_MODEL_VISIBLE_TEXT_FIXTURE.schemaDescriptions), [
      'action', 'content', 'old_string', 'new_string',
    ]);
    assert.deepEqual(Object.keys(WHITEBOARD_ISSUE_FIXTURES), [
      'invalid_arguments', 'whiteboard_not_initialized', 'whiteboard_version_missing',
      'whiteboard_read_failed', 'whiteboard_write_failed', 'whiteboard_old_string_not_found',
      'whiteboard_old_string_not_unique', 'whiteboard_too_large',
      'whiteboard_batch_conflict', 'aborted',
    ]);
    assert.equal(WHITEBOARD_ISSUE_FIXTURES.whiteboard_batch_conflict.retryable, false);
  });

  test('freezes the complete pre-change payload measurements', () => {
    assert.deepEqual(WHITEBOARD_BEFORE_CHANGE_TOKEN_FIXTURE, {
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
  });

  test('covers lifecycle, branch, repair, and both request projections', () => {
    assert.deepEqual(new Set(WHITEBOARD_LIFECYCLE_FIXTURES.map((fixture) => fixture.terminal)), new Set([
      'success', 'provider_error', 'aborted', 'timeout', 'cutoff', 'settled_before_write',
    ]));
    assert.deepEqual(WHITEBOARD_BRANCH_FIXTURES.map((fixture) => fixture.name), [
      'retry', 'edit-and-resend with pending copy',
    ]);
    assert.deepEqual(WHITEBOARD_TERMINAL_REPAIR_FIXTURES.map((fixture) => fixture.expectedStatus), [
      'ok', 'aborted',
    ]);
    assert.deepEqual(WHITEBOARD_REQUEST_PROJECTION_FIXTURES.map((fixture) => fixture.expectedProjection), [
      'full', 'generic-stub',
    ]);
  });

  test('covers responsive, history, editor, and live UI states', () => {
    assert.deepEqual(
      new Set(WHITEBOARD_UI_STATE_FIXTURES.map((fixture) => fixture.layout)),
      new Set(['tabbed']),
    );
    assert.ok(WHITEBOARD_UI_STATE_FIXTURES.some((fixture) => fixture.model === 'historical'));
    assert.ok(WHITEBOARD_UI_STATE_FIXTURES.some((fixture) => fixture.user === 'editing'));
    assert.ok(WHITEBOARD_UI_STATE_FIXTURES.some((fixture) => fixture.model === 'live-unanchored'));
    assert.ok(WHITEBOARD_UI_STATE_FIXTURES.some((fixture) => fixture.model === 'unavailable'));
    assert.ok(WHITEBOARD_UI_STATE_FIXTURES.some((fixture) => fixture.model === 'historical-newer-available'));
    assert.equal(WHITEBOARD_OVERLAY_EXIT_FIXTURES.filter((fixture) => fixture.closes).length, 1);
    assert.deepEqual(WHITEBOARD_PREVIEW_EXCLUSION_FIXTURES.map((fixture) => fixture.previewVisible), [
      false, true, true, false,
    ]);
  });

  test('covers every visible export source and the exact ZIP carrier', () => {
    assert.equal(WHITEBOARD_EXPORT_SOURCE_FIXTURES.length, 5);
    assert.deepEqual(Object.keys(WHITEBOARD_EXPORT_FIXTURE.entries).sort(), ['model.md', 'user.md']);
    assert.equal(WHITEBOARD_EXPORT_FIXTURE.notice, 'Export captures exactly what you see now.');
  });

  test('covers import eligibility, filenames, and streaming rejection conditions', () => {
    assert.equal(WHITEBOARD_IMPORT_ELIGIBILITY_FIXTURES.filter((fixture) => fixture.eligible).length, 2);
    assert.equal(WHITEBOARD_IMPORT_FILENAME_FIXTURES.filter((fixture) => fixture.accepted).length, 3);
    assert.deepEqual(WHITEBOARD_IMPORT_REJECTION_FIXTURES, [
      'compressed input above 128 KiB', 'missing model.md', 'missing user.md',
      'duplicate model.md', 'unexpected root entry', 'nested entry', 'directory entry',
      'absolute entry', 'traversal entry', 'entry output above 32 KiB',
      'combined output above 64 KiB', 'invalid UTF-8', 'malformed compression',
      'both documents empty',
    ]);
    assert.deepEqual(WHITEBOARD_STREAMING_ZIP_FIXTURES.map((fixture) => fixture.accepted), [
      true, true, true, false, false, true, false, false,
    ]);
  });

  test('freezes constrained-model recovery and visibility expectations', () => {
    assert.deepEqual(WHITEBOARD_CONSTRAINED_MODEL_FIXTURES.map((fixture) => fixture.name), [
      'batch conflict recovery', 'read edit reread', 'pinned user comprehension',
      'failure continuity',
    ]);
    assert.match(WHITEBOARD_CONSTRAINED_MODEL_FIXTURES[0].expectedNextAction, /one intended lc_whiteboard call/);
    assert.match(WHITEBOARD_CONSTRAINED_MODEL_FIXTURES[2].expectedNextAction, /pinned user version/);
  });
});
