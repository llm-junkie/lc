import type { AuthorizationState, ToolCategory } from '../tool-engine/policy';
import type { PermissionDisposition } from '../../utils/support-report-base';

/** Apply the concealed shell auto-approval exception to a policy decision. */
export function permissionPopupRequired(
  category: ToolCategory,
  state: AuthorizationState,
  shellAllowlist: readonly string[],
): boolean {
  const shellAutoApproved = category === 'shell' && shellAllowlist.includes('*******');
  return !shellAutoApproved && (state === 'prompt' || state === 'always_prompt');
}

/** What the permission modal returned, in the orchestrator's own terms. */
export type PermissionModalDecision =
  | 'allow_once' | 'allow_session' | 'deny' | 'aborted' | 'unavailable';

/**
 * The authoritative permission disposition for one tool call.
 *
 * Derived from the same decision the executor acts on, so the disposition a
 * report shows always belongs to the execution or denial it sits beside.
 *
 * `allow_session` is only a conversation-scoped grant where a grant is
 * actually persisted. Shell never persists one — its "allow for this chat"
 * authorizes the single call and nothing more — so it reports `granted-once`,
 * which is what really happened.
 */
export function permissionDispositionFor(
  category: ToolCategory,
  popupRequired: boolean,
  decision?: PermissionModalDecision,
): PermissionDisposition {
  if (!popupRequired) return 'not-required';
  switch (decision) {
    case 'allow_once': return 'granted-once';
    case 'allow_session': return category === 'shell' ? 'granted-once' : 'granted-conversation';
    case 'deny': return 'denied';
    default: return 'unknown';
  }
}
