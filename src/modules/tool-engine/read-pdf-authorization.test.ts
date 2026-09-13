/**
 * `lc_read_pdf` must participate in File I/O authorization exactly like
 * every other path-reading tool.
 *
 * This exists because it did not. `targetPathsFromArgs` did not know
 * the tool, so the orchestrator saw zero canonical targets,
 * `resolveFileAuthorization` short-circuited to `allGranted: true`, and
 * per-directory grants were bypassed for PDFs inside allowed roots. The
 * Rust boundary still refused paths outside the roots, so the failure
 * was invisible in the common case — nothing prompted, and everything
 * appeared to work.
 *
 * Run with:
 *   tsx --test src/modules/tool-engine/read-pdf-authorization.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { targetPathsFromArgs, targetDirsFromArgs } from './check-dir-permission.ts';
import { normalizePathForMatch } from './clean-path.ts';
import {
  authorizeFileCall,
  buildGrantSnapshot,
  resolveExposure,
  resolveFileAuthorization,
} from './policy.ts';
import { FILE_IO_NAMES, FILE_IO_READ_ONLY_NAMES, FILE_IO_MUTATING_NAMES } from './registry-names.ts';
import { CONTENDABLE_READ_NAMES, findContendedFilePaths } from '../chat-pipeline/batch-contention.ts';
import { CANONICAL_TOOL_NAMES } from '../../utils/support-report-base.ts';

const ROOT = 'D:/docs';
const PDF = 'D:/docs/report.pdf';

/**
 * `dirPermissions` is keyed by the canonical (normalized, lowercased)
 * root, and `resolveFileAuthorization` expects canonical targets — so
 * the fixtures normalize exactly as the orchestrator does.
 */
function grants(dirPerms: Record<string, string[]>, roots: string[] = [ROOT]) {
  return {
    toolGrants: new Set<string>(),
    allowedRoots: roots,
    dirPermissions: new Map(
      Object.entries(dirPerms).map(
        ([k, v]) => [normalizePathForMatch(k), new Set(v)] as const,
      ),
    ),
  };
}

/** Canonicalize a target the way the orchestrator does before authorizing. */
const canon = (p: string): string => normalizePathForMatch(p);

describe('lc_read_pdf target extraction', () => {
  it('reports its paths, so authorization sees real targets', () => {
    const paths = targetPathsFromArgs('lc_read_pdf', { paths: [PDF, 'D:/docs/b.pdf'] });
    assert.deepEqual(paths, [PDF, 'D:/docs/b.pdf']);
  });

  it('is not a directory-target tool — the parent dir is the scope', () => {
    assert.deepEqual(targetDirsFromArgs('lc_read_pdf', { paths: [PDF] }), ['D:/docs']);
  });

  it('de-duplicates repeated paths like the other readers', () => {
    assert.deepEqual(targetPathsFromArgs('lc_read_pdf', { paths: [PDF, PDF] }), [PDF]);
  });

  it('returns nothing for a call with no paths', () => {
    assert.deepEqual(targetPathsFromArgs('lc_read_pdf', {}), []);
  });
});

describe('lc_read_pdf file authorization', () => {
  it('is granted when the directory pre-grants the tool', () => {
    const r = resolveFileAuthorization(
      'lc_read_pdf', [canon(PDF)], false, grants({ 'D:/docs': ['lc_read_pdf'] }),
    );
    assert.equal(r.allGranted, true);
  });

  it('PROMPTS when the root is allowed but the tool is not granted', () => {
    // The regression: this previously never prompted.
    const r = resolveFileAuthorization(
      'lc_read_pdf', [canon(PDF)], false, grants({ 'D:/docs': ['lc_read_file'] }),
    );
    assert.equal(r.allGranted, false, 'an ungranted tool must require approval');
    assert.ok(r.ungrantedDirs.length > 0 || r.missingGrantRoots.length > 0);
  });

  it('prompts when the directory has no grants at all', () => {
    const r = resolveFileAuthorization('lc_read_pdf', [canon(PDF)], false, grants({}));
    assert.equal(r.allGranted, false);
  });

  it('surfaces an out-of-root path for approval rather than silently allowing it', () => {
    const r = resolveFileAuthorization(
      'lc_read_pdf', [canon('C:/Downloads/x.pdf')], false, grants({ 'D:/docs': ['lc_read_pdf'] }),
    );
    assert.equal(r.allGranted, false);
    assert.ok(
      r.ungrantedDirs.some((d) => d.toLowerCase().includes('downloads')),
      `expected the out-of-root dir in the approval scope, got ${JSON.stringify(r.ungrantedDirs)}`,
    );
  });

  it('a grant for a sibling tool does not authorize lc_read_pdf', () => {
    const r = resolveFileAuthorization(
      'lc_read_pdf', [canon(PDF)], false,
      grants({ 'D:/docs': ['lc_read_image', 'lc_read_file', 'lc_grep'] }),
    );
    assert.equal(r.allGranted, false);
  });

  it('a descendant path is covered by the root grant', () => {
    const r = resolveFileAuthorization(
      'lc_read_pdf', [canon('D:/docs/sub/deep/a.pdf')], false,
      grants({ 'D:/docs': ['lc_read_pdf'] }),
    );
    assert.equal(r.allGranted, true);
  });

  it('a mixed batch is not granted when any target is unauthorized', () => {
    const r = resolveFileAuthorization(
      'lc_read_pdf', [canon(PDF), canon('C:/elsewhere/y.pdf')], false,
      grants({ 'D:/docs': ['lc_read_pdf'] }),
    );
    assert.equal(r.allGranted, false, 'one unauthorized target must block the batch');
  });
});

