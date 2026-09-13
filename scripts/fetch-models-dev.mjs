/**
 * Copyright 2026 LC Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Download the models.dev catalogue snapshot that `build-models-cache.mjs`
 * reduces to `public/models-cache.json`.
 *
 * This is a manual refresh tool, not a build step. Nothing in `npm run build`,
 * `npm test`, CI, or `run_dev` calls it — the build reads the tracked
 * `public/models-cache.json` instead, so it stays offline and two builds of one
 * commit produce identical bytes. Refreshing the catalogue is a deliberate act
 * that ends in a reviewable diff.
 *
 * The 3 MB snapshot it writes is gitignored; only the ~390 KB derived cache is
 * tracked.
 *
 * Usage:
 *   node scripts/fetch-models-dev.mjs           # skip if already present
 *   node scripts/fetch-models-dev.mjs --force   # re-download regardless
 *
 * Then regenerate and commit the cache:
 *   node scripts/build-models-cache.mjs
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const SOURCE = 'https://models.dev/api.json';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'scripts', 'data', 'models-dev.json');
const FORCE = process.argv.includes('--force');

const mib = (bytes) => `${(bytes / 1048576).toFixed(2)} MiB`;

if (existsSync(OUT) && !FORCE) {
  console.log(`models-dev: already present (${mib(statSync(OUT).size)}) — ${OUT}`);
  console.log('models-dev: pass --force to re-download.');
  process.exit(0);
}

// Download to a sibling temp file and rename on success, so an interrupted or
// failed fetch cannot leave a truncated snapshot that build-models-cache.mjs
// would happily parse into a short catalogue.
const TEMP = `${OUT}.partial`;

try {
  console.log(`models-dev: downloading ${SOURCE} …`);
  const response = await fetch(SOURCE, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  if (!response.body) throw new Error('response carried no body');

  mkdirSync(dirname(OUT), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(TEMP));

  const { size } = statSync(TEMP);
  if (size === 0) throw new Error('downloaded file is empty');

  renameSync(TEMP, OUT);
  console.log(`models-dev: wrote ${mib(size)} -> ${OUT}`);
  console.log('models-dev: now run `node scripts/build-models-cache.mjs` and commit public/models-cache.json.');
} catch (error) {
  rmSync(TEMP, { force: true });
  console.error(`models-dev: download failed — ${error.message}`);
  process.exit(1);
}
