/**
 * read_image — inspect one or more images from disk.
 *
 * Accepts multiple paths in a single call so the model can batch
 * requests. The Rust bridge produces data URLs, but the handler keeps
 * those bytes in a short-lived side-channel cache instead of returning
 * them in the tool result. A vision-capable chat model receives the
 * cached images on the next model turn; `analyze:true` returns a text
 * description from the configured vision sub-agent instead.
 *
 * Encoding options (applied to ALL images in the batch):
 *   - "original" (default for analyze:false): raw bytes, no conversion.
 *   - "low_jpeg":    re-encode as JPEG quality 30 (3/10). Smallest
 *                    output — good for quick visual checks.
 *   - "medium_jpeg" (default for analyze:true): re-encode as JPEG
 *                    quality 60 (6/10). Balanced size vs quality for
 *                    detailed inspection.
 *
 * Downscale (applied before encoding, both modes):
 *   - Factor [0.1–1.0], default 1.0 (no resize). 0.5 = half width & height.
 *   - Useful for large images — reduces encoding time and output size.
 *
 * Sub-agent mode (`analyze: true`):
 *   When set, the images are NOT returned as base64. Instead, a
 *   separate vision-model call (sub-agent) describes them, and the
 *   result includes only metadata + the sub-agent's text
 *   description. This keeps base64 out of the conversation
 *   permanently. Use `instruction` to guide the sub-agent (e.g.
 *   "Focus on the error dialog in the bottom-right corner").
 *   Omit `analyze` (or set it to false) when the active chat model is
 *   vision-capable and the image itself should be injected on the next
 *   turn. Non-vision chat models must use `analyze:true`.
 *
 *   In analyze mode:
 *   - Default encoding is "medium_jpeg" (not "original").
 *   - Hard cap: 5 MiB per encoded image. If exceeded, the error
 *     tells the model to lower encoding quality or downscale.
 *   - Analysis is time-limited per image; provider-specific timeout
 *     errors report the actual selected duration.
 *
 *   Metadata returned for every image includes original_wh
 *   ([width, height] before any downscale) and wh_downscale
 *   (the factor actually applied, 1.0 = no resize).
 */
import { z } from 'zod';
import type { ToolHandler } from '../types';
import type { JsonSchema } from '../../llm-client/types';
import type { ProfileRequestHeaderSettings } from '../../../types';
import {
  profileRequestHeaderSettings,
  withProfileRequestHeaders,
} from '../../llm-client/index.ts';
import {
  normalizeReadImageDescription,
  READ_IMAGE_WARNINGS,
} from '../read-image-result.ts';

const MAX_IMAGE_PATHS = 20;
const HARD_CAP_IMAGE_INPUT_BYTES = 50 * 1024 * 1024;
const ANALYZE_PATH_LIMIT = 10;
/** Provider token ceiling for each per-image vision call. */
export const READ_IMAGE_ANALYSIS_MAX_TOKENS = 4_000;
export const READ_IMAGE_SYSTEM_PROMPT =
  'You are an image analysis assistant. Report only what you see. ' +
  'Be thorough and precise. Never infer content from filenames.';

const schema = z.object({
  paths: z.array(z.string()).min(
    1,
    'paths must contain at least one path. Add an image path and retry.',
  ).max(
    MAX_IMAGE_PATHS,
    `paths accepts at most ${MAX_IMAGE_PATHS} entries. Split the image request into batches of ${MAX_IMAGE_PATHS} or fewer paths.`,
  ),
  max_bytes: z.number().int().positive().max(
    HARD_CAP_IMAGE_INPUT_BYTES,
    `max_bytes must be at most ${HARD_CAP_IMAGE_INPUT_BYTES} (50 MiB). Use a smaller byte limit or a smaller image.`,
  ).optional(),
  encoding: z.enum(['original', 'low_jpeg', 'medium_jpeg']).optional(),
  /** Downscale factor [0.1–1.0], default 1.0 (no resize).
   *  Applied before encoding. 0.5 = half width & height. */
  downscale: z.number().min(
    0.1,
    'downscale must be at least 0.1. Use a factor between 0.1 and 1.0, or omit downscale for no resize.',
  ).max(
    1.0,
    'downscale must be at most 1.0. Use a factor between 0.1 and 1.0, or omit downscale for no resize.',
  ).optional(),
  /** If true, use a sub-agent vision call to describe the images
   *  instead of returning base64. The result includes text
   *  descriptions — no data_url or base64 fields. */
  analyze: z.boolean().optional(),
  /** Custom instruction for the sub-agent when analyze is true.
   *  E.g. "Focus on the error messages and stack traces." */
  instruction: z.string().optional(),
});

