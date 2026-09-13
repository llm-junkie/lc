/**
 * Shared preset definitions for the generation parameters panel.
 * Kept in a separate module so both the panel (for display) and
 * the chat view (for tagging the active preset on each reply)
 * can import them from one place.
 */
import type { GenerationParams, GenerationParamsSnapshot } from '../types';

export interface Preset {
  name: string;
  systemPrompt: string;
  params: Partial<GenerationParams>;
}

/**
 * Helper for declaring presets without repeating the long
 * `*_enabled: true` list on every row. Any field whose name
 * doesn't end in `_enabled` is treated as a numeric value
 * (e.g. `temperature`, `top_k`, `reasoning_effort`); fields
 * ending in `_enabled` are the boolean toggle flags.
 */
function preset(
  name: string,
  systemPrompt: string,
  values: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    max_tokens?: number;
    repeat_penalty?: number;
    reasoning_effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    enabled?: {
      temperature?: boolean;
      top_p?: boolean;
      top_k?: boolean;
      max_tokens?: boolean;
      repeat_penalty?: boolean;
      reasoning_effort?: boolean;
    };
  },
): Preset {
  const enabled = values.enabled ?? {};
  return {
    name,
    systemPrompt,
    params: {
      ...(values.temperature !== undefined ? { temperature: values.temperature } : {}),
      ...(values.top_p !== undefined ? { top_p: values.top_p } : {}),
      ...(values.top_k !== undefined ? { top_k: values.top_k } : {}),
      ...(values.max_tokens !== undefined ? { max_tokens: values.max_tokens } : {}),
      ...(values.repeat_penalty !== undefined ? { repeat_penalty: values.repeat_penalty } : {}),
      ...(values.reasoning_effort !== undefined ? { reasoning_effort: values.reasoning_effort } : {}),
      temperature_enabled: enabled.temperature ?? false,
      top_p_enabled: enabled.top_p ?? false,
      top_k_enabled: enabled.top_k ?? false,
      max_tokens_enabled: enabled.max_tokens ?? false,
      repeat_penalty_enabled: enabled.repeat_penalty ?? false,
      reasoning_enabled: enabled.reasoning_effort ?? false,
    },
  };
}

export const PRESETS: Preset[] = [
  preset('Assistant', 'Be helpful, clear, and practical, adapting the level of detail to the request.', {
    temperature: 0.4, reasoning_effort: 'medium',
    enabled: { temperature: true, reasoning_effort: true },
  }),
  preset('Balanced', 'Balance accuracy, clarity, and useful detail without overexplaining.', {
    temperature: 0.7, reasoning_effort: 'medium',
    enabled: { temperature: true, reasoning_effort: true },
  }),
  preset('Brainstorm', 'Generate varied possibilities freely, including unconventional but relevant ideas.', {
    temperature: 0.9, reasoning_effort: 'low',
    enabled: { temperature: true, reasoning_effort: true },
  }),
  preset('Code', 'Produce correct, maintainable code and explain only what is necessary.', {
    temperature: 0.2, reasoning_effort: 'high',
    enabled: { temperature: true, reasoning_effort: true },
  }),
  preset('Concise', 'Answer directly and briefly, omitting nonessential detail.', {
    temperature: 0.1, reasoning_effort: 'low',
    enabled: { temperature: true, reasoning_effort: true },
  }),
  preset('Creative', 'Favor imaginative, distinctive responses while staying coherent and relevant.', {
    temperature: 1.0, reasoning_effort: 'low',
    enabled: { temperature: true, reasoning_effort: true },
  }),
  preset('Precise', 'Prioritize accuracy, explicit assumptions, and unambiguous wording.', {
    temperature: 0.1, reasoning_effort: 'high',
    enabled: { temperature: true, reasoning_effort: true },
  }),
  preset('Writer', 'Write polished, natural prose with strong structure and consistent tone.', {
    temperature: 0.5, reasoning_effort: 'medium',
    enabled: { temperature: true, reasoning_effort: true },
  }),
];

/** Capture only the generation controls shown in an assistant reply footer. */
export function snapshotGenerationParams(params: GenerationParams, apiVariant?: string): GenerationParamsSnapshot {
  return {
    temperature: params.temperature,
    temperature_enabled: apiVariant !== 'gemini' && params.temperature_enabled === true,
    top_p: params.top_p,
    top_p_enabled: apiVariant !== 'gemini' && params.top_p_enabled === true,
    top_k: params.top_k,
    top_k_enabled: apiVariant !== 'gemini' && params.top_k_enabled === true,
    max_tokens: params.max_tokens,
    max_tokens_enabled: params.max_tokens_enabled === true,
    repeat_penalty: params.repeat_penalty,
    repeat_penalty_enabled: apiVariant !== 'gemini' && params.repeat_penalty_enabled === true,
    reasoning_effort: params.reasoning_effort,
    reasoning_enabled: params.reasoning_enabled === true,
  };
}

/**
 * True when every `*_enabled` flag is off — nothing is sent, so the server
 * applies its own defaults.
 *
 * Deliberately blind to the numeric values: in this mode none of them reach
 * the server, so a user who nudges temperature and then switches every
 * toggle off is squarely back on server defaults. Comparing the numbers
 * against `DEFAULT_PARAMS` here is what once made the params panel's chip
 * disagree with the composer button and the reply footnote.
 *
 * The single definition of "Server default" — everything that needs to
 * answer that question must call this.
 */
export function isServerDefaultParams(params: GenerationParams): boolean {
  return !(
    params.temperature_enabled ||
    params.top_p_enabled ||
    params.top_k_enabled ||
    params.max_tokens_enabled ||
    params.repeat_penalty_enabled ||
    params.reasoning_enabled
  );
}

/**
 * Detect which preset (if any) the given params match. Returns the
 * preset name for a known preset, or "Server default" when no
 * generation flags are enabled (the params are being passed as
 * `undefined` to the server, so the server uses its own defaults).
 */
export function detectPresetName(params: GenerationParams): string {
  if (isServerDefaultParams(params)) return 'Server default';
  return resolveParameterPreset(params)?.name ?? 'Custom';
}

/** Resolve the active built-in preset from its generation controls. */
export function resolveParameterPreset(
  params: GenerationParams,
): Preset | undefined {
  if (isServerDefaultParams(params)) return undefined;
  return PRESETS.find((candidate) => paramsMatchPreset(params, candidate.params));
}

/** The two fields `presetLabel` reads. Both `GenerationParams` (live
 *  conversation state) and `GenerationParamsSnapshot` (frozen onto a reply)
 *  satisfy it, so one helper serves the composer and the reply chip. */
type ReasoningSource = Pick<
  GenerationParams,
  'reasoning_effort' | 'reasoning_enabled'
>;

/**
 * Display label for an active preset: `"Custom · xhigh"`.
 *
 * "Server default" stands alone — no generation flags are enabled, so no
 * effort is being sent and there is nothing to report. Every other preset
 * carries its reasoning effort, and `-` marks reasoning being off.
 *
 * Shared by the composer's preset button and an assistant reply's params
 * chip so the two always read the same for the same params.
 */
export function presetLabel(
  presetName: string,
  params: ReasoningSource | undefined,
): string {
  if (presetName === 'Server default') return presetName;
  const effort = params?.reasoning_enabled ? (params.reasoning_effort ?? '-') : '-';
  return `${presetName} · ${effort}`;
}

function paramsMatchPreset(
  params: GenerationParams,
  preset: Partial<GenerationParams>,
): boolean {
  for (const [key, value] of Object.entries(preset)) {
    if (params[key as keyof GenerationParams] !== value) return false;
  }
  return true;
}
