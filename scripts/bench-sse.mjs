// Copyright 2026 LC Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
// Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.

/**
 * Local decoder CPU scaling for valid newline-heavy events below its cap.
 * Reports measurements and output fingerprints; no timing assertions.
 * The optional decoder path permits before/after runs on an exported source.
 * This does not measure networking, browser rendering, or interaction latency.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.argv.includes('--help')) {
  console.log('Usage: npm run bench:sse -- [decoder.ts]\nReports JSON lines for LF, CRLF, CR, and fragmented LF input; three measured passes after warmup.');
} else {
  if (process.argv.length > 3 || process.argv[2]?.startsWith('--')) throw new Error('Use one decoder source path.');
  const decoderUrl = process.argv[2]
    ? pathToFileURL(resolve(process.argv[2]))
    : new URL('../src/modules/llm-client/transport/sse-decoder.ts', import.meta.url);
  const { decodeSSE } = await import(decoderUrl.href);
  const decoderPath = fileURLToPath(decoderUrl);
  console.log(JSON.stringify({
    node: process.version, decoder: decoderPath, runs: 3,
    decoderSha256: createHash('sha256').update(readFileSync(decoderPath)).digest('hex'),
    scope: 'local decoder CPU; no network or browser measurements',
  }));

  async function measure(bytes, chunkBytes) {
    let offset = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) { controller.close(); return; }
        const end = Math.min(offset + chunkBytes, bytes.length);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
    });
    const items = [];
    const start = performance.now();
    for await (const item of decodeSSE(body)) items.push(item);
    const ms = performance.now() - start;
    return {
      ms,
      events: items.filter((item) => item.type === 'event').length,
      issues: items.filter((item) => item.type === 'issue').length,
      outputSha256: createHash('sha256').update(JSON.stringify(items)).digest('hex'),
    };
  }

  for (const [shape, newline, chunkBytes] of [
    ['LF single buffer', '\n', Infinity],
    ['LF fragmented', '\n', 4_096],
    ['CRLF single buffer', '\r\n', Infinity],
    ['CR single buffer', '\r', Infinity],
  ]) {
    await measure(new TextEncoder().encode(`data: {}${newline}${newline}`), chunkBytes);
    for (const size of [65_536, 131_072, 262_144, 524_288, 1_048_576]) {
      const line = `data: ${newline}`;
      const bytes = new TextEncoder().encode(line.repeat(Math.floor(size / line.length)) + `data: {}${newline}${newline}`);
      const samples = [];
      for (let pass = 0; pass < 3; pass += 1) samples.push(await measure(bytes, chunkBytes));
      const times = samples.map((sample) => sample.ms).sort((a, b) => a - b);
      console.log(JSON.stringify({
        shape, bytes: bytes.length, chunkBytes: Number.isFinite(chunkBytes) ? chunkBytes : bytes.length,
        expectedEvents: 1, medianMs: times[1], samples,
      }));
    }
  }
}
