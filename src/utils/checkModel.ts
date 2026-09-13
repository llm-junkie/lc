/**
 * Pre-flight check: verify a model is reachable on the server before
 * sending an expensive vision / research request.  Uses `LLMClient`
 * (the same API client the ModelPicker's Refresh button uses) so
 * proxy rewriting, auth, and response parsing are handled centrally.
 *
 * A quick model-list GET is practically free (no GPU compute),
 * so we catch "model not loaded" or "server unreachable" in
 * milliseconds instead of waiting for a 120-second HTTP timeout.
 */

import type { ToolHandlerContext } from '../modules/tool-engine/types';
import { LLMClient, profileRequestHeaderSettings } from '../modules/llm-client/index.ts';
import { resolveModelServer } from '../modules/server-profiles/index.ts';
import { resolveProfileCredential } from '../platform/chat-credential.ts';

export type ModelCheckResult =
  | { ok: true; found: true; loaded: true }
  | { ok: false; found: true; loaded: false; error: string }
  | { ok: false; found: false; loaded: false; error: string };

/**
 * Ping the server's model list via `LLMClient.listModels()` and check
 * whether `modelName` is **loaded** (actively running, not just known).
 * If the model exists but isn't loaded, LM Studio will auto-load it on
 * first request — which can OOM the server if another model is already
 * eating GPU memory.  We catch this early and tell the model to ask
 * the user to load it manually.
 */
export async function checkModelLoaded(
  ctx: ToolHandlerContext,
  modelRef: string,
): Promise<ModelCheckResult> {
  if (ctx.signal.aborted) {
    throw { code: 'Aborted', message: 'Operation cancelled by user.' };
  }
  const resolved = resolveModelServer(modelRef);
  if (!resolved) {
    return {
      ok: false, found: false, loaded: false,
      error: `Cannot resolve model "${modelRef}" to any known server profile. Check Settings → Agentic tools.`,
    };
  }
  if (!resolved.baseUrl) {
    return {
      ok: false, found: false, loaded: false,
      error: 'No server URL configured — cannot check model availability.',
    };
  }
  if (!resolved.modelId) {
    return {
      ok: false, found: false, loaded: false,
      error: 'No model name configured for this operation. Set a vision model or web research model in Settings.',
    };
  }

  try {
    // Resolve API key: prefer keychain, fall back to plaintext.
    const apiKey = await resolveProfileCredential(resolved);
    const client = new LLMClient({
      baseUrl: resolved.baseUrl,
      modelFetchUrl: resolved.modelFetchUrl,
      apiKey,
      apiVariant: 'openai',
      routing: 'proxy',
      ...profileRequestHeaderSettings(resolved),
    });
    const list = await client.listModels(ctx.signal);
    const entry = list.find((m) => m.id === resolved.modelId) as unknown as Record<string, unknown> | undefined;

    if (!entry) {
      return {
        ok: false, found: false, loaded: false,
        error:
          `Model "${resolved.modelId}" is not known to the server ` +
          `(${resolved.baseUrl}). Check the model name in Settings.`,
      };
    }

    // `state` is an LM Studio extension: only entries from its native REST
    // endpoint carry it (see restModelToInfo). A plain OpenAI-compatible
    // /v1/models — llama.cpp, vLLM, … — reports no load state at all, and a
    // model it lists is by definition being served. Treat `undefined` as
    // loaded, exactly as the ModelPicker does; only an explicit non-loaded
    // state blocks the request.
    const isLoaded = entry.state === undefined || entry.state === 'loaded';

    if (!isLoaded) {
      return {
        ok: false, found: true, loaded: false,
        error:
          `Sub-agent "${resolved.modelId}" exists on the server but is NOT ` +
          `currently loaded. Ask the user to load "${resolved.modelId}" manually.`,
      };
    }

    return { ok: true, found: true, loaded: true };
  } catch (err) {
    if (ctx.signal.aborted) {
      throw { code: 'Aborted', message: 'Operation cancelled by user.' };
    }
    return {
      ok: false, found: false, loaded: false,
      error:
        `Could not reach server at ${resolved.baseUrl}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Is the server running?`,
    };
  }
}
