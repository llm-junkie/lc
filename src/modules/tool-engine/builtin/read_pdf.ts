/** PDF processing stays native; this handler validates and resolves profiles. */
import { z } from 'zod';
import type { ToolHandler, ToolConfig, ToolHandlerContext } from '../types';
import type { JsonSchema } from '../../llm-client/types';
import type { NativeModelConfig, ReadPdfResult } from '../sandbox-bridge';
import { withProfileRequestHeaders, profileRequestHeaderSettings } from '../../llm-client/request-headers.ts';
import { parsePageRange } from './pdf-chunking.ts';
import { READ_PDF_GUIDANCE, READ_PDF_SELECTION_ERROR_CODES } from '../tool-guidance.ts';

const HARD_CAP_BYTES = 100 * 1024 * 1024;
const DEFAULT_BUDGET_MS = 5 * 60 * 1000;
const schema = z.object({
  paths: z.array(z.string()).min(
    1,
    'paths must contain at least one path. Add a PDF path and retry.',
  ),
  depth: z.enum(['text_only', 'full']).optional(),
  /** 1-based page selection, e.g. "1-5,12,40-55". Omitted = all pages. */
  pages: z.string().optional(),
  /** Rasterize these pages regardless of the visual-content verdict. */
  force_render: z.string().optional(),
  /** Return verbatim per-page text alongside the summary. */
  include_text: z.boolean().optional(),
  /** False skips summary generation and always includes extracted text. */
  summarize: z.boolean().optional(),
  /** Steer the summarizer, e.g. "Focus on the payment terms". */
  instruction: z.string().optional(),
  max_bytes: z.number().int().positive().max(
    HARD_CAP_BYTES,
    `max_bytes must be at most ${HARD_CAP_BYTES} (100 MiB). Use a smaller byte limit or omit it to keep the default cap.`,
  ).optional(),
});


export type ReadPdfInput = z.infer<typeof schema>;
export type ReadPdfOutput = ReadPdfResult;
const CACHED_SCHEMA = Object.freeze(schema.toJSONSchema()) as unknown as JsonSchema;
export function visionAvailable(config: Pick<ToolConfig, 'visionModel' | 'modelIsVision'>): boolean {
  if (config.visionModel && config.visionModel.trim()) return true;
  return config.modelIsVision !== false;
}

/** An empty selection means the active profile, without model-ID lookup. */
export async function resolvePdfModel(ctx: ToolHandlerContext, selection: string): Promise<NativeModelConfig | undefined> {
  const c = ctx.config;
  const selected = selection.trim();
  if (selected) {
    const { resolveModelServerAuth } = await import('../../server-profiles/index.ts');
    const resolved = await resolveModelServerAuth(selected);
    if (!resolved) return undefined;
    return {
      server_url: resolved.baseUrl, model: resolved.modelId, api_key: resolved.apiKey || undefined,
      api_variant: resolved.apiVariant, api_style: resolved.apiStyle,
      request_headers: Object.entries(withProfileRequestHeaders({}, profileRequestHeaderSettings(resolved))),
    };
  }
  if (!c.llmServerUrl || !c.llmModel) return undefined;
  return {
    server_url: c.llmServerUrl, model: c.llmModel, api_key: c.llmApiKey || undefined,
    api_variant: c.llmApiVariant, api_style: c.llmApiStyle,
    request_headers: Object.entries(withProfileRequestHeaders({}, {
      includeLcIdentifierHeader: c.llmIncludeLcIdentifierHeader, lcIdentifierHeader: c.llmLcIdentifierHeader,
      includeAdditionalRequestHeaders: c.llmIncludeAdditionalRequestHeaders, requestHeaders: c.llmRequestHeaders,
    })),
  };
}

export const readPdf: ToolHandler<ReadPdfInput, ReadPdfOutput> = {
  name: 'lc_read_pdf', description: READ_PDF_GUIDANCE.essential,
  uiDescription: 'Read PDFs, summarize, extract text, and inspect visual content.',
  input: schema, toJsonSchema: () => CACHED_SCHEMA,
  run: async (input, ctx) => {
    const deadline = ctx.config.deadlineMs && ctx.config.deadlineMs > 0 ? ctx.config.deadlineMs : Date.now() + DEFAULT_BUDGET_MS;
    const active = () => {
      if (ctx.signal.aborted) throw { code: 'Aborted', message: 'Operation cancelled by user.' };
      if (Date.now() >= deadline) throw { code: 'Timeout', message: 'PDF processing exceeded the tool call time budget.' };
    };
    active();
    const pages = parsePageRange(input.pages, 'pages');
    if (pages.kind === 'invalid') throw { code: READ_PDF_SELECTION_ERROR_CODES.pages, message: `Invalid "pages" value: ${pages.message}` };
    const force = parsePageRange(input.force_render, 'force_render');
    if (force.kind === 'invalid') throw { code: READ_PDF_SELECTION_ERROR_CODES.forceRender, message: `Invalid "force_render" value: ${force.message}` };
    const summarize = input.summarize !== false;
    if (!summarize && (input.depth === 'full' || force.kind === 'ok')) {
      throw { code: 'invalid_arguments', message: 'summarize:false returns extracted text only. Use depth="text_only" and omit force_render, or set summarize:true for visual summarization.' };
    }
    const vision = visionAvailable(ctx.config);
    // Resolving credentials/profile metadata makes no model-readiness request.
    // The native pipeline contacts only models needed by the admitted pages.
    const textModel = summarize ? await resolvePdfModel(ctx, ctx.config.pdfSummarizeModel ?? '') : undefined;
    active();
    const visionModel = summarize && input.depth === 'full' && vision
      ? await resolvePdfModel(ctx, ctx.config.visionModel ?? '') : undefined;
    active();
    const result = await ctx.sandbox.readPdf({
      paths: input.paths, depth: input.depth ?? 'text_only',
      pages: pages.kind === 'ok' ? pages.pages : undefined,
      force_render: force.kind === 'ok' ? force.pages : undefined,
      include_text: !summarize || input.include_text === true, summarize,
      instruction: input.instruction, text_model: textModel, vision_model: visionModel, vision_available: vision,
      max_bytes: input.max_bytes, allowed_roots: ctx.config.allowedRoots,
      call_id: ctx.identity.operationId, group_id: ctx.identity.groupId,
      deadline_ms: Math.max(1, deadline - Date.now()),
    });
    active();
    return result;
  },
};
