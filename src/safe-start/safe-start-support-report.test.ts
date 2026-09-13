import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSafeStartSupportReport } from './safe-start-support-report.ts';
import { isSupportReportV1, SUPPORT_REPORT_VERSION_V1 } from '../utils/support-report.ts';
import {
  copySupportReport,
  saveSupportReport,
  supportReportBytes,
  supportReportPreviewText,
} from '../utils/support-report-delivery.ts';

test('minimal Safe Start report uses shared redaction and exact delivery bytes without stores', async () => {
  const snapshot = await createSafeStartSupportReport({
    lastCompletedPhase: 'storage-opened',
    incompleteStartCount: 2,
    safeStartState: 'active',
    failureCode: 'conversation-metadata-unavailable',
  }, {}, new Date('2026-08-03T00:00:00.000Z'));
  const parsed = JSON.parse(snapshot.serialized);
  assert.deepEqual(parsed.startup, {
    lastCompletedPhase: 'storage-opened',
    incompleteStartCount: 2,
    safeStartState: 'active',
    failureCode: 'conversation-metadata-unavailable',
  });
  assert.equal(parsed.storage.integrity.conversationCountReadable, false);
  assert.equal(parsed.storage.integrity.settingsReadable, false);
  assert.equal(parsed.providers.count, 0);
  assert.equal(parsed.models.count, 0);

  let copied = '';
  let saved = '';
  const preview = supportReportPreviewText(snapshot);
  await copySupportReport(snapshot, async (text) => { copied = text; });
  await saveSupportReport(snapshot, async (_name, text) => { saved = text; return true; });
  assert.equal(copied, preview);
  assert.equal(saved, preview);
  assert.deepEqual(new TextEncoder().encode(preview), supportReportBytes(snapshot));
});

test('Safe Start emits the same current schema version as Settings', async () => {
  const snapshot = await createSafeStartSupportReport(
    { lastCompletedPhase: 'renderer-created', incompleteStartCount: 2, safeStartState: 'active' },
    {},
    new Date(2026, 7, 4, 6, 7),
  );
  const parsed = JSON.parse(snapshot.serialized);
  assert.equal(parsed.format, 'llm-client:support-report');
  assert.equal(parsed.version, SUPPORT_REPORT_VERSION_V1);
  assert.ok(isSupportReportV1(parsed));
  assert.equal(snapshot.filename, 'lc-support-v1-2026-08-04-0607.json');
  // The surface is recorded so a thin report is attributable, and
  // store-dependent sections are marked unavailable rather than guessed.
  assert.equal(parsed.collection.surface, 'safe-start');
  assert.equal(parsed.ui.reportSurface, 'safe-start');
  assert.equal(parsed.collection.sections.providers, 'unavailable');
  assert.equal(parsed.collection.sections.activeRequest, 'unavailable');
  assert.equal(parsed.collection.sections.authConfiguration, 'unavailable');
});

test('the Safe Start report module graph never reaches a normal application store', async () => {
  // support-report.md / troubleshooting.md: the recovery branch must not import settings, profile,
  // model, conversation, Dexie, provider, tool, or skill modules. A static
  // walk of the import graph is the only way to prove that, since a runtime
  // check would pass simply by not calling them.
  const { readFile } = await import('node:fs/promises');
  const { dirname, resolve } = await import('node:path');

  const FORBIDDEN = [
    'store/settings', 'store/conversations', 'store/db', 'store/modelVisibility',
    'server-profiles', 'chat-pipeline', 'tool-engine', 'modules/skills', 'dexie',
  ];
  const seen = new Set<string>();
  const offenders: string[] = [];

  async function walk(file: string): Promise<void> {
    if (seen.has(file)) return;
    seen.add(file);
    let source: string;
    try {
      source = await readFile(file, 'utf8');
    } catch {
      return;
    }
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const specifier of specifiers) {
      if (FORBIDDEN.some((bad) => specifier.includes(bad))) {
        offenders.push(`${file} -> ${specifier}`);
      }
      if (!specifier.startsWith('.')) continue;
      const base = resolve(dirname(file), specifier);
      // Specifiers carry their own extension (see the import convention in
      // architecture.md), so `base` resolves directly; the suffixed candidates
      // remain for any specifier written without one.
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
        try {
          await readFile(candidate, 'utf8');
          await walk(candidate);
          break;
        } catch { /* try the next extension */ }
      }
    }
  }

  await walk(resolve('src/safe-start/safe-start-support-report.ts'));
  assert.deepEqual(offenders, [], `Safe Start report imports a normal store: ${offenders.join(', ')}`);
  assert.ok(seen.size > 3, 'the walk must actually traverse the graph');
});
