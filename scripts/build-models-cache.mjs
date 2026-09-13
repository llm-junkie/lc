/**
 * Build a compact provider-scoped models cache from the full models.dev
 * catalog (https://models.dev/api.json, from the anomalyco/models.dev
 * community registry).
 *
 * The input (`models-dev.json`) is a downloaded snapshot of that API.
 * This script strips it down to only the 5 fields LC actually uses
 * per model, preserving each provider's `api` field so the runtime
 * lookup can match a profile's baseUrl against the right provider.
 *
 * Output format:
 *   { "providerId": { "api": "https://...", "m": { "ModelId": {c,n,v,r,t} } } }
 *
 * Usage:  node scripts/build-models-cache.mjs [input]
 *
 * Outputs to both public/models-cache.json (web/dev) and
 * src-tauri/resources/models-cache.json (Tauri bundle).
 *
 * This is a manual refresh tool, not a build step. `public/models-cache.json`
 * is tracked, so `npm run build` stages it directly and never needs the network
 * or the 3 MB snapshot. Refreshing the catalogue is a deliberate act that ends
 * in a reviewable diff.
 *
 * To refresh the cache:
 *   1. node scripts/fetch-models-dev.mjs
 *   2. node scripts/build-models-cache.mjs
 *   3. commit public/models-cache.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const IN = process.argv[2] || resolve(ROOT, 'scripts', 'data', 'models-dev.json');
const OUT_WEB = resolve(ROOT, 'public', 'models-cache.json');
const OUT_TAURI = resolve(ROOT, 'src-tauri', 'resources', 'models-cache.json');

const rawText = readFileSync(IN, 'utf-8');
const clean = rawText.charCodeAt(0) === 0xFEFF ? rawText.slice(1) : rawText;
const raw = JSON.parse(clean);

//   c = context_window  (limit.context)
//   n = display_name    (name)
//   v = vision          (modalities.input includes "image")
//   r = reasoning       (reasoning)
//   t = tools           (tool_call)
/** @type {Record<string, {api: string, m: Record<string, {c?:number, n?:string, v?:boolean, r?:boolean, t?:boolean}>}>} */
const cache = {};
let totalModels = 0;

for (const [providerId, provider] of Object.entries(raw)) {
  if (!provider || !provider.models || !provider.api) continue;
  const api = typeof provider.api === 'string' ? provider.api : '';
  if (!api.startsWith('http')) continue;

  const models = {};
  for (const [, m] of Object.entries(provider.models)) {
    if (!m || typeof m !== 'object') continue;
    const ctx = m.limit?.context;
    const name = typeof m.name === 'string' ? m.name : undefined;
    const hasVision = Array.isArray(m.modalities?.input) && m.modalities.input.includes('image');
    const reasoning = m.reasoning === true;
    const tools = m.tool_call !== false;
    if (!ctx && !name && !hasVision && !reasoning) continue;

    const modelId = typeof m.id === 'string' ? m.id : undefined;
    const key = modelId || 'unknown';
    if (!models[key]) {
      models[key] = {};
      if (ctx) models[key].c = ctx;
      if (name) models[key].n = name;
      models[key].v = hasVision;
      models[key].r = reasoning;
      models[key].t = tools;
      totalModels++;
    }
  }

  if (Object.keys(models).length > 0) {
    cache[providerId] = { api, m: models };
  }
}

const json = JSON.stringify(cache);

mkdirSync(resolve(ROOT, 'public'), { recursive: true });
writeFileSync(OUT_WEB, json);
process.stdout.write(`models-cache: ${Object.keys(cache).length} providers, ${totalModels} models -> ${OUT_WEB} (${(json.length / 1024).toFixed(1)} KB)\n`);

mkdirSync(resolve(ROOT, 'src-tauri', 'resources'), { recursive: true });
writeFileSync(OUT_TAURI, json);
process.stdout.write(`models-cache: ${Object.keys(cache).length} providers, ${totalModels} models -> ${OUT_TAURI} (${(json.length / 1024).toFixed(1)} KB)\n`);
