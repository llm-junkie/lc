import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import '../ui/tools/whiteboard-state.spec.ts';
import { formatWhiteboardVersionId } from '../store/whiteboard.ts';
import {
  applyExactWhiteboardEdit,
  WHITEBOARD_INPUT_SCHEMA,
} from '../modules/tool-engine/whiteboard.ts';
import {
  isWhiteboardPackageFilename,
  whiteboardPackageFilename,
} from '../ui/tools/whiteboard-package.ts';
import { whiteboardLayoutForWidth } from '../ui/tools/whiteboard-state.ts';
import {
  WHITEBOARD_IMPORT_FILENAME_FIXTURES,
  WHITEBOARD_INVALID_INPUT_FIXTURES,
  WHITEBOARD_VALID_INPUT_FIXTURES,
  WHITEBOARD_VERSION_ID_FIXTURES,
} from './contract-fixtures.ts';

describe('lc_whiteboard missing-implementation gate', () => {
  test('formats the owner-prefixed ID from the controlled local clock', () => {
    assert.equal(
      formatWhiteboardVersionId('user', WHITEBOARD_VERSION_ID_FIXTURES.controlledNow),
      WHITEBOARD_VERSION_ID_FIXTURES.user,
    );
    assert.equal(
      formatWhiteboardVersionId('model', WHITEBOARD_VERSION_ID_FIXTURES.controlledNow),
      WHITEBOARD_VERSION_ID_FIXTURES.model,
    );
  });

  test('accepts only the frozen flat strict input forms', () => {
    for (const fixture of WHITEBOARD_VALID_INPUT_FIXTURES) {
      assert.equal(WHITEBOARD_INPUT_SCHEMA.safeParse(fixture.input).success, true, fixture.label);
    }
    for (const fixture of WHITEBOARD_INVALID_INPUT_FIXTURES) {
      assert.equal(WHITEBOARD_INPUT_SCHEMA.safeParse(fixture.input).success, false, fixture.label);
    }
  });

  test('applies one exact occurrence and diagnoses the two miss classes', () => {
    assert.deepEqual(applyExactWhiteboardEdit('alpha beta gamma', 'beta', 'BETA'), {
      kind: 'changed',
      content: 'alpha BETA gamma',
    });
    assert.equal(applyExactWhiteboardEdit('alpha alpha', 'alpha', 'A').kind, 'not-unique');
    assert.equal(applyExactWhiteboardEdit('alpha', 'missing', 'A').kind, 'not-found');
  });

  test('accepts only the frozen package basenames and uses local time', () => {
    for (const fixture of WHITEBOARD_IMPORT_FILENAME_FIXTURES) {
      assert.equal(isWhiteboardPackageFilename(fixture.name), fixture.accepted, fixture.name);
    }
    assert.equal(
      whiteboardPackageFilename(new Date(2026, 7, 22, 14, 30)),
      'lc-whiteboard-2026-08-22-1430.zip',
    );
  });

  test('uses the accepted single-board tabbed layout at every width', () => {
    assert.equal(whiteboardLayoutForWidth(1200), 'tabbed');
    assert.equal(whiteboardLayoutForWidth(640), 'tabbed');
  });
});
