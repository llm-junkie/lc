import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attachGroupAbort } from './abort-link.ts';
import { ALL_TOOL_NAMES, TOOL_POLICY, authorizeFileCall, authorizeNonFileCall, buildGrantSnapshot, parentDir, resolveExposure, resolveFileAuthorization } from './policy.ts';
import {
  BUILTIN_TOOLS,
  HANDLERS_BY_NAME,
} from './registry.ts';
import {
  LLM_CLIENT_TOOL_NAMES,
  LLM_CLIENT_TOOL_NAMES_ARE_EXACT,
} from './registry-names.ts';
import { grantToolOnRoots, normalizeGrantState } from './grant-state.ts';
import {
  CURRENT_TIME_TZ_LIMIT_MESSAGE,
  CURRENT_TIME_TZ_MAX_CHARACTERS,
  getCurrentTime,
  resolveTz,
} from './builtin/get_current_time.ts';
import { grep } from './builtin/grep.ts';
import { listDir } from './builtin/list_dir.ts';
import {
  SKILL_ID_LIMIT_MESSAGE,
  SKILL_ID_MAX_CHARACTERS,
  skill,
} from './builtin/skill.ts';
import { toolHistory, type ToolHistoryOutput } from './builtin/tool_history.ts';
import {
  WEB_RESEARCH_PROMPT_MAX_CHARS,
  WEB_RESEARCH_SUMMARY_MAX_BYTES,
  WEB_RESEARCH_SOURCE_MAX_CHARS,
  webResearch,
} from './builtin/web_research.ts';
import { webSearch } from './builtin/web_search.ts';
import { writeFile } from './builtin/write_file.ts';
import { APPLY_PATCH_INPUT_MESSAGES } from './builtin/apply_patch.ts';
import { normalizeOptionalAbsence, validateToolCalls } from './runner.ts';
import {
  TOOL_HELP_INPUT_MESSAGES,
  TOOL_HELP_MAX_QUERY_TERMS,
} from './tool-help.ts';
import type { ToolHandlerContext } from './types';
import { createSerializedAsyncQueue } from '../chat-pipeline/serialized-async-queue.ts';
import { ARCHIVED_TOOL_NAME } from '../chat-pipeline/message-history.ts';
import { grantedDirectoriesForDecision } from '../../ui/tools/permission-modal-state.ts';
import { useConversations } from '../../store/conversations.ts';
import { utf8ByteLength } from './utf8-budget.ts';
import { RUN_SHELL_STDIN_CAP_BYTES, runShell } from './builtin/run_shell.ts';
import { WEB_FETCH_HARD_CAP_BYTES, webFetch } from './builtin/web_fetch.ts';
import { FILESYSTEM_BATCH_MAX_ENTRIES } from './builtin/tool-contract-metadata.ts';
import {
  TOOL_ISSUE_MESSAGE_MAX_BYTES,
  TOOL_ISSUE_TRUNCATION_MARKER,
} from './model-text-budget.ts';

describe('bounded utility inputs', () => {
  it('rejects over-limit timezone and skill IDs through production validation', () => {
    const cases = [
      {
        name: 'lc_get_current_time',
        arguments: { tz: 'x'.repeat(CURRENT_TIME_TZ_MAX_CHARACTERS + 1) },
        field: 'tz',
        message: CURRENT_TIME_TZ_LIMIT_MESSAGE,
      },
      {
        name: 'lc_skill',
        arguments: { id: 'x'.repeat(SKILL_ID_MAX_CHARACTERS + 1) },
        field: 'id',
        message: SKILL_ID_LIMIT_MESSAGE,
      },
    ] as const;

    for (const probe of cases) {
      const rejected = validateToolCalls([{
        created_at: 0,
        id: `${probe.name}-over-limit`,
        name: probe.name,
        arguments: JSON.stringify(probe.arguments),
      }], HANDLERS_BY_NAME)[0];
      assert.deepEqual(rejected.error, [{
        code: 'invalid_arguments',
        message: `Tool arguments failed validation: ${probe.field}: ${probe.message}`,
        retryable: false,
      }]);
    }
  });

  it('gives an actionable remedy for apply-patch and tool-help bounds', () => {
    const cases = [
      {
        name: 'lc_apply_patch',
        arguments: { patch: '' },
        field: 'patch',
        message: APPLY_PATCH_INPUT_MESSAGES.required,
        corrected: { patch: '*** Begin Patch\n*** End Patch' },
      },
      {
        name: 'lc_apply_patch',
        arguments: { patch: 'x'.repeat(1_048_577) },
        field: 'patch',
        message: APPLY_PATCH_INPUT_MESSAGES.maximum,
        corrected: { patch: 'x'.repeat(1_048_576) },
      },
      {
        name: 'lc_tool_help',
        arguments: { tool: 'x'.repeat(81) },
        field: 'tool',
        message: TOOL_HELP_INPUT_MESSAGES.tool,
        corrected: { tool: 'x'.repeat(80) },
      },
      {
        name: 'lc_tool_help',
        arguments: { tool: 'lc_read_file', query: 'x'.repeat(161) },
        field: 'query',
        message: TOOL_HELP_INPUT_MESSAGES.queryCharacters,
        corrected: { tool: 'lc_read_file', query: 'x'.repeat(160) },
      },
      {
        name: 'lc_tool_help',
        arguments: {
          tool: 'lc_read_file',
          query: Array.from(
            { length: TOOL_HELP_MAX_QUERY_TERMS + 1 },
            (_, index) => `term${index}`,
          ).join(' '),
        },
        field: 'query',
        message: TOOL_HELP_INPUT_MESSAGES.queryTerms,
        corrected: {
          tool: 'lc_read_file',
          query: Array.from(
            { length: TOOL_HELP_MAX_QUERY_TERMS },
            (_, index) => `term${index}`,
          ).join(' '),
        },
      },
    ] as const;

    for (const [index, probe] of cases.entries()) {
      const rejected = validateToolCalls([{
        created_at: 0,
        id: `actionable-bound-${index}`,
        name: probe.name,
        arguments: JSON.stringify(probe.arguments),
      }], HANDLERS_BY_NAME)[0];
      assert.deepEqual(rejected.error, [{
        code: 'invalid_arguments',
        message: `Tool arguments failed validation: ${probe.field}: ${probe.message}`,
        retryable: false,
      }]);

      const corrected = validateToolCalls([{
        created_at: 0,
        id: `corrected-bound-${index}`,
        name: probe.name,
        arguments: JSON.stringify(probe.corrected),
      }], HANDLERS_BY_NAME)[0];
      assert.equal(corrected.error, undefined, probe.name);
    }
  });
});

describe('lc_run_shell stdin budget', () => {
  it('enforces the 1 MiB limit as UTF-8 bytes', () => {
    const exact = 'x'.repeat(RUN_SHELL_STDIN_CAP_BYTES);
    assert.equal(runShell.input.safeParse({ cmd: 'echo', stdin: exact }).success, true);

    const oversized = '漢'.repeat(Math.floor(RUN_SHELL_STDIN_CAP_BYTES / 3) + 1);
    assert.ok(new TextEncoder().encode(oversized).byteLength > RUN_SHELL_STDIN_CAP_BYTES);
    assert.equal(runShell.input.safeParse({ cmd: 'echo', stdin: oversized }).success, false);
  });
});

describe('lc_web_fetch response budget', () => {
  it('rejects byte caps above the native 32 MiB hard ceiling', () => {
    assert.equal(webFetch.input.safeParse({
      url: 'https://example.com',
      max_bytes: WEB_FETCH_HARD_CAP_BYTES,
    }).success, true);
    assert.equal(webFetch.input.safeParse({
      url: 'https://example.com',
      max_bytes: WEB_FETCH_HARD_CAP_BYTES + 1,
    }).success, false);
  });
});

