/**
 * Tool-engine unit tests — pure functions (no Tauri bridge needed).
 * Run with: node --test --experimental-strip-types src/modules/tool-engine/tool-engine.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../../whiteboard/contract-fixtures.spec.ts';
import '../../whiteboard/implementation-contract.spec.ts';
import { checkDirPermission, directoryIsTargetTool, targetDirsFromArgs } from './check-dir-permission.ts';
import { tryParseLenient } from './try-parse-lenient.ts';
import type { LenientParseResult } from './try-parse-lenient';
import { runWithPool, normalizeConcurrency } from './run-with-pool.ts';
import { FILE_IO_NAMES } from './registry-names.ts';
import { applyPatch } from './builtin/apply_patch.ts';
import { edit } from './builtin/edit.ts';
import { writeFile } from './builtin/write_file.ts';
import { createMockBridge } from './sandbox-bridge.ts';
import type { ApplyPatchArgs } from './sandbox-bridge';
import type { ToolHandlerContext } from './types';
import { approvedScopesCoverRequired, grantTool, grantToolOnRoots, initializeWebAccessGrantDefaults, normalizeGrantState, readToolGrants } from './grant-state.ts';
import { setWebAccessEnabled, setSkillsEnabled, setWorkspaceEnabled } from './workspace-state.ts';
import { normalizeThrownToolError } from './tool-error.ts';
import {
  TOOL_ISSUE_MESSAGE_MAX_BYTES,
  TOOL_ISSUE_TRUNCATION_MARKER,
} from './model-text-budget.ts';
import { truncateUtf8, utf8ByteLength } from './utf8-budget.ts';
import {
  CURRENT_TIME_TZ_LIMIT_MESSAGE,
  CURRENT_TIME_TZ_MAX_CHARACTERS,
  formatRfc2822,
  getCurrentTime,
  invalidTimezoneWarning,
  normalizeIsoOffset,
  resolveTz,
} from './builtin/get_current_time.ts';
import {
  FIXED_GREP_EXCLUDED_EXTENSIONS,
  FIXED_SEARCH_EXCLUDED_DIRS,
  grep,
} from './builtin/grep.ts';
import { globFiles } from './builtin/glob_files.ts';
import { GREP_COMPLETENESS_CONTRACT } from './builtin/tool-contract-metadata.ts';
import { listDir } from './builtin/list_dir.ts';
import { readFile } from './builtin/read_file.ts';
import { readImage } from './builtin/read_image.ts';
import { stat as statTool } from './builtin/stat.ts';
import { GREP_GUIDANCE } from './tool-guidance.ts';
import {
  DEFAULT_SERIALIZED_TOOL_RESULT_MAX_BYTES,
  executeToolCall,
  serializeToolResultWithinLimit,
  serializedToolResultLimitBytes,
} from './runner.ts';

function descriptionOf(handler: { description: string | (() => string) }): string {
  return typeof handler.description === 'function' ? handler.description() : handler.description;
}

describe('model-facing tool resource limits', () => {
  it('accepts exact file/directory caps and rejects cap plus one', () => {
    const path = 'C:\\work\\target';
    const readCap = 32 * 1024 * 1024;
    assert.equal(readFile.input.safeParse({ paths: [path], max_bytes: readCap }).success, true);
    assert.equal(readFile.input.safeParse({ paths: [path], max_bytes: readCap + 1 }).success, false);

    assert.equal(listDir.input.safeParse({ paths: [path], max_entries: 5000 }).success, true);
    assert.equal(listDir.input.safeParse({ paths: [path], max_entries: 5001 }).success, false);

    const statPaths = Array.from({ length: 100 }, (_, index) => `${path}-${index}`);
    assert.equal(statTool.input.safeParse({ paths: statPaths }).success, true);
    assert.equal(statTool.input.safeParse({ paths: [...statPaths, `${path}-100`] }).success, false);
  });

  it('describes hard caps and signalled image-analysis truncation', () => {
    assert.match(descriptionOf(readFile), /default output cap is 1 MiB/i);
    assert.match(descriptionOf(readFile), /32 MiB/i);
    assert.match(descriptionOf(readFile), /fails without a partial body/i);
    assert.match(descriptionOf(listDir), /hard limit of 5000/i);
    assert.match(descriptionOf(readImage), /first 10 paths/i);
    assert.match(descriptionOf(readImage), /actionable warning/i);
    assert.doesNotMatch(descriptionOf(readImage), /silently/i);
  });

  it('describes partial application for multi-file mutating tools', () => {
    for (const handler of [writeFile, edit]) {
      assert.match(descriptionOf(handler), /entries commit independently/i);
      assert.match(descriptionOf(handler), /does not roll back earlier changes/i);
    }
  });
});

describe('complete serialized tool-result budget', () => {
  it('measures exact UTF-8 bytes at and above a supplied boundary', () => {
    const value = { text: 'é' };
    const measured = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    assert.equal(serializeToolResultWithinLimit(value, measured).output, JSON.stringify(value));
    assert.equal(serializeToolResultWithinLimit(value, measured - 1).output, undefined);
  });

  it('uses the documented default and large-payload exceptions', () => {
    assert.equal(serializedToolResultLimitBytes('lc_stat'), 4 * 1024 * 1024);
    assert.equal(serializedToolResultLimitBytes('lc_read_file'), 64 * 1024 * 1024);
    assert.equal(serializedToolResultLimitBytes('lc_web_fetch'), 64 * 1024 * 1024);
    assert.equal(serializedToolResultLimitBytes('lc_run_shell'), 16 * 1024 * 1024);
  });

  it('replaces oversized plain and envelope results with bounded actionable errors', async () => {
    const context = {
      config: { allowedRoots: [], shellAllowlist: [] },
      identity: { operationId: 'operation', groupId: 'group' },
      signal: new AbortController().signal,
      sandbox: { abortGroup: () => {} },
    } as unknown as ToolHandlerContext;
    const payload = { payload: 'x'.repeat(DEFAULT_SERIALIZED_TOOL_RESULT_MAX_BYTES) };
    const outputs = [
      payload,
      { status: 'ok', data: payload, issues: [], warnings: [], metrics: { durationMs: 0 } },
    ];

    for (const output of outputs) {
      const handler = {
        name: 'lc_stat',
        description: 'stat',
        input: { parse: (value: unknown) => value },
        run: async () => output,
      } as unknown as import('./types.ts').ToolHandler;
      const result = await executeToolCall(
        { id: 'call', name: 'lc_stat', arguments: '{}', created_at: 0 },
        {},
        handler,
        context,
      );
      const envelope = JSON.parse(result.output);
      const measuredBytes = new TextEncoder().encode(JSON.stringify(output)).byteLength;

      assert.equal(result.is_error, true);
      assert.equal(envelope.status, 'error');
      assert.equal('data' in envelope, false);
      assert.equal(envelope.issues[0].code, 'result_too_large');
      assert.equal(
        envelope.issues[0].message,
        `The lc_stat result is ${measuredBytes} UTF-8 bytes. The limit is 4194304 bytes.`,
      );
      assert.equal(
        envelope.issues[0].remedy,
        'Narrow the request or split the work into several calls.',
      );
      assert.ok(new TextEncoder().encode(result.output).byteLength < 1024);
    }
  });
});

describe('mutating file tool argument integrity', () => {
  it('preserves a top-level write mode and rejects a misplaced per-file mode', () => {
    const valid = writeFile.input.safeParse({
      files: [{ path: 'C:\\work\\file.txt', content: 'replacement' }],
      mode: 'overwrite',
    });
    assert.equal(valid.success, true);
    if (valid.success) assert.equal(valid.data.mode, 'overwrite');

    const misplaced = writeFile.input.safeParse({
      files: [{
        path: 'C:\\work\\file.txt',
        content: 'replacement',
        mode: 'overwrite',
      }],
    });
    assert.equal(misplaced.success, false);
  });

  it('preserves top-level edit creation intent and rejects a misplaced flag', () => {
    const valid = edit.input.safeParse({
      files: [{ path: 'C:\\work\\file.txt', old_string: '', new_string: 'new' }],
      create_if_missing: true,
    });
    assert.equal(valid.success, true);
    if (valid.success) assert.equal(valid.data.create_if_missing, true);

    const misplaced = edit.input.safeParse({
      files: [{
        path: 'C:\\work\\file.txt',
        old_string: '',
        new_string: 'new',
        create_if_missing: true,
      }],
    });
    assert.equal(misplaced.success, false);
  });

  it('rejects unknown apply_patch control fields instead of stripping them', () => {
    const patch = '*** Begin Patch\n*** Add File: C:\\work\\new.txt\n+new\n*** End Patch';
    assert.equal(applyPatch.input.safeParse({ patch }).success, true);
    assert.equal(applyPatch.input.safeParse({ patch, mode: 'overwrite' }).success, false);
  });
});

describe('Phase 0 search tool contracts', () => {
  it('locks the native fixed traversal exclusion catalog', () => {
    assert.deepEqual([...FIXED_SEARCH_EXCLUDED_DIRS], [
      '.git', 'node_modules', 'target', '__pycache__', '.venv', 'venv', '.env',
      'dist', 'build', '.next', '.nuxt', '.cache', 'coverage', '.idea', '.vscode',
    ]);
    assert.deepEqual([...FIXED_GREP_EXCLUDED_EXTENSIONS], [
      'exe', 'dll', 'so', 'dylib', 'bin', 'png', 'jpg', 'jpeg', 'gif', 'ico',
      'webp', 'bmp', 'woff', 'woff2', 'ttf', 'eot', 'pdf', 'zip', 'tar', 'gz',
      '7z', 'rar',
    ]);
  });

  it('describes grep as regex-only and discloses its false-negative boundaries', () => {
    assert.match(descriptionOf(grep), /with regular expressions/i);
    assert.doesNotMatch(descriptionOf(grep), /literal strings or regex/i);
    assert.match(descriptionOf(grep), /lc_glob_files/);
    assert.match(descriptionOf(grep), /Example: lc_grep/);

    const advanced = GREP_GUIDANCE.sections.map((section) => section.guidance).join('\n');
    assert.match(advanced, /metacharacter.*literal/i);
    assert.match(advanced, /zero result does not prove/i);
    for (const name of FIXED_SEARCH_EXCLUDED_DIRS) assert.ok(advanced.includes(`\`${name}\``));
    for (const ext of FIXED_GREP_EXCLUDED_EXTENSIONS) assert.ok(advanced.includes(`\`${ext}\``));
  });

  it('discloses glob directory results and fixed traversal exclusions', () => {
    assert.match(descriptionOf(globFiles), /files and directories/i);
    assert.match(descriptionOf(globFiles), /is_dir/);
    assert.match(descriptionOf(globFiles), /zero matches does not prove/i);
    assert.match(descriptionOf(globFiles), /cancellation returns a normal result/i);
    assert.match(descriptionOf(globFiles), /preserves matches collected/i);
    for (const name of FIXED_SEARCH_EXCLUDED_DIRS) assert.ok(descriptionOf(globFiles).includes(`\`${name}\``));
  });

  it('uses the same tri-state grep contract in grep and its glob sibling', () => {
    assert.match(GREP_COMPLETENESS_CONTRACT, /error-free lc_grep results/i);
    assert.ok(descriptionOf(grep).includes(GREP_COMPLETENESS_CONTRACT));
    assert.ok(descriptionOf(globFiles).includes(GREP_COMPLETENESS_CONTRACT));
  });
});

describe('lc_get_current_time ISO offsets', () => {
  it('accepts the exact tz character cap and rejects cap plus one', () => {
    assert.equal(
      getCurrentTime.input.safeParse({ tz: 'x'.repeat(CURRENT_TIME_TZ_MAX_CHARACTERS) }).success,
      true,
    );
    const overCap = getCurrentTime.input.safeParse({
      tz: 'x'.repeat(CURRENT_TIME_TZ_MAX_CHARACTERS + 1),
    });
    assert.equal(overCap.success, false);
    if (!overCap.success) assert.equal(overCap.error.issues[0]?.message, CURRENT_TIME_TZ_LIMIT_MESSAGE);
  });

  it('normalizes UTC and short Intl offsets to valid ISO 8601 suffixes', () => {
    assert.equal(normalizeIsoOffset('GMT'), 'Z');
    assert.equal(normalizeIsoOffset('GMT+2'), '+02:00');
    assert.equal(normalizeIsoOffset('GMT-5'), '-05:00');
    assert.equal(normalizeIsoOffset('GMT+05:30'), '+05:30');
  });

  it('accepts runtime-supported timezone names omitted from supportedValuesOf', () => {
    assert.deepEqual(resolveTz('UTC'), { tz: 'UTC' });
    assert.deepEqual(resolveTz('Asia/Kolkata'), { tz: 'Asia/Kolkata' });
    assert.deepEqual(resolveTz('Asia/Kathmandu'), { tz: 'Asia/Kathmandu' });

    const invalid = resolveTz('Not/ARealTimezone');
    assert.notEqual(invalid.tz, 'Not/ARealTimezone');
    assert.equal(invalid.tz_warning, invalidTimezoneWarning(invalid.tz));
    assert.doesNotMatch(invalid.tz_warning ?? '', /Not\/ARealTimezone/);
  });

  it('formats RFC 2822 in the requested timezone', () => {
    const date = new Date('2026-07-23T22:05:45.000Z');
    assert.equal(formatRfc2822(date, 'Asia/Tokyo'), 'Fri, 24 Jul 2026 07:05:45 +0900');
    assert.equal(formatRfc2822(date, 'America/New_York'), 'Thu, 23 Jul 2026 18:05:45 -0400');
    assert.equal(formatRfc2822(date, 'UTC'), 'Thu, 23 Jul 2026 22:05:45 +0000');
  });
});

describe('authoritative grant state', () => {
  const webAccessNames = ['lc_web_fetch', 'lc_web_search'];

  it('reads only known Web Access grants', () => {
    const grants = readToolGrants({
      tool_grants: ['lc_web_fetch', 'lc_run_shell', 'unknown_tool'],
    }, webAccessNames);
    assert.deepEqual([...grants], ['lc_web_fetch']);
  });

  it('merges nearby Web Access approvals when each update uses the latest state', () => {
    const first = grantTool({ tool_grants: [] }, 'lc_web_fetch');
    const second = grantTool(first, 'lc_web_search');
    assert.deepEqual(second.tool_grants, ['lc_web_fetch', 'lc_web_search']);
  });

  it('pre-grants all Web Access tools on first enable only', () => {
    const names = [
      'lc_web_fetch',
      'lc_web_search',
      'lc_web_research',
    ];
    const initialized = initializeWebAccessGrantDefaults({
      tool_grants: [],
      web_access_grants_initialized: false,
    }, names);
    assert.equal(names.length, 3);
    assert.deepEqual(initialized.tool_grants, names);
    assert.equal(initialized.web_access_grants_initialized, true);

    const explicitlyUnchecked = { tool_grants: [], web_access_grants_initialized: true };
    assert.equal(
      initializeWebAccessGrantDefaults(explicitlyUnchecked, names),
      explicitlyUnchecked,
    );
  });

  it('grants one file tool on exactly the selected existing root', () => {
    const initial = {
      allowed_roots: ['/a', '/b'],
      dir_permissions: {
        '/a': ['lc_read_file'],
        '/b': ['lc_read_file'],
      },
    };
    const updated = grantToolOnRoots(initial, 'lc_write_file', ['/a']);
    assert.deepEqual(updated.dir_permissions?.['/a'], ['lc_read_file', 'lc_write_file']);
    assert.deepEqual(updated.dir_permissions?.['/b'], ['lc_read_file']);
  });

  it('treats an empty file approval scope list as a no-op', () => {
    const initial = {
      allowed_roots: ['/a'],
      dir_permissions: { '/a': ['lc_read_file'] },
    };
    assert.deepEqual(grantToolOnRoots(initial, 'lc_write_file', []), normalizeGrantState(initial));
  });

  it('requires every missing file scope before a batch can run', () => {
    assert.equal(approvedScopesCoverRequired(['/a', '/b'], ['/a']), false);
    assert.equal(approvedScopesCoverRequired(['/a', '/b'], ['/b', '/a']), true);
    assert.equal(approvedScopesCoverRequired(['/a'], []), false);
  });
});

describe('workspace activation transitions', () => {
  const webAccessNames = ['lc_web_fetch', 'lc_web_search'];

  it('activates local Workspace defaults without enabling Web Access', () => {
    const activated = setWorkspaceEnabled({
      enabled: false,
      web_access_enabled: false,
      tool_history_enabled: false,
      file_io_enabled: false,
      shell_enabled: false,
      skills_enabled: false,
      whiteboard_enabled: false,
      tool_grants: [],
      web_access_grants_initialized: false,
    }, true);

    assert.equal(activated.enabled, true);
    assert.equal(activated.web_access_enabled, false);
    assert.equal(activated.tool_history_enabled, true);
    assert.equal(activated.file_io_enabled, true);
    assert.equal(activated.shell_enabled, false);
    assert.equal(activated.skills_enabled, false);
    assert.equal(activated.whiteboard_enabled, true);
    assert.equal(activated.web_access_grants_initialized, false);
    assert.deepEqual(activated.tool_grants, []);
  });

  it('restores activation defaults while preserving other categories and grants', () => {
    const configured = {
      enabled: true,
      web_access_enabled: true,
      tool_history_enabled: false,
      file_io_enabled: true,
      shell_enabled: true,
      skills_enabled: true,
      whiteboard_enabled: true,
      tool_grants: ['lc_web_fetch'],
      web_access_grants_initialized: true,
    };

    const deactivated = setWorkspaceEnabled(configured, false);
    assert.equal(deactivated.enabled, false);
    assert.equal(deactivated.web_access_enabled, true);
    assert.deepEqual(deactivated.tool_grants, ['lc_web_fetch']);

    const reactivated = setWorkspaceEnabled(deactivated, true);
    assert.equal(reactivated.enabled, true);
    assert.equal(reactivated.web_access_enabled, true);
    assert.equal(reactivated.tool_history_enabled, true);
    assert.equal(reactivated.file_io_enabled, true);
    assert.equal(reactivated.shell_enabled, true);
    assert.equal(reactivated.skills_enabled, true);
    assert.equal(reactivated.whiteboard_enabled, true);
    assert.deepEqual(reactivated.tool_grants, ['lc_web_fetch']);
  });

  it('initializes Web Access defaults only on its first direct activation', () => {
    const first = setWebAccessEnabled({
      enabled: true,
      web_access_enabled: false,
      tool_grants: [],
      web_access_grants_initialized: false,
    }, true, webAccessNames);
    assert.deepEqual(first.tool_grants, webAccessNames);

    const explicitlyUnchecked = {
      ...first,
      tool_grants: [],
    };
    const off = setWebAccessEnabled(explicitlyUnchecked, false, webAccessNames);
    const onAgain = setWebAccessEnabled(off, true, webAccessNames);
    assert.deepEqual(onAgain.tool_grants, []);
  });

  it('selects the default built-in skills only on the first direct Skills activation', () => {
    const first = setSkillsEnabled({
      enabled: true,
      skills_enabled: false,
      skills_initialized: false,
      enabled_skill_ids: ['custom-skill'],
      tool_grants: [],
      web_access_grants_initialized: true,
    }, true, ['lc:builtin:lc-tools', 'lc:builtin:ste100']);
    assert.equal(first.skills_initialized, true);
    assert.deepEqual(first.enabled_skill_ids, ['custom-skill', 'lc:builtin:lc-tools', 'lc:builtin:ste100']);

    const userUnchecked = {
      ...first,
      enabled_skill_ids: ['custom-skill'],
    };
    const off = setSkillsEnabled(userUnchecked, false, ['lc:builtin:lc-tools', 'lc:builtin:ste100']);
    const onAgain = setSkillsEnabled(off, true, ['lc:builtin:lc-tools', 'lc:builtin:ste100']);
    assert.deepEqual(onAgain.enabled_skill_ids, ['custom-skill']);

    const legacy = setSkillsEnabled({
      ...off,
      skills_initialized: undefined,
      enabled_skill_ids: [],
    }, true, ['lc:builtin:lc-tools', 'lc:builtin:ste100']);
    assert.deepEqual(legacy.enabled_skill_ids, []);
  });
});

describe('native tool error preservation', () => {
  it('preserves the native path-outside-roots code and path', () => {
    const normalized = normalizeThrownToolError({
      code: 'PathOutsideRoots',
      message: {
        path: 'C:\\outside\\file.txt',
        allowed_roots: ['C:\\workspace'],
      },
    });
    assert.equal(normalized.status, 'error');
    assert.equal(normalized.issue.code, 'path_outside_roots');
    assert.equal(normalized.issue.path, 'C:\\outside\\file.txt');
    assert.match(normalized.issue.message, /C:\\workspace/);
  });

  it('preserves aborted and timeout terminal states', () => {
    assert.equal(normalizeThrownToolError({ code: 'Aborted', message: 'aborted' }).status, 'aborted');
    assert.equal(normalizeThrownToolError(new DOMException('Aborted', 'AbortError')).status, 'aborted');
    assert.equal(normalizeThrownToolError({ code: 'Timeout', message: 'timeout' }).status, 'timeout');
  });

  it('preserves native shell launch detail without encouraging an identical retry', () => {
    const normalized = normalizeThrownToolError({
      code: 'ExecutableNotFound',
      message: {
        executable: 'missing-tool',
        native_code: 2,
        native_reason: 'The system cannot find the file specified.',
      },
    });
    assert.equal(normalized.issue.code, 'executable_not_found');
    assert.equal(normalized.issue.executable, 'missing-tool');
    assert.equal(normalized.issue.native_code, 2);
    assert.equal(normalized.issue.native_reason, 'The system cannot find the file specified.');
    assert.equal(normalized.issue.retryable, false);
  });

  it('preserves cwd-specific codes and builtin suggested calls', () => {
    const cwd = normalizeThrownToolError({
      code: 'CwdNotFound',
      message: { path: 'D:\\missing', native_code: 3, native_reason: 'Path not found' },
    });
    assert.equal(cwd.issue.code, 'cwd_not_found');
    assert.equal(cwd.issue.path, 'D:\\missing');
    assert.equal(cwd.issue.retryable, false);

    const builtin = normalizeThrownToolError({
      code: 'WindowsBuiltinRequiresCmd',
      message: {
        builtin: 'rmdir',
        suggested_call: { cmd: 'cmd', args: ['/d', '/u', '/c', 'rmdir /s /q doomed'] },
        required_allowlist_entry: 'cmd',
      },
    });
    assert.equal(builtin.issue.code, 'windows_builtin_requires_cmd');
    assert.deepEqual(builtin.issue.suggested_call, {
      cmd: 'cmd',
      args: ['/d', '/u', '/c', 'rmdir /s /q doomed'],
    });
    assert.equal(builtin.issue.required_allowlist_entry, 'cmd');
    assert.equal(builtin.issue.retryable, false);
  });

  // apply_patch no-clobber guards used to surface as `path_outside_roots`,
  // which told the model to fix a sandbox problem that did not exist.
  it('reports apply_patch collisions as already_exists, not path_outside_roots', () => {
    for (const message of [
      'add target already exists: D:\\work\\new.txt',
      'move destination already exists: D:\\work\\new.txt',
    ]) {
      const normalized = normalizeThrownToolError({ code: 'AlreadyExists', message });
      assert.equal(normalized.issue.code, 'already_exists');
      assert.equal(normalized.issue.message, message);
      assert.equal(normalized.issue.retryable, true);
    }
  });

  it('snake-cases variants with consecutive capitals', () => {
    assert.equal(normalizeThrownToolError({ code: 'NotAFile', message: 'x' }).issue.code, 'not_a_file');
    assert.equal(normalizeThrownToolError({ code: 'NotADir', message: 'x' }).issue.code, 'not_a_dir');
    assert.equal(normalizeThrownToolError({ code: 'Io', message: 'x' }).issue.code, 'io');
    assert.equal(normalizeThrownToolError({ code: 'TooLarge', message: 'x' }).issue.code, 'too_large');
  });

  it('bounds generic and structured issue messages as UTF-8', () => {
    const oversized = '界'.repeat(TOOL_ISSUE_MESSAGE_MAX_BYTES);
    for (const error of [new Error(oversized), { code: 'Io', message: oversized }]) {
      const message = normalizeThrownToolError(error).issue.message;
      assert.ok(utf8ByteLength(message) <= TOOL_ISSUE_MESSAGE_MAX_BYTES);
      assert.ok(message.includes(TOOL_ISSUE_TRUNCATION_MARKER.trim()));
    }
  });
});

describe('UTF-8 result budgets', () => {
  it('never exceeds the requested byte limit or splits a character', () => {
    for (const limit of [0, 1, 2, 3, 4, 7, 16, 31]) {
      const capped = truncateUtf8('start 😀 日本語 end', limit);
      assert.ok(utf8ByteLength(capped.text) <= limit);
      assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(capped.text)));
    }
  });

  it('keeps exact-boundary text unchanged', () => {
    const text = 'a😀b';
    const bytes = utf8ByteLength(text);
    assert.deepEqual(truncateUtf8(text, bytes), {
      text,
      truncated: false,
      originalBytes: bytes,
      returnedBytes: bytes,
    });
  });
});

/* ── checkDirPermission ───────────────────────────────────── */

