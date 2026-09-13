/**
 * Real support-report v1 fixture compatibility and privacy checks.
 *
 * These are deliberately invariant checks, not golden snapshots: the default
 * and opted-in files were captured at different diagnostic-ring moments, so
 * timestamps, events, counters, and byte sizes are expected to differ.
 *
 * Run with:
 *   tsx --test src/utils/support-report-fixtures.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  SUPPORT_ARCHIVE,
  SUPPORT_DEFAULT_JSON,
  SUPPORT_INCLUDED_JSON,
  ensureExtracted,
} from '../../scripts/fixture-lc-archives.mjs';
import {
  SUPPORT_REPORT_MAX_COLLECTION_ITEMS,
  SUPPORT_REPORT_MAX_DEPTH,
  SUPPORT_REPORT_MAX_EVENTS,
  SUPPORT_REPORT_MAX_SERIALIZED_BYTES,
  SUPPORT_REPORT_MAX_STRING_CHARACTERS,
} from './support-report-base.ts';
import { isSupportReportV1, type SupportReportV1 } from './support-report.ts';

const FORBIDDEN_STRING_PATTERNS = {
  url: /https?:\/\//i,
  email: /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/,
  windowsPath: /\b[a-z]:[\\/]/i,
  uncPath: /\\\\[^\\\s]+\\[^\\\s]+/,
  homePath: /(?:\/home\/|\/Users\/)/,
  providerKey: /\bsk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{12,}/,
  authorizationHeader: /authorization\s*:/i,
  cookieHeader: /cookie\s*:/i,
  longBase64: /\b[A-Za-z0-9+/]{80,}={0,2}\b/,
};

const FORBIDDEN_EXACT_KEYS = new Set([
  'apiKey', 'authorization', 'baseUrl', 'content', 'conversationId', 'cookie',
  'credentials', 'host', 'messageId', 'prompt', 'requestBody', 'responseBody',
  'attachments', 'toolInput', 'toolResult',
]);

interface StringPathEntry {
  path: string;
  value: string;
}

interface KeyPathEntry {
  key: string;
  path: string;
}

interface LoadedSupportFixture {
  dir: string;
  file: string;
  text: string;
  report: SupportReportV1;
}

async function readSupportFixture(name: string): Promise<LoadedSupportFixture> {
  const dir = (await ensureExtracted())[SUPPORT_ARCHIVE];
  const file = join(dir, name);
  const text = readFileSync(file, 'utf8');
  const report: unknown = JSON.parse(text);
  if (!isSupportReportV1(report)) {
    throw new Error(`${name}: fixture is not a valid support-report v1 document`);
  }
  return { dir, file, text, report };
}

function collectStrings(
  value: unknown,
  path = '',
  output: StringPathEntry[] = [],
): StringPathEntry[] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStrings(entry, `${path}[${index}]`, output));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      collectStrings(entry, path ? `${path}.${key}` : key, output);
    }
  } else if (typeof value === 'string') {
    output.push({ path, value });
  }
  return output;
}

function collectKeys(
  value: unknown,
  path = '',
  output: KeyPathEntry[] = [],
): KeyPathEntry[] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectKeys(entry, `${path}[${index}]`, output));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = path ? `${path}.${key}` : key;
      output.push({ key, path: nextPath });
      collectKeys(entry, nextPath, output);
    }
  }
  return output;
}

function maximumDepth(value: unknown, depth = 0): number {
  if (Array.isArray(value)) {
    return value.reduce((max, entry) => Math.max(max, maximumDepth(entry, depth + 1)), depth);
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (max, entry) => Math.max(max, maximumDepth(entry, depth + 1)),
      depth,
    );
  }
  return depth;
}

test('support archive contains exactly the default and opted-in production reports', async () => {
  const { dir } = await readSupportFixture(SUPPORT_DEFAULT_JSON);
  assert.deepEqual(
    readdirSync(dir).filter((entry) => entry !== '.extracted-ok').sort(),
    [SUPPORT_DEFAULT_JSON, SUPPORT_INCLUDED_JSON].sort(),
  );
});

for (const name of [SUPPORT_DEFAULT_JSON, SUPPORT_INCLUDED_JSON]) {
  test(`${name}: remains a valid bounded support-report v1 document`, async () => {
    const { file, text, report } = await readSupportFixture(name);
    assert.ok(isSupportReportV1(report));
    assert.ok(text.endsWith('}\n'), 'saved support reports include their delivery newline');
    assert.equal(Buffer.byteLength(text, 'utf8'), statSync(file).size);
    assert.ok(Buffer.byteLength(text, 'utf8') <= SUPPORT_REPORT_MAX_SERIALIZED_BYTES);
    assert.ok(report.diagnostics.events.length <= SUPPORT_REPORT_MAX_EVENTS);
    assert.equal(report.diagnostics.eventCount, report.diagnostics.events.length);
    assert.ok(maximumDepth(report) <= SUPPORT_REPORT_MAX_DEPTH);

    for (const entry of collectStrings(report)) {
      assert.ok(
        entry.value.length <= SUPPORT_REPORT_MAX_STRING_CHARACTERS,
        `${entry.path}: string exceeds the support-report bound`,
      );
    }

    assert.equal(report.limits.maxSerializedBytes, SUPPORT_REPORT_MAX_SERIALIZED_BYTES);
    assert.equal(report.limits.maxStringCharacters, SUPPORT_REPORT_MAX_STRING_CHARACTERS);
    assert.equal(report.limits.maxCollectionItems, SUPPORT_REPORT_MAX_COLLECTION_ITEMS);
    assert.equal(report.limits.maxEvents, SUPPORT_REPORT_MAX_EVENTS);
    assert.equal(report.limits.maxDepth, SUPPORT_REPORT_MAX_DEPTH);
  });

  test(`${name}: contains no captured private-content shapes`, async () => {
    const { report } = await readSupportFixture(name);
    for (const entry of collectStrings(report)) {
      for (const [label, pattern] of Object.entries(FORBIDDEN_STRING_PATTERNS)) {
        assert.equal(pattern.test(entry.value), false, `${entry.path}: matched forbidden ${label}`);
      }
    }
    for (const entry of collectKeys(report)) {
      assert.equal(
        FORBIDDEN_EXACT_KEYS.has(entry.key),
        false,
        `${entry.path}: forbidden support-report key`,
      );
    }
  });
}

test('default support report excludes both opt-in payloads', async () => {
  const { report } = await readSupportFixture(SUPPORT_DEFAULT_JSON);
  assert.equal(report.models.identifiersIncluded, false);
  assert.equal(Object.hasOwn(report.models, 'identifiers'), false);
  assert.equal(report.diagnostics.descriptionsIncluded, false);
  assert.equal(collectKeys(report).some((entry) => entry.key === 'description'), false);
});

test('opted-in support report includes bounded model identifiers without widening privacy', async () => {
  const { report } = await readSupportFixture(SUPPORT_INCLUDED_JSON);
  assert.equal(report.models.identifiersIncluded, true);
  assert.equal(report.models.identifiersTruncated, true);
  assert.ok(Array.isArray(report.models.identifiers));
  assert.equal(report.models.identifiers.length, SUPPORT_REPORT_MAX_COLLECTION_ITEMS);
  assert.ok(report.models.identifiers.every(
    (identifier) => typeof identifier === 'string' && identifier.length > 0,
  ));

  assert.equal(report.diagnostics.descriptionsIncluded, true);
  // No eligible descriptions were in this capture's event window. The pure
  // builder tests exercise actual sanitization; this fixture proves the
  // opt-in flag does not invent or widen data when no description exists.
  assert.equal(collectKeys(report).some((entry) => entry.key === 'description'), false);
});
