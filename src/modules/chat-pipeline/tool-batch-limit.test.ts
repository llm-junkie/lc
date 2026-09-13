import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TOOL_BATCH_LIMIT,
  DEFAULT_TOOL_ROUND_LIMIT,
  exceedsToolBatchLimit,
  formatToolBatchLimitMessage,
  resolveToolBatchLimit,
  resolveToolRoundLimit,
} from './tool-batch-limit.ts';

describe('tool batch limit', () => {
  it('defaults to sixteen and clamps invalid settings to the supported range', () => {
    assert.equal(DEFAULT_TOOL_BATCH_LIMIT, 16);
    assert.equal(resolveToolBatchLimit(undefined), DEFAULT_TOOL_BATCH_LIMIT);
    assert.equal(resolveToolBatchLimit(0), 1);
    assert.equal(resolveToolBatchLimit(12.6), 13);
    assert.equal(resolveToolBatchLimit(999), 64);
    assert.equal(resolveToolBatchLimit(Number.NaN), DEFAULT_TOOL_BATCH_LIMIT);
  });

  it('bounds stale or imported round limits at the execution boundary', () => {
    assert.equal(DEFAULT_TOOL_ROUND_LIMIT, 128);
    assert.equal(resolveToolRoundLimit(undefined), DEFAULT_TOOL_ROUND_LIMIT);
    assert.equal(resolveToolRoundLimit(Number.NaN), DEFAULT_TOOL_ROUND_LIMIT);
    assert.equal(resolveToolRoundLimit(0), 1);
    assert.equal(resolveToolRoundLimit(1.6), 2);
    assert.equal(resolveToolRoundLimit(1_000_000), 256);
  });

  it('rejects only batches larger than the selected limit', () => {
    assert.equal(exceedsToolBatchLimit(8, 8), false);
    assert.equal(exceedsToolBatchLimit(9, 8), true);
  });

  it('explains that the rejected calls were not executed', () => {
    assert.equal(
      formatToolBatchLimitMessage(321, 8),
      'LC rejected a batch of 321 tool calls. The maximum is 8. No calls were executed, and the response ended.',
    );
  });
});