describe('checkDirPermission', () => {
  it('extracts filesystem-root parents without dropping the separator', () => {
    assert.deepEqual(targetDirsFromArgs('lc_read_file', { paths: ['/file.txt'] }), ['/']);
    assert.deepEqual(targetDirsFromArgs('lc_read_file', { paths: ['C:\\file.txt'] }), ['C:\\']);
  });

  it('pins which tools resolve their target itself (whole-call pre-flight on a missing path)', () => {
    // The orchestrator pre-flight rejects the WHOLE call with
    // path_resolution_failed when scopeDirForResolved yields null, which for
    // a missing path happens exactly for these three tools. Extending this
    // set silently extends that whole-call rejection to another tool.
    const directoryTargets = FILE_IO_NAMES.filter(directoryIsTargetTool);
    assert.deepEqual(
      directoryTargets,
      ['lc_list_dir', 'lc_grep', 'lc_glob_files'],
    );
  });

  it('returns ok for tools without path args', () => {
    const r = checkDirPermission('lc_web_fetch', { url: 'https://example.com' }, [], {});
    assert.equal(r.ok, true);
    assert.equal(r.root, '');
  });

  it('returns ok when tool is already granted', () => {
    const r = checkDirPermission(
      'lc_read_file',
      { paths: ['/home/user/file.txt'] },
      ['/home/user'],
      { '/home/user': ['lc_read_file'] },
    );
    assert.equal(r.ok, true);
    assert.equal(r.root, '/home/user');
  });

  it('keeps ancestor grants effective across a more-specific root for another tool', () => {
    const parent = '/projects';
    const child = '/projects/private';
    const permissions = {
      [parent]: ['lc_read_file'],
      [child]: ['lc_write_file'],
    };

    const inheritedRead = checkDirPermission(
      'lc_read_file',
      { paths: [`${child}/readme.md`] },
      [parent, child],
      permissions,
    );
    const childWrite = checkDirPermission(
      'lc_write_file',
      { files: [{ path: `${child}/output.txt`, content: 'ok' }] },
      [parent, child],
      permissions,
    );
    const siblingWrite = checkDirPermission(
      'lc_write_file',
      { files: [{ path: `${parent}/public/output.txt`, content: 'blocked' }] },
      [parent, child],
      permissions,
    );

    assert.deepEqual(inheritedRead, { ok: true, root: parent });
    assert.deepEqual(childWrite, { ok: true, root: child });
    assert.equal(siblingWrite.ok, false);
    assert.deepEqual(siblingWrite.ungranted, [`${parent}/public`]);
  });

  it('lets a root write grant cover a child root without a write checkmark', () => {
    const r = checkDirPermission(
      'lc_write_file',
      { files: [{ path: '/projects/private/output.txt', content: 'ok' }] },
      ['/projects', '/projects/private'],
      {
        '/projects': ['lc_write_file'],
        '/projects/private': ['lc_read_file'],
      },
    );

    assert.deepEqual(r, { ok: true, root: '/projects' });
  });

  it('returns ungranted when tool not in dirPermissions', () => {
    const r = checkDirPermission(
      'lc_read_file',
      { paths: ['/home/user/file.txt'] },
      ['/home/user'],
      {},
    );
    assert.equal(r.ok, false);
    assert.equal(r.root, '/home/user');
    assert.deepEqual(r.ungranted, ['/home/user']);
  });

  it('handles list_dir targeting the directory directly', () => {
    const r = checkDirPermission(
      'lc_list_dir',
      { paths: ['/projects/src'] },
      ['/projects'],
      { '/projects': ['lc_list_dir'] },
    );
    assert.equal(r.ok, true);
    assert.equal(r.root, '/projects');
  });

  it('requires separator match to prevent prefix collision', () => {
    // "/projects-secret" should NOT match root "/projects"
    const r = checkDirPermission(
      'lc_read_file',
      { paths: ['/projects-secret/evil.txt'] },
      ['/projects'],
      { '/projects': ['lc_read_file'] },
    );
    assert.equal(r.ok, false);
  });

  it('normalises backslashes to forward slashes', () => {
    const r = checkDirPermission(
      'lc_read_file',
      { paths: ['C:\\Users\\test\\file.txt'] },
      ['C:/Users/test'],
      { 'C:/Users/test': ['lc_read_file'] },
    );
    assert.equal(r.ok, true);
  });

  it('matches alternate lexical spellings in both roots and grants', () => {
    const r = checkDirPermission(
      'lc_read_file',
      { paths: ['c:/Users/test/./nested/../file.txt'] },
      ['C:\\Users\\TEST\\'],
      { 'c:/users/test': ['lc_read_file'] },
    );
    assert.equal(r.ok, true);
  });

  it('handles write_file with files array', () => {
    const r = checkDirPermission(
      'lc_write_file',
      { files: [{ path: '/tmp/out.txt', content: 'hi' }] },
      ['/tmp'],
      { '/tmp': ['lc_write_file'] },
    );
    assert.equal(r.ok, true);
  });

  it('returns ungranted with dir list when pathsOutsideRoots', () => {
    const r = checkDirPermission(
      'lc_read_file',
      { paths: ['/forbidden/x.txt'] },
      ['/allowed'],
      {},
    );
    assert.equal(r.ok, false);
    // Should suggest /forbidden as ungranted candidate.
    assert.ok(r.ungranted?.includes('/forbidden'));
  });

  it('leftovers returns non-ok paths only', () => {
    const r = checkDirPermission(
      'lc_read_file',
      { paths: ['/ok/file.txt', '/bad/secret.txt'] },
      ['/ok'],
      { '/ok': ['lc_read_file'] },
    );
    assert.equal(r.ok, false);
    // Only /bad should be in ungranted since /ok is fine.
    assert.ok(r.ungranted?.includes('/bad'));
    assert.ok(!r.ungranted?.includes('/ok'));
  });
});

