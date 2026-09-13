/**
 * Prompt-prefix diagnostics.
 *
 * Provider cache counters say what the *provider* reported. This module
 * explains only what *LC* changed between two comparable requests, and it does
 * so without retaining any request content
 * (docs/cache-observability.md §5).
 *
 * Privacy design:
 *   - A fresh HMAC key is generated per session with `crypto.getRandomValues`
 *     and imported as **non-extractable**, so it cannot be serialized even by
 *     mistake. It is never persisted or exported.
 *   - Only keyed digests and byte counts are retained, in memory, for the
 *     lifetime of the session. An unkeyed stable content hash is never used,
 *     because that would be a durable fingerprint of user content.
 *   - Nothing this module stores leaves it except a bounded conclusion enum
 *     and bounded qualifiers.
 *
 * Behavioral design:
 *   - The comparison runs on the FINAL provider-shaped body, after Tool
 *     History projection and request assembly, immediately before send.
 *   - It is strictly read-only: it never mutates or reorders the request, and
 *     it never injects `cache_control`, `prompt_cache_breakpoint`,
 *     `prompt_cache_key`, `session_id`, `x-session-id`, routing controls, or
 *     retention controls — docs/README.md standing constraint 6.
 */

/* ------------------------------------------------------------------ */
/*  Bounded vocabulary                                                 */
/* ------------------------------------------------------------------ */

export const PREFIX_CONCLUSIONS = [
  'no-comparable-request',
  'provider-protocol-or-model-changed',
  'cache-relevant-options-changed',
  'tool-definitions-or-choice-changed',
  'system-or-skills-changed',
  'history-prefix-changed',
  'stable-prefix-active-suffix-changed',
  'stable-prefix',
] as const;
export type PrefixConclusion = (typeof PREFIX_CONCLUSIONS)[number];

/**
 * Separate from the conclusion: these describe provider/router behavior LC
 * cannot observe, never a claim about what LC did.
 */
export const PREFIX_QUALIFIERS = [
  /**
   * LC's reusable core prefix is stable, but the provider's own breakpoint
   * may still include the changing latest message. Rendered as "provider may
   * not reuse the stable prefix under the current breakpoint" — never as
   * "LC caused a cache miss".
   */
  'provider-breakpoint-may-exclude-suffix',
  /**
   * The request went through a router whose sticky route may have failed over
   * for reasons outside LC's request. The upstream provider is unknown and is
   * never inferred from model name, price, latency, or cache counters.
   */
  'router-upstream-unknown',
] as const;
export type PrefixQualifier = (typeof PREFIX_QUALIFIERS)[number];

/** Bounded conclusion for one request. This is the only thing that escapes. */
export interface PrefixDiagnostic {
  conclusion: PrefixConclusion;
  qualifiers: PrefixQualifier[];
}

/* ------------------------------------------------------------------ */
/*  Bounds                                                             */
/* ------------------------------------------------------------------ */

/** History blocks digested individually before the tail is folded together. */
export const MAX_HISTORY_BLOCKS = 1_024;
/** Comparison chains kept in memory. Oldest is evicted first. */
export const MAX_TRACKED_CHAINS = 16;
/** Bytes of each keyed digest retained (hex characters = 2x). */
const DIGEST_BYTES = 16;

/* ------------------------------------------------------------------ */
/*  Request description                                                */
/* ------------------------------------------------------------------ */

export interface RequestScope {
  conversationId: string;
  profileId: string;
  protocol: string;
  apiStyle: string;
  model: string;
}

/**
 * Cache-relevant segments of one provider-shaped request, as plain strings.
 * These are hashed immediately and never retained.
 */
export interface RequestSegments {
  /** Protocol, API style, and model. */
  providerIdentity: string;
  /** Cache-relevant reasoning/effort controls only. */
  options: string;
  /** Ordered tool definitions plus tool-choice controls. */
  tools: string;
  /** System instructions and resolved skills. */
  system: string;
  /** Projected historical blocks, in order. */
  history: string[];
  /** The active-turn suffix. */
  suffix: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stable(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value) ?? '';
}

/**
 * Domain separator for digest inputs. Not cosmetic — it is what makes a
 * concatenation unambiguous.
 *
 * Joining with nothing lets different inputs collide: `['ab', 'c']` and
 * `['a', 'bc']` produce the same string, so two genuinely different requests
 * would digest identically and a real prefix change would report as
 * `stable-prefix`. NUL is safe as the separator because every value joined
 * with it is either `stable()` output — `JSON.stringify` escapes a NUL in the
 * payload to the six characters `\u0000`, so a literal one cannot survive into
 * the string — or a hex digest, which is `[0-9a-f]` only.
 *
 * Always written as this escape, never as a literal NUL byte in the source: a
 * raw one makes the file read as binary to `git` and `grep` so it stops
 * diffing in review, and any editor or formatter that strips control
 * characters would silently change every digest, turning every comparison into
 * a spurious "changed" with no error to notice.
 */
const DIGEST_SEPARATOR = '\u0000';

