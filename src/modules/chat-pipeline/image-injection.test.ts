/**
 * An lc_read_image batch must reach the model EXACTLY ONCE per tool-loop
 * session.
 *
 * `reqMessages` is rebuilt from the store on every tool-call round and
 * the decoded batch stays cached until the loop ends.  Before the fix the
 * same synthetic user turn was re-emitted in every round; models read
 * each arrival as a NEW user message containing an image and answered it
 * unprompted, restarted their plan from step 1, re-called lc_read_image
 * (registering another batch, which compounded the problem), or stopped
 * with work outstanding.  Reproduced on all three adapters across 5 models.
 *
 * See docs/streaming.md, "Adapter constraints proven against live endpoints".
 *
 * Run with:
 *   node --test --experimental-strip-types src/modules/chat-pipeline/image-injection.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendImageDeliveryWarning,
  buildImageTurnParts,
  imageBatchIdForDelivery,
  resolveImageDelivery,
  stripInternalImageResultFields,
} from './message-history.ts';
import {
  decodeLcResultJson,
  prependLcResultNotice,
  repeatedToolCallNotice,
} from '../tool-engine/tool-result-content.ts';

/**
 * Mirrors the orchestrator's per-request loop: for each tool message with a
 * live batch, decide delivery; anything injected is recorded in the
 * `injected` set by flushPendingImages() and that set survives across
 * tool-call rounds via the caller's ref.
 *
 * Returns the number of requests that actually carried the pixels.
 */
function runToolLoop(opts: {
  rounds: number;
  modelIsVision: boolean;
  batchId?: string | null;
  imageCount?: number;
  /** Rounds (1-based) in which the model calls lc_read_image again. */
  extraReadsAt?: number[];
  }): { deliveries: number; blocked: number; missing: number; skipped: number } {
  const { rounds, modelIsVision, batchId = 'batch-1', imageCount = 1, extraReadsAt = [] } = opts;
  const injected = new Set<string>();
  const liveBatches: string[] = batchId ? [batchId] : [];
  let deliveries = 0, blocked = 0, missing = 0, skipped = 0;

  for (let round = 1; round <= rounds; round++) {
    // A repeated lc_read_image call registers a brand-new batch id.
    if (extraReadsAt.includes(round)) liveBatches.push(`batch-extra-${round}`);

    const pending: string[] = [];
    for (const id of liveBatches) {
      const delivery = resolveImageDelivery({
        batchId: id,
        imageCount,
        modelIsVision,
        alreadyInjected: injected,
      });
      if (delivery === 'inject') { pending.push(id); deliveries++; }
      else if (delivery === 'blocked-no-vision') blocked++;
      else if (delivery === 'blocked-cache-miss') missing++;
      else if (delivery === 'skip-already-sent') skipped++;
    }
    // flushPendingImages(): emits one user turn, then records the batches.
    for (const id of pending) injected.add(id);
  }
  return { deliveries, blocked, missing, skipped };
}