export type ReadImageInput = z.infer<typeof schema>;

export interface ReadImageEntry {
  path: string;
  mime: string | null;
  size_bytes: number;
  original_size_bytes: number;
  /** Original image dimensions [width, height] before any downscale. */
  original_wh: [number, number] | null;
  /** Downscale factor applied (1.0 = no resize). */
  wh_downscale: number;
  encoding: string;
  truncated: boolean;
  /** Internal bridge field; stripped before the tool result is persisted. */
  data_url?: string;
  error: string | null;
}

export interface ReadImageOutput {
  images: ReadImageEntry[];
  /** True when a sub-agent described the images. */
  analyzed: boolean;
  /** Vision sub-agent description, or null when no description was produced. */
  description: string | null;
  /** True only when analyze mode accepted the first ten of more requested paths. */
  truncated: boolean;
  /** Number of paths supplied to the call. */
  total_requested: number;
  /** Paths attempted: all in delivery mode, or the leading analyze-mode subset. */
  processed_count: number;
  /** Images encoded and admitted to a vision request; zero in ordinary delivery mode. */
  analyzed_count: number;
  /** Images whose vision response contained usable bounded text. */
  described_count: number;
  /** Trailing paths not attempted by analyze mode; zero in delivery mode. */
  dropped_count: number;
  /** Actionable capability, delivery, or truncation guidance. */
  warning: string | null;
}

const CACHED_SCHEMA = Object.freeze(schema.toJSONSchema()) as unknown as JsonSchema;

/* ------------------------------------------------------------------ */
/*  Image cache — keeps base64 off the JS main thread                  */
/* ------------------------------------------------------------------ */

export interface CachedImage {
  data_url: string;
  path: string;
  mime: string;
}

interface CachedBatch {
  images: CachedImage[];
  bytes: number;
  /** Conversation ID this batch belongs to. */
  conversationId: string;
  /** Generation ID prevents a reused provider call ID crossing turns. */
  generationId: string;
  /** Call ID this batch was created for. */
  callId: string;
  /** Timestamp for TTL eviction. */
  createdAt: number;
}

const MAX_CACHED_BATCHES = 8;
const MAX_CACHED_BYTES = 64 * 1024 * 1024; // 64 MiB of data URLs
const MAX_BATCHES_PER_GENERATION = 3;
const MAX_BYTES_PER_GENERATION = 32 * 1024 * 1024;
const TTL_MS = 5 * 60 * 1000; // 5-minute TTL (Phase 3.4)

/** Module-level cache. Insertion order selects the oldest surplus batch. */
const imageBatchCache = new Map<string, CachedBatch>();

/**
 * Admit one ordinary-delivery batch to the bounded side-channel cache.
 * Exported so the real eviction policy can be crossed in a regression test;
 * callers must still use `getImageBatch` because admission can evict this or
 * an older batch immediately.
 */
export function cacheImageBatch(
  id: string,
  images: CachedImage[],
  conversationId: string,
  generationId: string,
  callId: string,
): void {
  const bytes = images.reduce((n, i) => n + i.data_url.length, 0);
  imageBatchCache.delete(id);            // refresh insertion order
  imageBatchCache.set(id, {
    images,
    bytes,
    conversationId,
    generationId,
    callId,
    createdAt: Date.now(),
  });
  evict();
}

