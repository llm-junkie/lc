/**
 * Operator-run live probe for provider cache reporting. It serves the release
 * gate in docs/README.md, "Release gate" — "dated live probes for each service
 * where credentials are available" — by verifying the documented field shape
 * over two identical requests. See docs/cache-observability.md, "Running a
 * live probe", for the invocation and for what the output does not contain.
 *
 * This script is never run by `npm test`, `npm run build`, or any hook. It has
 * no defaults: the surface, endpoint, model, and credential environment
 * variable must all be passed explicitly, so it cannot contact a provider by
 * accident.
 *
 * What it does
 *   1. Sends one fixed synthetic prompt, twice, unchanged.
 *   2. Reads only the `usage` object from each response.
 *   3. Reports which documented cache fields were present, as bounded buckets.
 *
 * What it never does
 *   - print or persist the credential, the request body, the response body,
 *     any header, a request id, a cache or session key, or provider output;
 *   - add `cache_control`, `prompt_cache_breakpoint`, `prompt_cache_key`,
 *     `session_id`, `x-session-id`, or any OpenRouter routing control — the
 *     probe must observe native behavior, not manufacture it;
 *   - retry, tune, or vary the request between the two calls.
 *
 * The prompt is fixed synthetic filler with no user data in it. It is long
 * because provider caches have minimum-prefix thresholds; it is identical
 * across both calls because that is what the criterion asks to verify.
 *
 * Usage:
 *   node scripts/probe-cache-live.mjs \
 *     --surface "OpenAI — Chat Completions" \
 *     --envelope chat-completions \
 *     --base-url https://api.openai.com/v1 \
 *     --model <model-id> \
 *     --key-env OPENAI_API_KEY \
 *     [--out docs/evidence/cache-live-probe.json]   # evidence filename unchanged
 *
 * Envelopes: chat-completions | responses | anthropic
 *
 * Exit code is 0 when both calls succeeded and the surface reported at least
 * one recognized cache field on the second call; 1 otherwise. A failing probe
 * is evidence too — record it rather than rerunning until it passes.
 */

const ENVELOPES = ['chat-completions', 'responses', 'anthropic'];

/** Fixed synthetic filler. Contains no user, workspace, or account data. */
const FILLER_UNIT = [
  'Section marker. This paragraph is fixed synthetic probe filler used only to ',
  'exceed a provider minimum cacheable prefix length. It describes nothing, ',
  'references nothing, and is identical on every run so two consecutive ',
  'requests share a byte-identical prefix. ',
].join('');

/** Roughly 24k characters: above every documented minimum-prefix threshold. */
const SYNTHETIC_PREFIX = FILLER_UNIT.repeat(80);
const SYNTHETIC_QUESTION = 'Reply with the single word: acknowledged.';

/**
 * Bounded token buckets. Exact counts are provider billing detail and are not
 * part of the evidence this criterion asks for.
 */
function tokenBucket(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'unknown';
  if (value === 0) return 'zero';
  if (value < 1_000) return '1-999';
  if (value < 10_000) return '1k-9k';
  if (value < 100_000) return '10k-99k';
  return '100k+';
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--')) fail(`Unexpected argument: ${key}`);
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

function fail(message) {
  // Never interpolate a credential, URL, or response body into this.
  process.stderr.write(`probe-cache-live: ${message}\n`);
  process.exit(2);
}

/** Endpoint class only. The configured host never reaches the evidence file. */
function endpointClass(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'invalid';
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host.startsWith('127.') || host === '::1') return 'loopback';
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return 'private-network';
    return parsed.protocol === 'https:' ? 'public-https' : 'public-http';
  } catch {
    return 'invalid';
  }
}

function buildRequest(envelope, model) {
  // Deliberately minimal. No cache directive, no routing control, no session
  // field, no `stream`. Only what a request needs to exist.
  if (envelope === 'anthropic') {
    return {
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: `${SYNTHETIC_PREFIX}\n\n${SYNTHETIC_QUESTION}` }],
    };
  }
  if (envelope === 'responses') {
    return {
      model,
      max_output_tokens: 16,
      input: [{ role: 'user', content: `${SYNTHETIC_PREFIX}\n\n${SYNTHETIC_QUESTION}` }],
    };
  }
  return {
    model,
    max_tokens: 16,
    messages: [{ role: 'user', content: `${SYNTHETIC_PREFIX}\n\n${SYNTHETIC_QUESTION}` }],
  };
}

function endpointFor(envelope, baseUrl) {
  const root = baseUrl.replace(/\/+$/, '');
  if (envelope === 'anthropic') return /\/v\d+$/i.test(root) ? `${root}/messages` : `${root}/v1/messages`;
  if (envelope === 'responses') return `${root}/responses`;
  return `${root}/chat/completions`;
}