describe('production tool policy', () => {
  it('keeps exposure independent from empty grants', () => {
    const exposure = resolveExposure({
      enabled: true,
      file_io_enabled: true,
      shell_enabled: true,
      web_access_enabled: true,
      tool_history_enabled: true,
      skills_enabled: true,
      whiteboard_enabled: true,
      tool_grants: [],
      dir_permissions: {},
    });
    assert.equal(exposure.exposedNames.size, 21);
    assert.ok(exposure.exposedNames.has('lc_tool_history'));
    assert.ok(exposure.exposedNames.has('lc_skill'));
    assert.ok(exposure.exposedNames.has('lc_tool_help'));
    assert.ok(exposure.exposedNames.has('lc_read_pdf'));
    assert.ok(exposure.exposedNames.has('lc_whiteboard'));
    assert.deepEqual(
      exposure.exposedHandlers.map((handler) => handler.name),
      BUILTIN_TOOLS.map((handler) => handler.name),
    );
  });

  it('keeps the exported llm-client ToolName union in exact registry parity', () => {
    assert.equal(LLM_CLIENT_TOOL_NAMES_ARE_EXACT, true);
    assert.deepEqual(
      new Set(LLM_CLIENT_TOOL_NAMES),
      new Set(BUILTIN_TOOLS.map((handler) => handler.name)),
    );
  });

  it('keeps Whiteboard category, registry, and policy membership in parity', () => {
    assert.deepEqual(new Set(BUILTIN_TOOLS.map((handler) => handler.name)), ALL_TOOL_NAMES);
    assert.deepEqual(new Set(TOOL_POLICY.keys()), ALL_TOOL_NAMES);
    const hidden = resolveExposure({ enabled: true, whiteboard_enabled: false });
    assert.equal(hidden.exposedNames.has('lc_whiteboard'), false);

    const exposure = resolveExposure({ enabled: true, whiteboard_enabled: true });
    assert.equal(exposure.exposedNames.has('lc_whiteboard'), true);
    assert.equal(exposure.exposedNames.has('lc_tool_help'), true);
    const decision = authorizeNonFileCall(
      'lc_whiteboard',
      exposure,
      buildGrantSnapshot({ tool_grants: [], allowed_roots: [], dir_permissions: {} }),
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.state, 'no_prompt');
    assert.deepEqual(decision.policy, {
      name: 'lc_whiteboard',
      category: 'whiteboard',
      grantScope: 'none',
      promptPolicy: 'no_prompt',
      defaultGrantOnRootAdd: false,
      mutability: 'conversation_state',
    });
  });

  it('exposes no history tool when Workspace is off', () => {
    const exposure = resolveExposure({ enabled: false, tool_history_enabled: true });
    assert.equal(exposure.exposedNames.size, 0);
  });

  it('exposes tool help only with an operational category', () => {
    const foundationOnly = resolveExposure({ enabled: true });
    assert.deepEqual(
      [...foundationOnly.exposedNames],
      ['lc_todo_write', 'lc_ask_user', 'lc_get_current_time'],
    );
    assert.equal(foundationOnly.exposedNames.has('lc_tool_help'), false);

    const skillsOnly = resolveExposure({ enabled: true, skills_enabled: true });
    assert.equal(skillsOnly.exposedNames.has('lc_tool_help'), false);

    const historyOnly = resolveExposure({ enabled: true, tool_history_enabled: true });
    assert.equal(historyOnly.exposedNames.has('lc_tool_help'), false);

    const fileOnly = resolveExposure({ enabled: true, file_io_enabled: true });
    assert.equal(fileOnly.exposedNames.has('lc_tool_help'), true);
    assert.equal(fileOnly.exposedNames.size, 14);
  });

  it('authorizes foundation tools without a grant or popup', () => {
    const exposure = resolveExposure({ enabled: true });
    const expectedMutability = new Map([
      ['lc_todo_write', 'conversation_state'],
      ['lc_ask_user', 'conversation_state'],
      ['lc_get_current_time', 'read_only'],
    ]);
    for (const [name, mutability] of expectedMutability) {
      const decision = authorizeNonFileCall(
        name,
        exposure,
        buildGrantSnapshot({ tool_grants: [], allowed_roots: [], dir_permissions: {} }),
      );
      assert.equal(decision.allowed, true);
      assert.equal(decision.state, 'no_prompt');
      assert.equal(decision.policy.category, 'foundation');
      assert.equal(decision.policy.mutability, mutability);
    }
  });

  it('drops stale Foundation grants during normal grant normalization', () => {
    const normalized = normalizeGrantState({
      tool_grants: ['lc_todo_write', 'lc_ask_user', 'lc_get_current_time', 'lc_web_search'],
      allowed_roots: [],
      dir_permissions: {},
    });
    assert.deepEqual(normalized.tool_grants, ['lc_web_search']);
  });

  // The archived-turn marker occupies the function.name slot of the model's own
  // prior turns, so models imitate it. Pointing it at a real, declared tool is
  // the whole fix: a placeholder there costs a round-trip on unknown_tool, and
  // naming a tool absent from the request's tools array is its own risk.
  it('names a real, exposed tool in the archived-turn marker', () => {
    assert.ok(
      BUILTIN_TOOLS.some((handler) => handler.name === ARCHIVED_TOOL_NAME),
      `archived marker "${ARCHIVED_TOOL_NAME}" must be a built-in tool`,
    );
    const exposure = resolveExposure({ enabled: true, tool_history_enabled: true });
    assert.ok(
      exposure.exposedNames.has(ARCHIVED_TOOL_NAME),
      'the marker must be exposed wherever archiving happens',
    );
  });

  it('keeps a child-directory approval out of an enclosing root', () => {
    const parent = 'c:/lc-test/roots';
    const child = 'c:/lc-test/roots/what';
    const grants = buildGrantSnapshot({
      allowed_roots: [parent],
      dir_permissions: {},
    });

    const authorization = resolveFileAuthorization(
      'lc_write_file',
      [`${child}/sample.txt`],
      false,
      grants,
    );

    assert.deepEqual(authorization.ungrantedDirs, [child]);
    assert.deepEqual(authorization.missingGrantRoots, [parent]);

    const updated = grantToolOnRoots(
      { allowed_roots: [parent], dir_permissions: {} },
      'lc_write_file',
      authorization.ungrantedDirs,
    );

    assert.deepEqual(updated.dir_permissions?.[parent], undefined);
    assert.deepEqual(updated.dir_permissions?.[child], [
      'lc_write_file',
    ]);
  });

  it('inherits all seven ancestor read grants after a write-only child root is added', () => {
    const parent = 'c:/lc-test/roots';
    const child = `${parent}/what`;
    const readOnlyTools = [
      'lc_read_file',
      'lc_read_image',
      'lc_read_pdf',
      'lc_list_dir',
      'lc_stat',
      'lc_glob_files',
      'lc_grep',
    ];
    const grants = buildGrantSnapshot({
      allowed_roots: [parent, child],
      dir_permissions: {
        [parent]: readOnlyTools,
        [child]: ['lc_write_file'],
      },
    });

    for (const toolName of readOnlyTools) {
      const readAuthorization = resolveFileAuthorization(
        toolName,
        [child],
        true,
        grants,
      );
      assert.equal(readAuthorization.allGranted, true, toolName);
      assert.deepEqual(readAuthorization.matchedRoots, [parent], toolName);
    }

    const writeAuthorization = resolveFileAuthorization(
      'lc_write_file',
      [child],
      true,
      grants,
    );

    assert.equal(writeAuthorization.allGranted, true);
    assert.deepEqual(writeAuthorization.matchedRoots, [child]);
  });

  it('lets a root write grant cover descendants despite a read-only child root', () => {
    const parent = 'c:/lc-test/roots';
    const child = `${parent}/what`;
    const nested = `${child}/nested`;
    const grants = buildGrantSnapshot({
      allowed_roots: [parent, child],
      dir_permissions: {
        [parent]: ['lc_write_file'],
        [child]: ['lc_read_file'],
      },
    });

    const authorization = resolveFileAuthorization(
      'lc_write_file',
      [nested],
      true,
      grants,
    );

    assert.equal(authorization.allGranted, true);
    assert.deepEqual(authorization.matchedRoots, [parent]);
  });

  it('does not broaden a child write grant to its parent or sibling', () => {
    const parent = 'c:/lc-test/roots';
    const child = `${parent}/what`;
    const sibling = `${parent}/other`;
    const grants = buildGrantSnapshot({
      allowed_roots: [parent, child],
      dir_permissions: {
        [parent]: ['lc_read_file'],
        [child]: ['lc_write_file'],
      },
    });

    const parentAuthorization = resolveFileAuthorization(
      'lc_write_file',
      [parent],
      true,
      grants,
    );
    const siblingAuthorization = resolveFileAuthorization(
      'lc_write_file',
      [sibling],
      true,
      grants,
    );

    assert.equal(parentAuthorization.allGranted, false);
    assert.deepEqual(parentAuthorization.ungrantedDirs, [parent]);
    assert.equal(siblingAuthorization.allGranted, false);
    assert.deepEqual(siblingAuthorization.ungrantedDirs, [sibling]);
  });

  it('keeps a mixed lc_stat batch scoped to target directories', () => {
    const parent = 'c:/lc-test/roots';
    const child = 'c:/lc-test/roots/what';
    const nestedMissing = `${child}/nonexistent_dir`;
    const grants = buildGrantSnapshot({
      allowed_roots: [parent],
      dir_permissions: {},
    });

    const authorization = resolveFileAuthorization(
      'lc_stat',
      [child, child, child, nestedMissing],
      true,
      grants,
    );

    assert.deepEqual(authorization.ungrantedDirs, [child]);
    assert.deepEqual(authorization.missingGrantRoots, [parent]);
  });

  it('keeps disjoint child scopes separate when no requested parent covers them', () => {
    const parent = 'c:/lc-test/roots';
    const pip = 'c:/lc-test/roots/what/pip';
    const setuptools = 'c:/lc-test/roots/what/setuptools';
    const grants = buildGrantSnapshot({
      allowed_roots: [parent],
      dir_permissions: {},
    });

    const authorization = resolveFileAuthorization(
      'lc_stat',
      [pip, setuptools],
      true,
      grants,
    );

    assert.deepEqual(authorization.ungrantedDirs, [pip, setuptools]);
  });

  it('does not strip a canonical scope directory a second time', () => {
    const grants = buildGrantSnapshot({
      allowed_roots: ['c:/lc-test/roots'],
      dir_permissions: {},
    });

    const authorization = resolveFileAuthorization(
      'lc_read_image',
      ['C:\\lc-test\\roots\\what', 'E:\\tmp'],
      true,
      grants,
    );

    assert.deepEqual(authorization.ungrantedDirs, [
      'C:\\lc-test\\roots\\what',
      'E:\\tmp',
    ]);
  });

  it('prompts for every exact out-of-root apply_patch scope without broadening', () => {
    const grants = buildGrantSnapshot({ allowed_roots: [], dir_permissions: {} });
    const exposure = resolveExposure({ enabled: true, file_io_enabled: true });
    const targets = ['C:\\outside\\alpha', 'D:\\other\\beta'];
    const authorization = resolveFileAuthorization('lc_apply_patch', targets, true, grants);
    const decision = authorizeFileCall('lc_apply_patch', exposure, grants, authorization);

    assert.deepEqual(authorization.ungrantedDirs, targets);
    assert.equal(decision.state, 'prompt');
    assert.deepEqual(decision.ungrantedDirs, targets);
    assert.deepEqual(grantedDirectoriesForDecision(targets, 'deny'), []);
  });

  it('preserves a Windows drive root when taking a parent', () => {
    assert.equal(parentDir('E:\\tmp'), 'E:\\');
  });
});

