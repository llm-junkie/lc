/**
 * Same-batch read/write contention detection.
 *
 * Characterizes the case a frontier model hit under test: an `lc_edit_file` and an
 * `lc_read_file` on one path in a single turn, where the read returned the
 * pre-edit content and the model concluded the edit result had lied.
 *
 * Run with:
 *   node --test --experimental-strip-types src/modules/chat-pipeline/batch-contention.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fileTargetsOf,
  findContendedFilePaths,
  patchFileTargets,
} from './batch-contention.ts';

const call = (name: string, parsed: unknown, error?: unknown) => ({
  call: { name },
  parsed,
  ...(error ? { error } : {}),
});

describe('findContendedFilePaths', () => {
  it('flags a file read and edited in the same batch', () => {
    const contended = findContendedFilePaths([
      call('lc_edit_file', { path: 'D:\\p\\a.md', old_string: 'x', new_string: 'y' }),
      call('lc_read_file', { paths: ['D:\\p\\a.md'] }),
    ]);
    assert.deepEqual([...contended], ['d:/p/a.md']);
  });

  it('leaves an unrelated read alone', () => {
    const contended = findContendedFilePaths([
      call('lc_edit_file', { path: 'D:\\p\\a.md', old_string: 'x', new_string: 'y' }),
      call('lc_read_file', { paths: ['D:\\p\\b.md'] }),
    ]);
    assert.equal(contended.size, 0);
  });

  it('reports nothing when a batch only reads', () => {
    const contended = findContendedFilePaths([
      call('lc_read_file', { paths: ['D:\\p\\a.md'] }),
      call('lc_stat', { paths: ['D:\\p\\a.md'] }),
    ]);
    assert.equal(contended.size, 0);
  });

  it('reports nothing when a batch only writes', () => {
    const contended = findContendedFilePaths([
      call('lc_write_file', { files: [{ path: 'D:\\p\\a.md', content: '1' }] }),
      call('lc_edit_file', { path: 'D:\\p\\a.md', old_string: 'x', new_string: 'y' }),
    ]);
    assert.equal(contended.size, 0);
  });

  it('matches across path spellings of one file', () => {
    const contended = findContendedFilePaths([
      call('lc_write_file', { files: [{ path: 'D:\\p\\sub\\..\\a.md', content: '1' }] }),
      call('lc_read_file', { paths: ['d:/p/a.md'] }),
    ]);
    assert.deepEqual([...contended], ['d:/p/a.md']);
  });

  it('flags each read tool that races a write', () => {
    const contended = findContendedFilePaths([
      call('lc_write_file', { files: [{ path: 'D:\\p\\a.png', content: '' }] }),
      call('lc_read_image', { paths: ['D:\\p\\a.png'] }),
      call('lc_stat', { paths: ['D:\\p\\a.png'] }),
    ]);
    assert.deepEqual([...contended], ['d:/p/a.png']);
  });

  it('covers patch targets, which preflight has not resolved yet', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: D:\\p\\a.md',
      '@@',
      '-old',
      '+new',
      '*** Delete File: D:\\p\\gone.txt',
      '*** End Patch',
    ].join('\n');
    const contended = findContendedFilePaths([
      call('lc_apply_patch', { patch }),
      call('lc_read_file', { paths: ['D:\\p\\a.md', 'D:\\p\\gone.txt'] }),
    ]);
    assert.deepEqual([...contended].sort(), ['d:/p/a.md', 'd:/p/gone.txt']);
  });

  it('ignores calls that failed validation', () => {
    const contended = findContendedFilePaths([
      call('lc_edit_file', { path: 'D:\\p\\a.md' }, [{ code: 'invalid_arguments' }]),
      call('lc_read_file', { paths: ['D:\\p\\a.md'] }),
    ]);
    assert.equal(contended.size, 0);
  });

  it('ignores directory-scoped and non-file tools', () => {
    const contended = findContendedFilePaths([
      call('lc_write_file', { files: [{ path: 'D:\\p\\a.md', content: '1' }] }),
      call('lc_grep', { searches: [{ path: 'D:\\p', pattern: 'x' }] }),
      call('lc_run_shell', { cmd: 'python', args: ['--version'] }),
    ]);
    assert.equal(contended.size, 0);
  });
});

describe('patchFileTargets', () => {
  it('reads every header form, including a rename destination', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: D:\\p\\u.txt',
      '*** Move to: D:\\p\\moved.txt',
      '*** Add File: D:\\p\\added.txt',
      '+content',
      '*** Delete File: D:\\p\\gone.txt',
      '*** End Patch',
    ].join('\n');
    assert.deepEqual(patchFileTargets({ patch }), [
      'D:\\p\\u.txt',
      'D:\\p\\added.txt',
      'D:\\p\\gone.txt',
      'D:\\p\\moved.txt',
    ]);
  });

  it('returns nothing for a malformed or absent patch', () => {
    assert.deepEqual(patchFileTargets({}), []);
    assert.deepEqual(patchFileTargets(null), []);
    assert.deepEqual(patchFileTargets({ patch: 42 }), []);
  });
});

describe('fileTargetsOf', () => {
  it('reads targets from both the flat and batch call shapes', () => {
    assert.deepEqual(
      fileTargetsOf('lc_edit_file', { path: 'D:\\p\\a.md' }),
      ['D:\\p\\a.md'],
    );
    assert.deepEqual(
      fileTargetsOf('lc_write_file', {
        files: [{ path: 'D:\\p\\a.md' }, { path: 'D:\\p\\b.md' }],
      }),
      ['D:\\p\\a.md', 'D:\\p\\b.md'],
    );
  });

  it('tolerates arguments that are not an object', () => {
    assert.deepEqual(fileTargetsOf('lc_read_file', undefined), []);
    assert.deepEqual(fileTargetsOf('lc_read_file', 'nonsense'), []);
  });
});
