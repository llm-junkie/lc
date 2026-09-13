/** Conversation/generation-keyed imperative response-phase observer. */
export type PhaseState = 'idle' | 'started' | 'running' | 'finished';

export interface ResponsePhase {
  reasoning: PhaseState;
  toolUse: PhaseState;
  textResponse: PhaseState;
}

type Listener = (phase: ResponsePhase, changed: (keyof ResponsePhase)[]) => void;

const INITIAL: Readonly<ResponsePhase> = Object.freeze({
  reasoning: 'idle',
  toolUse: 'idle',
  textResponse: 'idle',
});

interface GenerationPhaseEntry {
  generationId: string;
  phase: ResponsePhase;
}

const currentByConversation = new Map<string, GenerationPhaseEntry>();
const listenersByConversation = new Map<string, Set<Listener>>();

function transition(
  conversationId: string,
  generationId: string,
  updates: Partial<ResponsePhase>,
): void {
  const existing = currentByConversation.get(conversationId);
  const current = existing?.generationId === generationId ? existing.phase : INITIAL;
  const changed: (keyof ResponsePhase)[] = [];
  const next = { ...current };
  for (const key of Object.keys(updates) as (keyof ResponsePhase)[]) {
    const value = updates[key];
    if (value !== undefined && value !== next[key]) {
      next[key] = value;
      changed.push(key);
    }
  }
  if (changed.length === 0 && existing?.generationId === generationId) return;
  currentByConversation.set(conversationId, { generationId, phase: next });
  const notified = changed.length > 0 ? changed : ['reasoning', 'toolUse', 'textResponse'] as const;
  for (const listener of listenersByConversation.get(conversationId) ?? []) {
    try {
      listener(next, [...notified]);
    } catch {
      // A UI listener must not affect generation progress.
    }
  }
}

export function onPhaseChange(conversationId: string, listener: Listener): () => void {
  let listeners = listenersByConversation.get(conversationId);
  if (!listeners) {
    listeners = new Set();
    listenersByConversation.set(conversationId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners!.delete(listener);
    if (listeners!.size === 0) listenersByConversation.delete(conversationId);
  };
}

export function getPhase(conversationId: string): Readonly<ResponsePhase> {
  return currentByConversation.get(conversationId)?.phase ?? INITIAL;
}

export function resetAll(conversationId: string, generationId: string): void {
  transition(conversationId, generationId, { ...INITIAL });
}

export function clearGenerationPhase(conversationId: string, generationId: string): void {
  const existing = currentByConversation.get(conversationId);
  if (!existing || existing.generationId !== generationId) return;
  transition(conversationId, generationId, { ...INITIAL });
  currentByConversation.delete(conversationId);
}

export function reasoningStarted(conversationId: string, generationId: string): void {
  transition(conversationId, generationId, { reasoning: 'started' });
}
export function reasoningRunning(conversationId: string, generationId: string): void {
  transition(conversationId, generationId, { reasoning: 'running' });
}
export function reasoningFinished(conversationId: string, generationId: string): void {
  transition(conversationId, generationId, { reasoning: 'finished' });
}
export function toolUseStarted(conversationId: string, generationId: string): void {
  transition(conversationId, generationId, { toolUse: 'started' });
}
export function toolUseRunning(conversationId: string, generationId: string): void {
  transition(conversationId, generationId, { toolUse: 'running' });
}
export function toolUseFinished(conversationId: string, generationId: string): void {
  transition(conversationId, generationId, { toolUse: 'finished' });
}
export function textResponseStarted(conversationId: string, generationId: string): void {
  transition(conversationId, generationId, { textResponse: 'started' });
}
export function textResponseRunning(conversationId: string, generationId: string): void {
  transition(conversationId, generationId, { textResponse: 'running' });
}
export function textResponseFinished(conversationId: string, generationId: string): void {
  transition(conversationId, generationId, { textResponse: 'finished' });
}

export function resetResponseStatusForTests(): void {
  currentByConversation.clear();
  listenersByConversation.clear();
}
