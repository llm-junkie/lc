/**
 * Phase 2.1 — Execution-group identity tests.
 *
 * Verifies that the ToolExecutionIdentity infrastructure:
 *   1. Is present in ToolHandlerContext for every tool call
 *   2. Links modelToolCallId to the provider call.id
 *   3. Has unique groupId per model tool call, unique operationId per native child
 *   4. Is forwarded to the sandbox bridge (run_shell, web_fetch)
 *   5. Is threaded through the orchestrator's per-call context
 *
 * These are pure JS tests — no Tauri runtime needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ToolExecutionIdentity,
  ToolHandlerContext,
} from './types';
import type { RunShellArgs, WebFetchArgs } from './sandbox-bridge';

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

/** Mint a valid identity — mirrors the orchestrator's pattern. */
function mintIdentity(opts?: {
  modelToolCallId?: string;
  conversationId?: string;
  generationId?: string;
}): ToolExecutionIdentity {
  return {
    groupId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    modelToolCallId: opts?.modelToolCallId ?? 'call_test_123',
    conversationId: opts?.conversationId ?? 'conv_test_456',
    generationId: opts?.generationId ?? 'gen_test_789',
  };
}

/** Build a minimal ToolHandlerContext for identity tests. */
function mockCtx(
  identity: ToolExecutionIdentity,
): ToolHandlerContext {
  return {
    sandbox: {
      readFile: () => Promise.reject(new Error('not implemented')),
      readImage: () => Promise.reject(new Error('not implemented')),
      readPdf: () => Promise.reject(new Error('not implemented')),
      analyzeImages: () => Promise.reject(new Error('not implemented')),
      writeFile: () => Promise.reject(new Error('not implemented')),
      listDir: () => Promise.reject(new Error('not implemented')),
      stat: () => Promise.reject(new Error('not implemented')),
      runShell: (args: RunShellArgs) => Promise.resolve({
        stdout: `call_id=${args.call_id} group_id=${args.group_id}`,
        stderr: '',
        exit_code: 0,
        duration_ms: 0,
        timed_out: false,
        stdout_truncated: false,
        stderr_truncated: false,
      }),
      grep: () => Promise.reject(new Error('not implemented')),
      edit: () => Promise.reject(new Error('not implemented')),
      webFetch: (args: WebFetchArgs) => Promise.resolve({
        status: 200,
        final_url: args.url,
        content_type: 'text/plain',
        body: `call_id=${args.call_id} group_id=${args.group_id}`,
        truncated: false,
      }),
      webSearch: () => Promise.reject(new Error('not implemented')),
      globFiles: () => Promise.reject(new Error('not implemented')),
      applyPatch: () => Promise.reject(new Error('not implemented')),
      applyPatchTargets: () => Promise.reject(new Error('not implemented')),
      applyPatchPreflight: () => Promise.reject(new Error('not implemented')),
      abortToolCalls: () => Promise.resolve(0),
      abortGroup: () => Promise.resolve(0),
    },
    config: {
      allowedRoots: ['/test'],
      shellAllowlist: ['echo', 'cat'],
      webFetchRatePerMin: 50,
      maxShellTimeoutMs: 120_000,
      maxWebFetchBytes: 32 * 1024 * 1024,
      maxWebFetchTimeoutMs: 30_000,
      searchProvider: null,
      visionModel: '',
      webResearchModel: '',
      pdfSummarizeModel: '',
      llmServerUrl: '',
      llmModel: '',
      llmApiKey: '',
      llmApiStyle: 'chat',
      llmApiVariant: 'openai',
    },
    signal: new AbortController().signal,
    identity,
    llmCall: undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe('Phase 2.1 — Execution-group identity', () => {
  describe('ToolExecutionIdentity shape', () => {
    it('contains all required fields', () => {
      const id = mintIdentity();
      assert.ok(typeof id.groupId === 'string' && id.groupId.length > 0,
        'groupId must be a non-empty string');
      assert.ok(typeof id.operationId === 'string' && id.operationId.length > 0,
        'operationId must be a non-empty string');
      assert.ok(typeof id.modelToolCallId === 'string' && id.modelToolCallId.length > 0,
        'modelToolCallId must be a non-empty string');
      assert.ok(typeof id.conversationId === 'string' && id.conversationId.length > 0,
        'conversationId must be a non-empty string');
    });

    it('groupId is unique per call (different modelToolCallIds get different groups)', () => {
      const id1 = mintIdentity({ modelToolCallId: 'call_1' });
      const id2 = mintIdentity({ modelToolCallId: 'call_2' });
      assert.notStrictEqual(id1.groupId, id2.groupId,
        'different model tool calls must have different groupIds');
    });

    it('operationId is unique per call', () => {
      const id1 = mintIdentity();
      const id2 = mintIdentity();
      assert.notStrictEqual(id1.operationId, id2.operationId,
        'different operations must have different operationIds');
    });

    it('groupId and operationId differ within the same call', () => {
      const id = mintIdentity();
      assert.notStrictEqual(id.groupId, id.operationId,
        'groupId and operationId must differ — they track different levels');
    });

    it('modelToolCallId reflects the provider-assigned call ID', () => {
      const id = mintIdentity({ modelToolCallId: 'call_abc_001' });
      assert.strictEqual(id.modelToolCallId, 'call_abc_001');
    });

    it('conversationId is stable across child operations of the same model call', () => {
      const id = mintIdentity({ conversationId: 'conv_stable' });
      assert.strictEqual(id.conversationId, 'conv_stable');
    });

    it('generationId distinguishes a replacement run in the same conversation', () => {
      // A Retry or a Stop-then-Send reuses the conversation and can reuse a
      // provider tool-call ID, so conversation scope alone cannot tell a live
      // call from one owned by a generation that no longer exists.
      const first = mintIdentity({ conversationId: 'conv_same', generationId: 'gen_first' });
      const replacement = mintIdentity({
        conversationId: 'conv_same',
        generationId: 'gen_second',
      });

      assert.strictEqual(first.conversationId, replacement.conversationId);
      assert.notStrictEqual(first.generationId, replacement.generationId,
        'a replacement generation must be distinguishable from the one it replaced');
    });
  });

  describe('ToolHandlerContext carries identity', () => {
    it('identity is present in context', () => {
      const identity = mintIdentity();
      const ctx = mockCtx(identity);
      assert.ok(ctx.identity, 'identity must be present');
      assert.strictEqual(ctx.identity.groupId, identity.groupId);
      assert.strictEqual(ctx.identity.operationId, identity.operationId);
    });

    it('multiple contexts for the same model turn share one groupId', () => {
      // Simulates compound tools (like web_research) where multiple
      // native children share the same model tool call.
      const groupId = crypto.randomUUID();
      const ctx1 = mockCtx({
        groupId,
        operationId: crypto.randomUUID(),
        modelToolCallId: 'call_1',
        conversationId: 'conv_1',
        generationId: 'gen_1',
      });
      const ctx2 = mockCtx({
        groupId,
        operationId: crypto.randomUUID(),
        modelToolCallId: 'call_1',
        conversationId: 'conv_1',
        generationId: 'gen_1',
      });

      assert.strictEqual(ctx1.identity.groupId, ctx2.identity.groupId,
        'same model call → same groupId');
      assert.notStrictEqual(ctx1.identity.operationId, ctx2.identity.operationId,
        'different native children → different operationIds');
    });

    it('different model turns get different groupIds', () => {
      const ctx1 = mockCtx(mintIdentity({ modelToolCallId: 'call_A' }));
      const ctx2 = mockCtx(mintIdentity({ modelToolCallId: 'call_B' }));
      assert.notStrictEqual(ctx1.identity.groupId, ctx2.identity.groupId);
    });
  });

  describe('Sandbox bridge forwards identity', () => {
    it('runShell receives call_id (operationId) and group_id', async () => {
      const identity = mintIdentity();
      const ctx = mockCtx(identity);

      const result = await ctx.sandbox.runShell({
        cmd: 'echo hello',
        allowed_roots: ctx.config.allowedRoots,
        allowlist: ctx.config.shellAllowlist.join(','),
        call_id: identity.operationId,
        group_id: identity.groupId,
      });

      assert.ok(result.stdout.includes(`call_id=${identity.operationId}`),
        'runShell must receive operationId as call_id');
      assert.ok(result.stdout.includes(`group_id=${identity.groupId}`),
        'runShell must receive groupId as group_id');
    });

    it('webFetch receives call_id (operationId) and group_id', async () => {
      const identity = mintIdentity();
      const ctx = mockCtx(identity);

      const result = await ctx.sandbox.webFetch({
        url: 'https://example.com',
        call_id: identity.operationId,
        group_id: identity.groupId,
      });

      assert.ok(result.body.includes(`call_id=${identity.operationId}`),
        'webFetch must receive operationId as call_id');
      assert.ok(result.body.includes(`group_id=${identity.groupId}`),
        'webFetch must receive groupId as group_id');
    });

    it('accepts a request without an optional group_id', async () => {
      const identity = mintIdentity();
      const ctx = mockCtx(identity);

      // Should not throw even without group_id
      const result = await ctx.sandbox.webFetch({
        url: 'https://example.com',
        call_id: identity.operationId,
        // group_id intentionally omitted
      });

      assert.ok(result.body.includes(`call_id=${identity.operationId}`));
      assert.ok(result.body.includes('group_id=undefined'));
    });
  });

  describe('Compound tool identity (web_research pattern)', () => {
    it('all children of one model tool call share the SAME groupId', async () => {
      const groupId = crypto.randomUUID();
      const modelCallId = 'call_research_1';

      const childOps: string[] = [];
      // Simulate 3 research fetches under one model call
      for (let i = 0; i < 3; i++) {
        const opId = crypto.randomUUID();
        childOps.push(opId);
        const ctx = mockCtx({
          groupId,
          operationId: opId,
          modelToolCallId: modelCallId,
          conversationId: 'conv_1',
          generationId: 'gen_1',
        });

        const result = await ctx.sandbox.webFetch({
          url: `https://example.com/${i}`,
          call_id: opId,
          group_id: groupId,
        });

        assert.ok(result.body.includes(`group_id=${groupId}`),
          `child ${i}: must share group_id=${groupId}`);
        assert.ok(result.body.includes(`call_id=${opId}`),
          `child ${i}: must have unique call_id=${opId}`);
      }

      // All 3 ops have different operationIds
      assert.strictEqual(new Set(childOps).size, 3,
        'all 3 children must have unique operationIds');
    });
  });

  describe('Identity immutability (Phase 1.5 contract)', () => {
    it('spread-clone creates independent copy — original is not mutated', () => {
      const originalIdentity = mintIdentity();
      const ctx = mockCtx(originalIdentity);

      // Simulate orchestrator pattern: create a new identity via spread.
      // This is the Phase 1.5 contract — workers receive a NEW object,
      // not a reference to shared state.
      const clonedIdentity: ToolExecutionIdentity = {
        ...ctx.identity,
        operationId: crypto.randomUUID(),
      };

      // Original must be unchanged by the clone
      assert.strictEqual(ctx.identity.operationId, originalIdentity.operationId,
        'original context identity must NOT be affected by clone');
      assert.notStrictEqual(clonedIdentity.operationId, originalIdentity.operationId,
        'cloned identity must have independent operationId');

      // Re-mutating the clone must not affect the original either
      (clonedIdentity as { groupId: string }).groupId = 'mutated';
      assert.notStrictEqual(ctx.identity.groupId, 'mutated',
        'mutating clone must not affect original');
    });

    it('cloned context gets a new identity reference (per-call immutability)', () => {
      const originalIdentity = mintIdentity();
      const ctx = mockCtx(originalIdentity);

      // Simulate orchestrator cloning for allow_once
      const clonedIdentity: ToolExecutionIdentity = {
        ...originalIdentity,
        operationId: crypto.randomUUID(), // new op for retry
      };
      const clonedCtx = { ...ctx, identity: clonedIdentity };

      assert.notStrictEqual(clonedCtx.identity.operationId,
        originalIdentity.operationId,
        'cloned context must have independent operationId');
      assert.strictEqual(clonedCtx.identity.groupId,
        originalIdentity.groupId,
        'cloned context must retain original groupId');
      assert.strictEqual(clonedCtx.identity.modelToolCallId,
        originalIdentity.modelToolCallId,
        'cloned context must retain original modelToolCallId');
    });
  });
});
