import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeWindowsCmdInput, normalizeWindowsShellCall, WINDOWS_CMD_BUILTINS } from './windows-cmd.ts';

describe('Windows cmd adapter', () => {
  it('normalizes a backward-compatible full command before approval', () => {
    const call = normalizeWindowsShellCall({
      created_at: 0,
      id: 'unicode',
      name: 'lc_run_shell',
      arguments: JSON.stringify({ cmd: 'cmd /c echo héllo wörld 日本語', timeout_ms: 1_000 }),
    }, true);
    assert.deepEqual(JSON.parse(call.arguments), {
      cmd: 'cmd',
      args: ['/d', '/u', '/c', 'echo héllo wörld 日本語'],
      timeout_ms: 1_000,
    });
  });

  it('preserves a quoted findstr pattern as one /c command tail', () => {
    const normalized = normalizeWindowsCmdInput({
      cmd: 'cmd',
      args: ['/c', 'findstr', '/n', '/c:"Secret Master"', '/c:"Secret Grandmaster"', 'src\\*.ts'],
    });
    assert.deepEqual(normalized, {
      cmd: 'cmd',
      args: [
        '/d',
        '/u',
        '/c',
        'findstr /n /c:"Secret Master" /c:"Secret Grandmaster" src\\*.ts',
      ],
    });
  });

  it('removes only a full outer wrapper around a legacy /c tail', () => {
    assert.deepEqual(normalizeWindowsCmdInput({
      cmd: 'cmd /c "cd /d D:\\workspace && git status --porcelain"',
    }), {
      cmd: 'cmd',
      args: ['/d', '/u', '/c', 'cd /d D:\\workspace && git status --porcelain'],
    });
  });

  it('does not strip quotes from multiple quoted tail arguments', () => {
    assert.deepEqual(normalizeWindowsCmdInput({
      cmd: 'cmd /c "C:\\Program Files\\tool.exe" "two words"',
    }), {
      cmd: 'cmd',
      args: ['/d', '/u', '/c', '"C:\\Program Files\\tool.exe" "two words"'],
    });
  });

  it('keeps native executable plus argv calls unchanged', () => {
    const input = { cmd: 'git', args: ['status', '--short'] };
    assert.equal(normalizeWindowsCmdInput(input), input);
  });

  it('recognizes destructive and stateful cmd.exe builtins', () => {
    for (const builtin of ['rmdir', 'rd', 'del', 'copy', 'move', 'set']) {
      assert.equal(WINDOWS_CMD_BUILTINS.has(builtin), true, builtin);
    }
    assert.equal(WINDOWS_CMD_BUILTINS.has('findstr'), false);
  });

  it('never classifies a completed process result from output substrings', () => {
    const orchestrator = readFileSync(new URL('./orchestrator.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(orchestrator, /shell_spawn_failed/);
    assert.doesNotMatch(orchestrator, /output\.includes\(['"]cannot find['"]\)/);
    assert.doesNotMatch(orchestrator, /output\.includes\(['"]spawn['"]\)/);
  });
});