/* ── tryParseLenient (Phase 0B.5) ──────────────────────────── */

describe('tryParseLenient', () => {
  it('parses valid JSON without correction', () => {
    const r: LenientParseResult | null = tryParseLenient('{"paths":["/tmp/file.txt"]}');
    assert.ok(r !== null);
    assert.equal(r!.corrected, false);
    assert.deepEqual(r!.value, { paths: ['/tmp/file.txt'] });
  });

  it('parses valid JSON array', () => {
    const r = tryParseLenient('[1, 2, 3]');
    assert.ok(r !== null);
    assert.equal(r!.corrected, false);
    assert.deepEqual(r!.value, [1, 2, 3]);
  });

  it('handles empty string', () => {
    const r = tryParseLenient('');
    assert.ok(r !== null);
    assert.equal(r!.corrected, false);
    assert.deepEqual(r!.value, {});
  });

  it('handles null/undefined-like inputs via caller guard', () => {
    // The wrapper in validateToolCalls handles this; tryParseLenient
    // receives non-empty strings.  We test the edge directly.
    const r = tryParseLenient('{}');
    assert.ok(r !== null);
    assert.equal(r!.corrected, false);
    assert.deepEqual(r!.value, {});
  });

  it('corrects trailing junk (model added text after JSON)', () => {
    const raw = '{"paths":["/tmp/file.txt"]} extra text that model added';
    const r = tryParseLenient(raw);
    assert.ok(r !== null);
    assert.equal(r!.corrected, true, 'should be flagged as corrected');
    assert.deepEqual(r!.value, { paths: ['/tmp/file.txt'] });
  });

  it('corrects trailing "]}" extra characters', () => {
    // Classic model bug: writes extra ]} after valid JSON.
    // Use JSON.stringify to build the test case reliably.
    const validJson = JSON.stringify({ paths: ['D:\\file.txt'] });
    const raw = validJson + ']}';
    // raw = {"paths":["D:\\file.txt"]]}  — valid is 26 chars, raw is 28
    const r = tryParseLenient(raw);
    assert.ok(r !== null, `failed to parse: ${raw}`);
    assert.equal(r!.corrected, true);
    assert.deepEqual(r!.value, { paths: ['D:\\file.txt'] });
  });

  it('corrects when array has trailing junk', () => {
    const raw = '[{"a":1},{"b":2}] trailing garbage ]} more';
    const r = tryParseLenient(raw);
    assert.ok(r !== null);
    assert.equal(r!.corrected, true);
    assert.deepEqual(r!.value, [{ a: 1 }, { b: 2 }]);
  });

  it('returns null for completely malformed input', () => {
    const r = tryParseLenient('not json at all just random text');
    assert.equal(r, null);
  });

  it('returns null for unmatched brackets', () => {
    const r = tryParseLenient('{"a":1');
    assert.equal(r, null);
  });

  // Performance: at most 50 repair attempts; work depends on input length.

  it('parses 100 KB malformed JSON in < 50 ms (GLM C4, GPT §3.9)', () => {
    // Build a 100 KB string: valid JSON prefix + 100 KB of trailing 'x's.
    // The old O(n) algorithm would call JSON.parse ~100,000 times.
    // The new algorithm scans for '}' from the end (O(n) scan, O(1) parses).
    const prefix = '{"path":"/tmp/file.txt","content":"hello world"}';
    const targetSize = 100_000;
    const padding = 'x'.repeat(targetSize - prefix.length);
    const raw = prefix + padding;
    assert.equal(raw.length, targetSize);

    const start = performance.now();
    const r = tryParseLenient(raw);
    const elapsed = performance.now() - start;

    assert.ok(r !== null);
    assert.equal(r!.corrected, true);
    assert.deepEqual(r!.value, JSON.parse(prefix));
    assert.ok(elapsed < 50,
      `must complete in <50 ms, took ${elapsed.toFixed(1)} ms`);
  });

  it('handles deeply nested valid JSON fast (no trailing junk)', () => {
    // Build a valid JSON with many closing braces — the scanner should
    // still be fast since it only parses up to ~50 candidates.
    const parts: string[] = [];
    for (let i = 0; i < 1500; i++) {
      parts.push(`{"k${i}":`);
    }
    parts.push('"v"');
    for (let i = 0; i < 1500; i++) {
      parts.push('}');
    }
    const raw = parts.join('');
    assert.ok(raw.length > 5000, `expected >5000 chars, got ${raw.length}`);

    const start = performance.now();
    const r = tryParseLenient(raw);
    const elapsed = performance.now() - start;

    // Fast path: valid JSON without trailing junk
    assert.ok(r !== null);
    assert.equal(r!.corrected, false);
    assert.ok(elapsed < 50,
      `valid nested JSON should be fast, took ${elapsed.toFixed(1)} ms`);
  });

  it('caps retries at 50 candidates (worst-case bound)', () => {
    // Build a string with 100 closing braces, each preceded by invalid
    // JSON. Only the first valid parse should succeed.
    const raw = 'deadbeef' + '}'.repeat(100);
    const start = performance.now();
    const r = tryParseLenient(raw);
    const elapsed = performance.now() - start;
    // It will try up to 50 candidates and fail all of them.
    assert.equal(r, null);
    assert.ok(elapsed < 50,
      `capped retries must be fast, took ${elapsed.toFixed(1)} ms`);
  });

  it('returns null when malformed input has no candidate boundary', () => {
    const raw = '{"a":1,"b":2' + 'z'.repeat(10); // 10 chars trailing junk, no }
    const r = tryParseLenient(raw);
    assert.equal(r, null,
      'short strings with no bracket candidates and no valid prefix return null');
  });
});

