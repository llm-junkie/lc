/** Clipboard write that survives a WebView denying the async clipboard API.
 *
 *  The Tauri WebView does not always grant `navigator.clipboard` (it is
 *  gated on a secure context and, on some platforms, on user activation
 *  the framework has already consumed). The hidden-textarea +
 *  `execCommand('copy')` path is the fallback that still works there.
 *  Rejects when both paths fail, so callers can surface the failure. */
export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to the WebView selection-based copy path.
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    if (!document.execCommand('copy')) {
      throw new Error('Clipboard copy was denied');
    }
  } finally {
    textarea.remove();
  }
}
