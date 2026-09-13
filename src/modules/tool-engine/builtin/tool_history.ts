/**
 * lc_tool_history — retrieve archived tool call results from
 * previous conversation turns.
 *
 * Pure JS (no Rust round-trip). Reads from the conversation store.
 * When tool_history is enabled, completed turns' tool results are
 * replaced with stubs in context; this tool lets the model pull
 * specific past results on demand.
 *
 * Phase 5.8 improvements:
 * - UTF-8 byte length for caps (not JS string length)
 * - Bounded partial first result instead of zero when first exceeds cap
 * - Dedicated summary response type (no synthetic __summary__ entries)
 * - Structured error handling around store access
 */
import { z } from 'zod';
import type { ToolHandler } from '../types';
import type { JsonSchema } from '../../llm-client/types';
import { useConversations } from '../../../store/conversations.ts';
import type { Message, WhiteboardTurnReferences } from '../../../types';
import { truncateUtf8, utf8ByteLength } from '../utf8-budget.ts';
import {
  SEARCH_DEFAULT_MAX_RESULTS,
  SEARCH_MAX_QUERY_CHARACTERS,
  SEARCH_MAX_QUERY_TERMS,
  SEARCH_MAX_RESULTS,
  ToolHistorySearchInputError,
  parseSearchQuery,
  searchToolHistory,
  type ToolHistorySearchCandidate,
  type ToolHistorySearchOutput,
} from './tool-history-search.ts';

const schema = z.object({
  /** The id of the assistant message whose tool results to retrieve. */
  message_id: z.string().optional(),
  /** Filter to a specific tool name (e.g. 'lc_grep', 'lc_read_file'). */
  tool_name: z.string().optional(),
  /** A specific tool_call id to retrieve exactly one result. */
  tool_call_id: z.string().optional(),
  /** Lexical search over this conversation's archived calls. Mutually
   *  exclusive with tool_call_id; message_id and tool_name narrow its scope. */
  query: z.string().refine(
    (value) => Array.from(value).length <= SEARCH_MAX_QUERY_CHARACTERS,
    { message: `query accepts at most ${SEARCH_MAX_QUERY_CHARACTERS} characters. Shorten the query and retry.` },
  ).meta({ maxLength: SEARCH_MAX_QUERY_CHARACTERS }).optional(),
  /** Maximum search hits returned (search mode only). */
  max_results: z.number().int().min(1).max(
    SEARCH_MAX_RESULTS,
    `max_results must be at most ${SEARCH_MAX_RESULTS}. Use ${SEARCH_MAX_RESULTS} or a smaller result limit.`,
  ).default(SEARCH_DEFAULT_MAX_RESULTS).optional(),
  /** Maximum total bytes across all returned results (1–524288).
   *  Individual results are also capped at 262144 bytes head+tail. */
  max_result_bytes: z.number().int().min(1).max(
    524288,
    'max_result_bytes must be at most 524288. Use 524288 or a smaller byte limit.',
  ).default(65536).optional(),
});

export type ToolHistoryInput = z.infer<typeof schema>;

export interface ToolHistoryResultItem {
  tool_call_id: string;
  tool_name: string;
  arguments: string;
  output: string;
  output_truncated: boolean;
  is_error: boolean;
  duration_ms: number;
  created_at: number | null;
}

/** Summary entry for list mode (replaces synthetic __summary__ entries). */
export interface ToolHistorySummaryEntry {
  type: 'summary';
  message_id: string;
  tool_count: number;
  tools: string[];
}

export interface ToolHistoryOutput {
  message_id: string | null;
  /** Owning turn references for exact message/call retrieval only. */
  whiteboard_refs?: WhiteboardTurnReferences;
  /** Archived tool calls matching the query. */
  total_archived: number;
  /** Archived tool calls covered by this response — same unit as
   *  `total_archived`, so the two are directly comparable. In list mode the
   *  calls are represented by the `summary` entries rather than returned
   *  individually. */
  returned: number;
  truncated: boolean;
  truncated_bytes: number;
  /** Archived turn ids, returned when a lookup matches nothing so the next
   *  call can name a real one instead of guessing again. */
  available_message_ids: string[];
  /** Percentage of available bytes returned (0–100), e.g. 88.99.
   *  100 means all results fit; <100 when per-result or total cap was hit. */
  coverage_pct: number;
  /** Actual results (retrieval mode). */
  results: ToolHistoryResultItem[];
  /** Summary entries (list mode); empty in retrieval modes. */
  summary: ToolHistorySummaryEntry[];
}

