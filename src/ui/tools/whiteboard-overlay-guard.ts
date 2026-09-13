/**
 * Cross-surface guard for leaving an open Whiteboard editor.
 *
 * The overlay owns the in-app confirmation UI. Navigation surfaces only ask
 * whether their requested exit may proceed, so they never fall back to a
 * permissive browser confirmation when that UI is unavailable or throws.
 */

export type WhiteboardOverlayExitReason =
  | 'close'
  | 'escape'
  | 'backdrop'
  | 'conversation-switch'
  | 'conversation-delete'
  | 'new-conversation'
  | 'preview-open'
  | 'settings-open'
  | 'reload'
  | 'parent-unmount';

export type WhiteboardOverlayExitGuard = (
  reason: WhiteboardOverlayExitReason,
) => boolean | Promise<boolean>;

let activeGuard: WhiteboardOverlayExitGuard | null = null;

/** Register the currently mounted Whiteboard overlay as the exit owner. */
export function registerWhiteboardOverlayExitGuard(
  guard: WhiteboardOverlayExitGuard,
): () => void {
  activeGuard = guard;
  return () => {
    if (activeGuard === guard) activeGuard = null;
  };
}

export function isWhiteboardOverlayExitGuardActive(): boolean {
  return activeGuard !== null;
}

/**
 * Ask the active overlay to close. Any unavailable, rejected, or failed
 * confirmation is a denial: unsaved text stays mounted.
 */
export async function requestWhiteboardOverlayExit(
  reason: WhiteboardOverlayExitReason,
): Promise<boolean> {
  const guard = activeGuard;
  if (!guard) return true;
  try {
    return (await guard(reason)) === true;
  } catch {
    return false;
  }
}

/** Test-only reset that cannot affect production state unless imported. */
export function resetWhiteboardOverlayExitGuardForTests(): void {
  activeGuard = null;
}
