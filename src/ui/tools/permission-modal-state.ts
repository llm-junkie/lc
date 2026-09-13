/** Return all scopes approved by the whole-call modal decision. */
export function grantedDirectoriesForDecision(
  dirs: readonly string[],
  decision: 'allow_once' | 'allow_session' | 'deny' | 'unavailable',
): string[] {
  return decision === 'allow_once' || decision === 'allow_session'
    ? [...dirs]
    : [];
}
