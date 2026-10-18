import { WEB_FETCH_GUIDANCE } from '../tool-guidance.ts';
/**
 * web_fetch — fetch a URL, return text content.
 *
 * Implements an SSRF blocklist (private IP ranges, localhost, file://,
 * etc.) on the Rust side. The body is capped at max_bytes (default
 * 1 MiB) and the request times out at timeout_ms (default 10s, hard
 * cap 30s).
 */
import { z } from 'zod';
import type { ToolHandler } from '../types';
import type { JsonSchema } from '../../llm-client/types';
import { remainingMs } from '../runner.ts';

export const WEB_FETCH_HARD_CAP_BYTES = 32 * 1024 * 1024;
export const WEB_FETCH_HARD_CAP_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

const schema = z.object({
  url: z.string().url(),
  max_bytes: z.number().int().positive().max(
    WEB_FETCH_HARD_CAP_BYTES,
    `max_bytes must be at most ${WEB_FETCH_HARD_CAP_BYTES} (32 MiB). Use a smaller byte limit or omit it to keep the default 1 MiB cap.`,
  ).optional(),
  timeout_ms: z.number().int().positive().max(
    WEB_FETCH_HARD_CAP_TIMEOUT_MS,
    `timeout_ms must be at most ${WEB_FETCH_HARD_CAP_TIMEOUT_MS}. Use 30000 milliseconds or less.`,
  ).optional(),
  /** HTML processing: "minimal" removes style/head/nav/footer/noscript sections,
   *  including scripts inside them, then strips remaining tags. Script contents
   *  outside those sections survive. "clean" removes those scripts too.
   *  "raw" returns the body without this processing. */
  strip_mode: z.enum(['clean', 'minimal', 'raw']).optional(),
}).strict();

export type WebFetchInput = z.infer<typeof schema>;

export interface WebFetchOutput {
  status: number;
  final_url: string;
  content_type: string;
  body: string;
  truncated: boolean;
}

const CACHED_SCHEMA = Object.freeze(schema.toJSONSchema()) as unknown as JsonSchema;

export const webFetch: ToolHandler<WebFetchInput, WebFetchOutput> = {
  name: 'lc_web_fetch',
  description: WEB_FETCH_GUIDANCE.essential,
  uiDescription: 'Fetch a public URL. Body truncated; private IPs blocked.',
  input: schema,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (input, ctx) => {
    // Phase 2.1: Use ctx.identity for operation + group identity.
    //   - call_id = identity.operationId (Rust registry key)
    //   - group_id = identity.groupId (batch abort by group)
    //
    // Phase 2.2: Connect JS AbortSignal to native abort_tool_calls.
    //   When the chat is stopped, the signal fires → we call the
    //   Tauri command to cancel the in-flight request via its
    //   CancellationToken. The listener is removed in `finally`.
    const callId = ctx.identity.operationId;
    const groupId = ctx.identity.groupId;

    const onAbort = () => {
      ctx.sandbox.abortToolCalls({ callIds: [callId] }).catch(() => {});
    };
    ctx.signal.addEventListener('abort', onAbort);

    try {
      if (ctx.signal.aborted) {
        throw { code: 'Aborted', message: 'Operation cancelled by user.' };
      }

      return ctx.sandbox.webFetch({
        ...input,
        call_id: callId,
        group_id: groupId,
        // Phase 2.5: Derive timeout from the per-call deadline.
        timeout_ms: input.timeout_ms
          ?? remainingMs(ctx.config.deadlineMs, Math.min(DEFAULT_TIMEOUT_MS, ctx.config.maxWebFetchTimeoutMs)),
      });
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
  },
};
