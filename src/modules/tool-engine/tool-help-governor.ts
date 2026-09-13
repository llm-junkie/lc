import type { ToolCallRecord, ToolResultEnvelope } from './types';
import {
  buildToolHelpData,
  TOOL_HELP_MESSAGES,
  toolHelpDuplicateKey,
  type ToolHelpData,
  type ToolHelpInput,
} from './tool-help.ts';

export const TOOL_HELP_TOTAL_LIMIT = 6;
export const TOOL_HELP_GUIDANCE_LIMIT = 3;
export const TOOL_HELP_LOOKUP_LIMIT = 2;

export interface ToolHelpGovernorState {
  total: number;
  guidance: number;
  unresolved: number;
  seen: Set<string>;
}

export interface HelpGovernableCall {
  call: ToolCallRecord;
  parsed?: unknown;
  error?: unknown;
}

export function createToolHelpGovernorState(): ToolHelpGovernorState {
  return { total: 0, guidance: 0, unresolved: 0, seen: new Set<string>() };
}

function envelope(data: ToolHelpData): ToolResultEnvelope<ToolHelpData> {
  return { status: 'ok', data, issues: [], warnings: [] };
}

function limitResult(
  input: ToolHelpInput,
  message: string,
  retained?: Pick<ToolHelpData, 'resolved_tool' | 'correction' | 'suggestions'>,
): ToolResultEnvelope<ToolHelpData> {
  return envelope({
    mode: 'limit_reached',
    requested_tool: input.tool,
    ...(retained?.resolved_tool ? { resolved_tool: retained.resolved_tool } : {}),
    ...(retained?.correction ? { correction: retained.correction } : {}),
    ...(retained?.suggestions?.length ? { suggestions: retained.suggestions.slice(0, 3) } : {}),
    message,
  });
}

function normalizedInput(parsed: unknown): ToolHelpInput | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const value = parsed as Record<string, unknown>;
  if (typeof value.tool !== 'string') return undefined;
  return {
    tool: value.tool.trim(),
    ...(typeof value.query === 'string' && value.query.trim()
      ? { query: value.query.trim() }
      : {}),
  };
}

/**
 * Decide every help result in batch-index order before concurrent execution.
 * Invalid help calls consume the total limit and keep their validation issue.
 */
export function governToolHelpCalls(
  calls: readonly HelpGovernableCall[],
  exposedNames: ReadonlySet<string>,
  state: ToolHelpGovernorState,
): ReadonlyMap<ToolCallRecord, ToolResultEnvelope<ToolHelpData>> {
  const results = new Map<ToolCallRecord, ToolResultEnvelope<ToolHelpData>>();
  if (!exposedNames.has('lc_tool_help')) return results;

  for (const entry of calls) {
    if (entry.call.name !== 'lc_tool_help') continue;

    const input = normalizedInput(entry.parsed) ?? { tool: '' };
    if (state.total >= TOOL_HELP_TOTAL_LIMIT) {
      results.set(entry.call, limitResult(input, TOOL_HELP_MESSAGES.totalLimit));
      continue;
    }
    state.total = Math.min(TOOL_HELP_TOTAL_LIMIT, state.total + 1);

    if (entry.error || !entry.parsed) continue;

    const key = toolHelpDuplicateKey(input, exposedNames);
    if (state.seen.has(key)) {
      results.set(entry.call, envelope({
        mode: 'already_returned',
        requested_tool: input.tool,
        message: TOOL_HELP_MESSAGES.duplicate,
      }));
      continue;
    }

    const data = buildToolHelpData(input, exposedNames);
    // The mode is the authoritative accounting signal. Payload fields remain
    // bounded output details and do not define the counter category.
    const returnsGuidance = data.mode === 'basic' || data.mode === 'matched';
    if (returnsGuidance) {
      if (state.guidance >= TOOL_HELP_GUIDANCE_LIMIT) {
        results.set(entry.call, limitResult(input, TOOL_HELP_MESSAGES.guidanceLimit, data));
        continue;
      }
      state.guidance = Math.min(TOOL_HELP_GUIDANCE_LIMIT, state.guidance + 1);
    } else {
      if (state.unresolved >= TOOL_HELP_LOOKUP_LIMIT) {
        results.set(entry.call, limitResult(input, TOOL_HELP_MESSAGES.lookupLimit, data));
        continue;
      }
      state.unresolved = Math.min(TOOL_HELP_LOOKUP_LIMIT, state.unresolved + 1);
    }

    state.seen.add(key);
    results.set(entry.call, envelope(data));
  }

  return results;
}