describe('production cancellation link', () => {
  it('aborts the native group once and detaches cleanly', async () => {
    const controller = new AbortController();
    const calls: Array<{ groupId: string }> = [];
    const detach = attachGroupAbort(controller.signal, 'group-1', async (args) => {
      calls.push(args);
      return 1 as never;
    });

    controller.abort();
    controller.abort();
    await Promise.resolve();
    assert.deepEqual(calls, [{ groupId: 'group-1' }]);

    detach();
    assert.equal(calls.length, 1);
  });

  it('signals native cancellation for an already-aborted call', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    attachGroupAbort(controller.signal, 'group-2', async () => {
      called = true;
      return 1 as never;
    });
    await Promise.resolve();
    assert.equal(called, true);
  });
});

describe('permission modal serialization', () => {
  it('settles a thrown modal as denied and continues the queue', async () => {
    let attempt = 0;
    const modal = createSerializedAsyncQueue<[], { decision: 'allow_once' | 'deny' }>(
      async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('modal failed');
        return { decision: 'allow_once' as const };
      },
      () => ({ decision: 'deny' as const }),
    );

    assert.deepEqual(await modal(), { decision: 'deny' });
    assert.deepEqual(await modal(), { decision: 'allow_once' });
  });
});

describe('permission modal directory scopes', () => {
  it('approves all listed directories or none', () => {
    const dirs = ['c:/lc-test/roots/what', 'c:/lc-test/roots/other'];

    assert.deepEqual(grantedDirectoriesForDecision(dirs, 'allow_once'), dirs);
    assert.deepEqual(grantedDirectoriesForDecision(dirs, 'allow_session'), dirs);
    assert.deepEqual(grantedDirectoriesForDecision(dirs, 'deny'), []);
  });
});

