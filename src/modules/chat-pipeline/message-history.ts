import {
  READ_IMAGE_WARNINGS,
  setReadImageResultWarning,
} from '../tool-engine/read-image-result.ts';
import {
  decodeLcResultJson,
  encodeLcResultJson,
} from '../tool-engine/tool-result-content.ts';

/**
 * Function name carried by the synthetic tool call that stands in for an
 * archived turn's real tool calls.
 *
 * It must name a real, exposed tool. This sits in the `function.name` slot of
 * the model's *own* prior turns, the strongest conditioning signal a transcript
 * carries, and models across families reproduce whatever they find there. A
 * placeholder here costs a round-trip on `unknown_tool` every time one imitates
 * it, and no alternative placeholder helps — anything in that slot reads as
 * callable. Naming the retrieval tool instead makes the imitation do the right
 * thing, and keeps LC from naming a tool absent from the request's `tools`
 * array, which strict providers can reject on its own.
 *
 * Archiving only happens when `lc_tool_history` is exposed (see `historyEnabled`
 * in the orchestrator), so this name is always live where it appears.
 */
export const ARCHIVED_TOOL_NAME = 'lc_tool_history';

/**
 * Arguments on the synthetic call. List mode keeps the exchange coherent —
 * the turn reads as "asked for the archive index, got a summary naming the
 * message_id" rather than a retrieval that answered itself.
 */
export const ARCHIVED_TOOL_ARGUMENTS = '{}';

/** Build the generic archive stub for every tool, including lc_tool_help. */
export function buildArchivedToolStub(
  count: number,
  messageId: string,
  toolNames: readonly string[],
): string {
  return `⚠️ ${count} tool result(s) from this turn have been archived. ` +
    `Use lc_tool_history with message_id="${messageId}" to retrieve them. ` +
    `Tools called: ${[...new Set(toolNames)].join(', ')}.`;
}

/** Stable, provider-safe identity for an archived assistant tool-call stub. */
export function archiveToolCallId(assistantMessageId: string): string {
  let escaped = '';
  for (const character of assistantMessageId) {
    if (/^[A-Za-z0-9_]$/.test(character)) {
      escaped += character;
    } else if (character === '-') {
      escaped += '--';
    } else {
      escaped += `-x${character.codePointAt(0)!.toString(16)}-`;
    }
  }
  return `archived_${escaped}`;
}

/**
 * Build the content parts for a tool-delivered image turn.
 *
 * Tool-returned pixels have to travel as a `user` turn: no protocol LC targets
 * accepts images inside a tool result across the board (the first attempted
 * shape was reverted after two endpoints rejected it outright). The leading label exists
 * because models otherwise read that turn as a fresh question and answer it
 * instead of continuing — `gpt-5.6-luna` reasoned verbatim *"the user sent an
 * image and didn't ask an explicit question"* before abandoning its remaining
 * steps. See docs/streaming.md, "Adapter constraints proven against live
 * endpoints".
 */
export function buildImageTurnParts(
  toolCallId: string,
  images: ReadonlyArray<{ path: string; data_url: string }>,
): Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
> {
  return [
    {
      type: 'text',
      text:
        `[LC] Tool output for lc_read_image (${toolCallId}) — this is ` +
        `tool-delivered data, not a new request from the user. ` +
        `Continue your current task.`,
    },
    ...images.flatMap((img, idx) => [
      { type: 'text' as const, text: `Image ${idx + 1}: ${img.path}` },
      { type: 'image_url' as const, image_url: { url: img.data_url } },
    ]),
  ];
}

/** How a cached `lc_read_image` batch should reach the model on this request. */
export type ImageDelivery =
  /** No image batch was registered for this tool call. */
  | 'none'
  /** Emit the pixels as a synthetic user turn (first delivery only). */
  | 'inject'
  /** Already delivered in an earlier tool-call round — do not resend. */
  | 'skip-already-sent'
  /** Model has no vision capability: warn on the tool result, drop the batch. */
  | 'blocked-no-vision'
  /** A registered non-empty batch expired or was evicted before delivery. */
  | 'blocked-cache-miss';

/**
 * Decide how an `lc_read_image` batch reaches the model for one request.
 *
 * `reqMessages` is rebuilt from the store on every tool-call round and the
 * batch stays cached until the loop ends, so without the
 * `skip-already-sent` outcome the same synthetic user turn is re-emitted
 * every round. Models read each arrival as a NEW user message
 * containing an image and answer it unprompted, restart their plan from
 * step 1, re-call `lc_read_image` (registering another batch, which
 * compounds it), or stop with work outstanding.  Reproduced on all three
 * adapters across 5 models — see docs/streaming.md, "Adapter constraints
 * proven against live endpoints".
 *
 * Pure so the invariant "each batch is delivered at most once per tool-loop
 * session" is testable without booting the store or the adapters.
 */
export function resolveImageDelivery(input: {
  /** Batch id for this tool call, or null when the call produced no images. */
  batchId: string | null;
  /** Number of images held in the batch. */
  imageCount: number;
  /** Whether the active chat model accepts `image_url` content parts. */
  modelIsVision: boolean;
  /** Batch ids already sent on an earlier request in this tool-loop session. */
  alreadyInjected: ReadonlySet<string> | undefined;
}): ImageDelivery {
  const { batchId, imageCount, modelIsVision, alreadyInjected } = input;
  if (!batchId) return 'none';
  // Only non-empty batches are registered. A missing/empty cache lookup for a
  // real batch therefore means bounded-cache eviction, expiry, or app reload;
  // treating it as "none" would silently claim the images were delivered.
  if (imageCount <= 0) return 'blocked-cache-miss';
  // Checked before the already-sent case: a non-vision batch is dropped on
  // first sight, so it can never have been injected.
  if (!modelIsVision) return 'blocked-no-vision';
  if (alreadyInjected?.has(batchId)) return 'skip-already-sent';
  return 'inject';
}

/** Add the actionable control text for an image-delivery refusal/degradation. */
export function appendImageDeliveryWarning(
  content: string,
  delivery: Extract<ImageDelivery, 'blocked-no-vision' | 'blocked-cache-miss'>,
): string {
  return setReadImageResultWarning(
    content,
    delivery === 'blocked-no-vision'
      ? READ_IMAGE_WARNINGS.visionUnsupported
      : READ_IMAGE_WARNINGS.deliveryCacheMiss,
  );
}

/** Extract an ordinary-delivery batch only when the tool reported pixels. */
export function imageBatchIdForDelivery(output: string): string | null {
  const decoded = decodeLcResultJson(output)?.data;
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
  const parsed = decoded as Record<string, unknown>;
  return typeof parsed._image_batch_id === 'string'
    && parsed._image_batch_id
    && typeof parsed.images_delivered === 'number'
    && parsed.images_delivered > 0
    ? parsed._image_batch_id
    : null;
}

/** Remove transient image-delivery fields while retaining LC framing notices. */
export function stripInternalImageResultFields(output: string): string {
  if (!output.includes('_image_batch_id') && !output.includes('images_delivered')) {
    return output;
  }
  const decoded = decodeLcResultJson(output);
  if (!decoded?.data || typeof decoded.data !== 'object' || Array.isArray(decoded.data)) {
    return output;
  }
  const result = decoded.data as Record<string, unknown>;
  delete result._image_batch_id;
  delete result.images_delivered;
  return encodeLcResultJson(result, decoded.notices);
}