/** Cache-relevant reasoning controls across the three request shapes. */
const OPTION_KEYS = [
  'reasoning', 'reasoning_effort', 'thinking', 'reasoning_split', 'output_config',
  'generation_config', 'response_format',
] as const;

/**
 * Split a final provider-shaped body into cache-relevant segments.
 *
 * The body is only read. Ordering is taken exactly as assembled, so a
 * reordering upstream shows up as a change rather than being normalized away.
 */
export function describeRequest(body: unknown, scope: RequestScope): RequestSegments {
  const request = isRecord(body) ? body : {};

  const options: Record<string, unknown> = {};
  for (const key of OPTION_KEYS) {
    if (request[key] !== undefined) options[key] = request[key];
  }

  const tools = stable({
    tools: request.tools,
    tool_choice: request.tool_choice,
    parallel_tool_calls: request.parallel_tool_calls,
  });

  // Responses uses `instructions`; Anthropic uses top-level `system`; Chat
  // Completions carries system/developer turns inside the message array.
  const timeline: unknown[] = Array.isArray(request.messages)
    ? request.messages
    : Array.isArray(request.input)
      ? request.input
      : [];

  const systemParts: string[] = [];
  if (request.instructions !== undefined) systemParts.push(stable(request.instructions));
  if (request.system !== undefined) systemParts.push(stable(request.system));
  if (request.system_instruction !== undefined) systemParts.push(stable(request.system_instruction));

  const conversation: unknown[] = [];
  for (const item of timeline) {
    const role = isRecord(item) ? item.role : undefined;
    if (role === 'system' || role === 'developer') {
      systemParts.push(stable(item));
      continue;
    }
    conversation.push(item);
  }

  // The active turn starts at the most recent user item — the same boundary
  // Tool History projection uses. Everything before it is historical.
  let boundary = -1;
  for (let i = conversation.length - 1; i >= 0; i--) {
    const item = conversation[i];
    if (isRecord(item) && (item.role === 'user' || item.type === 'user_input')) {
      boundary = i;
      break;
    }
  }
  const historyItems = boundary < 0 ? conversation : conversation.slice(0, boundary);
  const suffixItems = boundary < 0 ? [] : conversation.slice(boundary);

  return {
    providerIdentity: stable({
      protocol: scope.protocol,
      apiStyle: scope.apiStyle,
      model: scope.model || stable(request.model),
    }),
    options: stable(options),
    tools,
    system: systemParts.join(DIGEST_SEPARATOR),
    history: historyItems.map((item) => stable(item)),
    suffix: stable(suffixItems),
  };
}

/* ------------------------------------------------------------------ */
/*  Per-session keyed digests                                          */
/* ------------------------------------------------------------------ */

interface Hasher {
  digest(value: string): Promise<string>;
}

let sessionHasher: Promise<Hasher> | null = null;