describe('web research bounds and cancellation', () => {
  function context(
    signal: AbortSignal,
    webSearch: ToolHandlerContext['sandbox']['webSearch'],
    webFetch: ToolHandlerContext['sandbox']['webFetch'],
    llmCall?: ToolHandlerContext['llmCall'],
  ): ToolHandlerContext {
    return {
      sandbox: { webSearch, webFetch } as ToolHandlerContext['sandbox'],
      config: {
        searchProvider: { provider: 'brave', apiKey: 'test-key', baseUrl: '' },
      } as ToolHandlerContext['config'],
      signal,
      ...(llmCall ? { llmCall } : {}),
      identity: {
        groupId: 'research-group',
        operationId: 'research-operation',
        modelToolCallId: 'model-call',
        conversationId: 'conversation',
        generationId: 'generation',
      },
    };
  }

  it('uses one broad search and treats max_results as the usable-source cap', async () => {
    const searches: number[] = [];
    const controller = new AbortController();
    const ctx = context(
      controller.signal,
      async (args) => {
        searches.push(args.max_results ?? 0);
        return {
          source: 'brave',
          results: [{ title: 'One', url: 'https://example.com/one', snippet: 'one' }],
        };
      },
      async () => ({ status: 200, final_url: '', content_type: 'text/plain', body: '', truncated: false }),
    );

    const result = await webResearch.run({ query: 'typescript', max_results: 1 }, ctx);
    assert.deepEqual(searches, [10]);
    assert.equal(result.sources.length, 1);
    assert.equal(result.research_info.search_mode, 'broad');
    assert.equal(result.research_info.search_requests_used, 1);
  });

  it('uses one verified focused search for preferred domains', async () => {
    const queries: string[] = [];
    const controller = new AbortController();
    const ctx = context(
      controller.signal,
      async (args) => {
        queries.push(args.query);
        return {
          source: 'brave',
          results: [
            { title: 'Official', url: 'https://docs.example.com/guide', snippet: 'official' },
            { title: 'Unexpected', url: 'https://other.example.net/post', snippet: 'other' },
          ],
        };
      },
      async () => ({ status: 200, final_url: '', content_type: 'text/plain', body: '', truncated: false }),
    );

    const result = await webResearch.run({
      query: 'example guide',
      preferred_domains: ['example.com'],
      max_results: 2,
    }, ctx);

    assert.equal(queries.length, 1);
    assert.match(queries[0], /site:example\.com/);
    assert.equal(result.sources.length, 1, 'out-of-domain search hits are discarded');
    assert.equal(result.research_info.search_mode, 'focused');
    assert.equal(result.research_info.search_requests_used, 1);
  });

  it('spends a second search call only for explicit cross-checking', async () => {
    const queries: string[] = [];
    const controller = new AbortController();
    const ctx = context(
      controller.signal,
      async (args) => {
        queries.push(args.query);
        return { source: 'brave', results: [] };
      },
      async () => ({ status: 200, final_url: '', content_type: 'text/plain', body: '', truncated: false }),
    );

    const result = await webResearch.run({
      query: 'verify example',
      preferred_domains: ['example.com'],
      cross_check: true,
    }, ctx);

    assert.equal(queries.length, 2);
    assert.ok(queries.some((query) => query === 'verify example'));
    assert.ok(queries.some((query) => query.includes('site:example.com')));
    assert.equal(result.research_info.search_mode, 'cross_check');
    assert.equal(result.research_info.search_requests_used, 2);
  });

  it('settles every cross-check search child before it reports a sibling failure', async () => {
    const controller = new AbortController();
    const bothStarted = Promise.withResolvers<void>();
    const releaseBroad = Promise.withResolvers<void>();
    let searches = 0;
    let parentSettled = false;
    let parentError: unknown;
    const ctx = context(
      controller.signal,
      async (args) => {
        searches += 1;
        if (searches === 2) bothStarted.resolve();
        await bothStarted.promise;
        if (args.query.includes('site:example.com')) {
          throw new Error('focused search failed');
        }
        await releaseBroad.promise;
        return { source: 'brave', results: [] };
      },
      async () => ({ status: 200, final_url: '', content_type: 'text/plain', body: '', truncated: false }),
    );

    const parent = webResearch.run({
      query: 'verify child lifetime',
      preferred_domains: ['example.com'],
      cross_check: true,
    }, ctx).then(
      () => { parentSettled = true; },
      (error: unknown) => {
        parentSettled = true;
        parentError = error;
      },
    );

    await bothStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      assert.equal(parentSettled, false, 'the parent must remain live while a search child is active');
    } finally {
      releaseBroad.resolve();
      await parent;
    }
    assert.match(String(parentError), /focused search failed/);
  });

  it('backfills failed fetches from the same search result pool', async () => {
    const controller = new AbortController();
    let fetches = 0;
    const ctx = context(
      controller.signal,
      async () => ({
        source: 'brave',
        results: Array.from({ length: 5 }, (_, index) => ({
          title: `Result ${index}`,
          url: `https://source${index}.example/page`,
          snippet: 'snippet',
        })),
      }),
      async (args) => {
        fetches += 1;
        if (args.url.includes('source0')) {
          return { status: 403, final_url: args.url, content_type: 'text/html', body: 'Access denied', truncated: false };
        }
        return {
          status: 200,
          final_url: args.url,
          content_type: 'text/plain',
          body: 'usable research content '.repeat(30),
          truncated: false,
        };
      },
      async () => 'Synthesized [1] [2]',
    );

    const result = await webResearch.run({ query: 'backfill example', max_results: 2 }, ctx);

    assert.equal(fetches, 3);
    assert.equal(result.sources.length, 2);
    assert.ok(result.sources.every((source) => !source.url.includes('source0')));
    assert.equal(result.research_info.search_requests_used, 1);
    assert.equal(result.research_info.fetch_requests_used, 3);
  });

  it('runs fetch children concurrently with a hard width of four', async () => {
    const controller = new AbortController();
    const release = Promise.withResolvers<void>();
    const firstBatchStarted = Promise.withResolvers<void>();
    let active = 0;
    let maxActive = 0;
    let fetches = 0;
    const ctx = context(
      controller.signal,
      async () => ({
        source: 'brave',
        results: Array.from({ length: 6 }, (_, index) => ({
          title: `Result ${index}`,
          url: `https://source${index}.example/page`,
          snippet: 'snippet',
        })),
      }),
      async (args) => {
        fetches += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (fetches === 4) firstBatchStarted.resolve();
        await release.promise;
        active -= 1;
        return {
          status: 200,
          final_url: args.url,
          content_type: 'text/plain',
          body: 'usable research content '.repeat(30),
          truncated: false,
        };
      },
      async () => 'Synthesized',
    );

    const pending = webResearch.run({ query: 'concurrency', max_results: 6 }, ctx);
    await firstBatchStarted.promise;
    assert.equal(fetches, 4, 'the second batch must wait for the first');
    assert.equal(maxActive, 4, 'the real fetch fan-out reaches its configured width');
    release.resolve();
    const result = await pending;
    assert.equal(result.sources.length, 6);
    assert.equal(maxActive, 4);
  });

  it('retries sparse clean HTML once with minimal extraction', async () => {
    const controller = new AbortController();
    const stripModes: Array<string | undefined> = [];
    const ctx = context(
      controller.signal,
      async () => ({
        source: 'brave',
        results: [{ title: 'SPA', url: 'https://spa.example/page', snippet: 'snippet' }],
      }),
      async (args) => {
        stripModes.push(args.strip_mode);
        return {
          status: 200,
          final_url: args.url,
          content_type: 'text/html',
          body: args.strip_mode === 'clean' ? '' : 'usable inline application data '.repeat(25),
          truncated: false,
        };
      },
      async () => 'Synthesized [1]',
    );

    const result = await webResearch.run({ query: 'SPA data', max_results: 1 }, ctx);

    assert.deepEqual(stripModes, ['clean', 'minimal']);
    assert.equal(result.sources.length, 1);
    assert.equal(result.research_info.fetch_requests_used, 2);
  });

  it('accepts hostnames but rejects URLs and path-scoped preferred domains', () => {
    assert.equal(webResearch.input.safeParse({
      query: 'valid',
      preferred_domains: ['react.dev', 'docs.example.com'],
    }).success, true);
    assert.equal(webResearch.input.safeParse({
      query: 'invalid URL',
      preferred_domains: ['https://react.dev'],
    }).success, false);
    assert.equal(webResearch.input.safeParse({
      query: 'invalid path',
      preferred_domains: ['github.com/facebook/react'],
    }).success, false);
    assert.equal(webResearch.input.safeParse({
      query: 'invalid IP literal',
      preferred_domains: ['127.0.0.1'],
    }).success, false);
  });

  it('starts no later fetch batch after cancellation', async () => {
    const controller = new AbortController();
    let fetches = 0;
    const ctx = context(
      controller.signal,
      async () => ({
        source: 'brave',
        results: Array.from({ length: 6 }, (_, index) => ({
          title: `Result ${index}`,
          url: `https://example.com/${index}`,
          snippet: 'snippet',
        })),
      }),
      async () => {
        fetches += 1;
        controller.abort();
        return { status: 200, final_url: '', content_type: 'text/plain', body: '', truncated: false };
      },
    );

    await assert.rejects(
      webResearch.run({ query: 'plain query', max_results: 6 }, ctx),
      (error: unknown) => (
        typeof error === 'object' && error !== null &&
        (error as { code?: string }).code === 'Aborted'
      ),
    );
    assert.ok(fetches >= 1 && fetches <= 4, 'cancellation may finish only the already-admitted bounded batch');
  });

  it('reports cancellation before validating late sub-agent output', async () => {
    const controller = new AbortController();
    const ctx = context(
      controller.signal,
      async () => ({
        source: 'brave',
        results: [{ title: 'One', url: 'https://example.com/one', snippet: 'one' }],
      }),
      async (args) => ({
        status: 200,
        final_url: args.url,
        content_type: 'text/plain',
        body: 'usable research content '.repeat(30),
        truncated: false,
      }),
      async (params) => {
        assert.equal(params.signal, controller.signal);
        controller.abort();
        return 'x'.repeat(WEB_RESEARCH_SUMMARY_MAX_BYTES + 1);
      },
    );

    await assert.rejects(
      webResearch.run({ query: 'late synthesis', max_results: 1 }, ctx),
      (error: unknown) => (
        typeof error === 'object' && error !== null &&
        (error as { code?: string }).code === 'Aborted'
      ),
    );
  });

  it('enforces the complete synthesis-prompt and per-source caps', async () => {
    const controller = new AbortController();
    let prompt = '';
    const ctx = context(
      controller.signal,
      async () => ({
        source: 'brave',
        results: Array.from({ length: 10 }, (_, index) => ({
          title: `Title ${index}`,
          url: `https://source${index}.example/page`,
          snippet: 'snippet',
        })),
      }),
      async (args) => ({
        status: 200,
        final_url: args.url,
        content_type: 'text/plain',
        body: 'x'.repeat(100_000),
        truncated: false,
      }),
      async (params) => {
        prompt = String(params.userContent);
        return 'Synthesized';
      },
    );

    await webResearch.run({ query: 'prompt cap', max_results: 10 }, ctx);
    assert.ok(prompt.length <= WEB_RESEARCH_PROMPT_MAX_CHARS);
    const contentSections = prompt.split(/\[Source \d+ [^\]]*\]\nTitle:[\s\S]*?\nContent:\n/).slice(1);
    assert.equal(contentSections.length, 10);
    for (const [index, section] of contentSections.entries()) {
      const withoutFollowingSeparator = section.replace(/\n\n$/, '');
      const content = withoutFollowingSeparator.replace(/\n\[Content truncated by LC\]$/, '');
      assert.ok(
        content.length <= WEB_RESEARCH_SOURCE_MAX_CHARS,
        `source ${index + 1} exceeded its content cap`,
      );
    }
  });

  it('accepts the synthesis byte cap and rejects blank or oversized model text', async () => {
    const controller = new AbortController();
    const baseContext = (llmCall: NonNullable<ToolHandlerContext['llmCall']>) => context(
      controller.signal,
      async () => ({
        source: 'brave',
        results: [{ title: 'Source', url: 'https://source.example/page', snippet: 'snippet' }],
      }),
      async (args) => ({
        status: 200,
        final_url: args.url,
        content_type: 'text/plain',
        body: 'usable research content '.repeat(30),
        truncated: false,
      }),
      llmCall,
    );

    const exact = 'x'.repeat(WEB_RESEARCH_SUMMARY_MAX_BYTES);
    const accepted = await webResearch.run(
      { query: 'bounded synthesis', max_results: 1 },
      baseContext(async () => exact),
    );
    assert.equal(accepted.summary, exact);

    await assert.rejects(
      webResearch.run(
        { query: 'oversized synthesis', max_results: 1 },
        baseContext(async () => `${exact}x`),
      ),
      (error: unknown) => (
        typeof error === 'object' && error !== null
        && (error as { code?: string }).code === 'ModelOutputTooLarge'
        && String((error as { message?: string }).message).includes(`limit is ${WEB_RESEARCH_SUMMARY_MAX_BYTES} bytes`)
      ),
    );

    await assert.rejects(
      webResearch.run(
        { query: 'blank synthesis', max_results: 1 },
        baseContext(async () => ' \n\t '),
      ),
      (error: unknown) => (
        typeof error === 'object' && error !== null
        && (error as { code?: string }).code === 'InvalidModelOutput'
      ),
    );
  });

  it('starts no child after the inherited deadline has expired', async () => {
    const controller = new AbortController();
    let searches = 0;
    const ctx = context(
      controller.signal,
      async () => {
        searches += 1;
        return { source: 'brave', results: [] };
      },
      async () => ({ status: 200, final_url: '', content_type: 'text/plain', body: '', truncated: false }),
    );
    ctx.config.deadlineMs = Date.now() - 1;

    await assert.rejects(
      webResearch.run({ query: 'late' }, ctx),
      (error: unknown) => (
        typeof error === 'object' && error !== null &&
        (error as { code?: string }).code === 'Timeout'
      ),
    );
    assert.equal(searches, 0);
  });

  it('rejects a sub-agent success that arrives after the inherited deadline', async () => {
    const controller = new AbortController();
    const ctx = context(
      controller.signal,
      async () => ({
        source: 'brave',
        results: [{ title: 'Source', url: 'https://source.example/page', snippet: 'snippet' }],
      }),
      async (args) => ({
        status: 200,
        final_url: args.url,
        content_type: 'text/plain',
        body: 'usable research content '.repeat(30),
        truncated: false,
      }),
      async () => {
        ctx.config.deadlineMs = Date.now() - 1;
        return 'Late synthesis';
      },
    );
    ctx.config.deadlineMs = Date.now() + 30_000;

    await assert.rejects(
      webResearch.run({ query: 'late synthesis' }, ctx),
      (error: unknown) => (
        typeof error === 'object' && error !== null &&
        (error as { code?: string }).code === 'Timeout'
      ),
    );
  });
});