/* ── runWithPool (Phase 0B.11) ──────────────────────────────── */

describe('runWithPool', () => {
  it('runs all items and returns results in order', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runWithPool(items, 3, async (n) => n * 2);
    assert.deepEqual(results, [2, 4, 6, 8, 10]);
  });

  it('respects concurrency limit', async () => {
    let maxConcurrent = 0;
    let current = 0;
    const items = Array.from({ length: 4 }, (_, i) => i);
    const entered = items.map(() => Promise.withResolvers<void>());
    const release = items.map(() => Promise.withResolvers<void>());
    const pending = runWithPool(items, 2, async (n) => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      entered[n].resolve();
      await release[n].promise;
      current--;
      return n;
    });

    await Promise.all([entered[0].promise, entered[1].promise]);
    assert.equal(maxConcurrent, 2);
    release[0].resolve();
    await entered[2].promise;
    release[1].resolve();
    await entered[3].promise;
    release[2].resolve();
    release[3].resolve();
    await pending;
    assert.equal(maxConcurrent, 2);
  });

  it('accepts the maximum supported pool width of 64', async () => {
    const items = Array.from({ length: 64 }, (_, index) => index);
    const entered = items.map(() => Promise.withResolvers<void>());
    const release = Promise.withResolvers<void>();
    let current = 0;
    let maxConcurrent = 0;
    const pending = runWithPool(items, 64, async (item) => {
      current += 1;
      maxConcurrent = Math.max(maxConcurrent, current);
      entered[item].resolve();
      await release.promise;
      current -= 1;
      return item;
    });

    await Promise.all(entered.map((gate) => gate.promise));
    assert.equal(maxConcurrent, 64);
    release.resolve();
    assert.deepEqual(await pending, items);
  });

  it('calls onItem for each completed item', async () => {
    const received: number[] = [];
    await runWithPool([10, 20, 30], 2, async (n) => n * 10, (r) => {
      received.push(r);
    });
    assert.deepEqual(received.sort((a, b) => a - b), [100, 200, 300]);
  });

  it('publishes a fast result while a slow sibling is still pending', async () => {
    const slow = Promise.withResolvers<void>();
    const fastPublished = Promise.withResolvers<void>();
    const received: string[] = [];
    const pending = runWithPool(['slow', 'fast'], 2, async (item) => {
      if (item === 'slow') await slow.promise;
      return item;
    }, (item) => {
      received.push(item);
      if (item === 'fast') fastPublished.resolve();
    });

    await fastPublished.promise;
    assert.deepEqual(received, ['fast']);
    slow.resolve();
    assert.deepEqual(await pending, ['slow', 'fast']);
  });

  it('fills results array in correct positions regardless of completion order', async () => {
    const items = [0, 1, 2, 3, 4];
    const entered = items.map(() => Promise.withResolvers<void>());
    const release = items.map(() => Promise.withResolvers<void>());
    const pending = runWithPool(items, 3, async (n) => {
      entered[n].resolve();
      await release[n].promise;
      return n * 10;
    });

    await Promise.all([entered[0].promise, entered[1].promise, entered[2].promise]);
    release[2].resolve();
    await entered[3].promise;
    release[1].resolve();
    await entered[4].promise;
    release[4].resolve();
    release[3].resolve();
    release[0].resolve();

    const results = await pending;
    assert.deepEqual(results, [0, 10, 20, 30, 40]);
  });

  // ── Phase 0B.11: error recovery ───────────────────────────

  it('Phase 0B.11: one worker error does not abandon others', async () => {
    const items = ['a', 'b', 'c', 'd'];
    const completed: string[] = [];
    let error: unknown = null;
    try {
      await runWithPool(items, 2, async (item) => {
        if (item === 'b') throw new Error('worker b failed');
        completed.push(item);
        return item.toUpperCase();
      });
    } catch (e) {
      error = e;
    }
    // The error is thrown, but all non-failing items completed first.
    assert.ok(error instanceof Error);
    assert.ok(String(error).includes('worker b failed'));
    // Workers a, c, d should have completed
    assert.deepEqual(completed.sort(), ['a', 'c', 'd']);
  });

  it('Phase 0B.11: aggregate error when multiple workers fail', async () => {
    const items = ['x', 'y', 'z'];
    let error: unknown = null;
    try {
      await runWithPool(items, 3, async (item) => {
        if (item !== 'y') throw new Error(`${item} failed`);
        return item;
      });
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof Error);
    const msg = String(error);
    assert.ok(msg.includes('2 tool workers failed'));
    assert.ok(msg.includes('x failed'));
    assert.ok(msg.includes('z failed'));
  });

  it('visits every accepted item before reporting an all-failing batch', async () => {
    const executed: number[] = [];
    let error: unknown = null;
    try {
      await runWithPool([1, 2, 3, 4], 2, async (item) => {
        executed.push(item);
        throw new Error(`${item} failed`);
      });
    } catch (caught) {
      error = caught;
    }

    assert.deepEqual(executed.sort((a, b) => a - b), [1, 2, 3, 4]);
    assert.match(String(error), /4 tool workers failed/);
  });

  it('drains remaining indices when every current worker rejects', async () => {
    const executed: number[] = [];
    let error: unknown = null;
    try {
      await runWithPool([1, 2, 3, 4], 2, async (item) => {
        executed.push(item);
        if (item <= 2) throw new Error(`${item} failed`);
        return item;
      });
    } catch (caught) {
      error = caught;
    }

    assert.deepEqual(executed.sort((a, b) => a - b), [1, 2, 3, 4]);
    assert.match(String(error), /2 tool workers failed/);
    assert.match(String(error), /1 failed/);
    assert.match(String(error), /2 failed/);
  });

  it('Phase 0B.11: successful workers results are preserved after partial failure', async () => {
    let threw = false;
    try {
      await runWithPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('fail');
        return n * 100;
      });
    } catch {
      threw = true;
    }
    assert.ok(threw, 'should throw on error');
    // The fix: all workers completed before the throw.
    // Workers 1 and 3 succeeded, worker 2 failed.
  });

  it('Phase 0B.11: onItem is NOT called for failed workers', async () => {
    const received: number[] = [];
    try {
      await runWithPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('fail');
        return n * 10;
      }, (r) => { received.push(r); });
    } catch { /* expected */ }
    // Only workers 1 and 3 completed successfully
    assert.deepEqual(received.sort(), [10, 30]);
  });

  it('drains every accepted item before reporting an onItem failure', async () => {
    const executed: number[] = [];
    const published: number[] = [];
    let error: unknown = null;

    try {
      await runWithPool([1, 2, 3], 1, async (n) => {
        executed.push(n);
        return n * 10;
      }, (result) => {
        published.push(result);
        if (result === 10) throw new Error('observer failed');
      });
    } catch (caught) {
      error = caught;
    }

    assert.deepEqual(executed, [1, 2, 3]);
    assert.deepEqual(published, [10, 20, 30]);
    assert.match(String(error), /observer failed/);
  });

  it('handles empty input', async () => {
    const results = await runWithPool([], 5, async () => 'x');
    assert.deepEqual(results, []);
  });

  it('handles single item', async () => {
    const results = await runWithPool([42], 1, async (n) => n + 1);
    assert.deepEqual(results, [43]);
  });
});

