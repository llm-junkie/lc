import { z } from 'zod';
import providerContractRegistrySource from './provider-contracts.v1.json' with { type: 'json' };

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const shortText = z.string().min(1).max(240);
const wirePath = z.string().min(1).max(200);
const sourceId = z.string().regex(/^[a-z0-9][a-z0-9.-]*$/);
const contractId = z.string().regex(/^[a-z0-9][a-z0-9.-]*$/);
const modelId = z.string().min(1).max(240).refine(
  (value) => ![...value].some((character) => '*?[]{}()'.includes(character)),
  'model IDs must be exact; glob and regex metacharacters are forbidden',
);

const sourceSchema = z.object({
  id: sourceId,
  kind: z.enum(['official-doc', 'sanitized-fixture', 'upstream-metadata-schema']),
  title: shortText,
  url: z.string().url(),
  verified_at: date,
}).strict();

const controlSchema = z.object({
  semantic: z.enum(['effort', 'mode', 'budget', 'retention', 'carrier-return', 'summary']),
  path: wirePath,
  handling: z.enum(['passthrough', 'capability-driven', 'constant', 'server-default', 'unsupported', 'unknown']),
  documented_values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(32).optional(),
  constant: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]).optional(),
  note: shortText.optional(),
}).strict().superRefine((control, context) => {
  if (control.handling === 'constant' && control.constant === undefined) {
    context.addIssue({ code: 'custom', message: 'constant handling requires a constant value' });
  }
  if (control.handling !== 'constant' && control.constant !== undefined) {
    context.addIssue({ code: 'custom', message: 'constant is allowed only with constant handling' });
  }
});

const historySchema = z.object({
  archive: z.literal('all-returned'),
  replay: z.enum([
    'all-prior',
    'tool-request-all-prior',
    'same-turn',
    'provider-output-items',
    'provider-filtered',
    'remote-handle',
    'none',
    'unknown',
  ]),
  tool_history_independent: z.literal(true),
  provider_filter: shortText.optional(),
}).strict();

const carrierSchema = z.object({
  kind: z.enum(['plaintext', 'summary', 'encrypted', 'signed-plaintext', 'redacted', 'remote-handle', 'unknown']),
  response_paths: z.array(wirePath).max(16),
  companion_paths: z.array(wirePath).max(16).optional(),
  stream_events: z.array(shortText).max(24),
  replay: z.enum(['exact', 'plaintext', 'provider-managed', 'none', 'unknown']),
  meter: z.enum(['local-text', 'display-only', 'provider-reported-bound', 'provider-reported-input', 'unknown']),
  note: shortText.optional(),
}).strict();

const streamingSchema = z.object({
  delta_mode: z.enum(['append', 'cumulative', 'mixed', 'unknown', 'not-documented']),
  live_meter: z.enum(['plaintext-only', 'unknown-until-terminal', 'provider-authoritative', 'not-supported']),
  terminal_reconciliation: z.literal('replace-transient'),
}).strict();

const usageSchema = z.object({
  input_tokens: z.array(wirePath).max(12),
  output_tokens: z.array(wirePath).max(12),
  reasoning_tokens: z.array(wirePath).max(12),
  reasoning_relation: z.enum([
    'subset-of-output',
    'separate-from-output',
    'inclusive-undifferentiated',
    'not-reported',
    'unknown',
  ]),
  missing_reasoning: z.literal('unknown'),
}).strict();

const modelOverrideSchema = z.object({
  id: modelId,
  capabilities: z.object({ vision: z.boolean().optional(), tools: z.boolean().optional() }).strict().optional(),
  reasoning: z.enum(['always', 'optional', 'none', 'unknown']),
  controls: z.array(controlSchema).max(12).optional(),
  history: historySchema.optional(),
  note: shortText.optional(),
}).strict();