async function createSessionHasher(): Promise<Hasher> {
  const subtle = globalThis.crypto?.subtle;
  const keyBytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(keyBytes);

  // `extractable: false` — the browser will refuse to export this key, so a
  // future code path cannot serialize it into a report or an archive.
  const key = await subtle.importKey(
    'raw',
    keyBytes as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  keyBytes.fill(0);

  const encoder = new TextEncoder();
  return {
    async digest(value: string): Promise<string> {
      const signature = await subtle.sign('HMAC', key, encoder.encode(value) as unknown as ArrayBuffer);
      const bytes = new Uint8Array(signature).subarray(0, DIGEST_BYTES);
      let out = '';
      for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
      return out;
    },
  };
}

/** Fresh random key per session. Tests may reset it to isolate chains. */
export function sessionPrefixHasher(): Promise<Hasher> {
  if (!sessionHasher) sessionHasher = createSessionHasher();
  return sessionHasher;
}

/* ------------------------------------------------------------------ */
/*  Comparison                                                         */
/* ------------------------------------------------------------------ */

interface ChainRecord {
  providerIdentity: string;
  options: string;
  tools: string;
  system: string;
  history: string[];
  suffix: string;
}

/**
 * In-memory only, bounded, and never serialized. A `Map` preserves insertion
 * order, which makes eviction a simple oldest-first delete.
 */
export class PrefixComparisonStore {
  private readonly chains = new Map<string, ChainRecord>();

  get(chainKey: string): ChainRecord | undefined {
    return this.chains.get(chainKey);
  }

  set(chainKey: string, record: ChainRecord): void {
    if (this.chains.has(chainKey)) this.chains.delete(chainKey);
    this.chains.set(chainKey, record);
    while (this.chains.size > MAX_TRACKED_CHAINS) {
      const oldest = this.chains.keys().next();
      if (oldest.done) break;
      this.chains.delete(oldest.value);
    }
  }

  clear(): void {
    this.chains.clear();
  }
}

const defaultStore = new PrefixComparisonStore();

/** Test seam. Never used by production code paths. */
export function resetPrefixDiagnostics(): void {
  defaultStore.clear();
  sessionHasher = null;
}

/**
 * `previous` is a prefix of `current` when every previous element matches
 * position-for-position. Appending new history is therefore NOT a break in the
 * earlier common prefix, while reordering, editing, or stubbing an earlier
 * block is — docs/cache-observability.md §5.
 */
export function isPrefixOf(previous: readonly string[], current: readonly string[]): boolean {
  if (previous.length > current.length) return false;
  for (let i = 0; i < previous.length; i++) {
    if (previous[i] !== current[i]) return false;
  }
  return true;
}

/** Fold the overflow tail so the retained digest list stays bounded. */
async function boundHistory(digests: string[], hasher: Hasher): Promise<string[]> {
  if (digests.length <= MAX_HISTORY_BLOCKS) return digests;
  const head = digests.slice(0, MAX_HISTORY_BLOCKS - 1);
  head.push(await hasher.digest(digests.slice(MAX_HISTORY_BLOCKS - 1).join(DIGEST_SEPARATOR)));
  return head;
}

export interface PrefixComparisonInput {
  segments: RequestSegments;
  scope: RequestScope;
  /** Set when the response will be attributed to a router rather than a provider. */
  viaRouter?: boolean;
}

/**
 * Compare this request against the previous one in the same conversation and
 * profile, then record it for the next comparison.
 *
 * Returns only a bounded conclusion. Digests stay inside `store`.
 */
export async function comparePrefix(
  input: PrefixComparisonInput,
  store: PrefixComparisonStore = defaultStore,
  hasherFactory: () => Promise<Hasher> = sessionPrefixHasher,
): Promise<PrefixDiagnostic> {
  const hasher = await hasherFactory();
  const { segments, scope } = input;

  // The chain is scoped to conversation + profile. A different chain means
  // there is nothing comparable, not that something changed.
  const chainKey = await hasher.digest(`${scope.conversationId}${DIGEST_SEPARATOR}${scope.profileId}`);

  const record: ChainRecord = {
    providerIdentity: await hasher.digest(segments.providerIdentity),
    options: await hasher.digest(segments.options),
    tools: await hasher.digest(segments.tools),
    system: await hasher.digest(segments.system),
    history: await boundHistory(
      await Promise.all(segments.history.map((block) => hasher.digest(block))),
      hasher,
    ),
    suffix: await hasher.digest(segments.suffix),
  };

  const previous = store.get(chainKey);
  store.set(chainKey, record);

  const qualifiers: PrefixQualifier[] = [];
  if (input.viaRouter) qualifiers.push('router-upstream-unknown');

  if (!previous) return { conclusion: 'no-comparable-request', qualifiers };

  // Ordered exactly as docs/cache-observability.md §5 lists them: the earliest
  // cache-relevant segment
  // that changed is the one reported, because everything after it is moot.
  if (previous.providerIdentity !== record.providerIdentity) {
    return { conclusion: 'provider-protocol-or-model-changed', qualifiers };
  }
  if (previous.options !== record.options) {
    return { conclusion: 'cache-relevant-options-changed', qualifiers };
  }
  if (previous.tools !== record.tools) {
    return { conclusion: 'tool-definitions-or-choice-changed', qualifiers };
  }
  if (previous.system !== record.system) {
    return { conclusion: 'system-or-skills-changed', qualifiers };
  }
  if (!isPrefixOf(previous.history, record.history)) {
    return { conclusion: 'history-prefix-changed', qualifiers };
  }

  if (previous.suffix !== record.suffix || previous.history.length !== record.history.length) {
    // The reusable core prefix held. The provider's own breakpoint may still
    // sit after the changed suffix, which is the provider's behavior to
    // report — not an LC-caused miss.
    qualifiers.push('provider-breakpoint-may-exclude-suffix');
    return { conclusion: 'stable-prefix-active-suffix-changed', qualifiers };
  }

  return { conclusion: 'stable-prefix', qualifiers };
}

/** Human-facing wording. Always attributes the claim to LC, never the provider. */
export function prefixConclusionLabel(conclusion: PrefixConclusion): string {
  switch (conclusion) {
    case 'no-comparable-request': return 'no comparable earlier request';
    case 'provider-protocol-or-model-changed': return 'provider, protocol, or model changed';
    case 'cache-relevant-options-changed': return 'cache-relevant options changed';
    case 'tool-definitions-or-choice-changed': return 'tool definitions or choice changed';
    case 'system-or-skills-changed': return 'system instructions or skills changed';
    case 'history-prefix-changed': return 'earlier history changed';
    case 'stable-prefix-active-suffix-changed': return 'stable core prefix; active suffix changed';
    case 'stable-prefix': return 'stable prefix';
  }
}

export function prefixQualifierLabel(qualifier: PrefixQualifier): string {
  switch (qualifier) {
    case 'provider-breakpoint-may-exclude-suffix':
      return 'provider may not reuse the stable prefix under the current breakpoint';
    case 'router-upstream-unknown':
      return 'routed request; upstream provider not identified';
  }
}
