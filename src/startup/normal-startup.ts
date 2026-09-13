import type { StartupFailureCode } from './startup-state';
import type { StartupLifecycle } from './startup-runtime';

export type NormalStartupResult =
  | { ok: true }
  | {
    ok: false;
    code: Extract<
      StartupFailureCode,
      'conversation-storage-unavailable' | 'conversation-metadata-unavailable'
    >;
    cause: unknown;
  };

/** Testable normal-start coordinator; dependencies are injected by App. */
export async function initializeNormalStartup(
  startup: StartupLifecycle | undefined,
  dependencies: {
    openStorage: () => Promise<void>;
    hydrateConversationMetadata: () => Promise<void>;
  },
): Promise<NormalStartupResult> {
  try {
    await dependencies.openStorage();
  } catch (cause) {
    const code = 'conversation-storage-unavailable';
    startup?.failure(code);
    return { ok: false, code, cause };
  }
  startup?.phase('storage-opened');

  try {
    await dependencies.hydrateConversationMetadata();
  } catch (cause) {
    const code = 'conversation-metadata-unavailable';
    startup?.failure(code);
    return { ok: false, code, cause };
  }

  startup?.phase('conversation-metadata-loaded');
  startup?.phase('shell-mounted');
  startup?.ready();
  return { ok: true };
}
