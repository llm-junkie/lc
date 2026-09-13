// Copyright 2026 LC Contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PILOT_GUIDANCE_CATALOGS, type ToolGuidanceCatalog } from '../src/modules/tool-engine/tool-guidance.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface CheckedBlock {
  id: string;
  file: string;
  content: () => string;
}

function code(value: string): string {
  return `\`${value.replace(/`/g, '\\`')}\``;
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function catalogs(): ToolGuidanceCatalog[] {
  return [...PILOT_GUIDANCE_CATALOGS.values()]
    .sort((left, right) => left.tool.localeCompare(right.tool));
}

function catalogIndex(): string {
  const rows = catalogs().map((catalog) => [
    code(catalog.tool),
    catalog.purpose,
    catalog.keywords.map(code).join(', '),
    catalog.sections.map((section) => code(section.title)).join(', '),
  ].map(cell).join(' | '));
  return [
    'This table is checked against the typed guidance catalogs. Edit the catalog first.',
    '',
    '| Tool | Purpose | Help keywords | Advanced sections |',
    '|---|---|---|---|',
    ...rows.map((row) => `| ${row} |`),
  ].join('\n');
}

function recoveryIndex(): string {
  const recoveryRows = catalogs().flatMap((catalog) =>
    Object.entries(catalog.recovery)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([errorCode, recovery]) => [
        code(catalog.tool),
        code(errorCode),
        recovery.remedy,
        recovery.helpQuery ? code(recovery.helpQuery) : '—',
      ].map(cell).join(' | ')));
  const signalRows = catalogs().flatMap((catalog) =>
    Object.entries(catalog.signals)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([signal, guidance]) => [
        code(catalog.tool),
        code(signal),
        guidance,
      ].map(cell).join(' | ')));
  return [
    'These tables are checked against the typed guidance catalogs. Edit the catalog first.',
    '',
    '| Tool | Stable code | Catalog remedy | Help query |',
    '|---|---|---|---|',
    ...recoveryRows.map((row) => `| ${row} |`),
    '',
    '| Tool | Automatic signal | Catalog warning |',
    '|---|---|---|',
    ...signalRows.map((row) => `| ${row} |`),
  ].join('\n');
}

const BLOCKS: CheckedBlock[] = [
  {
    id: 'catalog-index',
    file: 'docs/tools/tool-reference.md',
    content: catalogIndex,
  },
  {
    id: 'recovery-index',
    file: 'docs/tools/tool-error-handling.md',
    content: recoveryIndex,
  },
];

function expectedBlock(block: CheckedBlock): string {
  return [
    `<!-- lc-tool-guidance-sync:${block.id}:start -->`,
    block.content(),
    `<!-- lc-tool-guidance-sync:${block.id}:end -->`,
  ].join('\n');
}

function currentBlock(document: string, block: CheckedBlock): string | undefined {
  const start = `<!-- lc-tool-guidance-sync:${block.id}:start -->`;
  const end = `<!-- lc-tool-guidance-sync:${block.id}:end -->`;
  const startIndex = document.indexOf(start);
  if (startIndex < 0) return undefined;
  const endIndex = document.indexOf(end, startIndex + start.length);
  if (endIndex < 0) return undefined;
  return document.slice(startIndex, endIndex + end.length);
}

if (process.argv.includes('--print')) {
  for (const block of BLOCKS) {
    console.log(`${block.file}\n${expectedBlock(block)}\n`);
  }
  process.exit(0);
}

const failures: string[] = [];
for (const block of BLOCKS) {
  const absolute = path.join(REPO_ROOT, block.file);
  const document = fs.readFileSync(absolute, 'utf8').replace(/\r\n/g, '\n');
  const current = currentBlock(document, block);
  if (current === undefined) failures.push(`${block.file}: missing ${block.id} block`);
  else if (current !== expectedBlock(block)) failures.push(`${block.file}: ${block.id} block is out of sync`);
}

if (failures.length > 0) {
  console.error(`tool-guidance-docs: ${failures.length} issue(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error('Run `npx tsx scripts/check-tool-guidance-docs.ts --print` to inspect the expected blocks.');
  process.exit(1);
}

console.log(`tool-guidance-docs: clean — ${BLOCKS.length} generated reference blocks match the typed catalogs`);
