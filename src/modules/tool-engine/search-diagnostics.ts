/**
 * One normalized boundary for every `lc_web_search` / `lc_web_research`
 * provider call.
 *
 * Both tools route their search requests through here so success, no-results,
 * and provider failure are recorded the same way. Before this existed only the
 * success path was instrumented, which meant a real provider outage surfaced in
 * a support report as a generic tool error and never as a search failure.
 *
 * What is recorded: the resolved provider, a bounded result-count bucket, and
 * the allowlisted ignored-parameter names. Never the query, the results, the
 * fetched pages, the key, or the exact host. A thrown sandbox/provider error is
 * observed and rethrown unchanged — the diagnostic never alters the outcome.
 */

import { recordDiagnosticEvent } from '../../utils/diagnostic-events.ts';
import { countBucket, type IgnoredSearchParam } from '../../utils/support-report-base.ts';
import type { ConcreteWebSearchProvider } from '../../store/settings';

/** Only these parameter names may ever be serialized. */
const ALLOWED_IGNORED = ['freshness', 'extra_snippets', 'cross_check'] as const;

function allowlistIgnored(names: readonly string[]): IgnoredSearchParam[] {
  return ALLOWED_IGNORED.filter((name) => names.includes(name));
}

/** The tool ran with nothing configured, so no provider call was attempted. */
export function recordSearchNotConfigured(): void {
  recordDiagnosticEvent({
    subsystem: 'search',
    operation: 'call',
    outcome: 'rejected',
    code: 'search-not-configured',
    searchResolved: 'none',
    searchConfigured: false,
  });
}

/**
 * Run one provider search and record its outcome exactly once.
 *
 * `try`/`catch`/`finally` rather than a `.then` chain: a sandbox rejection,
 * an HTTP failure surfaced as a throw, and a normal return all have to reach
 * the same recorder, and the failure code must not depend on the shape of the
 * thrown value.
 */
export async function withSearchCallDiagnostics<T>(
  provider: ConcreteWebSearchProvider,
  ignored: readonly string[],
  run: () => Promise<T>,
  resultCount: (value: T) => number,
): Promise<T> {
  const ignoredParams = allowlistIgnored(ignored);
  const base = {
    subsystem: 'search' as const,
    operation: 'call' as const,
    searchResolved: provider,
    searchConfigured: true,
    ...(ignoredParams.length > 0 ? { ignoredParams } : {}),
  };

  let value: T;
  try {
    value = await run();
  } catch (error) {
    recordDiagnosticEvent({
      ...base,
      outcome: 'error',
      code: 'search-provider-error',
      // Sanitized to a recognized failure class or dropped entirely; the
      // provider body and any query echoed inside it never survive.
      description: error,
    });
    throw error;
  }

  const count = resultCount(value);
  recordDiagnosticEvent({
    ...base,
    outcome: 'ok',
    code: count === 0 ? 'search-no-results' : 'search-ok',
    resultCountBucket: countBucket(count),
  });
  return value;
}
