/**
 * Generation session manager — process-local ownership of running responses.
 *
 * Before this existed, a generation's runtime state lived in `ChatView`: one
 * `busy` flag, one TPS value, one `AbortController` ref, and a page-exit
 * handler that only worked while that component happened to be mounted. That
 * arrangement can only ever describe one response, and it ties a response's
 * lifetime to a React component that unmounts whenever the user navigates.
 *
 * The manager separates the two. Runtime objects — controllers, credentials,
 * promises — live here and never enter a persisted store. React receives only
 * a small serializable projection per conversation, so a component can render
 * a session it does not own.
 *
 * Capacity is application-configurable up to the verified hard maximum of
 * three. Ownership and cleanup remain addressed by conversation/generation.
 */

/** Supported hard maximum concurrent generation sessions. */
export const GENERATION_CAPACITY = 3;

/** Conservative product default; Settings may select one or the hard maximum. */
export const DEFAULT_GENERATION_CAPACITY = 2;

/**
 * The limit actually enforced.
 *
 * Separate from the default because the registry mechanism and admission
 * policy are different things. Runtime settings may lower the policy for
 * rollback, and focused tests may temporarily select another supported value.
 */
let capacity = DEFAULT_GENERATION_CAPACITY;

/** The limit in force right now. */
export function generationCapacity(): number {
  return capacity;
}

export function configureGenerationCapacity(next: number): void {
  capacity = Math.max(1, Math.min(GENERATION_CAPACITY, Math.floor(next) || 1));
}

const profileLimits = new Map<string, number>();

/** Default is unlimited inside the application cap. */
export function profileGenerationLimit(profileId: string): number {
  return profileLimits.get(profileId) ?? Number.POSITIVE_INFINITY;
}

export function setProfileGenerationLimit(profileId: string, next?: number | null): void {
  if (next == null || !Number.isFinite(next)) {
    profileLimits.delete(profileId);
    return;
  }
  profileLimits.set(profileId, Math.max(1, Math.min(GENERATION_CAPACITY, Math.floor(next))));
}

/**
 * Test seam: raise or lower the enforced limit without mutating settings.
 */
export function setGenerationCapacityForTests(next: number): void {
  configureGenerationCapacity(next);
}

/**
 * What a session is doing, as far as the UI needs to know.
 *
 * The phase tracker updates this conversation/generation-owned projection as
 * streaming moves through thinking, writing, tools, and interaction waits.
 */
export type GenerationSessionPhase =
  | 'admitting'
  | 'running'
  | 'thinking'
  | 'writing'
  | 'using-tools'
  | 'waiting-permission'
  | 'waiting-user'
  | 'stopping'
  | 'finalizing'
  | 'failed';

/** Runtime entry. Never serialized, never persisted, never sent to React. */
export interface GenerationSessionRuntime {
  conversationId: string;
  generationId: string;
  assistantMessageId: string;
  controller: AbortController;
  startedAt: number;
  phase: GenerationSessionPhase;
  tps: number | null;
}

/** The safe projection React subscribes to. */
export interface GenerationSessionView {
  conversationId: string;
  generationId: string;
  assistantMessageId: string;
  phase: GenerationSessionPhase;
  tps: number | null;
  startedAt: number;
}

export type GenerationAttentionKind = 'completed' | 'failed';

export interface GenerationAttentionView {
  conversationId: string;
  generationId: string;
  kind: GenerationAttentionKind;
  at: number;
}

export interface StartSessionInput {
  conversationId: string;
  generationId: string;
  assistantMessageId: string;
  controller: AbortController;
}

type Listener = () => void;

const sessions = new Map<string, GenerationSessionRuntime>();
const listeners = new Set<Listener>();
const listenersByConversation = new Map<string, Set<Listener>>();
const attention = new Map<string, GenerationAttentionView>();

/**
 * Cached projections.
 *
 * `useSyncExternalStore` compares snapshots by identity, so a view object has
 * to stay referentially stable until something about the session actually
 * changes. Rebuilding it on every read would re-render forever.
 */
const views = new Map<string, GenerationSessionView>();

