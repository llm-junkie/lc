import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addFileChangePreviews,
  materializeFileChangePreview,
  mergeFileLineChanges,
  summarizeFileLineChanges,
  type FileLineChange,
} from './file-line-changes.ts';
import {
  prependLcResultNotice,
  repeatedToolCallNotice,
} from './tool-result-content.ts';

describe('file line changes', () => {
  it('summarizes successful mutation results with their change type', () => {
    const summary = summarizeFileLineChanges('lc_apply_patch', JSON.stringify({
      files: [
        { path: 'src/new.ts', action: 'add', lines_added: 2, lines_removed: 0 },
        { path: 'src/broken.ts', action: 'update', lines_added: 1, lines_removed: 1, error: 'no match' },
      ],
    }));

    assert.deepEqual(summary, {
      added: 2,
      removed: 0,
      files: [{ path: 'src/new.ts', added: 2, removed: 0, changeType: 'added' }],
    });
  });

  it('summarizes a mutation result behind a recognized LC notice', () => {
    const output = prependLcResultNotice(
      JSON.stringify({
        results: [{
          path: 'src/app.ts',
          replaced: true,
          lines_added: 2,
          lines_removed: 1,
        }],
      }),
      repeatedToolCallNotice('lc_edit_file', 2),
    );

    assert.deepEqual(summarizeFileLineChanges('lc_edit_file', output), {
      added: 2,
      removed: 1,
      files: [{
        path: 'src/app.ts',
        added: 2,
        removed: 1,
        changeType: 'modified',
      }],
    });
  });

  it('does not recover JSON from an unknown result prefix', () => {
    const output = '[LC] Unrecognized framing.\n\n'
      + JSON.stringify({
        results: [{
          path: 'src/app.ts',
          replaced: true,
          lines_added: 2,
          lines_removed: 1,
        }],
      });

    assert.equal(summarizeFileLineChanges('lc_edit_file', output), undefined);
  });

  it('folds repeated edits of the same path into one file', () => {
    const changes: FileLineChange[] = [
      { path: 'src/app.ts', added: 2, removed: 1, changeType: 'modified' },
      { path: 'src/app.ts', added: 4, removed: 3, changeType: 'modified' },
    ];

    assert.deepEqual(mergeFileLineChanges(changes), {
      added: 6,
      removed: 4,
      files: [{ path: 'src/app.ts', added: 6, removed: 4, changeType: 'modified' }],
    });
  });

  it('keeps a rename and a later destination edit in one logical file', () => {
    const summary = mergeFileLineChanges([
      { path: 'C:\\repo\\old.ts', moveTo: 'C:\\repo\\new.ts', added: 0, removed: 0, changeType: 'renamed' },
      { path: 'c:/repo/new.ts', added: 1, removed: 1, changeType: 'modified' },
    ]);

    assert.equal(summary.files.length, 1);
    assert.deepEqual(summary.files[0], {
      path: 'C:\\repo\\old.ts',
      moveTo: 'C:\\repo\\new.ts',
      added: 1,
      removed: 1,
      changeType: 'renamed',
    });
  });

  it('reconstructs highlighted edit previews from tool arguments', () => {
    const [change] = addFileChangePreviews(
      'lc_edit_file',
      JSON.stringify({
        path: 'src/app.ts',
        old_string: 'const mode = "old";\nrun(mode);',
        new_string: 'const mode = "new";\nrun(mode);',
      }),
      [{ path: 'src/app.ts', added: 2, removed: 2, changeType: 'modified' }],
    );

    assert.deepEqual(change.hunks?.[0].lines.map((line) => line.type), [
      'removed', 'removed', 'added', 'added',
    ]);
    assert.equal(change.hunks?.[0].lines[2].content, 'const mode = "new";');
  });

  it('keeps preview parsing lazy until a merged file is selected', () => {
    const merged = mergeFileLineChanges([
      {
        path: 'src/app.ts',
        added: 1,
        removed: 1,
        changeType: 'modified',
        previewSources: [{
          toolName: 'lc_edit_file',
          toolArguments: JSON.stringify({ path: 'src/app.ts', old_string: 'old', new_string: 'new' }),
          timestamp: 1_753_833_600_000,
          path: 'src/app.ts',
          added: 1,
          removed: 1,
          changeType: 'modified',
        }],
      },
    ]).files[0];

    assert.equal(merged.hunks, undefined);
    const materialized = materializeFileChangePreview(merged);
    assert.deepEqual(materialized.hunks?.[0].lines, [
      { type: 'removed', content: 'old' },
      { type: 'added', content: 'new' },
    ]);
    assert.equal(materialized.hunks?.[0].toolName, 'lc_edit_file');
    assert.equal(materialized.hunks?.[0].timestamp, 1_753_833_600_000);
  });

  it('parses update hunks from apply_patch arguments', () => {
    const [change] = addFileChangePreviews(
      'lc_apply_patch',
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: src/app.ts',
          '@@',
          ' const stable = true;',
          '-const value = "old";',
          '+const value = "new";',
          '*** End Patch',
        ].join('\n'),
      },
      [{ path: 'src/app.ts', added: 1, removed: 1, changeType: 'modified' }],
    );

    assert.deepEqual(change.hunks?.[0].lines, [
      { type: 'context', content: 'const stable = true;' },
      { type: 'removed', content: 'const value = "old";' },
      { type: 'added', content: 'const value = "new";' },
    ]);
  });
});