const contractSchema = z.object({
  id: contractId,
  provider_id: contractId,
  product: shortText,
  additional_products: z.array(shortText).min(1).max(8).optional(),
  protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic-messages', 'lmstudio-native-chat', 'gemini-interactions']),
  status: z.enum(['verified', 'partially-verified']),
  verified_at: date,
  match: z.object({
    origins: z.array(z.string().url()).min(1).max(12),
    base_path_prefixes: z.array(z.string().regex(/^\//)).min(1).max(12),
    path_match: z.enum(['prefix', 'exact']).optional(),
  }).strict(),
  request_path: z.string().regex(/^\//),
  model_policy: z.enum(['surface-default', 'exact-registration']),
  controls: z.array(controlSchema).max(16),
  history: historySchema,
  carriers: z.array(carrierSchema).min(1).max(16),
  streaming: streamingSchema,
  usage: usageSchema,
  models: z.array(modelOverrideSchema).max(256).optional(),
  source_ids: z.array(sourceId).min(1).max(24),
  note: shortText.optional(),
}).strict().superRefine((contract, context) => {
  const products = new Set([contract.product]);
  for (const product of contract.additional_products ?? []) {
    if (products.has(product)) {
      context.addIssue({ code: 'custom', message: `duplicate product name: ${product}` });
    }
    products.add(product);
  }

  const modelIds = new Set<string>();
  for (const model of contract.models ?? []) {
    if (modelIds.has(model.id)) {
      context.addIssue({ code: 'custom', message: `duplicate model ID: ${model.id}` });
    }
    modelIds.add(model.id);
  }
  if (contract.model_policy === 'exact-registration' && modelIds.size === 0) {
    context.addIssue({ code: 'custom', message: 'exact-registration requires at least one model entry' });
  }
  for (const origin of contract.match.origins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      context.addIssue({ code: 'custom', message: `match origin must be a canonical URL origin: ${origin}` });
    }
  }
});

export const providerContractRegistrySchema = z.object({
  schema_version: z.literal(1),
  registry_id: z.literal('lc-provider-contracts'),
  updated_at: date,
  invariants: z.object({
    retain_all_returned_reasoning: z.literal(true),
    tool_history_can_remove_reasoning: z.literal(false),
    missing_reasoning_tokens: z.literal('unknown'),
    effort_value_handling: z.literal('passthrough'),
    provider_selection: z.literal('exact-origin-path-protocol'),
    unmatched_provider: z.literal('protocol-fallback-unknown-semantics'),
    unregistered_exact_model: z.literal('surface-facts-only'),
  }).strict(),
  external_metadata: z.object({
    models_dev: z.object({
      repository: z.literal('https://github.com/anomalyco/models.dev'),
      reviewed_commit: z.string().regex(/^[0-9a-f]{40}$/),
      reviewed_at: date,
      generated_artifacts: z.array(z.string().url()).min(1).max(8),
      use_for: z.array(shortText).min(1).max(16),
      not_authoritative_for: z.array(shortText).min(1).max(16),
    }).strict(),
  }).strict(),
  sources: z.array(sourceSchema).min(1).max(256),
  contracts: z.array(contractSchema).min(1).max(256),
}).strict().superRefine((registry, context) => {
  const sources = new Set<string>();
  for (const source of registry.sources) {
    if (sources.has(source.id)) {
      context.addIssue({ code: 'custom', message: `duplicate source ID: ${source.id}` });
    }
    sources.add(source.id);
  }

  const contracts = new Set<string>();
  const matchKeys = new Map<string, string>();
  for (const contract of registry.contracts) {
    if (contracts.has(contract.id)) {
      context.addIssue({ code: 'custom', message: `duplicate contract ID: ${contract.id}` });
    }
    contracts.add(contract.id);
    for (const id of contract.source_ids) {
      if (!sources.has(id)) {
        context.addIssue({ code: 'custom', message: `contract ${contract.id} references missing source ${id}` });
      }
    }
    for (const origin of contract.match.origins) {
      for (const prefix of contract.match.base_path_prefixes) {
        const key = `${contract.protocol}\u0000${origin}\u0000${prefix}`;
        const previous = matchKeys.get(key);
        if (previous) {
          context.addIssue({
            code: 'custom',
            message: `contracts ${previous} and ${contract.id} have the same protocol/origin/path match`,
          });
        } else {
          matchKeys.set(key, contract.id);
        }
      }
    }
  }
});

export type ProviderContractRegistry = z.infer<typeof providerContractRegistrySchema>;
export type ProviderContract = ProviderContractRegistry['contracts'][number];
export type ProviderModelContract = NonNullable<ProviderContract['models']>[number];

export interface ProviderContractQuery {
  baseUrl: string;
  protocol: ProviderContract['protocol'];
  modelId?: string;
}

export interface ResolvedProviderContract {
  contract: ProviderContract;
  model?: ProviderModelContract;
  /**
   * `unregistered` is deliberately distinct from a missing provider match:
   * the wire surface is verified, but model-specific facts are not.
   */
  modelStatus: 'surface-default' | 'exact' | 'unregistered';
}

export type ProviderContractControl = ProviderContract['controls'][number];
export type ProviderContractHistory = ProviderContract['history'];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function parseProviderContractRegistry(value: unknown): ProviderContractRegistry {
  return deepFreeze(providerContractRegistrySchema.parse(value));
}

const bundledProviderContractRegistry = parseProviderContractRegistry(providerContractRegistrySource);
const bundledProviderContractRegistryPromise = Promise.resolve(bundledProviderContractRegistry);

/** Return the validated, immutable registry embedded in LC's application bundle. */
export function getProviderContractRegistry(): ProviderContractRegistry {
  return bundledProviderContractRegistry;
}

function pathMatches(pathname: string, prefix: string): boolean {
  if (prefix === '/') return true;
  const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return pathname === normalized || pathname.startsWith(`${normalized}/`);
}

/**
 * Resolve only exact, declared provider boundaries. A model ID never selects a
 * provider and is never matched by prefix, substring, case folding, or regex.
 */
export function resolveProviderContract(
  registry: ProviderContractRegistry,
  query: ProviderContractQuery,
): ResolvedProviderContract | undefined {
  let url: URL;
  try {
    url = new URL(query.baseUrl);
  } catch {
    return undefined;
  }

  const candidates = registry.contracts.flatMap((contract) => {
    if (contract.protocol !== query.protocol || !contract.match.origins.includes(url.origin)) return [];
    const lengths = contract.match.base_path_prefixes
      .filter((prefix) => contract.match.path_match === 'exact'
        ? (url.pathname.replace(/\/+$/, '') || '/') === (prefix.replace(/\/+$/, '') || '/')
        : pathMatches(url.pathname, prefix))
      .map((prefix) => prefix.length);
    return lengths.length > 0 ? [{ contract, specificity: Math.max(...lengths) }] : [];
  }).sort((left, right) => right.specificity - left.specificity);

  if (candidates.length === 0) return undefined;
  if (candidates.length > 1 && candidates[0].specificity === candidates[1].specificity) {
    throw new Error(
      `ambiguous provider contract for ${url.origin}${url.pathname} and ${query.protocol}: `
      + `${candidates[0].contract.id}, ${candidates[1].contract.id}`,
    );
  }

  const contract = candidates[0].contract;
  const model = query.modelId === undefined
    ? undefined
    : contract.models?.find((candidate) => candidate.id === query.modelId);
  if (contract.model_policy === 'surface-default') {
    return { contract, ...(model ? { model } : {}), modelStatus: 'surface-default' };
  }
  return model
    ? { contract, model, modelStatus: 'exact' }
    : { contract, modelStatus: 'unregistered' };
}

/** Resolve against the validated registry already embedded in the bundle. */
export function resolveBundledProviderContract(
  query: ProviderContractQuery,
): ResolvedProviderContract | undefined {
  return resolveProviderContract(bundledProviderContractRegistry, query);
}

/** Map LC's profile vocabulary to the registry's wire-protocol vocabulary. */
export function providerContractProtocol(
  apiVariant?: string,
  apiStyle?: 'chat' | 'responses',
): ProviderContract['protocol'] {
  if (apiVariant === 'anthropic') return 'anthropic-messages';
  if (apiVariant === 'gemini') return 'gemini-interactions';
  if (apiVariant === 'lm-studio') return 'lmstudio-native-chat';
  return apiStyle === 'responses' ? 'openai-responses' : 'openai-chat';
}

/**
 * Surface controls remain valid for an unregistered model. Exact model
 * controls replace controls at the same semantic wire path and leave the
 * remaining surface controls intact.
 */
export function effectiveProviderControls(
  resolved: ResolvedProviderContract,
): readonly ProviderContractControl[] {
  if (!resolved.model?.controls) return resolved.contract.controls;
  const overrides = new Map(
    resolved.model.controls.map((control) => [`${control.semantic}\u0000${control.path}`, control]),
  );
  const merged = resolved.contract.controls.map((control) => (
    overrides.get(`${control.semantic}\u0000${control.path}`) ?? control
  ));
  const inheritedKeys = new Set(
    resolved.contract.controls.map((control) => `${control.semantic}\u0000${control.path}`),
  );
  for (const control of resolved.model.controls) {
    if (!inheritedKeys.has(`${control.semantic}\u0000${control.path}`)) merged.push(control);
  }
  return merged;
}

/** Model history overrides are usable only after an exact model match. */
export function effectiveProviderHistory(
  resolved: ResolvedProviderContract,
): ProviderContractHistory {
  return resolved.model?.history ?? resolved.contract.history;
}

function setWireValue(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const child = cursor[segment];
    if (!child || typeof child !== 'object' || Array.isArray(child)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
}

/**
 * Apply only controls whose value is completely described by the contract.
 * Capability-driven budgets/retention remain absent until model metadata
 * supplies the capability; LC never invents those values.
 */
export function applyProviderContractControls(
  target: Record<string, unknown>,
  resolved: ResolvedProviderContract,
  options: { reasoningEnabled: boolean; reasoningEffort?: string },
): void {
  const controls = effectiveProviderControls(resolved);
  const hasModeControl = controls.some((control) => control.semantic === 'mode'
    && control.handling !== 'unsupported');
  for (const control of controls) {
    if (control.handling === 'constant') {
      setWireValue(target, control.path, structuredClone(control.constant));
      continue;
    }
    if (control.semantic === 'effort' && control.handling === 'passthrough') {
      if (options.reasoningEnabled && options.reasoningEffort
        && !(options.reasoningEffort === 'none' && hasModeControl)) {
        setWireValue(target, control.path, options.reasoningEffort);
      }
      continue;
    }
    if (control.semantic === 'mode' && control.handling === 'capability-driven') {
      const enabled = options.reasoningEnabled && options.reasoningEffort !== 'none';
      const values = control.documented_values ?? [];
      if (values.length === 0) continue;
      const value = enabled
        ? (values.includes('adaptive') ? 'adaptive' : 'enabled')
        : (values.includes('disabled') ? 'disabled' : undefined);
      if (value !== undefined) setWireValue(target, control.path, value);
    }
  }
}

/**
 * Compatibility API for asynchronous consumers. The registry is already
 * embedded, validated, and resident in memory; this performs no fetch.
 */
export function loadProviderContractRegistry(): Promise<ProviderContractRegistry> {
  return bundledProviderContractRegistryPromise;
}
