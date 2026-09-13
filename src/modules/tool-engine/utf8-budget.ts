const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * Longest whole-code-point prefix of `text` that encodes to at most
 * `maxBytes` UTF-8 bytes. Never splits a surrogate pair, so the result is
 * always valid UTF-8. Unlike `truncateUtf8` it adds no marker text, which
 * matters where invented characters could be mistaken for stored content.
 */
export function takeUtf8Prefix(text: string, maxBytes: number): string {
  return takePrefix(text, Math.max(0, Math.floor(maxBytes)));
}

function takePrefix(text: string, maxBytes: number): string {
  let used = 0;
  let output = '';
  for (const char of text) {
    const size = utf8ByteLength(char);
    if (used + size > maxBytes) break;
    output += char;
    used += size;
  }
  return output;
}

function takeSuffix(text: string, maxBytes: number): string {
  let used = 0;
  const output: string[] = [];
  const chars = Array.from(text);
  for (let index = chars.length - 1; index >= 0; index--) {
    const char = chars[index];
    const size = utf8ByteLength(char);
    if (used + size > maxBytes) break;
    output.push(char);
    used += size;
  }
  return output.reverse().join('');
}

/** Return valid UTF-8 text whose encoded size never exceeds maxBytes. */
export function truncateUtf8(
  text: string,
  maxBytes: number,
  marker = '\n… [truncated]\n',
): { text: string; truncated: boolean; originalBytes: number; returnedBytes: number } {
  const limit = Math.max(0, Math.floor(maxBytes));
  const originalBytes = utf8ByteLength(text);
  if (originalBytes <= limit) {
    return { text, truncated: false, originalBytes, returnedBytes: originalBytes };
  }
  if (limit === 0) {
    return { text: '', truncated: true, originalBytes, returnedBytes: 0 };
  }

  const markerBytes = utf8ByteLength(marker);
  if (markerBytes >= limit) {
    const output = takePrefix(text, limit);
    return {
      text: output,
      truncated: true,
      originalBytes,
      returnedBytes: utf8ByteLength(output),
    };
  }

  const contentBudget = limit - markerBytes;
  const headBudget = Math.floor(contentBudget * 0.7);
  const tailBudget = contentBudget - headBudget;
  const output = takePrefix(text, headBudget) + marker + takeSuffix(text, tailBudget);
  return {
    text: output,
    truncated: true,
    originalBytes,
    returnedBytes: utf8ByteLength(output),
  };
}