interface ArchivedToolResult {
  item: ToolHistoryResultItem;
  /** False when the adjacent assistant has no matching tool call. */
  ownershipResolved: boolean;
}

interface ArchivedToolTurn {
  toolResults: ArchivedToolResult[];
  toolNames: string[];
  whiteboardRefs?: WhiteboardTurnReferences;
}

const PER_RESULT_CAP_BYTES = 262144; // 256 KB head+tail per result (UTF-8 bytes)

const WHITEBOARD_TOOL_NAME = 'lc_whiteboard';
const WHITEBOARD_ACTIONS = new Set(['read', 'replace', 'edit']);

/** Stable bounded projections; canonical local messages remain untouched. */
export const WHITEBOARD_HISTORY_REDACTED_OUTPUT =
  'Historical Whiteboard content is redacted. Use whiteboard_refs for retained version IDs, or call lc_whiteboard with action read for the current boards.';
export const UNRESOLVED_HISTORY_REDACTED_OUTPUT =
  'Archived tool output is redacted because LC could not resolve its owning tool call.';

/** Cap on the ids offered back after a lookup miss. */
const MAX_LISTED_MESSAGE_IDS = 20;

/** Archived turn ids to offer back after a lookup miss. */
function listArchivedIds(archived: ReadonlyMap<string, unknown>): string[] {
  return [...archived.keys()].slice(0, MAX_LISTED_MESSAGE_IDS);
}

function capOutput(output: string, maxBytes = PER_RESULT_CAP_BYTES): { text: string; truncated: boolean } {
  const capped = truncateUtf8(output, Math.min(maxBytes, PER_RESULT_CAP_BYTES));
  return { text: capped.text, truncated: capped.truncated };
}

/** Keep only the non-sensitive operation selector from Whiteboard arguments. */
function projectWhiteboardArguments(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '{}';
    const action = (parsed as { action?: unknown }).action;
    return typeof action === 'string' && WHITEBOARD_ACTIONS.has(action)
      ? JSON.stringify({ action })
      : '{}';
  } catch {
    return '{}';
  }
}

function projectArchivedResult(
  toolCall: { name: string; arguments: string } | undefined,
  message: Message,
): ArchivedToolResult {
  const common = {
    tool_call_id: message.tool_call_id!,
    output_truncated: false,
    is_error: message.tool_is_error ?? false,
    duration_ms: message.tool_duration_ms ?? 0,
    created_at: message.createdAt,
  };

  if (!toolCall) {
    return {
      ownershipResolved: false,
      item: {
        ...common,
        tool_name: 'unknown',
        arguments: '',
        output: UNRESOLVED_HISTORY_REDACTED_OUTPUT,
      },
    };
  }

  if (toolCall.name === WHITEBOARD_TOOL_NAME) {
    return {
      ownershipResolved: true,
      item: {
        ...common,
        tool_name: toolCall.name,
        arguments: projectWhiteboardArguments(toolCall.arguments),
        output: WHITEBOARD_HISTORY_REDACTED_OUTPUT,
      },
    };
  }

  return {
    ownershipResolved: true,
    item: {
      ...common,
      tool_name: toolCall.name,
      arguments: toolCall.arguments,
      output: message.content,
    },
  };
}

// JSON Schema maxLength counts Unicode code points. The query validator uses
// the same measure explicitly; `.meta()` keeps the generated wire schema in
// lockstep instead of using Zod's UTF-16-code-unit `.max()` implementation.
const CACHED_SCHEMA = Object.freeze(schema.toJSONSchema()) as unknown as JsonSchema;

/**
 * Constrained tool-call decoders sometimes serialize every optional string as
 * an empty value even when the model chose to omit it. Normalize before mode
 * selection so `query: ""` cannot conflict with a real `tool_call_id` (and
 * vice versa).
 */