describe('image batch injection', () => {
  describe('resolveImageDelivery', () => {
    const base = { batchId: 'b1', imageCount: 1, modelIsVision: true, alreadyInjected: undefined };

    it('injects on first sight', () => {
      assert.equal(resolveImageDelivery(base), 'inject');
    });

    it('skips a batch already sent in an earlier round', () => {
      assert.equal(
        resolveImageDelivery({ ...base, alreadyInjected: new Set(['b1']) }),
        'skip-already-sent',
      );
    });

    it('still injects when a DIFFERENT batch was already sent', () => {
      assert.equal(
        resolveImageDelivery({ ...base, alreadyInjected: new Set(['other']) }),
        'inject',
      );
    });

    it('blocks for non-vision models', () => {
      assert.equal(resolveImageDelivery({ ...base, modelIsVision: false }), 'blocked-no-vision');
    });

    it('blocks for non-vision models even when already recorded', () => {
      assert.equal(
        resolveImageDelivery({ ...base, modelIsVision: false, alreadyInjected: new Set(['b1']) }),
        'blocked-no-vision',
      );
    });

    it('returns none without a batch id', () => {
      assert.equal(resolveImageDelivery({ ...base, batchId: null }), 'none');
    });

    it('signals a missing registered batch instead of silently dropping it', () => {
      assert.equal(resolveImageDelivery({ ...base, imageCount: 0 }), 'blocked-cache-miss');
    });

    it('gives a literal retry when the bounded cache dropped the pixels', () => {
      const warned = appendImageDeliveryWarning('{"images":[]}', 'blocked-cache-miss');
      const parsed = JSON.parse(warned) as { images: unknown[]; warning?: string };
      assert.deepEqual(parsed.images, []);
      assert.match(parsed.warning ?? '', /sent no image/i);
      assert.match(parsed.warning ?? '', /Call lc_read_image again/);
      assert.match(parsed.warning ?? '', /fewer paths/);
      assert.match(parsed.warning ?? '', /downscale/);
      assert.match(parsed.warning ?? '', /low_jpeg/);
      assert.doesNotMatch(warned, /\n\nWARNING:/);

      const warnedAgain = appendImageDeliveryWarning(warned, 'blocked-cache-miss');
      assert.equal(JSON.parse(warnedAgain).warning, parsed.warning);
    });

    it('sets the capability warning inside the structured image result', () => {
      const warned = appendImageDeliveryWarning(
        '{"images":[],"description":null,"warning":null}',
        'blocked-no-vision',
      );
      const parsed = JSON.parse(warned) as { description: string | null; warning: string };
      assert.equal(parsed.description, null);
      assert.match(parsed.warning, /does not support vision/);
      assert.match(parsed.warning, /analyze:true/);
    });

    it('registers only a non-empty delivery batch', () => {
      assert.equal(imageBatchIdForDelivery(JSON.stringify({
        _image_batch_id: 'batch-1', images_delivered: 1,
      })), 'batch-1');
      assert.equal(imageBatchIdForDelivery(JSON.stringify({
        _image_batch_id: 'batch-empty', images_delivered: 0,
      })), null);
      assert.equal(imageBatchIdForDelivery('{bad json'), null);
    });

    it('keeps repeated image results deliverable and strips only transient fields', () => {
      const notice = repeatedToolCallNotice('lc_read_image', 2);
      const repeated = prependLcResultNotice(JSON.stringify({
        images: [{ path: 'D:/work/cat.png' }],
        warning: null,
        _image_batch_id: 'batch-repeat',
        images_delivered: 1,
      }), notice);

      assert.equal(imageBatchIdForDelivery(repeated), 'batch-repeat');

      const warned = appendImageDeliveryWarning(repeated, 'blocked-cache-miss');
      const warnedResult = decodeLcResultJson(warned);
      assert.ok(warnedResult);
      assert.deepEqual(warnedResult.notices, [notice]);
      assert.match(
        (warnedResult.data as { warning: string }).warning,
        /sent no image/i,
      );

      const persisted = stripInternalImageResultFields(warned);
      const persistedResult = decodeLcResultJson(persisted);
      assert.ok(persistedResult);
      assert.deepEqual(persistedResult.notices, [notice]);
      assert.equal(
        '_image_batch_id' in (persistedResult.data as Record<string, unknown>),
        false,
      );
      assert.equal(
        'images_delivered' in (persistedResult.data as Record<string, unknown>),
        false,
      );
    });
  });

  describe('across a multi-round tool loop', () => {
    it('THE REGRESSION: delivers exactly once over 10 rounds', () => {
      const { deliveries, skipped } = runToolLoop({ rounds: 10, modelIsVision: true });
      assert.equal(deliveries, 1, 'pixels must reach the model on exactly one request');
      assert.equal(skipped, 9, 'every later round must suppress the batch');
    });

    it('delivers once even on a single-round loop', () => {
      assert.equal(runToolLoop({ rounds: 1, modelIsVision: true }).deliveries, 1);
    });

    it('never delivers to a non-vision model', () => {
      const { deliveries, blocked } = runToolLoop({ rounds: 5, modelIsVision: false });
      assert.equal(deliveries, 0);
      assert.equal(blocked, 5);
    });

    it('a repeated lc_read_image call adds one delivery, not a per-round stream', () => {
      // The compounding case: confusion made the model re-read the image at
      // round 3, registering a second batch. Each batch may still be
      // delivered only once — 2 batches, 2 deliveries, never 2-per-turn.
      const { deliveries } = runToolLoop({
        rounds: 8,
        modelIsVision: true,
        extraReadsAt: [3],
      });
      assert.equal(deliveries, 2);
    });

    it('multiple distinct images each deliver exactly once', () => {
      const { deliveries } = runToolLoop({
        rounds: 12,
        modelIsVision: true,
        extraReadsAt: [2, 5, 9],
      });
      assert.equal(deliveries, 4, '1 original + 3 re-reads, each sent once');
    });
  });

  describe('pre-fix behaviour is genuinely rejected', () => {
    it('ignoring alreadyInjected would resend every round', () => {
      // Sanity check that the assertions above have teeth: the old code path
      // (no membership check) produces one delivery per round.
      let deliveries = 0;
      for (let i = 0; i < 10; i++) {
        const delivery = resolveImageDelivery({
          batchId: 'b1',
          imageCount: 1,
          modelIsVision: true,
          alreadyInjected: undefined, // <- the bug: set never consulted
        });
        if (delivery === 'inject') deliveries++;
      }
      assert.equal(deliveries, 10);
      assert.notEqual(deliveries, 1, 'this is the pre-fix resend behavior');
    });
  });
});

describe('the image turn is labelled as tool output', () => {
  const imgs = [
    { path: 'D:/t/gear.png', data_url: 'data:image/png;base64,AAAA' },
    { path: 'D:/t/cat.png', data_url: 'data:image/png;base64,BBBB' },
  ];

  it('leads with a label naming the originating tool call', () => {
    const parts = buildImageTurnParts('call_abc123', imgs);
    assert.equal(parts[0].type, 'text');
    const label = (parts[0] as { text: string }).text;
    assert.match(label, /call_abc123/);
    assert.match(label, /not a new request from the user/);
    assert.match(label, /Continue your current task/);
  });

  it('THE RESIDUAL CASE: the turn never opens with a bare image', () => {
    // gpt-5.6-luna reasoned "the user sent an image and didn't ask an explicit
    // question", then abandoned its remaining steps. The label is what
    // contradicts that inference, so it must come first.
    const parts = buildImageTurnParts('c1', imgs);
    assert.notEqual(parts[0].type, 'image_url');
    assert.equal(parts.findIndex(p => p.type === 'image_url') > 0, true);
  });

  it('keeps every image with its path label, in order', () => {
    const parts = buildImageTurnParts('c1', imgs);
    assert.deepEqual(parts.slice(1), [
      { type: 'text', text: 'Image 1: D:/t/gear.png' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: 'Image 2: D:/t/cat.png' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
    ]);
  });

  it('still emits the label when the batch is empty', () => {
    const parts = buildImageTurnParts('c1', []);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'text');
  });
});
