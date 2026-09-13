/**
 * Phase 0B.8 — cleanPath and isAbsolutePath tests
 *
 * Verifies that cleanPath no longer truncates valid paths at spaces,
 * commas, semicolons, or parentheses (GPT §3.4).
 *
 * Run with:
 *   node --test --experimental-strip-types src/modules/tool-engine/clean-path.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPath, formatPathForDisplay, isAbsolutePath, normalizePathForMatch, parentDirectory, pathResolutionFailureMessage, scopeDirForResolved, scopeDirForStatResolved } from './clean-path.ts';
import { resolvePathForScope } from './path-safety.ts';
import type { ResolvedPathInfo } from './clean-path';

describe('cleanPath (Phase 0B.8)', () => {
  describe('basic behavior', () => {
    it('preserves simple paths', () => {
      assert.equal(cleanPath('C:\\Users'), 'C:\\Users');
      assert.equal(cleanPath('/home/user'), '/home/user');
      assert.equal(cleanPath('C:\\'), 'C:\\');
    });

    it('strips surrounding whitespace', () => {
      assert.equal(cleanPath('  C:\\foo  '), 'C:\\foo');
      assert.equal(cleanPath('\t/home/dir\n'), '/home/dir');
    });

    it('strips trailing path separators', () => {
      assert.equal(cleanPath('C:\\foo\\'), 'C:\\foo');
      assert.equal(cleanPath('/home/user/'), '/home/user');
      assert.equal(cleanPath('C:'), 'C:\\'); // bare drive letter
    });

    it('collapses double backslashes from JSON round-trips', () => {
      assert.equal(cleanPath('C:\\\\foo\\\\bar'), 'C:\\foo\\bar');
    });

    it('is idempotent', () => {
      const cases = ['C:\\foo', '/home/user', 'C:\\foo\\', '  /path  '];
      for (const c of cases) {
        assert.equal(cleanPath(cleanPath(c)), cleanPath(c));
      }
    });
  });

  // ── Phase 0B.8 regression: paths with special characters ──────

  describe('preserves spaces (was: truncated at first space)', () => {
    it('Windows path with spaces', () => {
      assert.equal(cleanPath('C:\\Program Files\\LC'), 'C:\\Program Files\\LC');
    });

    it('Unix path with spaces', () => {
      assert.equal(cleanPath('/home/user/my documents'), '/home/user/my documents');
    });

    it('path with only trailing whitespace stripped', () => {
      assert.equal(cleanPath('  C:\\My Data\\file.txt  '), 'C:\\My Data\\file.txt');
    });
  });

  describe('preserves commas (was: truncated at comma)', () => {
    it('Unix path with comma', () => {
      assert.equal(cleanPath('/work/a,b'), '/work/a,b');
    });

    it('path with comma in filename', () => {
      assert.equal(cleanPath('/work/a,b/file.txt'), '/work/a,b/file.txt');
    });

    it('Windows path with comma', () => {
      assert.equal(cleanPath('C:\\data\\backup,old'), 'C:\\data\\backup,old');
    });
  });

  describe('preserves semicolons', () => {
    it('Unix path with semicolon', () => {
      assert.equal(cleanPath('/usr/local;bin'), '/usr/local;bin');
    });
  });

  describe('preserves parentheses (was: truncated at parenthesis)', () => {
    it('Unix path with parentheses', () => {
      assert.equal(cleanPath('/work/project (old)/file.txt'), '/work/project (old)/file.txt');
    });

    it('Windows path with parentheses', () => {
      assert.equal(cleanPath('C:\\Projects\\App (v2)\\src'), 'C:\\Projects\\App (v2)\\src');
    });
  });

  describe('edge cases', () => {
    it('empty input', () => {
      assert.equal(cleanPath(''), '');
      assert.equal(cleanPath('   '), '');
    });

    it('UNC paths (preserves leading double backslash)', () => {
      assert.equal(cleanPath('\\\\server\\share\\'), '\\\\server\\share');
    });

    it('JSON-roundtripped paths collapse double backslashes', () => {
      // When a path survives a JSON round-trip, \\ becomes \\\\.
      // The cleanPath collapse fixes this.
      assert.equal(cleanPath('C:\\\\foo\\\\bar'), 'C:\\foo\\bar');
    });
  });

  // ── Phase 0B.12: drive-letter normalisation ──────────────────

  describe('normalises drive letter to uppercase', () => {
    it('lowercase drive letter → uppercase', () => {
      assert.equal(cleanPath('c:\\lc-test\\workspace'), 'C:\\lc-test\\workspace');
    });

    it('already uppercase drive letter stays unchanged', () => {
      assert.equal(cleanPath('C:\\lc-test'), 'C:\\lc-test');
    });

    it('lowercase drive letter with trailing separator', () => {
      assert.equal(cleanPath('c:\\'), 'C:\\');
    });

    it('lowercase bare drive letter (C:) → C:\\', () => {
      assert.equal(cleanPath('c:'), 'C:\\');
    });

    it('UNC paths are unaffected (no drive letter)', () => {
      assert.equal(cleanPath('\\\\server\\share\\dir'), '\\\\server\\share\\dir');
    });

    it('Unix paths are unaffected (no drive letter)', () => {
      assert.equal(cleanPath('/home/user/docs'), '/home/user/docs');
    });

    it('idempotent after normalisation', () => {
      assert.equal(cleanPath(cleanPath('d:\\foo')), cleanPath('d:\\foo'));
    });

    it('mixed-case input with spaces and trailing junk', () => {
      assert.equal(
        cleanPath('  d:\\Program Files\\LC\\  '),
        'D:\\Program Files\\LC',
      );
    });
  });
});

describe('formatPathForDisplay', () => {
  it('uses native separators and an uppercase drive for Windows paths', () => {
    assert.equal(formatPathForDisplay('d:/dev/home/tests/what', true), 'D:\\dev\\home\\tests\\what');
    assert.equal(formatPathForDisplay('D:\\DEV\\home', true), 'D:\\DEV\\home');
  });

  it('formats forward-slash UNC paths on Windows', () => {
    assert.equal(formatPathForDisplay('//server/share/folder', true), '\\\\server\\share\\folder');
  });

  it('leaves every path unchanged on macOS and Linux', () => {
    assert.equal(formatPathForDisplay('/home/user/docs', false), '/home/user/docs');
    assert.equal(formatPathForDisplay('//network/share', false), '//network/share');
    assert.equal(formatPathForDisplay('C:/cross-platform-literal', false), 'C:/cross-platform-literal');
  });
});

describe('isAbsolutePath', () => {
  it('recognises Windows drive-letter paths', () => {
    assert.ok(isAbsolutePath('C:\\foo'));
    assert.ok(isAbsolutePath('D:\\'));
    assert.ok(isAbsolutePath('C:/foo'));
  });

  it('recognises UNC paths', () => {
    assert.ok(isAbsolutePath('\\\\server\\share'));
  });

  it('recognises Unix absolute paths', () => {
    assert.ok(isAbsolutePath('/home/user'));
    assert.ok(isAbsolutePath('/'));
  });

  it('rejects relative paths', () => {
    assert.ok(!isAbsolutePath('foo\\bar'));
    assert.ok(!isAbsolutePath('./relative'));
    assert.ok(!isAbsolutePath(''));
    assert.ok(!isAbsolutePath('file.txt'));
  });
});

describe('normalizePathForMatch', () => {
  it('collapses lexical aliases before grant matching', () => {
    assert.equal(
      normalizePathForMatch('C:\\Projects\\App\\.\\src\\..\\data\\'),
      'c:/projects/app/data',
    );
    assert.equal(
      normalizePathForMatch('c:/projects/app/data'),
      'c:/projects/app/data',
    );
  });

  it('preserves UNC identity while normalizing its spelling', () => {
    assert.equal(
      normalizePathForMatch('\\\\SERVER\\Share\\folder\\..\\data\\'),
      '//server/share/data',
    );
  });
});

// ── Phase 0B.12: parentDirectory and scopeDirForResolved ─────────

describe('parentDirectory', () => {
  it('returns parent of a file path', () => {
    assert.equal(parentDirectory('C:\\lc-test\\workspace\\src\\ChatView.tsx'), 'C:\\lc-test\\workspace\\src');
  });

  it('returns drive root when one level deep', () => {
    assert.equal(parentDirectory('D:\\foo'), 'D:\\');
  });

  it('returns drive root for drive root itself', () => {
    assert.equal(parentDirectory('D:\\'), 'D:\\');
  });

  it('handles forward slashes', () => {
    assert.equal(parentDirectory('D:/foo/bar/file.txt'), 'D:/foo/bar');
  });

  it('handles UNC paths', () => {
    assert.equal(parentDirectory('\\\\server\\share\\dir\\file.txt'), '\\\\server\\share\\dir');
  });

  it('returns null for empty string', () => {
    assert.equal(parentDirectory(''), null);
  });
});

describe('scopeDirForResolved (Phase 0B.12)', () => {
  const mk = (overrides: Partial<ResolvedPathInfo> = {}): ResolvedPathInfo => ({
    canonical: 'C:\\lc-test\\workspace\\src\\ui\\chat\\ChatView.tsx',
    exists: true,
    is_dir: false,
    ...overrides,
  });

  describe('directoryIsTarget = false (file tools: lc_read_file, lc_edit_file, etc.)', () => {
    it('file → parent directory', () => {
      const r = scopeDirForResolved(mk(), false);
      assert.equal(r, 'C:\\lc-test\\workspace\\src\\ui\\chat');
    });

    it('directory → parent directory', () => {
      const r = scopeDirForResolved(mk({ is_dir: true, canonical: 'C:\\lc-test\\workspace\\src\\ui\\chat' }), false);
      assert.equal(r, 'C:\\lc-test\\workspace\\src\\ui');
    });
  });

  describe('directoryIsTarget = true (lc_list_dir, lc_grep, lc_glob_files)', () => {
    it('directory → itself', () => {
      const r = scopeDirForResolved(mk({ is_dir: true, canonical: 'C:\\lc-test\\workspace\\src' }), true);
      assert.equal(r, 'C:\\lc-test\\workspace\\src');
    });

    it('file → parent directory (lc_grep targeting a file)', () => {
      const r = scopeDirForResolved(mk(), true);
      assert.equal(r, 'C:\\lc-test\\workspace\\src\\ui\\chat');
    });

    it('non-existent path → null', () => {
      const r = scopeDirForResolved(mk({ exists: false }), true);
      assert.equal(r, null);
    });

    it('null canonical → null', () => {
      const r = scopeDirForResolved(mk({ canonical: null }), true);
      assert.equal(r, null);
    });
  });
});

describe('scopeDirForStatResolved', () => {
  it('uses an existing directory itself as the stat scope', () => {
    assert.equal(
      scopeDirForStatResolved({
        canonical: 'C:\\lc-test\\roots\\what',
        exists: true,
        is_dir: true,
      }),
      'C:\\lc-test\\roots\\what',
    );
  });

  it('uses the parent for existing files and missing paths', () => {
    assert.equal(
      scopeDirForStatResolved({
        canonical: 'C:\\lc-test\\roots\\what\\broken_gear.md',
        exists: true,
        is_dir: false,
      }),
      'C:\\lc-test\\roots\\what',
    );
    assert.equal(
      scopeDirForStatResolved({
        canonical: 'C:\\lc-test\\roots\\what\\missing\\file.txt',
        exists: false,
        is_dir: false,
      }),
      'C:\\lc-test\\roots\\what\\missing',
    );
  });
});

describe('pathResolutionFailureMessage', () => {
  it('states the absolute-path rule for a relative or empty path', () => {
    assert.equal(
      pathResolutionFailureMessage('src/foo.ts'),
      'Target path must be absolute: src/foo.ts',
    );
    assert.equal(
      pathResolutionFailureMessage('  '),
      'Target path must be absolute:   ',
    );
  });

  it('states the existence rule for an absolute path that failed to resolve', () => {
    assert.equal(
      pathResolutionFailureMessage('D:\\missing\\dir'),
      'Target path does not exist or cannot be resolved: D:\\missing\\dir',
    );
  });
});

describe('pathResolutionFailureMessage agrees with resolvePathForScope', () => {
  // The helper reimplements the resolver's non-absolute guard because
  // clean-path.ts is deliberately dependency-free while path-safety.ts
  // imports Tauri. This test fails if the two predicates diverge, which
  // would leave the message naming the wrong rule.
  for (const p of ['src/foo.ts', './rel/x.txt', '  ', String.raw`D:\abs\file.txt`, String.raw`D:\missing\dir`]) {
    it(`partitions ${JSON.stringify(p)} the same way`, async () => {
      const scope = await resolvePathForScope(p, false);
      const message = pathResolutionFailureMessage(p);
      const claimsAbsoluteRule = message.startsWith('Target path must be absolute');
      if (claimsAbsoluteRule) {
        assert.equal(scope, null, 'resolver must also reject a path the message calls non-absolute');
      } else {
        // In the non-Tauri fallback an absolute path always yields a scope,
        // so the existence branch is only reachable under Tauri; here we
        // assert the message never claims the absolute rule for it.
        assert.notEqual(scope, null);
      }
    });
  }
});