/** Monotonic counter for aggregate consumers and diagnostics. */
let version = 0;

function publish(conversationId: string): void {
  version += 1;
  const runtime = sessions.get(conversationId);
  if (!runtime) views.delete(conversationId);
  else {
    views.set(conversationId, {
      conversationId: runtime.conversationId,
      generationId: runtime.generationId,
      assistantMessageId: runtime.assistantMessageId,
      phase: runtime.phase,
      tps: runtime.tps,
      startedAt: runtime.startedAt,
    });
  }
  const changedListeners = new Set(listeners);
  for (const listener of listenersByConversation.get(conversationId) ?? []) {
    changedListeners.add(listener);
  }
  for (const listener of changedListeners) {
    try {
      listener();
    } catch {
      // One bad subscriber must not stop the others from updating.
    }
  }
}

/** Read the global session change counter. */
export function getGenerationSessionsVersion(): number {
  return version;
}

/** Subscribe to any session change. Returns an unsubscribe function. */
export function subscribeToGenerationSessions(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The projection for one conversation, or `undefined` when it has no session.
 *
 * Stable across reads, so it can be used directly as a `useSyncExternalStore`
 * snapshot.
 */
export function getGenerationSessionView(
  conversationId: string | null | undefined,
): GenerationSessionView | undefined {
  return conversationId ? views.get(conversationId) : undefined;
}

/** Subscribe only to changes owned by one conversation. */
export function subscribeToGenerationSession(
  conversationId: string,
  listener: Listener,
): () => void {
  const scoped = listenersByConversation.get(conversationId) ?? new Set<Listener>();
  scoped.add(listener);
  listenersByConversation.set(conversationId, scoped);
  return () => {
    scoped.delete(listener);
    if (scoped.size === 0) listenersByConversation.delete(conversationId);
  };
}

/** Unread terminal state retained after the runtime session has been removed. */
export function getGenerationAttention(
  conversationId: string | null | undefined,
): GenerationAttentionView | undefined {
  return conversationId ? attention.get(conversationId) : undefined;
}

/** Viewing a conversation acknowledges its background completion/error. */
export function clearGenerationAttention(conversationId: string): void {
  if (!attention.delete(conversationId)) return;
  publish(conversationId);
}

/** A corpus wipe releases every unread terminal projection. */
export function clearAllGenerationAttention(): void {
  const conversationIds = [...attention.keys()];
  if (conversationIds.length === 0) return;
  attention.clear();
  for (const conversationId of conversationIds) publish(conversationId);
}

/** The runtime entry. Callers inside the pipeline only. */
export function getGenerationSession(
  conversationId: string,
): GenerationSessionRuntime | undefined {
  return sessions.get(conversationId);
}

export function activeGenerationCount(): number {
  return sessions.size;
}

export function hasGenerationCapacity(): boolean {
  return sessions.size < capacity;
}

/** Whether this conversation is the owner of a live session. */
export function isGenerationSessionOwner(
  conversationId: string,
  generationId: string,
): boolean {
  return sessions.get(conversationId)?.generationId === generationId;
}

/**
 * Register a running session.
 *
 * The caller has already crossed its durable admission boundary; this records
 * the runtime half. Registering a second session for one conversation is a
 * programming error, not a race to tolerate — the durable admission path
 * already fenced it.
 */
function registerGenerationSession(
  input: StartSessionInput,
  enforcedCapacity: number,
): GenerationSessionRuntime {
  const existing = sessions.get(input.conversationId);
  if (existing) {
    throw new Error(
      `Conversation ${input.conversationId} already owns generation ${existing.generationId}.`,
    );
  }
  // The manager enforces the cap itself rather than trusting whichever
  // admission path called it. An advisory registry that silently accepts an
  // over-capacity session would make the limit a convention instead of an
  // invariant, and the failure would only surface as resource exhaustion.
  if (sessions.size >= enforcedCapacity) {
    throw new Error(`All ${enforcedCapacity} generation slots are in use.`);
  }
  const runtime: GenerationSessionRuntime = {
    ...input,
    startedAt: Date.now(),
    phase: 'running',
    tps: null,
  };
  attention.delete(input.conversationId);
  sessions.set(input.conversationId, runtime);
  publish(input.conversationId);
  return runtime;
}

export function startGenerationSession(input: StartSessionInput): GenerationSessionRuntime {
  return registerGenerationSession(input, capacity);
}

/**
 * Register work whose admission was committed before its durable transcript
 * boundary. A later Settings reduction governs future commits; it must not
 * terminate or strand work the store has already accepted. The verified hard
 * maximum remains enforced as a final programming-error backstop.
 */
export function startCommittedGenerationSession(
  input: StartSessionInput,
): GenerationSessionRuntime {
  return registerGenerationSession(input, GENERATION_CAPACITY);
}

/**
 * Remove a session, but only if the named generation still owns it.
 *
 * The fence matters: a late `finally` from a generation that was already
 * replaced must not deregister its successor.
 */
export function endGenerationSession(
  conversationId: string,
  generationId: string,
  options: { unread?: boolean; outcome?: GenerationAttentionKind } = {},
): boolean {
  const runtime = sessions.get(conversationId);
  if (!runtime || runtime.generationId !== generationId) return false;
  sessions.delete(conversationId);
  if (options.unread) {
    attention.set(conversationId, {
      conversationId,
      generationId,
      kind: options.outcome ?? (runtime.phase === 'failed' ? 'failed' : 'completed'),
      at: Date.now(),
    });
  } else {
    attention.delete(conversationId);
  }
  publish(conversationId);
  return true;
}

/** Record the live token rate for a session. Ignored once it is replaced. */
export function setGenerationSessionTps(
  conversationId: string,
  generationId: string,
  tps: number | null,
): void {
  const runtime = sessions.get(conversationId);
  if (!runtime || runtime.generationId !== generationId) return;
  if (runtime.tps === tps) return;
  runtime.tps = tps;
  publish(conversationId);
}

/** Move a session to a new phase. Ignored once it is replaced. */
export function setGenerationSessionPhase(
  conversationId: string,
  generationId: string,
  phase: GenerationSessionPhase,
): void {
  const runtime = sessions.get(conversationId);
  if (!runtime || runtime.generationId !== generationId) return;
  if (runtime.phase === phase) return;
  runtime.phase = phase;
  publish(conversationId);
}

/**
 * Abort one conversation's session.
 *
 * Marks it stopping before aborting, so anything reading the projection sees
 * the transition rather than a session that silently stops producing output.
 * The entry stays registered until the pipeline settles and calls
 * `endGenerationSession`; that is what stops late work from starting a
 * replacement generation or mutating this one.
 *
 * `expectedGenerationId` fences the cancellation. A user pressing Stop means
 * "stop whatever is running here" and passes nothing; a deferred callback
 * holding a generation it captured earlier must pass it, or it can cancel the
 * replacement that started after the one it meant to stop.
 *
 * Returns the runtime that was cancelled, so the caller can perform the
 * durable finalization it owns.
 */
export function cancelGenerationSession(
  conversationId: string,
  expectedGenerationId?: string,
): GenerationSessionRuntime | undefined {
  const runtime = sessions.get(conversationId);
  if (!runtime) return undefined;
  if (expectedGenerationId !== undefined && runtime.generationId !== expectedGenerationId) {
    return undefined;
  }
  setGenerationSessionPhase(conversationId, runtime.generationId, 'stopping');
  runtime.controller.abort();
  return runtime;
}

/**
 * Every live session, as a snapshot the caller can iterate while terminalizing.
 *
 * Returns a copied array because callers mutate the registry as they go.
 */
export function activeGenerationSessions(): GenerationSessionRuntime[] {
  return [...sessions.values()];
}

/** Test seam: clear every projection, notify its owner, and restore defaults. */
export function resetGenerationSessionsForTests(): void {
  capacity = DEFAULT_GENERATION_CAPACITY;
  profileLimits.clear();
  const ids = new Set([...sessions.keys(), ...attention.keys()]);
  sessions.clear();
  views.clear();
  attention.clear();
  for (const id of ids) publish(id);
}