describe('lc_read_pdf batch contention', () => {
  it('is a contendable reader', () => {
    assert.ok(CONTENDABLE_READ_NAMES.has('lc_read_pdf'));
  });

  it('flags a PDF read in the same batch as a write to that path', () => {
    const contended = findContendedFilePaths([
      { call: { name: 'lc_write_file' }, parsed: { files: [{ path: PDF, content: 'x' }] } },
      { call: { name: 'lc_read_pdf' }, parsed: { paths: [PDF] } },
    ] as never);
    assert.ok(
      [...contended].some((p) => p.toLowerCase().includes('report.pdf')),
      `expected contention on the PDF, got ${JSON.stringify([...contended])}`,
    );
  });

  it('does not flag two concurrent PDF reads', () => {
    const contended = findContendedFilePaths([
      { call: { name: 'lc_read_pdf' }, parsed: { paths: [PDF] } },
      { call: { name: 'lc_read_pdf' }, parsed: { paths: [PDF] } },
    ] as never);
    assert.equal(contended.size, 0, 'reads do not contend with reads');
  });
});

describe('lc_read_pdf tool vocabularies', () => {
  it('is a File I/O tool and a read-only one', () => {
    assert.ok((FILE_IO_NAMES as readonly string[]).includes('lc_read_pdf'));
    assert.ok((FILE_IO_READ_ONLY_NAMES as readonly string[]).includes('lc_read_pdf'));
  });

  it('is never treated as mutating', () => {
    assert.ok(!(FILE_IO_MUTATING_NAMES as readonly string[]).includes('lc_read_pdf'));
  });

  it('is a canonical name, so diagnostics do not degrade it to "unknown"', () => {
    assert.ok((CANONICAL_TOOL_NAMES as readonly string[]).includes('lc_read_pdf'));
  });

  it('every read-only File I/O tool yields targets for authorization', () => {
    // Guards the whole class: a future reader added without a
    // targetPathsFromArgs branch would silently bypass grants the same
    // way lc_read_pdf did.
    for (const name of FILE_IO_READ_ONLY_NAMES) {
      const args =
        name === 'lc_grep'
          ? { searches: [{ path: ROOT, pattern: 'x' }] }
          : name === 'lc_glob_files'
            ? { root: ROOT }
            : { paths: [PDF] };
      assert.ok(
        targetPathsFromArgs(name, args).length > 0,
        `${name} produced no authorization targets`,
      );
    }
  });

  it('a root manually added in Workspace pre-grants all seven readers without a popup', () => {
    assert.equal(FILE_IO_READ_ONLY_NAMES.length, 7);
    const snapshot = buildGrantSnapshot({
      allowed_roots: [ROOT],
      dir_permissions: { [ROOT]: [...FILE_IO_READ_ONLY_NAMES] },
    });
    const exposure = resolveExposure({ enabled: true, file_io_enabled: true });
    const directoryTargets = new Set(['lc_list_dir', 'lc_glob_files', 'lc_grep']);

    for (const name of FILE_IO_READ_ONLY_NAMES) {
      const targetIsDirectory = directoryTargets.has(name);
      const authorization = resolveFileAuthorization(
        name,
        [canon(targetIsDirectory ? ROOT : PDF)],
        targetIsDirectory,
        snapshot,
      );
      assert.equal(authorization.allGranted, true, `${name} unexpectedly needs a grant`);
      assert.equal(
        authorizeFileCall(name, exposure, snapshot, authorization).state,
        'pregranted',
        `${name} unexpectedly opens a permission popup`,
      );
    }
  });
});
