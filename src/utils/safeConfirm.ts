/**
 * Safe wrapper around window.confirm().
 *
 * Tauri v2 overrides `window.confirm()` to return a Promise (it calls
 * the async dialog IPC). When the dialog plugin permission is
 * misconfigured, the Promise rejects asynchronously — a synchronous
 * try/catch won't catch it. This wrapper awaits the result and catches
 * the rejection, falling back to allowing the action. Destructive
 * actions already have secondary safety nets (hover warnings,
 * DangerAction tooltips).
 */
export async function safeConfirm(message: string): Promise<boolean> {
  try {
    return await confirm(message);
  } catch {
    // Tauri webview blocks confirm — allow the action through.
    // The caller is responsible for providing adequate warnings.
    return true;
  }
}