function nonBlank(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

/** Honest zero-coverage response for a conversation with no readable archive. */
function emptySearchOutput(query: string): ToolHistorySearchOutput {
  return {
    query,
    eligible_calls: 0,
    scanned_calls: 0,
    scanned_bytes: 0,
    matched_calls: 0,
    returned: 0,
    truncated: false,
    truncation_reasons: [],
    scan_coverage_pct: 100,
    hits: [],
  };
}

/**
 * Flatten the grouped archive into scan order for search. Ordering follows
 * conversation order, which makes a bounded scan's stopping point a
 * deterministic function of the conversation.
 */
function searchCandidates(
  archived: ReadonlyMap<string, ArchivedToolTurn>,
  filters: { message_id?: string; tool_name?: string },
): ToolHistorySearchCandidate[] {
  const candidates: ToolHistorySearchCandidate[] = [];
  for (const [messageId, entry] of archived) {
    if (filters.message_id && messageId !== filters.message_id) continue;
    for (const archivedResult of entry.toolResults) {
      // An unresolved result must not become searchable under the invented
      // name "unknown", even when a query names its id or leaked payload.
      if (!archivedResult.ownershipResolved) continue;
      const result = archivedResult.item;
      if (filters.tool_name && result.tool_name !== filters.tool_name) continue;
      candidates.push({
        message_id: messageId,
        tool_call_id: result.tool_call_id,
        tool_name: result.tool_name,
        arguments: result.arguments,
        output: result.output,
        is_error: result.is_error,
        created_at: result.created_at ?? null,
      });
    }
  }
  return candidates;
}

const rawToolHistory: ToolHandler<ToolHistoryInput, Partial<ToolHistoryOutput> | ToolHistorySearchOutput> = {
  name: 'lc_tool_history',
  description:
    'Retrieve archived tool call results from previous conversation turns.\n' +
    'If no identifier is provided, lc_tool_history lists archived calls.\n' +
    'tool_name alone filters this list.\n' +
    'It does not retrieve full payloads.\n' +
    'If message_id is provided, lc_tool_history retrieves results for that message.\n' +
    'tool_name can filter those results.\n' +
    'If tool_call_id is provided, lc_tool_history retrieves that exact call.\n' +
    'If query is provided, lc_tool_history searches archived call IDs, tool names, arguments, and outputs.\n' +
    'message_id and tool_name can narrow this search.\n' +
    'Each search hit returns a tool_call_id for exact retrieval.\n' +
    `query accepts at most ${SEARCH_MAX_QUERY_CHARACTERS} characters and ${SEARCH_MAX_QUERY_TERMS} distinct terms.\n` +
    'Do not combine query with tool_call_id.\n' +
    'Blank optional strings are treated as omitted.',
  uiDescription:
    'Retrieve archived tool results from previous turns on demand.',
  input: schema,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (input, ctx) => {
    const messageId = nonBlank(input.message_id);
    const requestedToolName = nonBlank(input.tool_name);
    const toolCallId = nonBlank(input.tool_call_id);
    const query = nonBlank(input.query);

    // Mode conflicts are rejected before any store access so the model gets
    // one unambiguous reason rather than an empty result it has to interpret.
    // Both this and parseSearchQuery throw ToolHistorySearchInputError, a
    // plain Error; converting it to a structured throw keeps the machine
    // code honest (invalid_arguments, like the schema-validated fields)
    // instead of the generic retryable handler_exception fallback.
    let parsedQuery: ReturnType<typeof parseSearchQuery> | undefined;
    try {
      if (query && toolCallId) {
        throw new ToolHistorySearchInputError(
          'query and tool_call_id are mutually exclusive. Use query to search, or tool_call_id to retrieve one exact call.',
        );
      }
      // Parse a real query before the store read. Blank decoder placeholders
      // were normalized above and intentionally select the ordinary list mode.
      parsedQuery = query ? parseSearchQuery(query) : undefined;
    } catch (error) {
      if (error instanceof ToolHistorySearchInputError) {
        throw { code: 'invalid_arguments', message: error.message };
      }
      throw error;
    }

    const convId = ctx.config.convId;
    if (!convId) {
      return parsedQuery
        ? emptySearchOutput(parsedQuery.raw)
        : { total_archived: 0, returned: 0, truncated: false, results: [] };
    }

    let conv;
    try {
      conv = useConversations.getState().byId[convId];
    } catch {
      return parsedQuery ? emptySearchOutput(parsedQuery.raw) : {
        total_archived: 0, returned: 0, truncated: false, results: [],
        summary: [{ type: 'summary', message_id: '', tool_count: 0, tools: ['store_error'] }],
      };
    }
    if (!conv) {
      return parsedQuery
        ? emptySearchOutput(parsedQuery.raw)
        : { total_archived: 0, returned: 0, truncated: false, results: [] };
    }
    const maxBytes = input.max_result_bytes ?? 65536;

    // Collect all tool messages, grouped by the assistant message that
    // preceded them. An assistant message with tool_calls is followed
    // by one or more role:'tool' messages sharing tool_call_id values.
    const archivedByAssistant = new Map<string, ArchivedToolTurn>();

    // A tool-history call runs inside the latest assistant turn. Only index
    // messages before the latest user message, matching the context-stubbing
    // boundary and preventing the active turn from querying itself.
    let archiveEnd = conv.messages.length;
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'user') {
        archiveEnd = i;
        break;
      }
    }

    for (let i = 0; i < archiveEnd; i++) {
      const m = conv.messages[i];
      if (m.role !== 'assistant' || !m.tool_calls?.length) continue;

      const results: ArchivedToolResult[] = [];
      const toolNames: string[] = [];

      // Collect tool results that follow this assistant message
      // until the next non-tool message.
      for (let j = i + 1; j < conv.messages.length; j++) {
        const tm = conv.messages[j];
        if (tm.role !== 'tool') break;
        if (!tm.tool_call_id) continue;

        // Match tool_call_id to the assistant's tool_calls to get the name.
        const tc = m.tool_calls.find((c) => c.id === tm.tool_call_id);
        const projected = projectArchivedResult(tc, tm);
        results.push(projected);
        toolNames.push(projected.item.tool_name);
      }

      if (results.length > 0) {
        archivedByAssistant.set(m.id, {
          toolResults: results,
          toolNames,
          ...(m.whiteboard_refs ? { whiteboardRefs: m.whiteboard_refs } : {}),
        });
      }
    }

    // ── Search mode: bounded lexical scan over this conversation only ──
    if (parsedQuery) {
      return searchToolHistory(
        searchCandidates(archivedByAssistant, {
          ...(messageId ? { message_id: messageId } : {}),
          ...(requestedToolName ? { tool_name: requestedToolName } : {}),
        }),
        parsedQuery,
        {
          ...(input.max_results !== undefined ? { maxResults: input.max_results } : {}),
          maxResponseBytes: maxBytes,
          signal: ctx.signal,
        },
      );
    }

    // ── List mode: no filters, return structured summary ──
    if (!messageId && !toolCallId) {
      const summaryEntries: ToolHistorySummaryEntry[] = [];
      let totalArchived = 0;
      let usedBytes = 0;
      let truncated = false;
      for (const [id, v] of archivedByAssistant) {
        const matchingNames = requestedToolName
          ? v.toolNames.filter((name) => name === requestedToolName)
          : v.toolNames;
        if (matchingNames.length === 0) continue;
        totalArchived += matchingNames.length;
        const summary: ToolHistorySummaryEntry = {
          type: 'summary',
          message_id: id,
          tool_count: matchingNames.length,
          tools: [...new Set(matchingNames)],
        };
        const size = utf8ByteLength(JSON.stringify(summary));
        if (usedBytes + size > maxBytes) {
          truncated = true;
          continue;
        }
        usedBytes += size;
        summaryEntries.push(summary);
      }
      // Count returned calls, not summary rows: `total_archived` is in tool
      // calls, and reporting rows against it read as near-total loss (or, in
      // testing, as "100% coverage" of the wrong quantity).
      const summarizedCalls = summaryEntries.reduce((sum, item) => sum + item.tool_count, 0);
      return {
        total_archived: totalArchived,
        returned: summarizedCalls,
        truncated,
        coverage_pct: totalArchived === 0 || !truncated ? 100 : Math.round((summarizedCalls / totalArchived) * 10000) / 100,
        results: [],
        summary: summaryEntries,
      };
    }

    // ── Specific call_id mode ──
    if (toolCallId) {
      const entries = messageId
        ? [[messageId, archivedByAssistant.get(messageId)] as const]
          .filter((entry): entry is readonly [string, ArchivedToolTurn] => Boolean(entry[1]))
        : Array.from(archivedByAssistant.entries());
      for (const [owningMessageId, v] of entries) {
        const archivedHit = v.toolResults.find((r) => r.item.tool_call_id === toolCallId);
        const hit = archivedHit?.item;
        if (hit && (!requestedToolName || hit.tool_name === requestedToolName)) {
          const capped = capOutput(hit.output, maxBytes);
          const returnedBytes = utf8ByteLength(capped.text);
          const originalBytes = utf8ByteLength(hit.output);
          const coveragePct = capped.truncated
            ? Math.round((returnedBytes / originalBytes) * 10000) / 100
            : 100;
          return {
            message_id: archivedHit.ownershipResolved ? owningMessageId : null,
            ...(archivedHit.ownershipResolved && v.whiteboardRefs
              ? { whiteboard_refs: v.whiteboardRefs }
              : {}),
            total_archived: 1,
            returned: 1,
            truncated: capped.truncated,
            truncated_bytes: capped.truncated ? originalBytes - returnedBytes : undefined,
            coverage_pct: coveragePct,
            results: [{ ...hit, output: capped.text, output_truncated: capped.truncated }],
          };
        }
      }
      return {
        total_archived: 0,
        returned: 0,
        truncated: false,
        results: [],
        available_message_ids: listArchivedIds(archivedByAssistant),
      };
    }

    // ── message_id mode (optionally filtered by tool_name) ──
    const entry = archivedByAssistant.get(messageId!);
    if (!entry) {
      // A miss used to be indistinguishable from a turn that archived nothing,
      // so a guessed id cost a round-trip and taught the model nothing. Hand
      // back the real ids instead.
      return {
        message_id: messageId,
        total_archived: 0,
        returned: 0,
        truncated: false,
        results: [],
        available_message_ids: listArchivedIds(archivedByAssistant),
      };
    }

    const matched = (requestedToolName
      ? entry.toolResults.filter((r) => r.item.tool_name === requestedToolName)
      : entry.toolResults)
      .map((result) => result.item);

    // Pre-compute total available bytes (UTF-8) for coverage calculation.
    let totalAvailableBytes = 0;
    for (const r of matched) {
      totalAvailableBytes += utf8ByteLength(r.output);
    }

    // Apply one exact UTF-8 byte budget across the whole response.
    let totalBytes = 0;
    const capped: ToolHistoryResultItem[] = [];
    let truncated = false;

    for (const r of matched) {
      const remainingBytes = maxBytes - totalBytes;
      if (remainingBytes <= 0) {
        truncated = true;
        break;
      }
      const cap = capOutput(r.output, remainingBytes);
      const size = utf8ByteLength(cap.text);
      totalBytes += size;
      capped.push({ ...r, output: cap.text, output_truncated: cap.truncated });
      if (cap.truncated) {
        truncated = true;
        break;
      }
    }
    if (capped.length < matched.length) truncated = true;

    const coveragePct = totalAvailableBytes > 0
      ? Math.round((totalBytes / totalAvailableBytes) * 10000) / 100
      : 100;

    return {
      message_id: messageId,
      ...(entry.whiteboardRefs ? { whiteboard_refs: entry.whiteboardRefs } : {}),
      total_archived: matched.length,
      returned: capped.length,
      truncated,
      truncated_bytes: truncated ? Math.max(0, totalAvailableBytes - totalBytes) : undefined,
      coverage_pct: coveragePct,
      results: capped,
    };
  },
};