function evict(): void {
  const now = Date.now();
  // Phase 3.4: TTL eviction — remove expired entries.
  for (const [id, b] of imageBatchCache) {
    if (now - b.createdAt > TTL_MS) {
      imageBatchCache.delete(id);
    }
  }
  // Fair admission: one generation may retain only a bounded share, so a
  // burst of reads in one chat cannot evict every pending batch from siblings.
  const ownerStats = new Map<string, { count: number; bytes: number }>();
  for (const batch of imageBatchCache.values()) {
    const owner = `${batch.conversationId}\0${batch.generationId}`;
    const stats = ownerStats.get(owner) ?? { count: 0, bytes: 0 };
    stats.count += 1;
    stats.bytes += batch.bytes;
    ownerStats.set(owner, stats);
  }
  for (const [id, batch] of imageBatchCache) {
    const owner = `${batch.conversationId}\0${batch.generationId}`;
    const stats = ownerStats.get(owner)!;
    if (stats.count <= MAX_BATCHES_PER_GENERATION && stats.bytes <= MAX_BYTES_PER_GENERATION) continue;
    imageBatchCache.delete(id);
    stats.count -= 1;
    stats.bytes -= batch.bytes;
  }
  // Keep each admitted owner's last batch when global limits require eviction.
  // Remove the oldest surplus batch first. If every owner has only one batch,
  // reject the newest admission instead of removing a sibling's last batch.
  let total = 0;
  for (const b of imageBatchCache.values()) total += b.bytes;
  while (imageBatchCache.size > MAX_CACHED_BATCHES || total > MAX_CACHED_BYTES) {
    const entries = [...imageBatchCache.entries()];
    const candidate = entries.find(([, batch]) =>
      ownerStats.get(`${batch.conversationId}\0${batch.generationId}`)!.count > 1,
    ) ?? entries.at(-1);
    if (!candidate) break;
    const [id, batch] = candidate;
    imageBatchCache.delete(id);
    const stats = ownerStats.get(`${batch.conversationId}\0${batch.generationId}`)!;
    stats.count -= 1;
    stats.bytes -= batch.bytes;
    total -= batch.bytes;
  }
}

export function getImageBatch(batchId: string): CachedImage[] | undefined {
  // TTL is a delivery contract, not merely a write-time cleanup heuristic.
  // Enforce it at the lookup that decides whether pixels reach the model.
  evict();
  return imageBatchCache.get(batchId)?.images;
}

export function deleteImageBatch(batchId: string): void {
  imageBatchCache.delete(batchId);
}

/** Dispose cache entries for one logical call without crossing generations. */
export function disposeCallImageBatches(
  conversationId: string,
  generationId: string,
  callId: string,
): void {
  for (const [id, b] of imageBatchCache) {
    if (
      b.conversationId === conversationId
      && b.generationId === generationId
      && b.callId === callId
    ) {
      imageBatchCache.delete(id);
    }
  }
}

/** Dispose every batch owned by exactly one terminal generation. */
export function disposeGenerationImageBatches(conversationId: string, generationId: string): void {
  for (const [id, batch] of imageBatchCache) {
    if (batch.conversationId === conversationId && batch.generationId === generationId) {
      imageBatchCache.delete(id);
    }
  }
}

export function imageBatchCacheMetrics(): { batches: number; bytes: number; generations: number } {
  const now = Date.now();
  let bytes = 0;
  let batches = 0;
  const generations = new Set<string>();
  for (const batch of imageBatchCache.values()) {
    // Diagnostics are read-only. Exclude expired entries without turning
    // support-report collection into a cache mutation boundary.
    if (now - batch.createdAt > TTL_MS) continue;
    batches += 1;
    bytes += batch.bytes;
    generations.add(`${batch.conversationId}\0${batch.generationId}`);
  }
  return { batches, bytes, generations: generations.size };
}