function headersFor(envelope, apiKey) {
  if (envelope === 'anthropic') {
    return {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  return { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
}

/** Which documented cache fields this response actually carried. */
function recognizedCacheFields(usage) {
  if (!usage || typeof usage !== 'object') return { fields: [], read: undefined, write: undefined, miss: undefined };
  const promptDetails = usage.prompt_tokens_details ?? {};
  const inputDetails = usage.input_tokens_details ?? {};
  const found = [];
  const note = (name, value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      found.push(name);
      return value;
    }
    return undefined;
  };

  const read = note('usage.prompt_tokens_details.cached_tokens', promptDetails.cached_tokens)
    ?? note('usage.input_tokens_details.cached_tokens', inputDetails.cached_tokens)
    ?? note('usage.cache_read_input_tokens', usage.cache_read_input_tokens)
    ?? note('usage.prompt_cache_hit_tokens', usage.prompt_cache_hit_tokens);
  const write = note('usage.prompt_tokens_details.cache_write_tokens', promptDetails.cache_write_tokens)
    ?? note('usage.input_tokens_details.cache_write_tokens', inputDetails.cache_write_tokens)
    ?? note('usage.cache_creation_input_tokens', usage.cache_creation_input_tokens)
    ?? note('usage.prompt_tokens_details.cache_creation_input_tokens', promptDetails.cache_creation_input_tokens);
  const miss = note('usage.prompt_cache_miss_tokens', usage.prompt_cache_miss_tokens);

  if (usage.cache_creation && typeof usage.cache_creation === 'object') {
    if (typeof usage.cache_creation.ephemeral_5m_input_tokens === 'number') {
      found.push('usage.cache_creation.ephemeral_5m_input_tokens');
    }
    if (typeof usage.cache_creation.ephemeral_1h_input_tokens === 'number') {
      found.push('usage.cache_creation.ephemeral_1h_input_tokens');
    }
  }
  return { fields: [...new Set(found)], read, write, miss };
}

async function callOnce(endpoint, headers, body) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // The body may contain the echoed prompt or account detail. Read the
    // status only; the body is never read, printed, or stored.
    return { ok: false, status: response.status };
  }
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, status: response.status, parseFailed: true };
  }
  return { ok: true, status: response.status, usage: parsed?.usage };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { surface, envelope, model, out } = args;
  const baseUrl = args['base-url'];
  const keyEnv = args['key-env'];

  if (!surface || !envelope || !baseUrl || !model || !keyEnv) {
    fail('required: --surface --envelope --base-url --model --key-env (see the header of this file)');
  }
  if (!ENVELOPES.includes(envelope)) fail(`--envelope must be one of ${ENVELOPES.join(', ')}`);

  const apiKey = process.env[keyEnv];
  if (!apiKey) fail(`environment variable ${keyEnv} is empty; export the credential before running`);

  const endpoint = endpointFor(envelope, baseUrl);
  const headers = headersFor(envelope, apiKey);
  const body = buildRequest(envelope, model);

  // Two identical calls. The first is expected to write the cache entry; the
  // second is the one whose read counter is the evidence.
  const first = await callOnce(endpoint, headers, body);
  const second = first.ok ? await callOnce(endpoint, headers, body) : { ok: false, status: 0 };

  const firstFields = recognizedCacheFields(first.usage);
  const secondFields = recognizedCacheFields(second.usage);
  const passed = first.ok && second.ok && secondFields.fields.length > 0;

  const record = {
    format: 'llm-client:cache-live-probe',
    version: 1,
    surface,
    envelope,
    endpointClass: endpointClass(baseUrl),
    // Date only. A time would narrow a run to a person's working session.
    date: new Date().toISOString().slice(0, 10),
    calls: [
      {
        status: first.status,
        recognizedFields: firstFields.fields,
        readBucket: tokenBucket(firstFields.read),
        writeBucket: tokenBucket(firstFields.write),
        missBucket: tokenBucket(firstFields.miss),
      },
      {
        status: second.status,
        recognizedFields: secondFields.fields,
        readBucket: tokenBucket(secondFields.read),
        writeBucket: tokenBucket(secondFields.write),
        missBucket: tokenBucket(secondFields.miss),
      },
    ],
    result: passed ? 'pass' : 'fail',
  };

  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  process.stdout.write(serialized);

  if (out) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(out, serialized, 'utf8');
    process.stderr.write(`probe-cache-live: evidence written to ${out}\n`);
  }

  process.stderr.write(
    passed
      ? 'probe-cache-live: PASS — update the fixture `verification` field and the '
        + 'docs/cache-observability.md table in the same change, quoting this record.\n'
      : 'probe-cache-live: FAIL — record this result as-is. Do not relabel the '
        + 'surface as live-verified.\n',
  );
  process.exit(passed ? 0 : 1);
}

main().catch(() => {
  // An exception can carry a URL or response fragment. Report the class only.
  fail('probe failed before it could produce a record');
});