function completeHistoryOutput(
  output: Partial<ToolHistoryOutput> | ToolHistorySearchOutput,
): ToolHistoryOutput | ToolHistorySearchOutput {
  if ('query' in output) {
    return {
      ...output,
      truncation_reasons: output.truncation_reasons ?? [],
      hits: output.hits.map((hit) => ({
        ...hit,
        created_at: hit.created_at ?? null,
      })),
    };
  }
  return {
    message_id: output.message_id ?? null,
    ...(output.whiteboard_refs ? { whiteboard_refs: output.whiteboard_refs } : {}),
    total_archived: output.total_archived ?? 0,
    returned: output.returned ?? 0,
    truncated: output.truncated ?? false,
    truncated_bytes: output.truncated_bytes ?? 0,
    available_message_ids: output.available_message_ids ?? [],
    coverage_pct: output.coverage_pct ?? 100,
    results: (output.results ?? []).map((result) => ({
      ...result,
      created_at: result.created_at ?? null,
    })),
    summary: output.summary ?? [],
  };
}

export const toolHistory: ToolHandler<ToolHistoryInput, ToolHistoryOutput | ToolHistorySearchOutput> = {
  ...rawToolHistory,
  run: async (input, ctx) => completeHistoryOutput(await rawToolHistory.run(input, ctx)),
};