/** Test/reset seam. Production uses generation-targeted disposal. */
export function clearImageBatches(): void {
  imageBatchCache.clear();
}

let nextBatchId = 0;

export const readImage: ToolHandler<ReadImageInput, ReadImageOutput> = {
  name: 'lc_read_image',
  description:
    'Read images from disk in ordinary delivery mode or analysis mode.\n' +
    'A call accepts at most 20 paths.\n' +
    'LC rejects a larger request.\n' +
    'In ordinary delivery mode, a vision-capable chat model receives cached images.\n' +
    'The cache expires after five minutes.\n' +
    'The cache holds at most eight batches and 64 MiB of data URLs.\n' +
    'If a batch expires or is evicted, the next model turn receives a warning.\n' +
    'Retry with fewer paths, a smaller downscale value, or a JPEG encoding.\n' +
    'If analyze=true, a configured vision sub-agent returns a text description.\n' +
    'Each provider response body has a 1 MiB cap.\n' +
    'Non-success response detail has a smaller 16 KiB cap.\n' +
    'Each usable description has a 64 KiB UTF-8 cap.\n' +
    'An oversized or blank description becomes a per-image error.\n' +
    'analyzed_count reports images encoded and admitted to a vision request. described_count reports usable descriptions returned.\n' +
    'Analysis mode uses medium_jpeg by default.\n' +
    'Each encoded image has a 5 MiB cap in analysis mode.\n' +
    'Analysis mode processes only the first 10 paths.\n' +
    'If it drops more paths, the result includes counts, truncated=true, and an actionable warning.\n' +
    'Use instruction to guide the analysis.\n' +
    'Analysis is time-limited and can time out.\n' +
    'The input limit defaults to 10 MiB per image.\n' +
    'max_bytes can increase this limit to the 50 MiB hard limit.\n' +
    'LC rejects a decoded image above 100 megapixels.\n' +
    'LC also rejects a dimension above 16,384 pixels.\n' +
    'LC performs these checks before downscaling.\n' +
    'LC does not enforce a minimum image dimension.\n' +
    'Some vision providers refuse images below provider-specific minimum dimensions.\n' +
    'A provider can reject such an image during delivery or analysis.\n' +
    'lc_read_image cannot increase image dimensions.\n' +
    'Enlarge the source image before you retry.\n' +
    'Encoding options are low_jpeg at q30, medium_jpeg at q60, and original raw bytes.\n' +
    'A downscale value from 0.1 through 1.0 reduces dimensions before encoding.\n' +
    'Supported formats are png, jpeg, gif, webp, and bmp.\n' +
    'LC detects the format from file contents, not from the file name.\n' +
    'Therefore, mime reports the decoded format.\n' +
    'SVG is vector markup. Read it as text with lc_read_file.\n' +
    'This build does not support TIFF or ICO.',
  uiDescription: 'Inspect images or analyze them with a vision sub-agent.',
  input: schema,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (input, ctx) => {
    // If the model does not support vision and analyze is false,
    // short-circuit before LC reads images from disk.
    if (!input.analyze && ctx.config.modelIsVision === false) {
      return {
        images: [],
        analyzed: false,
        description: null,
        truncated: false,
        total_requested: input.paths.length,
        processed_count: 0,
        analyzed_count: 0,
        described_count: 0,
        dropped_count: 0,
        warning: READ_IMAGE_WARNINGS.visionUnsupported,
      };
    }

    // Sub-agent mode: offload everything to Rust so base64 data
    // never crosses the JS bridge.  This keeps the UI responsive
    // even for large/many images.  Rust handles all protocol
    // variants (OpenAI CC, OpenAI Responses, Anthropic Messages,
    // LM Studio REST).
    if (input.analyze && ctx.config.llmServerUrl) {
      if (ctx.signal.aborted) {
        throw { code: 'Aborted', message: 'Operation cancelled by user.' };
      }

      // Dynamic import — the checkModel module pulls in LLMClient
      // + Tauri plugin deps.  Only load when analyze:true is
      // actually used, so analyze:false never pays the cost.
      const { checkModelLoaded } = await import('../../../utils/checkModel.ts');
      const { resolveModelServerAuth } = await import('../../server-profiles/index.ts');
      const visionModel = ctx.config.visionModel || ctx.config.llmModel;
      const isSameAsChat = !ctx.config.visionModel;

      // When "Same as chat model" is selected, use the chat profile's
      // config directly — skip model→profile resolution.  Otherwise
      // resolveModelServer may pick the wrong profile when the same
      // model ID exists in multiple profiles with different API styles
      // (e.g. one OpenAI/R and one OpenAI/CC profile).
      let serverUrl: string;
      let apiKey: string;
      let apiStyle: string;
      let apiVariant: string;
      let modelId: string;
      let requestHeaderSettings: ProfileRequestHeaderSettings;

      if (isSameAsChat) {
        // Skip model-loaded check — the chat model is already active.
        serverUrl = ctx.config.llmServerUrl;
        apiKey = ctx.config.llmApiKey ?? '';
        apiStyle = ctx.config.llmApiStyle ?? 'chat';
        apiVariant = ctx.config.llmApiVariant;
        modelId = ctx.config.llmModel;
        requestHeaderSettings = {
          includeLcIdentifierHeader: ctx.config.llmIncludeLcIdentifierHeader,
          lcIdentifierHeader: ctx.config.llmLcIdentifierHeader,
          includeAdditionalRequestHeaders: ctx.config.llmIncludeAdditionalRequestHeaders,
          requestHeaders: ctx.config.llmRequestHeaders,
        };
      } else {
        const modelCheck = await checkModelLoaded(ctx, visionModel);
        if (!modelCheck.ok) {
          throw new Error((modelCheck as { ok: false; error: string }).error);
        }

        // Resolve the vision model's actual server — ctx.config.llmServerUrl
        // points at the active chat profile, not the vision model's profile.
        const resolved = await resolveModelServerAuth(visionModel);
        serverUrl = resolved?.baseUrl ?? ctx.config.llmServerUrl;
        apiKey = resolved?.apiKey ?? ctx.config.llmApiKey ?? '';
        apiVariant = resolved?.apiVariant ?? 'openai';
        apiStyle = resolved?.apiStyle ?? ctx.config.llmApiStyle ?? 'chat';
        modelId = resolved?.modelId ?? visionModel;
        requestHeaderSettings = resolved
          ? profileRequestHeaderSettings(resolved)
            : {
              includeLcIdentifierHeader: ctx.config.llmIncludeLcIdentifierHeader,
              lcIdentifierHeader: ctx.config.llmLcIdentifierHeader,
              includeAdditionalRequestHeaders: ctx.config.llmIncludeAdditionalRequestHeaders,
              requestHeaders: ctx.config.llmRequestHeaders,
            };
      }

      // Model discovery/profile resolution can await network or keychain work.
      // Do not start a native vision request after Stop won that race.
      if (ctx.signal.aborted) {
        throw { code: 'Aborted', message: 'Operation cancelled by user.' };
      }

      const result = await ctx.sandbox.analyzeImages({
        paths: input.paths,
        encoding: input.encoding ?? 'medium_jpeg',
        downscale: input.downscale ?? 1.0,
        max_bytes: input.max_bytes,
        call_id: ctx.identity.operationId,
        group_id: ctx.identity.groupId,
        allowed_roots: ctx.config.allowedRoots,
        server_url: serverUrl,
        model: modelId,
        api_key: apiKey || undefined,
        api_variant: apiVariant,
        api_style: apiStyle,
        request_headers: Object.entries(withProfileRequestHeaders({}, requestHeaderSettings)),
        system_prompt: READ_IMAGE_SYSTEM_PROMPT,
        user_instruction: input.instruction || undefined,
        max_tokens: READ_IMAGE_ANALYSIS_MAX_TOKENS,
      });
      const warning = result.warning?.trim() || null;
      const normalizedDescription = normalizeReadImageDescription(result.description, warning);
      const analyzedCount = Number.isSafeInteger(result.analyzed_count) && result.analyzed_count > 0
        ? Math.min(result.analyzed_count, ANALYZE_PATH_LIMIT)
        : 0;
      const describedCount = normalizedDescription
        && Number.isSafeInteger(result.described_count)
        && result.described_count > 0
        ? Math.min(result.described_count, analyzedCount)
        : 0;
      const description = describedCount > 0 ? normalizedDescription : null;
      return {
        ...result,
        images: result.images.map((image) => ({
          ...image,
          mime: image.mime ?? null,
          original_wh: image.original_wh ?? null,
          wh_downscale: image.wh_downscale ?? 1,
          error: image.error ?? null,
        })),
        analyzed: describedCount > 0,
        description,
        truncated: result.truncated ?? false,
        total_requested: result.total_requested ?? input.paths.length,
        processed_count: result.processed_count ?? Math.min(input.paths.length, ANALYZE_PATH_LIMIT),
        analyzed_count: analyzedCount,
        described_count: describedCount,
        dropped_count: result.dropped_count ?? Math.max(0, input.paths.length - ANALYZE_PATH_LIMIT),
        warning,
      };
    }

    // Non-analyze mode: read images via Rust, strip base64 before
    // returning so JSON.stringify in executeToolCall doesn't block.
    // Store data URLs in the module-level cache; ChatView picks them
    // up on the next turn for image injection.
    const raw = await ctx.sandbox.readImage({
      paths: input.paths,
      encoding: input.encoding,
      downscale: input.downscale ?? 1.0,
      max_bytes: input.max_bytes,
      allowed_roots: ctx.config.allowedRoots,
    });
    // Native image reads can finish after terminal cleanup. Discard late pixels
    // before they can recreate cache entries for the cancelled generation.
    if (ctx.signal.aborted) {
      throw { code: 'Aborted', message: 'Operation cancelled by user.' };
    }

    // Phase 3.4: bind cache entries to conversation + call ID for
    // targeted disposal on terminal success/error/abort.
    const batchId = `${ctx.identity.conversationId}:${ctx.identity.generationId}:${ctx.identity.modelToolCallId}:${++nextBatchId}`;
    const validImages = raw.images
      .filter((img) => img.data_url && !img.error)
      .map((img) => ({ data_url: img.data_url!, path: img.path, mime: img.mime }));
    if (validImages.length > 0) {
      cacheImageBatch(
        batchId,
        validImages,
        ctx.identity.conversationId,
        ctx.identity.generationId,
        ctx.identity.modelToolCallId,
      );
    }

    // Return metadata plus transient side-channel identifiers. The
    // orchestrator registers and strips these fields before persisting
    // the tool result, while the ChatView image injection path uses the
    // module-level cache keyed by batchId.
    return {
      images: raw.images.map((img) => ({
        path: img.path,
        mime: img.mime ?? null,
        size_bytes: img.size_bytes ?? 0,
        original_size_bytes: img.original_size_bytes ?? 0,
        original_wh: img.original_wh ?? null,
        wh_downscale: img.wh_downscale ?? 1.0,
        encoding: img.encoding ?? 'original',
        truncated: img.truncated ?? false,
        error: img.error ?? null,
      })),
      analyzed: false,
      description: null,
      truncated: false,
      total_requested: input.paths.length,
      processed_count: input.paths.length,
      analyzed_count: 0,
      described_count: 0,
      dropped_count: 0,
      warning: null,
      _image_batch_id: batchId,
      images_delivered: validImages.length,
    } as ReadImageOutput & { _image_batch_id: string; images_delivered: number };
  },
};
