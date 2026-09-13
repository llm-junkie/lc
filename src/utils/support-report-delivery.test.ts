import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  copySupportReport,
  saveSupportReport,
  supportReportBytes,
  supportReportPreviewText,
} from './support-report-delivery.ts';
import { createSupportReportSnapshotV1 } from './support-report.ts';

test('preview, clipboard, and save receive precisely the same immutable bytes', async () => {
  const snapshot = createSupportReportSnapshotV1(
    { application: { version: '1.0.0', buildChannel: 'test' } },
    {},
    new Date(2026, 7, 3, 0, 5),
  );
  let copied = '';
  let savedName = '';
  let saved = '';
  const preview = supportReportPreviewText(snapshot);
  await copySupportReport(snapshot, async (text) => { copied = text; });
  const result = await saveSupportReport(snapshot, async (name, data) => {
    savedName = name;
    saved = data;
    return true;
  });

  assert.equal(result, true);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(preview, snapshot.serialized);
  assert.equal(copied, preview);
  assert.equal(saved, preview);
  assert.deepEqual(new TextEncoder().encode(copied), supportReportBytes(snapshot));
  assert.deepEqual(new TextEncoder().encode(saved), supportReportBytes(snapshot));
  assert.equal(savedName, 'lc-support-v1-2026-08-03-0005.json');
});
