/**
 * Cross the production lc_read_image cache's batch-count ceiling and prove
 * that request construction classifies the evicted payload as a warning, not
 * as an ordinary image-free result.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheImageBatch,
  clearImageBatches,
  disposeGenerationImageBatches,
  getImageBatch,
  imageBatchCacheMetrics,
} from './read_image.ts';
import { resolveImageDelivery } from '../../chat-pipeline/message-history.ts';

afterEach(clearImageBatches);

describe('lc_read_image bounded delivery cache', () => {
  it('makes eviction of a registered non-empty batch explicit', () => {
    clearImageBatches();
    for (let index = 1; index <= 9; index++) {
      cacheImageBatch(
        `batch-${index}`,
        [{ path: `D:/images/${index}.png`, mime: 'image/png', data_url: `data:image/png;base64,${index}` }],
        'conversation-1',
        'generation-1',
        `call-${index}`,
      );
    }

    assert.equal(getImageBatch('batch-1'), undefined, 'the ninth batch must evict the oldest');
    assert.equal(getImageBatch('batch-9')?.length, 1, 'the newest batch remains deliverable');
    assert.equal(
      resolveImageDelivery({
        batchId: 'batch-1',
        imageCount: getImageBatch('batch-1')?.length ?? 0,
        modelIsVision: true,
        alreadyInjected: undefined,
      }),
      'blocked-cache-miss',
    );
  });

  it('admits fairly and disposes only the terminal generation', () => {
    for (let index = 1; index <= 4; index++) {
      cacheImageBatch(
        `a-${index}`,
        [{ path: `/a/${index}.png`, mime: 'image/png', data_url: `data:a-${index}` }],
        'conversation-a',
        'generation-a',
        `call-a-${index}`,
      );
    }
    for (let index = 1; index <= 2; index++) {
      cacheImageBatch(
        `b-${index}`,
        [{ path: `/b/${index}.png`, mime: 'image/png', data_url: `data:b-${index}` }],
        'conversation-b',
        'generation-b',
        `call-b-${index}`,
      );
    }

    assert.equal(getImageBatch('a-1'), undefined, 'one owner cannot exceed its fair batch share');
    assert.equal(getImageBatch('b-1')?.length, 1, 'a sibling generation keeps its pending pixels');
    assert.deepEqual(imageBatchCacheMetrics(), { batches: 5, bytes: 40, generations: 2 });

    disposeGenerationImageBatches('conversation-a', 'generation-a');
    assert.equal(getImageBatch('a-4'), undefined);
    assert.equal(getImageBatch('b-2')?.length, 1);
    assert.equal(imageBatchCacheMetrics().generations, 1);
  });

  it('keeps reused provider call IDs scoped to their generations', () => {
    cacheImageBatch(
      'owner-a-batch',
      [{ path: '/a/image.png', mime: 'image/png', data_url: 'data:owner-a' }],
      'conversation-a',
      'generation-a',
      'reused-provider-call',
    );
    cacheImageBatch(
      'owner-b-batch',
      [{ path: '/b/image.png', mime: 'image/png', data_url: 'data:owner-b' }],
      'conversation-b',
      'generation-b',
      'reused-provider-call',
    );

    disposeGenerationImageBatches('conversation-a', 'generation-a');
    assert.equal(getImageBatch('owner-a-batch'), undefined);
    assert.equal(getImageBatch('owner-b-batch')?.[0]?.path, '/b/image.png');
  });
});
