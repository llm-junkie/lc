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
  readImage,
} from './read_image.ts';
import { imageBatchIdForDelivery, resolveImageDelivery } from '../../chat-pipeline/message-history.ts';
import { executeToolCall, runWithPool } from '../runner.ts';
import type { ToolHandlerContext } from '../types';

function imageContext(
  owner: string,
  signal: AbortSignal,
  read: () => Promise<string>,
): ToolHandlerContext {
  return {
    sandbox: {
      readImage: async () => ({ images: [{
        path: `D:/${owner}/image.png`, mime: 'image/png', data_url: await read(),
      }] }),
      abortGroup: async () => {},
    },
    config: { allowedRoots: ['D:/'], modelIsVision: true },
    identity: {
      conversationId: `conversation-${owner}`,
      generationId: `generation-${owner}`,
      groupId: `group-${owner}`,
      operationId: `operation-${owner}`,
      modelToolCallId: 'shared-provider-call',
    },
    signal,
  } as unknown as ToolHandlerContext;
}

afterEach(clearImageBatches);

describe('lc_read_image bounded delivery cache', () => {
  it('keeps a sibling batch under global byte pressure from three concurrent owners', async () => {
    const owners = ['small', 'large-b', 'large-c'];
    const gates = owners.map(() => Promise.withResolvers<string>());
    const completed = owners.map(() => Promise.withResolvers<void>());
    const started = Promise.withResolvers<void>();
    let starts = 0;
    const results = new Map<string, Awaited<ReturnType<typeof readImage.run>>>();
    const pool = runWithPool(owners, 3, async (owner, index) => readImage.run(
      { paths: [`D:/${owner}/image.png`] },
      imageContext(owner, new AbortController().signal, () => {
        if (++starts === 3) started.resolve();
        return gates[index].promise;
      }),
    ), (result, index) => {
      results.set(owners[index], result);
      completed[index].resolve();
    });
    await started.promise;
    for (let index = 0; index < owners.length; index++) {
      const bytes = (index === 0 ? 1 : 32) * 1024 * 1024;
      const prefix = 'data:image/png;base64,';
      gates[index].resolve(prefix + 'A'.repeat(bytes - prefix.length));
      await completed[index].promise;
    }
    await pool;
    const batchIdFor = (owner: string) => {
      const id = imageBatchIdForDelivery(JSON.stringify(results.get(owner)));
      assert.ok(id);
      return id;
    };
    const smallBatch = batchIdFor('small');
    assert.equal(getImageBatch(smallBatch)?.length, 1, 'a competing owner must not remove the last small sibling batch');
    assert.equal(getImageBatch(batchIdFor('large-b'))?.length, 1);
    const rejectedBatch = batchIdFor('large-c');
    assert.equal(getImageBatch(rejectedBatch), undefined);
    assert.equal(resolveImageDelivery({
      batchId: rejectedBatch, imageCount: 0, modelIsVision: true, alreadyInjected: undefined,
    }), 'blocked-cache-miss');
    assert.ok(imageBatchCacheMetrics().bytes <= 64 * 1024 * 1024);
  });

  it('keeps all three owners within the global batch-count limit', () => {
    const add = (owner: string, index: number) => cacheImageBatch(
      `${owner}-${index}`, [{ path: `/${owner}.png`, mime: 'image/png', data_url: 'data:image/png;base64,AAAA' }],
      `conversation-${owner}`, `generation-${owner}`, `call-${index}`,
    );
    add('a', 1);
    for (const owner of ['b', 'c']) {
      for (let index = 1; index <= 3; index++) add(owner, index);
    }
    add('a', 2);
    add('a', 3);
    assert.equal(imageBatchCacheMetrics().batches, 8);
    assert.equal(imageBatchCacheMetrics().generations, 3);
    for (const owner of ['a', 'b', 'c']) assert.equal(getImageBatch(`${owner}-3`)?.length, 1);
  });

  it('keeps per-generation byte limits and expires the remaining batch at delivery', (t) => {
    let now = 1_000;
    t.mock.method(Date, 'now', () => now);
    cacheImageBatch('oversized', [{ path: '/large.png', mime: 'image/png', data_url: 'A'.repeat(32 * 1024 * 1024 + 1) }], 'a', 'a', 'large');
    assert.equal(getImageBatch('oversized'), undefined);
    cacheImageBatch('small', [{ path: '/small.png', mime: 'image/png', data_url: 'data:image/png;base64,AAAA' }], 'b', 'b', 'small');
    now += 5 * 60 * 1_000;
    assert.equal(getImageBatch('small')?.length, 1);
    now += 1;
    assert.equal(getImageBatch('small'), undefined);
    assert.deepEqual(imageBatchCacheMetrics(), { batches: 0, bytes: 0, generations: 0 });
  });

  it('does not restore a cancelled owner cache after terminal cleanup', async () => {
    const controller = new AbortController();
    const lateRead = Promise.withResolvers<string>();
    const bothStarted = Promise.withResolvers<void>();
    const siblingDone = Promise.withResolvers<void>();
    let starts = 0;
    const pool = runWithPool(['retired', 'sibling'], 2, async (owner) => {
      const ctx = imageContext(owner, owner === 'retired' ? controller.signal : new AbortController().signal, () => {
        if (++starts === 2) bothStarted.resolve();
        return owner === 'retired' ? lateRead.promise : Promise.resolve('data:image/png;base64,AAAA');
      });
      return executeToolCall(
        { id: 'shared-provider-call', name: 'lc_read_image', arguments: '{}', created_at: 0 },
        { paths: [`D:/${owner}/image.png`] }, readImage, ctx,
      );
    }, (_result, index) => { if (index === 1) siblingDone.resolve(); });
    await bothStarted.promise;
    await siblingDone.promise;
    controller.abort();
    disposeGenerationImageBatches('conversation-retired', 'generation-retired');
    const before = imageBatchCacheMetrics();
    assert.equal(before.generations, 1);
    lateRead.resolve('data:image/png;base64,AAAA');
    const results = await pool;
    assert.deepEqual(imageBatchCacheMetrics(), before, 'late native completion must not recreate a terminal owner');
    assert.equal(results[0].is_error, true);
    assert.equal(JSON.parse(results[0].output).status, 'aborted');
    assert.equal(results[1].is_error, false);
  });

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