describe('tool history result budgets', () => {
  it('enforces the caller byte cap in direct and message retrieval modes', async () => {
    const conversationId = 'tool-history-budget-test';
    const priorById = useConversations.getState().byId;
    useConversations.setState({
      byId: {
        ...priorById,
        [conversationId]: {
          id: conversationId,
          title: 'test',
          model: 'test',
          createdAt: 1,
          updatedAt: 1,
          messages: [
            {
              id: 'assistant-1',
              role: 'assistant',
              content: '',
              createdAt: 1,
              tool_calls: [
                { created_at: 0, id: 'call-1', name: 'lc_read_file', arguments: '{}', status: 'ok' },
                { created_at: 0, id: 'call-2', name: 'lc_read_file', arguments: '{}', status: 'ok' },
              ],
            },
            { id: 'result-1', role: 'tool', content: '😀'.repeat(20), createdAt: 2, tool_call_id: 'call-1' },
            { id: 'result-2', role: 'tool', content: 'second-result', createdAt: 3, tool_call_id: 'call-2' },
          ],
        } as never,
      },
    });

    const ctx = {
      config: { convId: conversationId },
    } as ToolHandlerContext;
    try {
      const direct = await toolHistory.run(
        { tool_call_id: 'call-1', max_result_bytes: 5 },
        ctx,
      ) as ToolHistoryOutput;
      assert.ok(utf8ByteLength(direct.results[0].output) <= 5);
      assert.equal(direct.truncated, true);

      const message = await toolHistory.run(
        { message_id: 'assistant-1', max_result_bytes: 9 },
        ctx,
      ) as ToolHistoryOutput;
      assert.ok(message.results.reduce((sum, item) => sum + utf8ByteLength(item.output), 0) <= 9);
      assert.equal(message.truncated, true);
    } finally {
      useConversations.setState({ byId: priorById });
    }
  });
});