/* ── normalizeConcurrency (Phase 1.6) ───────────────────────── */

describe('normalizeConcurrency', () => {
  it('returns the value unchanged when in valid range', () => {
    assert.equal(normalizeConcurrency(1), 1);
    assert.equal(normalizeConcurrency(8), 8);
    assert.equal(normalizeConcurrency(64), 64);
  });

  it('clamps values above 64 to 64', () => {
    assert.equal(normalizeConcurrency(65), 64);
    assert.equal(normalizeConcurrency(100), 64);
    assert.equal(normalizeConcurrency(999), 64);
  });

  it('returns default (8) for zero', () => {
    assert.equal(normalizeConcurrency(0), 8);
  });

  it('returns default (8) for negative values', () => {
    assert.equal(normalizeConcurrency(-1), 8);
    assert.equal(normalizeConcurrency(-100), 8);
  });

  it('returns default (8) for NaN', () => {
    assert.equal(normalizeConcurrency(NaN), 8);
  });

  it('returns default (8) for Infinity', () => {
    assert.equal(normalizeConcurrency(Infinity), 8);
    assert.equal(normalizeConcurrency(-Infinity), 8);
  });

  it('returns default (8) for non-finite values', () => {
    assert.equal(normalizeConcurrency(Number.POSITIVE_INFINITY), 8);
    assert.equal(normalizeConcurrency(Number.NEGATIVE_INFINITY), 8);
    assert.equal(normalizeConcurrency(Number.NaN), 8);
  });
});

