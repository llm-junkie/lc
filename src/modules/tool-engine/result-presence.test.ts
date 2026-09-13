/** Model-visible result contracts must encode absence explicitly. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch } from './builtin/apply_patch.ts';
import { edit } from './builtin/edit.ts';
import { getCurrentTime } from './builtin/get_current_time.ts';
import { globFiles } from './builtin/glob_files.ts';
import { grep } from './builtin/grep.ts';
import { GREP_COMPLETENESS_CONTRACT } from './builtin/tool-contract-metadata.ts';
import {
  clearImageBatches,
  READ_IMAGE_ANALYSIS_MAX_TOKENS,
  readImage,
} from './builtin/read_image.ts';
import { listDir } from './builtin/list_dir.ts';
import { readFile } from './builtin/read_file.ts';
import { stat } from './builtin/stat.ts';
import { runShell } from './builtin/run_shell.ts';
import { todoWrite } from './builtin/todo_write.ts';
import { toolHistory } from './builtin/tool_history.ts';
import { webResearch } from './builtin/web_research.ts';
import { webSearch } from './builtin/web_search.ts';
import { webFetch } from './builtin/web_fetch.ts';
import { writeFile } from './builtin/write_file.ts';
import {
  normalizeReadImageDescription,
  READ_IMAGE_WARNINGS,
} from './read-image-result.ts';
import type { ToolHandlerContext } from './types';

function context(sandbox: Record<string, unknown>): ToolHandlerContext {
  return {
    sandbox,
    config: {
      allowedRoots: ['D:/work'],
      maxShellTimeoutMs: 30_000,
      modelIsVision: true,
      searchProvider: { provider: 'brave', apiKey: 'test', baseUrl: '' },
    },
    identity: {
      operationId: 'operation-1',
      groupId: 'group-1',
      conversationId: 'conversation-1',
      modelToolCallId: 'call-1',
    },
    signal: new AbortController().signal,
  } as unknown as ToolHandlerContext;
}

describe('model-visible result-field presence', () => {
  it('normalizes filesystem success, error, and non-applicable fields', async () => {
    const read = await readFile.run({ paths: ['D:/work/a.txt'] }, context({
      readFile: async () => ({ results: [{
        path: 'D:/work/a.txt', content: '', total_lines: 0, size_bytes: 0,
        truncated: false,
      }] }),
    }));
    assert.ok('results' in read);
    assert.deepEqual(read.results[0], {
      path: 'D:/work/a.txt', content: '', total_lines: 0, size_bytes: 0,
      truncated: false, sha256: null, encoding: null, error: null,
    });

    const write = await writeFile.run(
      { files: [{ path: 'D:/work/a.txt', content: '' }] },
      context({ writeFile: async () => ({ results: [{
        path: 'D:/work/a.txt', bytes_written: 0, mode: 'create',
      }] }) }),
    );
    assert.deepEqual(write.results[0], {
      path: 'D:/work/a.txt', bytes_written: 0, mode: 'create',
      lines_added: 0, lines_removed: null, error: null,
    });

    const listed = await listDir.run({ paths: ['D:/work'] }, context({
      listDir: async () => ({ results: [{
        path: 'D:/work', entries: [{ name: 'subdir', kind: 'dir' }], truncated: false,
      }] }),
    }));
    assert.deepEqual(listed.results[0], {
      path: 'D:/work', entries: [{ name: 'subdir', kind: 'dir', size: null, mtime: null }],
      truncated: false, error: null,
    });

    const stated = await stat.run({ paths: ['D:/work/missing'] }, context({
      stat: async () => ({ results: [{
        path: 'D:/work/missing', exists: false, is_dir: false, is_file: false,
        canonical: null, size_bytes: null, mtime_ms: null, error: null,
      }] }),
    }));
    assert.equal(Object.keys(stated.results[0]).length, 8);
    assert.equal(stated.results[0].error, null);
  });

  it('normalizes mutation diagnostics and output-mode arrays', async () => {
    const edited = await edit.run(
      { path: 'D:/work/a.txt', old_string: 'a', new_string: 'b' },
      context({ edit: async () => ({ results: [{
        path: 'D:/work/a.txt', replaced: false, occurrences: 0, file_exists: true,
        bytes_before: 1, bytes_after: 1,
      }] }) }),
    );
    assert.deepEqual(edited.results[0], {
      path: 'D:/work/a.txt', replaced: false, occurrences: 0, file_exists: true,
      bytes_before: 1, bytes_after: 1, lines_added: 0, lines_removed: 0,
      created: false, hint: null, match_lines: [], near_match_lines: [], error: null,
    });

    const patched = await applyPatch.run(
      { patch: '*** Begin Patch\n*** End Patch' },
      { ...context({ applyPatch: async () => ({
        files: [{ path: 'D:/work/a.txt', action: 'update', hunks_applied: 0, warnings: [] }],
        summary: '', fully_applied: false,
      }) }), nativePlanId: 'plan-1' },
    );
    assert.deepEqual(patched.files[0], {
      path: 'D:/work/a.txt', action: 'update', hunks_applied: 0, warnings: [],
      move_to: null, lines_added: 0, lines_removed: 0, error: null,
    });

    const searched = await grep.run(
      { searches: [{ path: 'D:/work', pattern: 'needle' }] },
      context({ grep: async () => ({ results: [{
        path: 'D:/work', pattern: 'needle',
        matches: [{ file: 'D:/work/a.txt', line: 1, content: 'needle' }],
        truncated: false, visited_entries: 1, files_selected: 1, bytes_read: 6,
        skipped_large: 0, skipped_binary: 0, skipped_symlink: 0,
        skipped_unreadable: 0, files_transcoded: 0,
      }] }) }),
    );
    assert.ok('results' in searched);
    assert.deepEqual(searched.results[0].matches[0], {
      file: 'D:/work/a.txt', line: 1, content: 'needle', content_truncated: false,
      encoding: null, before: [], after: [],
    });
    assert.equal(searched.results[0].truncated_reason, null);
    assert.equal(searched.results[0].error, null);
    assert.deepEqual(searched.results[0].files, []);
    assert.deepEqual(searched.results[0].counts, []);
  });

  it('keeps a failed grep entry in a mixed result and scopes completeness to error-free entries', async () => {
    const searched = await grep.run(
      {
        searches: [
          { path: 'D:/work', pattern: '[' },
          { path: 'D:/work', pattern: 'needle' },
        ],
      },
      context({ grep: async () => ({ results: [
        {
          path: 'D:/work', pattern: '[', matches: [], truncated: false,
          error: 'invalid regex', error_code: 'invalid_regex',
          visited_entries: 0, files_selected: 0, bytes_read: 0,
          skipped_large: 0, skipped_binary: 0, skipped_symlink: 0,
          skipped_unreadable: 0, files_transcoded: 0,
        },
        {
          path: 'D:/work', pattern: 'needle',
          matches: [{ file: 'D:/work/a.txt', line: 1, content: 'needle' }],
          truncated: false, visited_entries: 1, files_selected: 1, bytes_read: 6,
          skipped_large: 0, skipped_binary: 0, skipped_symlink: 0,
          skipped_unreadable: 0, files_transcoded: 0,
        },
      ] }) }),
    );

    assert.ok('status' in searched);
    assert.equal(searched.status, 'partial');
    assert.ok(searched.data);
    assert.equal(searched.data.results.length, 2);
    assert.equal(searched.data.results[0].error, 'invalid regex');
    assert.equal(searched.data.results[0].truncated, false);
    assert.equal(searched.data.results[1].error, null);
    assert.equal(searched.data.results[1].truncated, false);
    assert.match(GREP_COMPLETENESS_CONTRACT, /error-free lc_grep results/i);
  });

  it('normalizes image, glob, utility, and search absence', async () => {
    clearImageBatches();
    const image = await readImage.run({ paths: ['D:/work/a.png'] }, context({
      readImage: async () => ({ images: [{
        path: 'D:/work/a.png', mime: 'image/png', size_bytes: 4,
        original_size_bytes: 4, encoding: 'original', truncated: false,
        data_url: 'data:image/png;base64,AAAA',
      }] }),
    }));
    assert.equal(image.images[0].error, null);
    assert.equal(image.description, null);
    assert.equal(image.warning, null);
    assert.equal(image.truncated, false);

    const globbed = await globFiles.run({ pattern: '**/*', root: 'D:/work' }, context({
      globFiles: async () => ({
        matches: [{ path: 'D:/work/subdir', is_dir: true }],
        truncated: false, pattern_used: '**/*',
      }),
    }));
    assert.equal(globbed.matches[0].size_bytes, null);
    assert.equal(globbed.visited_entries, 0);

    const todos = await todoWrite.run({
      todos: [{
        id: 1,
        title: 'Check result shape',
        status: 'completed',
        completion_evidence: 'The result fields have the expected shape.',
      }],
    }, context({}));
    assert.deepEqual(todos.warnings, []);

    const time = await getCurrentTime.run({}, context({}));
    assert.equal(time.tz_warning, null);

    const web = await webSearch.run({ query: 'contract' }, context({
      webSearch: async () => ({
        results: [{ title: 't', url: 'https://example.com', snippet: 's' }], source: 'brave',
      }),
    }));
    assert.deepEqual(web.results[0].extra_snippets, []);
    assert.deepEqual(web.ignored_params, []);

    const research = await webResearch.run({ query: 'contract' }, context({
      webSearch: async () => ({ results: [], source: 'brave' }),
    }));
    assert.deepEqual(research.sources, []);
    assert.equal(research.research_info.provider, 'brave');
    assert.deepEqual(research.research_info.ignored_params, []);
    assert.ok(research.confidence_note);

    const historyContext = context({});
    const history = await toolHistory.run({}, {
      ...historyContext,
      config: { ...historyContext.config, convId: undefined },
    });
    assert.ok(!('query' in history));
    if (!('query' in history)) {
      assert.deepEqual(history, {
        message_id: null,
        total_archived: 0,
        returned: 0,
        truncated: false,
        truncated_bytes: 0,
        available_message_ids: [],
        coverage_pct: 100,
        results: [],
        summary: [],
      });
    }
    clearImageBatches();
  });

  it('keeps image capability and native warnings out of description', async () => {
    let readCalled = false;
    const noVisionContext = context({
      readImage: async () => {
        readCalled = true;
        return { images: [] };
      },
    });
    noVisionContext.config.modelIsVision = false;

    const result = await readImage.run({ paths: ['D:/work/a.png'] }, noVisionContext);
    assert.equal(readCalled, false);
    assert.equal(result.description, null);
    assert.equal(result.warning, READ_IMAGE_WARNINGS.visionUnsupported);
    assert.equal(result.processed_count, 0);

    const nativeWarning = 'Only 10 of 11 requested images were processed.';
    assert.equal(
      normalizeReadImageDescription(`${nativeWarning}\n\nActual image description.`, nativeWarning),
      'Actual image description.',
    );
    assert.equal(normalizeReadImageDescription(nativeWarning, nativeWarning), null);
  });

  it('separates images admitted to analysis requests from descriptions returned', async () => {
    let maxTokens: number | undefined;
    const analysisContext = context({
      analyzeImages: async (args: { max_tokens?: number }) => {
        maxTokens = args.max_tokens;
        return {
          images: [
            {
              path: 'D:/work/a.png', mime: 'image/png', size_bytes: 4,
              original_size_bytes: 4, original_wh: [2, 2], wh_downscale: 1,
              encoding: 'medium_jpeg', truncated: false,
            },
            {
              path: 'D:/work/b.png', mime: 'image/png', size_bytes: 4,
              original_size_bytes: 4, original_wh: [2, 2], wh_downscale: 1,
              encoding: 'medium_jpeg', truncated: false, error: 'no response text',
            },
          ],
          analyzed: true,
          description: 'Image 1: visible description',
          truncated: false,
          total_requested: 2,
          processed_count: 2,
          analyzed_count: 2,
          described_count: 1,
          dropped_count: 0,
        };
      },
    });
    analysisContext.config.llmServerUrl = 'http://127.0.0.1:1234';
    analysisContext.config.llmModel = 'vision-model';
    analysisContext.config.llmApiVariant = 'openai';
    const result = await readImage.run(
      { paths: ['D:/work/a.png', 'D:/work/b.png'], analyze: true },
      analysisContext,
    );

    assert.equal(maxTokens, READ_IMAGE_ANALYSIS_MAX_TOKENS);
    assert.equal(result.analyzed, true);
    assert.equal(result.analyzed_count, 2);
    assert.equal(result.described_count, 1);
    assert.equal(result.images[1].error, 'no response text');
  });

  it('does not infer vision success when the bridge omits described_count', async () => {
    const analysisContext = context({
      analyzeImages: async () => ({
        images: [],
        analyzed: true,
        description: 'unverified bridge text',
        truncated: false,
        total_requested: 1,
        processed_count: 1,
        analyzed_count: 1,
        described_count: undefined as unknown as number,
        dropped_count: 0,
      }),
    });
    analysisContext.config.llmServerUrl = 'http://127.0.0.1:1234';
    analysisContext.config.llmModel = 'vision-model';
    analysisContext.config.llmApiVariant = 'openai';

    const result = await readImage.run(
      { paths: ['D:/work/a.png'], analyze: true },
      analysisContext,
    );
    assert.equal(result.analyzed, false);
    assert.equal(result.description, null);
    assert.equal(result.analyzed_count, 1);
    assert.equal(result.described_count, 0);
  });

  it('does not encode cancellation as fetched or process content', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortedContext = {
      ...context({ abortToolCalls: async () => undefined }),
      signal: controller.signal,
    };

    await assert.rejects(
      () => runShell.run({ cmd: 'echo' }, abortedContext),
      (error: unknown) => (error as { code?: string }).code === 'Aborted',
    );
    await assert.rejects(
      () => webFetch.run({ url: 'https://example.com' }, abortedContext),
      (error: unknown) => (error as { code?: string }).code === 'Aborted',
    );
  });
});
