/**
 * The shape of the most recent provider request that actually ran.
 *
 * Why this exists: the support report used to reconstruct "the active request"
 * from whichever conversation and profile happened to be selected when the
 * report was generated. That is a description of the UI, not of a request.
 * Switching conversations, or editing a profile after a failure, silently
 * rewrote the facts a maintainer was trying to read. This module captures the
 * facts once, at the real request-assembly boundary, and keeps them.
 *
 * Privacy: every field is a closed enum, a boolean, or a bounded number. The
 * snapshot deliberately holds no model identifier, profile or conversation id,
 * endpoint, header, body, message, tool schema, or prompt. `endpointClass` is
 * the classification of the base URL, never any part of the host.
 *
 * The snapshot is in-memory only. It is never persisted, so it cannot outlive
 * the session that observed it.
 */

import type {
  CacheSurface,
  DiagnosticApiStyle,
  DiagnosticProtocol,
  DiagnosticRouting,
  EndpointClass,
  ReasoningEffortLevel,
} from '../../utils/support-report-base';

/** Capability and context facts the request path cannot derive by itself. */
export interface RequestModelFacts {
  /** Resolved capabilities for the model this request used. */
  capabilities?: {
    vision?: boolean;
    reasoning?: boolean;
    tools?: boolean;
  };
  /** Whether a context-window size was known for the model (support-report.md). */
  contextWindowKnown?: boolean;
}

export interface ActiveRequestSnapshot extends RequestModelFacts {
  protocol: DiagnosticProtocol;
  apiStyle: DiagnosticApiStyle;
  routing: DiagnosticRouting;
  endpointClass: EndpointClass;
  cacheSurface: CacheSurface;
  reasoningEnabled: boolean;
  reasoningEffort: ReasoningEffortLevel;
  /** Read timeout actually applied to this request, bucketed by the builder. */
  streamTimeoutMs?: number;
  /** Tool definitions in the final structured payload, not configuration keys. */
  toolDefinitionCount: number;
  /** When it was captured. Used only to prefer the latest observation. */
  at: number;
}

const MAX_RECENT_SESSIONS = 12;
const recentBySession = new Map<string, ActiveRequestSnapshot>();
let latest: ActiveRequestSnapshot | null = null;

/**
 * Record the shape of a request at the moment it is sent.
 *
 * Called from the provider boundary for every chat request, including ones
 * that go on to fail: a failed request is exactly the one a support report
 * needs to describe.
 */
export function recordActiveRequestSnapshot(
  snapshot: ActiveRequestSnapshot,
  sessionKey = 'unscoped',
): void {
  try {
    latest = snapshot;
    recentBySession.delete(sessionKey);
    recentBySession.set(sessionKey, snapshot);
    while (recentBySession.size > MAX_RECENT_SESSIONS) {
      const oldest = recentBySession.keys().next().value;
      if (oldest === undefined) break;
      recentBySession.delete(oldest);
    }
  } catch {
    // A diagnostic must never change the outcome of the observed operation.
  }
}

/** Bounded snapshots only; internal session keys are intentionally omitted. */
export function readRecentRequestSnapshots(): readonly ActiveRequestSnapshot[] {
  return [...recentBySession.values()];
}

/** The last request that actually ran, or `null` when none has. */
export function readActiveRequestSnapshot(): ActiveRequestSnapshot | null {
  return latest;
}

/** Test seam. Never used by production code paths. */
export function resetActiveRequestSnapshot(): void {
  latest = null;
  recentBySession.clear();
}

const EFFORTS: readonly ReasoningEffortLevel[] = [
  'none', 'low', 'medium', 'high', 'xhigh', 'max', 'unknown',
];

/** Clamp a provider-facing effort string to the closed vocabulary. */
export function reasoningEffortLevel(value: unknown): ReasoningEffortLevel {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)
    ? value as ReasoningEffortLevel
    : 'unknown';
}

/**
 * How many tool definitions the provider will actually receive.
 *
 * Counted from the final structured payload rather than from the persisted
 * tools configuration, whose keys are policy fields (`enabled`, `tool_grants`,
 * `allowed_roots`, limits, …) and have nothing to do with what was sent.
 */
export function toolDefinitionCount(body: unknown, fallback?: readonly unknown[]): number {
  if (body !== null && typeof body === 'object') {
    const tools = (body as Record<string, unknown>).tools;
    if (Array.isArray(tools)) return tools.length;
  }
  return Array.isArray(fallback) ? fallback.length : 0;
}