describe('lc_apply_patch native plan contract', () => {
  it('rejects execution when native preflight did not provide a plan ID', async () => {
    const sandbox = createMockBridge();
    const ctx = {
      sandbox,
      config: { allowedRoots: ['C:\\repo'] },
    } as unknown as ToolHandlerContext;

    await assert.rejects(
      applyPatch.run({ patch: '*** Begin Patch\n*** End Patch' }, ctx),
      /requires successful native preflight/,
    );
  });

  it('passes the exact native plan ID and roots to execution', async () => {
    let received: ApplyPatchArgs | undefined;
    const sandbox = createMockBridge({
      applyPatch: async (args) => {
        received = args;
        return { files: [], summary: 'ok', fully_applied: true };
      },
    });
    const ctx = {
      sandbox,
      nativePlanId: 'native-plan-123',
      config: { allowedRoots: ['C:\\repo'] },
      identity: { operationId: 'native-operation-123', groupId: 'native-group-123' },
    } as unknown as ToolHandlerContext;

    await applyPatch.run({ patch: 'patch-body' }, ctx);
    assert.deepEqual(received, {
      patch: 'patch-body',
      allowed_roots: ['C:\\repo'],
      plan_id: 'native-plan-123',
      call_id: 'native-operation-123',
      group_id: 'native-group-123',
    });
  });
});
