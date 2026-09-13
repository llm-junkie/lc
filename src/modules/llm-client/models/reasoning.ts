type ReasoningCapabilities = {
  /** OpenAI-compatible model IDs are the only reliable capability signal
   * when a cloud provider omits allowed_options from /models. */
  id?: string;
  /** LM Studio native REST uses `key` for the same identifier. */
  key?: string;
  capabilities?: { reasoning?: boolean | Record<string, unknown> } | null;
};

type OpenAIReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

function allowedReasoningOptions(
  model: ReasoningCapabilities | undefined,
): string[] | undefined {
  const reasoning = model?.capabilities?.reasoning;
  if (!reasoning || typeof reasoning !== 'object') return undefined;
  const options = reasoning.allowed_options;
  return Array.isArray(options)
    ? options.filter((option): option is string => typeof option === 'string')
    : undefined;
}

/**
 * Official OpenAI model pages do not expose `allowed_options` in the
 * `/models` response. Keep a small fallback table for the GPT-5 families
 * whose documented effort ranges differ, while leaving unrelated and local
 * model IDs untouched.
 *
 * Sources:
 * - GPT-5.6 model guidance: max, xhigh, high, medium, low
 * - GPT-5.4 / GPT-5.4 mini model pages: xhigh, high, medium, low
 * - Earlier GPT-5 families currently expose high or lower (no max)
 */
function documentedOpenAIReasoningOptions(model: ReasoningCapabilities | undefined): readonly OpenAIReasoningEffort[] | undefined {
  const rawId = model?.id ?? model?.key;
  if (!rawId) return undefined;
  const modelId = rawId.toLowerCase().split('/').pop()?.split(':')[0] ?? '';

  if (/^gpt-5\.6(?:-|$)/.test(modelId)) {
    return ['max', 'xhigh', 'high', 'medium', 'low'];
  }
  if (/^gpt-5\.(?:2|3|4|5)(?:-|$)/.test(modelId)) {
    return ['xhigh', 'high', 'medium', 'low'];
  }
  if (/^gpt-5(?:-|$)/.test(modelId) || /^gpt-5\.1(?:-|$)/.test(modelId)) {
    return ['high', 'medium', 'low'];
  }
  return undefined;
}

function pickAllowed<T extends string>(
  model: ReasoningCapabilities | undefined,
  priority: readonly T[],
): T | undefined {
  const allowed = allowedReasoningOptions(model);
  if (!allowed || allowed.length === 0) return undefined;
  const allowedSet = new Set(allowed);
  return priority.find((candidate) => allowedSet.has(candidate));
}

/** Resolve the native LM Studio reasoning value from model capabilities. */
export function resolveReasoningSetting(
  model: ReasoningCapabilities | undefined,
  preferred: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
): 'off' | 'on' | 'low' | 'medium' | 'high' | undefined {
  const native: 'off' | 'on' | 'low' | 'medium' | 'high' =
    preferred === 'none' ? 'off' :
    preferred === 'xhigh' ? 'high' :
    preferred === 'max' ? 'on' :
    preferred;
  const allowed = allowedReasoningOptions(model);
  if (!allowed || allowed.length === 0) return native;
  return pickAllowed(model, [native, 'medium', 'low', 'high', 'on', 'off']);
}

/** Resolve the OpenAI-compatible reasoning effort from model capabilities. */
export function resolveReasoningEffortOpenAI(
  model: ReasoningCapabilities | undefined,
  preferred: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
): OpenAIReasoningEffort | undefined {
  if (preferred === 'none') return undefined;
  const start: OpenAIReasoningEffort = preferred;
  const allowed = allowedReasoningOptions(model);
  if (allowed && allowed.length > 0) {
    const allowedSet = new Set(allowed);
    if (allowedSet.has(start)) return start;
    return pickAllowed(model, ['max', 'xhigh', 'high', 'medium', 'low'] as const);
  }

  // Cloud `/models` endpoints commonly omit LM Studio's capability object.
  // Use the official model-family table when the model ID is known; retain
  // the old passthrough for unknown/local-compatible IDs.
  const documented = documentedOpenAIReasoningOptions(model);
  if (!documented) return start;
  if (documented.includes(start)) return start;
  return documented[0];
}
