import {
  decodeLcResultJson,
  encodeLcResultJson,
} from './tool-result-content.ts';

export const READ_IMAGE_WARNINGS = Object.freeze({
  visionUnsupported:
    'This model does not support vision. ' +
    'Call lc_read_image with analyze:true to get text descriptions instead.',
  deliveryCacheMiss:
    "The image payload is not available in LC's transient delivery cache. " +
    'LC sent no image to the model. ' +
    'Call lc_read_image again with fewer paths or a smaller downscale value. ' +
    'You can also set encoding to "low_jpeg" or "medium_jpeg".',
});

/** Keep analysis content separate if a native boundary duplicates its warning. */
export function normalizeReadImageDescription(
  description: string | null | undefined,
  warning: string | null | undefined,
): string | null {
  let normalized = description?.trim() ?? '';
  const normalizedWarning = warning?.trim() ?? '';
  if (normalizedWarning) {
    if (normalized === normalizedWarning) return null;
    if (normalized.startsWith(`${normalizedWarning}\n\n`)) {
      normalized = normalized.slice(normalizedWarning.length).trim();
    }
  }
  return normalized || null;
}

/** Set the structured warning on a persisted lc_read_image result. */
export function setReadImageResultWarning(content: string, warning: string): string {
  const decoded = decodeLcResultJson(content);
  if (!decoded?.data || typeof decoded.data !== 'object' || Array.isArray(decoded.data)) {
    return content;
  }

  const result = decoded.data as Record<string, unknown>;
  const existing = typeof result.warning === 'string' ? result.warning.trim() : '';
  result.warning = existing
    ? (existing.includes(warning) ? existing : `${existing} ${warning}`)
    : warning;
  return encodeLcResultJson(result, decoded.notices);
}