describe('optional parameter absence encoding (Invariant 9)', () => {
  it('lc_skill accepts empty and whitespace id as list mode', async () => {
    assert.equal(skill.input.safeParse({}).success, true);
    assert.equal(skill.input.safeParse({ id: '' }).success, true);
    assert.equal(skill.input.safeParse({ id: '   ' }).success, true);

    const ctx = {
      config: {
        skillIds: ['lc:builtin:lc-tools'],
        exposedToolNames: ['lc_read_file'],
      },
    } as unknown as ToolHandlerContext;

    const omitted = await skill.run({}, ctx);
    assert.equal(omitted.mode, 'list');

    const empty = await skill.run({ id: '' }, ctx);
    assert.equal(empty.mode, 'list');

    const whitespace = await skill.run({ id: '   ' }, ctx);
    assert.equal(whitespace.mode, 'list');
  });

  it('lc_web_search and lc_web_research accept empty and whitespace freshness as all-time', async () => {
    assert.equal(webSearch.input.safeParse({ query: 'test' }).success, true);
    assert.equal(webSearch.input.safeParse({ query: 'test', freshness: '' }).success, true);
    assert.equal(webSearch.input.safeParse({ query: 'test', freshness: '   ' }).success, true);
    assert.equal(webSearch.input.safeParse({ query: 'test', freshness: '\t\n' }).success, true);
    assert.equal(webSearch.input.safeParse({ query: 'test', freshness: 'pd' }).success, true);
    assert.equal(webSearch.input.safeParse({ query: 'test', freshness: '2024-01-01to2024-06-30' }).success, true);
    assert.equal(webSearch.input.safeParse({ query: 'test', freshness: 'invalid' }).success, false);

    assert.equal(webResearch.input.safeParse({ query: 'test' }).success, true);
    assert.equal(webResearch.input.safeParse({ query: 'test', freshness: '' }).success, true);
    assert.equal(webResearch.input.safeParse({ query: 'test', freshness: '   ' }).success, true);
    assert.equal(webResearch.input.safeParse({ query: 'test', freshness: '\t\n' }).success, true);
    assert.equal(webResearch.input.safeParse({ query: 'test', freshness: 'pw' }).success, true);
    assert.equal(webResearch.input.safeParse({ query: 'test', freshness: 'invalid' }).success, false);

    let receivedFreshness: string | undefined = 'initial';
    const sandbox = {
      webSearch: async (args: { freshness?: string }) => {
        receivedFreshness = args.freshness;
        return { results: [], source: 'brave' };
      },
    };
    const ctx = {
      sandbox,
      config: {
        searchProvider: { provider: 'brave', apiKey: 'test', baseUrl: '' },
      },
      identity: { operationId: 'op1', groupId: 'g1' },
    } as unknown as ToolHandlerContext;

    const out = await webSearch.run({ query: 'test', freshness: '   ' }, ctx);
    assert.equal(receivedFreshness, undefined);
    assert.deepEqual(out.ignored_params, []);
  });

  it('lc_get_current_time treats empty and whitespace tz as omitted', async () => {
    const system = resolveTz(undefined);
    assert.equal(system.tz_warning, undefined);

    const empty = resolveTz('');
    assert.equal(empty.tz, system.tz);
    assert.equal(empty.tz_warning, undefined);

    const whitespace = resolveTz('   ');
    assert.equal(whitespace.tz, system.tz);
    assert.equal(whitespace.tz_warning, undefined);

    const tabs = resolveTz('\t\n');
    assert.equal(tabs.tz, system.tz);
    assert.equal(tabs.tz_warning, undefined);

    const out = await getCurrentTime.run({ tz: '   ' }, {} as ToolHandlerContext);
    assert.equal(out.tz, system.tz);
    assert.equal(out.tz_warning, null);
  });

  it('lc_list_dir normalizes empty pattern to undefined', async () => {
    let receivedPattern: string | undefined = 'initial';
    const sandbox = {
      listDir: async (args: { pattern?: string }) => {
        receivedPattern = args.pattern;
        return { results: [] };
      },
    };
    const ctx = {
      sandbox,
      config: { allowedRoots: ['C:\\repo'] },
    } as unknown as ToolHandlerContext;

    await listDir.run({ paths: ['C:\\repo'], pattern: '   ' }, ctx);
    assert.equal(receivedPattern, undefined);
  });

  it('lc_grep normalizes empty include to undefined', async () => {
    let receivedInclude: string | undefined = 'initial';
    const sandbox = {
      grep: async (args: { include?: string }) => {
        receivedInclude = args.include;
        return { results: [] };
      },
    };
    const ctx = {
      sandbox,
      config: { allowedRoots: ['C:\\repo'], maxShellTimeoutMs: 30000 },
      identity: { operationId: 'op1', groupId: 'g1' },
    } as unknown as ToolHandlerContext;

    await grep.run({ searches: [{ path: 'C:\\repo', pattern: 'foo' }], include: '   ' }, ctx);
    assert.equal(receivedInclude, undefined);
  });

  it('lc_run_shell normalizes empty cwd to undefined', async () => {
    let receivedCwd: string | undefined = 'initial';
    const sandbox = {
      runShell: async (args: { cwd?: string }) => {
        receivedCwd = args.cwd;
        return {
          stdout: '', stderr: '', exit_code: 0, duration_ms: 1, timed_out: false,
          stdout_truncated: false, stderr_truncated: false,
        };
      },
    };
    const ctx = {
      sandbox,
      config: { allowedRoots: ['C:\\repo'], shellAllowlist: ['echo'], maxShellTimeoutMs: 30000 },
      identity: { operationId: 'op1', groupId: 'g1' },
      signal: new AbortController().signal,
    } as unknown as ToolHandlerContext;

    await runShell.run({ cmd: 'echo', cwd: '   ' }, ctx);
    assert.equal(receivedCwd, undefined);
  });

  it('lc_run_shell preserves whitespace-only stdin through validation and execution', async () => {
    const content = ' \t\n ';
    const validated = validateToolCalls([{
      created_at: 0,
      id: 'stdin-whitespace',
      name: 'lc_run_shell',
      arguments: JSON.stringify({ cmd: 'echo', stdin: content }),
    }], HANDLERS_BY_NAME)[0];
    assert.equal(validated.error, undefined);
    assert.equal((validated.parsed as { stdin: string }).stdin, content);

    let receivedStdin: string | undefined;
    const sandbox = {
      runShell: async (args: { stdin?: string }) => {
        receivedStdin = args.stdin;
        return {
          stdout: '', stderr: '', exit_code: 0, duration_ms: 1, timed_out: false,
          stdout_truncated: false, stderr_truncated: false,
        };
      },
    };
    const ctx = {
      sandbox,
      config: { allowedRoots: ['C:\\repo'], shellAllowlist: ['echo'], maxShellTimeoutMs: 30000 },
      identity: { operationId: 'op1', groupId: 'g1' },
      signal: new AbortController().signal,
    } as unknown as ToolHandlerContext;

    await runShell.run(validated.parsed as { cmd: string; stdin: string }, ctx);
    assert.equal(receivedStdin, content);
  });

  it('lc_write_file normalizes empty expected_sha256 to undefined', async () => {
    let receivedExpected: string | undefined = 'initial';
    const sandbox = {
      writeFile: async (args: { files: Array<{ expected_sha256?: string }> }) => {
        receivedExpected = args.files[0]?.expected_sha256;
        return { results: [] };
      },
    };
    const ctx = {
      sandbox,
      config: { allowedRoots: ['C:\\repo'] },
    } as unknown as ToolHandlerContext;

    await writeFile.run({ files: [{ path: 'C:\\repo\\f.txt', content: 'x', expected_sha256: '  ' }] }, ctx);
    assert.equal(receivedExpected, undefined);
  });

  it('absorbs null on 64 optional parameters across the 20 applicable tools (Invariant 9)', () => {
    assert.equal(BUILTIN_TOOLS.length, 21);

    const callsWithNulls: Array<{ name: string; args: Record<string, unknown> }> = [
      {
        name: 'lc_read_file',
        args: { paths: ['/path/to/file.txt'], start_line: null, end_line: null, max_bytes: null },
      },
      {
        name: 'lc_read_image',
        args: { paths: ['/path/to/image.png'], max_bytes: null, encoding: null, downscale: null, analyze: null, instruction: null },
      },
      {
        name: 'lc_read_pdf',
        args: { paths: ['/path/to/doc.pdf'], depth: null, pages: null, force_render: null, include_text: null, instruction: null, max_bytes: null },
      },
      {
        name: 'lc_write_file',
        args: { files: [{ path: '/path/to/file.txt', content: 'hello', expected_sha256: null }], mode: null },
      },
      {
        name: 'lc_list_dir',
        args: { paths: ['/path/to/dir'], pattern: null, include_hidden: null, max_entries: null },
      },
      {
        name: 'lc_stat',
        args: { paths: ['/path/to/item'] },
      },
      {
        name: 'lc_glob_files',
        args: { pattern: '**/*', root: '/path/to/dir', include_hidden: null, max_results: null },
      },
      {
        name: 'lc_grep',
        args: { searches: [{ path: '/path/to/dir', pattern: 'foo' }], include: null, ignore_case: null, max_results: null },
      },
      {
        name: 'lc_edit_file',
        args: { path: '/path/to/file.txt', old_string: 'old', new_string: 'new', create_if_missing: null, files: null },
      },
      {
        name: 'lc_apply_patch',
        args: { patch: '*** Begin Patch\n*** Add File: /path/to/file.txt\n+line\n*** End Patch' },
      },
      {
        name: 'lc_run_shell',
        args: { cmd: 'echo', args: null, cwd: null, timeout_ms: null, env: null, stdin: null },
      },
      {
        name: 'lc_web_fetch',
        args: { url: 'https://example.com', max_bytes: null, timeout_ms: null, strip_mode: null },
      },
      {
        name: 'lc_web_search',
        args: { query: 'test query', max_results: null, freshness: null, extra_snippets: null },
      },
      {
        name: 'lc_web_research',
        args: { query: 'test query', max_results: null, preferred_domains: null, cross_check: null, freshness: null, extra_snippets: null },
      },
      {
        name: 'lc_get_current_time',
        args: { tz: null, format: null },
      },
      {
        name: 'lc_todo_write',
        args: { todos: [{ id: 1, title: 'Task 1', status: 'not-started' }] },
      },
      {
        name: 'lc_ask_user',
        args: { questions: [{ id: 1, question: 'Choose one.', choices: [{ title: 'A' }, { title: 'B', description: null }] }] },
      },
      {
        name: 'lc_whiteboard',
        args: { action: 'read', content: null, old_string: null, new_string: null },
      },
      {
        name: 'lc_tool_history',
        args: { message_id: null, tool_name: null, tool_call_id: null, query: null, max_results: null, max_result_bytes: null },
      },
      {
        name: 'lc_skill',
        args: { id: null },
      },
      {
        name: 'lc_tool_help',
        args: { tool: 'lc_grep', query: null },
      },
    ];

    assert.equal(callsWithNulls.length, 21);
    const toolRecords = callsWithNulls.map((c, i) => ({
      created_at: 0,
      id: `call_${i}`,
      name: c.name,
      arguments: JSON.stringify(c.args),
    }));

    const validated = validateToolCalls(toolRecords, HANDLERS_BY_NAME);
    for (let i = 0; i < validated.length; i++) {
      const v = validated[i];
      assert.equal(v.error, undefined, `tool ${v.call.name} rejected null optional fields: ${JSON.stringify(v.error)}`);
      assert.ok(v.parsed !== undefined, `tool ${v.call.name} must produce parsed result`);
    }
  });

  it('normalizes every schema-optional field identically for null, empty, and whitespace values', () => {
    type SchemaNode = { properties?: Record<string, unknown>; required?: string[]; items?: unknown };
    type PathPart = string | number;

    const baseArgs: Record<string, Record<string, unknown>> = {
      lc_read_image: { paths: ['/path/to/image.png'] },
      lc_read_pdf: { paths: ['/path/to/doc.pdf'] },
      lc_read_file: { paths: ['/path/to/file.txt'] },
      lc_write_file: { files: [{ path: '/path/to/file.txt', content: 'hello' }] },
      lc_list_dir: { paths: ['/path/to/dir'] },
      lc_web_fetch: { url: 'https://example.com' },
      lc_get_current_time: {},
      lc_run_shell: { cmd: 'echo' },
      lc_todo_write: { todos: [{ id: 1, title: 'Task 1', status: 'not-started' }] },
      lc_ask_user: { questions: [{ id: 1, question: 'Choose one.', choices: [{ title: 'A' }, { title: 'B' }] }] },
      lc_whiteboard: { action: 'read' },
      lc_grep: { searches: [{ path: '/path/to/dir', pattern: 'foo' }] },
      lc_edit_file: {
        files: [{ path: '/path/to/file.txt', old_string: 'old', new_string: 'new' }],
      },
      lc_web_search: { query: 'test query' },
      lc_web_research: { query: 'test query' },
      lc_stat: { paths: ['/path/to/item'] },
      lc_glob_files: { pattern: '**/*', root: '/path/to/dir' },
      lc_apply_patch: { patch: '*** Begin Patch\n*** Add File: /path/to/file.txt\n+line\n*** End Patch' },
      lc_tool_history: {},
      lc_skill: {},
      lc_tool_help: { tool: 'lc_grep' },
    };

    const optionalPaths = (schema: unknown): PathPart[][] => {
      const found: PathPart[][] = [];
      const walk = (raw: unknown, prefix: PathPart[]) => {
        const node = raw as SchemaNode | undefined;
        const required = new Set(node?.required ?? []);
        for (const [key, child] of Object.entries(node?.properties ?? {})) {
          const path = [...prefix, key];
          if (!required.has(key)) found.push(path);
          const childNode = child as SchemaNode;
          if (childNode.items) walk(childNode.items, [...path, 0]);
          else walk(child, path);
        }
      };
      walk(schema, []);
      return found;
    };

    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const setAt = (target: Record<string, unknown>, path: PathPart[], value: unknown) => {
      let cursor: unknown = target;
      for (const part of path.slice(0, -1)) {
        cursor = (cursor as Record<string | number, unknown>)[part];
      }
      (cursor as Record<string | number, unknown>)[path.at(-1)!] = value;
    };
    const deleteAt = (target: Record<string, unknown>, path: PathPart[]) => {
      let cursor: unknown = target;
      for (const part of path.slice(0, -1)) {
        cursor = (cursor as Record<string | number, unknown>)[part];
      }
      delete (cursor as Record<string | number, unknown>)[path.at(-1)!];
    };

    let checked = 0;
    for (const handler of BUILTIN_TOOLS) {
      if (handler.name === 'lc_whiteboard') continue;
      const defaultBase = baseArgs[handler.name];
      for (const path of optionalPaths(handler.toJsonSchema())) {
        if (handler.name === 'lc_run_shell' && path.length === 1 && path[0] === 'stdin') {
          continue;
        }
        const base = handler.name === 'lc_edit_file'
          ? ['path', 'old_string', 'new_string'].includes(String(path[0]))
            ? { files: [{ path: '/path/to/file.txt', old_string: 'old', new_string: 'new' }] }
            : { path: '/path/to/file.txt', old_string: 'old', new_string: 'new' }
          : defaultBase;
        assert.ok(base, `missing absence-test base args for ${handler.name}`);
        const omitted = clone(base);
        deleteAt(omitted, path);
        const omittedResult = validateToolCalls([{
          created_at: 0,
          id: 'omitted', name: handler.name, arguments: JSON.stringify(omitted),
        }], HANDLERS_BY_NAME)[0];
        assert.equal(omittedResult.error, undefined, `${handler.name}.${path.join('.')} omission rejected`);

        for (const absence of [null, '', '   ']) {
          const encoded = clone(base);
          setAt(encoded, path, absence);
          const result = validateToolCalls([{
            created_at: 0,
            id: 'encoded', name: handler.name, arguments: JSON.stringify(encoded),
          }], HANDLERS_BY_NAME)[0];
          assert.equal(
            result.error,
            undefined,
            `${handler.name}.${path.join('.')} rejected ${JSON.stringify(absence)}: ${JSON.stringify(result.error)}`,
          );
          assert.deepEqual(
            result.parsed,
            omittedResult.parsed,
            `${handler.name}.${path.join('.')} did not normalize ${JSON.stringify(absence)} to omission`,
          );
        }
        checked++;
      }
    }
    // The todo note, completion evidence, and ask-user choice description are
    // optional and use the same absence normalization.
    // lc_grep also has exclude, context_lines, output_mode,
    // max_matches_per_file, include_excluded_dirs, and a per-search
    // include override. Each was checked above: all six normalize null,
    // empty, and whitespace to omission.
    assert.equal(checked, 64, 'the exhaustive optional-field inventory changed; review the new contract');
  });

  it('preserves empty conditional lc_edit_file flat fields when they carry meaning', () => {
    const deletion = validateToolCalls([{
      created_at: 0,
      id: 'delete',
      name: 'lc_edit_file',
      arguments: JSON.stringify({ path: '/path/to/file.txt', old_string: 'old', new_string: '' }),
    }], HANDLERS_BY_NAME)[0];
    assert.equal(deletion.error, undefined);
    assert.equal((deletion.parsed as { new_string: string }).new_string, '');
  });

  it('rejects incomplete or mixed lc_edit_file forms before execution', () => {
    const cases = [
      {
        arguments: {},
        fields: ['path', 'old_string', 'new_string'],
      },
      {
        arguments: { path: '/path/to/file.txt', old_string: 'old' },
        fields: ['new_string'],
      },
      {
        arguments: {
          path: '/ignored.txt',
          old_string: 'ignored',
          new_string: 'ignored',
          files: [{ path: '/used.txt', old_string: 'old', new_string: 'new' }],
        },
        fields: ['files', 'path', 'old_string', 'new_string'],
      },
    ] as const;

    for (const [index, probe] of cases.entries()) {
      const rejected = validateToolCalls([{
        created_at: 0,
        id: `edit-shape-${index}`,
        name: 'lc_edit_file',
        arguments: JSON.stringify(probe.arguments),
      }], HANDLERS_BY_NAME)[0];
      assert.equal(rejected.error?.[0]?.code, 'invalid_arguments');
      assert.equal(rejected.error?.[0]?.retryable, false);
      for (const field of probe.fields) {
        assert.match(rejected.error?.[0]?.message ?? '', new RegExp(`\\b${field}\\b`));
      }
    }
  });

  it('rejects blank search queries as field-specific invalid arguments', () => {
    for (const name of ['lc_web_search', 'lc_web_research']) {
      for (const query of ['', ' \n\t ']) {
        const rejected = validateToolCalls([{
          created_at: 0,
          id: `${name}-blank`,
          name,
          arguments: JSON.stringify({ query }),
        }], HANDLERS_BY_NAME)[0];
        assert.deepEqual(rejected.error, [{
          code: 'invalid_arguments',
          message: `Tool arguments failed validation: query: query must contain non-whitespace text. Send the topic or question to ${name === 'lc_web_search' ? 'search for.' : 'research.'}`,
          retryable: false,
        }]);
      }
    }
  });

  it('bounds malformed and path-correction detail copied into validation issues', () => {
    const calls = [
      {
        created_at: 0,
        id: 'oversized-malformed-detail',
        name: 'lc_web_search',
        arguments: `{"query":"x"}${'x'.repeat(TOOL_ISSUE_MESSAGE_MAX_BYTES * 4)}`,
      },
      {
        created_at: 0,
        id: 'oversized-path-correction',
        name: 'lc_read_file',
        arguments: JSON.stringify({
          paths: [`D:/${'x'.repeat(TOOL_ISSUE_MESSAGE_MAX_BYTES * 4)} /file.txt`],
        }),
      },
    ];
    for (const rejected of validateToolCalls(calls, HANDLERS_BY_NAME)) {
      const message = rejected.error?.[0]?.message ?? '';
      assert.ok(utf8ByteLength(message) <= TOOL_ISSUE_MESSAGE_MAX_BYTES);
      assert.ok(message.includes(TOOL_ISSUE_TRUNCATION_MARKER.trim()));
    }
  });

  it('rejects every empty batch with a field-specific actionable remedy', () => {
    const cases = [
      ['lc_read_file', 'paths', 'paths must contain at least one path. Add a file path and retry.'],
      ['lc_read_image', 'paths', 'paths must contain at least one path. Add an image path and retry.'],
      ['lc_read_pdf', 'paths', 'paths must contain at least one path. Add a PDF path and retry.'],
      ['lc_write_file', 'files', 'files must contain at least one entry. Add a file and retry.'],
      ['lc_list_dir', 'paths', 'paths must contain at least one path. Add a directory path and retry.'],
      ['lc_stat', 'paths', 'paths must contain at least one path. Add a path and retry.'],
      ['lc_grep', 'searches', 'searches must contain at least one entry. Add a path-pattern search and retry.'],
      ['lc_edit_file', 'files', 'files must contain at least one entry. Add a file edit or use the flat path/old_string/new_string form.'],
      ['lc_todo_write', 'todos', 'todos must contain at least one item. Add a todo item and submit the complete list.'],
    ] as const;

    for (const [name, field, expectedMessage] of cases) {
      const rejected = validateToolCalls([{
        created_at: 0,
        id: 'empty', name, arguments: JSON.stringify({ [field]: [] }),
      }], HANDLERS_BY_NAME)[0];
      assert.equal(
        rejected.error?.[0]?.message,
        `Tool arguments failed validation: ${field}: ${expectedMessage}`,
        `${name}.${field} empty-batch remedy drifted`,
      );
    }
  });

  it('preserves every action-relevant Whiteboard optional string exactly', () => {
    const cases = [
      { action: 'replace', content: '' },
      { action: 'replace', content: ' \n\t' },
      { action: 'edit', old_string: '  ', new_string: '' },
      { action: 'edit', old_string: '\t', new_string: '  ' },
    ];
    const validated = validateToolCalls(cases.map((args, index) => ({
      created_at: 0,
      id: `whiteboard-exact-${index}`,
      name: 'lc_whiteboard',
      arguments: JSON.stringify(args),
    })), HANDLERS_BY_NAME);
    assert.deepEqual(validated.map((entry) => entry.error), cases.map(() => undefined));
    assert.deepEqual(validated.map((entry) => entry.parsed), cases);
  });

  it('pins and replays the stat and todo collection-cap remedies', () => {
    const statAtCap = Array.from({ length: 100 }, (_, i) => `/path/stat-${i}`);
    const statRejected = validateToolCalls([{
      created_at: 0,
      id: 'stat-over', name: 'lc_stat', arguments: JSON.stringify({ paths: [...statAtCap, '/path/stat-100'] }),
    }], HANDLERS_BY_NAME)[0];
    assert.equal(
      statRejected.error?.[0]?.message,
      'Tool arguments failed validation: paths: paths accepts at most 100 entries. Split the stat request into batches of 100 or fewer paths.',
    );
    for (const [index, paths] of [statAtCap, ['/path/stat-100']].entries()) {
      const replay = validateToolCalls([{
        created_at: 0,
        id: `stat-replay-${index}`, name: 'lc_stat', arguments: JSON.stringify({ paths }),
      }], HANDLERS_BY_NAME)[0];
      assert.equal(replay.error, undefined, `lc_stat split remedy failed: ${JSON.stringify(replay.error)}`);
    }

    const todo = (i: number) => ({ id: i + 1, title: `Task ${i + 1}`, status: 'not-started' as const });
    const todosAtCap = Array.from({ length: 20 }, (_, i) => todo(i));
    const todoRejected = validateToolCalls([{
      created_at: 0,
      id: 'todo-over', name: 'lc_todo_write', arguments: JSON.stringify({ todos: [...todosAtCap, todo(20)] }),
    }], HANDLERS_BY_NAME)[0];
    assert.equal(
      todoRejected.error?.[0]?.message,
      'Tool arguments failed validation: todos: todos accepts at most 20 items. Reduce the complete list to 20 or fewer items.',
    );
    const todoReplay = validateToolCalls([{
      created_at: 0,
      id: 'todo-replay', name: 'lc_todo_write', arguments: JSON.stringify({ todos: todosAtCap }),
    }], HANDLERS_BY_NAME)[0];
    assert.equal(todoReplay.error, undefined, `lc_todo_write reduction remedy failed: ${JSON.stringify(todoReplay.error)}`);
  });

  it('enforces filesystem batch caps and the stated split remedy', () => {
    const cases = [
      ['lc_read_file', 'paths', (i: number) => `/path/read-${i}.txt`],
      ['lc_write_file', 'files', (i: number) => ({ path: `/path/write-${i}.txt`, content: 'x' })],
      ['lc_list_dir', 'paths', (i: number) => `/path/dir-${i}`],
      ['lc_grep', 'searches', (i: number) => ({ path: `/path/dir-${i}`, pattern: 'x' })],
      ['lc_edit_file', 'files', (i: number) => ({ path: `/path/edit-${i}.txt`, old_string: 'a', new_string: 'b' })],
    ] as const;

    for (const [name, field, entry] of cases) {
      const handler = HANDLERS_BY_NAME.get(name)!;
      const atCap = Array.from({ length: FILESYSTEM_BATCH_MAX_ENTRIES }, (_, i) => entry(i));
      const overCap = [...atCap, entry(FILESYSTEM_BATCH_MAX_ENTRIES)];
      assert.equal(handler.input.safeParse({ [field]: atCap }).success, true, `${name} rejected its exact cap`);

      const rejected = validateToolCalls([{
        created_at: 0,
        id: 'over', name, arguments: JSON.stringify({ [field]: overCap }),
      }], HANDLERS_BY_NAME)[0];
      assert.match(rejected.error?.[0]?.message ?? '', /split .* batches of 20 or fewer/i);

      // Replay the message literally: the same 21 entries split 20 + 1.
      for (const [index, batch] of [atCap, overCap.slice(FILESYSTEM_BATCH_MAX_ENTRIES)].entries()) {
        const replay = validateToolCalls([{
          created_at: 0,
          id: `replay-${index}`, name, arguments: JSON.stringify({ [field]: batch }),
        }], HANDLERS_BY_NAME)[0];
        assert.equal(replay.error, undefined, `${name} split remedy failed: ${JSON.stringify(replay.error)}`);
      }
    }
  });

  it('pins and replays every model-facing numeric hard-cap remedy', () => {
    const cases = [
      {
        name: 'lc_read_image', base: { paths: ['/path/image.png'] }, field: 'max_bytes', cap: 50 * 1024 * 1024,
        message: 'max_bytes must be at most 52428800 (50 MiB). Use a smaller byte limit or a smaller image.',
      },
      {
        name: 'lc_read_file', base: { paths: ['/path/file.txt'] }, field: 'start_line', cap: 4_294_967_295,
        message: 'start_line must be at most 4294967295. Use a smaller 1-based line number or omit start_line to begin at line 1.',
      },
      {
        name: 'lc_read_file', base: { paths: ['/path/file.txt'] }, field: 'end_line', cap: 4_294_967_295,
        message: 'end_line must be at most 4294967295. Use a smaller 1-based line number or omit end_line to read to the end.',
      },
      {
        name: 'lc_web_fetch', base: { url: 'https://example.com' }, field: 'timeout_ms', cap: 30_000,
        message: 'timeout_ms must be at most 30000. Use 30000 milliseconds or less.',
      },
      {
        name: 'lc_run_shell', base: { cmd: 'echo' }, field: 'timeout_ms', cap: 120_000,
        message: 'timeout_ms must be at most 120000. Use 120000 milliseconds or less.',
      },
      {
        name: 'lc_grep', base: { searches: [{ path: '/path', pattern: 'x' }] }, field: 'max_results', cap: 5_000,
        message: 'max_results must be at most 5000. Use 5000 or a smaller result limit.',
      },
      {
        name: 'lc_web_search', base: { query: 'x' }, field: 'max_results', cap: 10,
        message: 'max_results must be at most 10. Use 10 or a smaller result limit.',
      },
      {
        name: 'lc_read_file', base: { paths: ['/path/file.txt'] }, field: 'max_bytes', cap: 32 * 1024 * 1024,
        message: 'max_bytes must be at most 33554432 (32 MiB). Use a smaller byte limit or omit it to keep the default 1 MiB cap.',
      },
      {
        name: 'lc_list_dir', base: { paths: ['/path/dir'] }, field: 'max_entries', cap: 5_000,
        message: 'max_entries must be at most 5000. Use 5000 or a smaller entry limit.',
      },
      {
        name: 'lc_glob_files', base: { pattern: '**/*', root: '/path' }, field: 'max_results', cap: 5_000,
        message: 'max_results must be at most 5000. Use 5000 or a smaller result limit.',
      },
      {
        name: 'lc_read_pdf', base: { paths: ['/path/doc.pdf'] }, field: 'max_bytes', cap: 100 * 1024 * 1024,
        message: 'max_bytes must be at most 104857600 (100 MiB). Use a smaller byte limit or omit it to keep the default cap.',
      },
      {
        name: 'lc_web_fetch', base: { url: 'https://example.com' }, field: 'max_bytes', cap: 32 * 1024 * 1024,
        message: 'max_bytes must be at most 33554432 (32 MiB). Use a smaller byte limit or omit it to keep the default 1 MiB cap.',
      },
      {
        name: 'lc_web_research', base: { query: 'x' }, field: 'max_results', cap: 10,
        message: 'max_results must be at most 10. Use 10 or a smaller result limit.',
      },
      {
        name: 'lc_tool_history', base: {}, field: 'max_results', cap: 50,
        message: 'max_results must be at most 50. Use 50 or a smaller result limit.',
      },
      {
        name: 'lc_tool_history', base: {}, field: 'max_result_bytes', cap: 524_288,
        message: 'max_result_bytes must be at most 524288. Use 524288 or a smaller byte limit.',
      },
    ] as const;

    for (const { name, base, field, cap, message } of cases) {
      for (const [id, args] of [
        ['exact-cap', { ...base, [field]: cap }],
        ['omit-field', base],
      ] as const) {
        const replay = validateToolCalls([{
          created_at: 0,
          id, name, arguments: JSON.stringify(args),
        }], HANDLERS_BY_NAME)[0];
        assert.equal(replay.error, undefined, `${name}.${field} remedy replay failed: ${JSON.stringify(replay.error)}`);
      }

      const rejected = validateToolCalls([{
        created_at: 0,
        id: 'cap-plus-one', name, arguments: JSON.stringify({ ...base, [field]: cap + 1 }),
      }], HANDLERS_BY_NAME)[0];
      assert.equal(
        rejected.error?.[0]?.message,
        `Tool arguments failed validation: ${field}: ${message}`,
        `${name}.${field} remedy text drifted`,
      );
    }
  });

  it('pins the lower-bound, range, and collection-entry remedies', () => {
    const cases = [
      {
        name: 'lc_read_file', base: { paths: ['/path/file.txt'] }, field: 'start_line', probe: 0,
        message: 'start_line must be a positive 1-based line number. Use 1 or larger, or omit start_line to begin at line 1.',
      },
      {
        name: 'lc_read_file', base: { paths: ['/path/file.txt'] }, field: 'end_line', probe: 0,
        message: 'end_line must be a positive 1-based line number. Use 1 or larger, or omit end_line to read to the end.',
      },
      {
        name: 'lc_read_image', base: { paths: ['/path/image.png'] }, field: 'downscale', probe: 0.05,
        message: 'downscale must be at least 0.1. Use a factor between 0.1 and 1.0, or omit downscale for no resize.',
      },
      {
        name: 'lc_read_image', base: { paths: ['/path/image.png'] }, field: 'downscale', probe: 2,
        message: 'downscale must be at most 1.0. Use a factor between 0.1 and 1.0, or omit downscale for no resize.',
      },
    ] as const;

    for (const { name, base, field, probe, message } of cases) {
      const rejected = validateToolCalls([{
        created_at: 0,
        id: 'probe', name, arguments: JSON.stringify({ ...base, [field]: probe }),
      }], HANDLERS_BY_NAME)[0];
      assert.equal(
        rejected.error?.[0]?.message,
        `Tool arguments failed validation: ${field}: ${message}`,
        `${name}.${field} lower/range-bound remedy drifted`,
      );
    }

    const domains = ['a.dev', 'b.dev', 'c.dev', 'd.dev', 'e.dev'];
    const domainBase = { query: 'x' };
    assert.equal(validateToolCalls([{
      created_at: 0,
      id: 'exact-cap', name: 'lc_web_research',
      arguments: JSON.stringify({ ...domainBase, preferred_domains: domains }),
    }], HANDLERS_BY_NAME)[0].error, undefined);
    const domainRejected = validateToolCalls([{
      created_at: 0,
      id: 'over', name: 'lc_web_research',
      arguments: JSON.stringify({ ...domainBase, preferred_domains: [...domains, 'f.dev'] }),
    }], HANDLERS_BY_NAME)[0];
    assert.equal(
      domainRejected.error?.[0]?.message,
      'Tool arguments failed validation: preferred_domains: preferred_domains accepts at most 5 entries. List 5 or fewer domains.',
    );
  });

  it('exposes and enforces the tool-history query character cap in its wire schema', () => {
    const exact = 'x'.repeat(512);
    assert.equal(toolHistory.input.safeParse({ query: exact }).success, true);
    assert.equal(toolHistory.input.safeParse({ query: '😀'.repeat(512) }).success, true);
    assert.equal(toolHistory.input.safeParse({ query: '😀'.repeat(513) }).success, false);
    const over = toolHistory.input.safeParse({ query: `${exact}x` });
    assert.equal(over.success, false);
    if (!over.success) assert.match(over.error.issues[0]?.message ?? '', /shorten the query/i);

    const querySchema = toolHistory.toJsonSchema().properties.query as { maxLength?: number };
    assert.equal(querySchema.maxLength, 512);
  });

  it('normalizes optional absence without dropping required empty content', () => {
    const schema = HANDLERS_BY_NAME.get('lc_write_file')!.toJsonSchema();
    assert.deepEqual(
      normalizeOptionalAbsence({
        files: [{ path: '/x', content: '', expected_sha256: '   ' }],
        mode: '   ',
      }, schema, 'lc_write_file'),
      { files: [{ path: '/x', content: '' }] },
    );
  });
});
