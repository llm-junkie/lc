import type { Message } from '../../types';
import { buildArchivedToolStub } from './message-history.ts';

/** Structural facts shared by request construction and TokenMeter accounting. */
export interface ToolHistoryProjection {
  /** tool_call_id -> canonical stored tool name for every call in the transcript. */
  readonly callNames: ReadonlyMap<string, string>;
  /** Tool-result message IDs removed by Tool History at this boundary. */
  readonly archivedToolMessageIds: ReadonlySet<string>;
  /** One synthetic result stub per archived assistant tool-call turn. */
  readonly archivedStubs: ReadonlyMap<string, string>;
}

/** Index of the latest real user turn, or -1 when none exists. */
export function findLastUserMessageIndex(messages: readonly Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return index;
  }
  return -1;
}

/**
 * Project the structural part of Tool History in one forward pass.
 *
 * `archiveBoundary` is exclusive. The orchestrator passes the latest user
 * index so the active turn remains intact; TokenMeter passes the same index
 * while active and `messages.length` while idle, when the completed turn has
 * become history.
 */
export function buildToolHistoryProjection(
  messages: readonly Message[],
  archiveBoundary: number,
  historyEnabled: boolean,
): ToolHistoryProjection {
  const callNames = new Map<string, string>();
  const archivedToolMessageIds = new Set<string>();
  const precedingCalls = new Map<string, { assistantId: string; toolName: string }>();
  const stubGroups = new Map<string, { count: number; tools: string[] }>();

  const boundary = historyEnabled
    ? Math.min(Math.max(archiveBoundary, 0), messages.length)
    : 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const seenInMessage = new Set<string>();
      for (const call of message.tool_calls) {
        if (seenInMessage.has(call.id)) continue;
        seenInMessage.add(call.id);
        callNames.set(call.id, call.name);
        precedingCalls.set(call.id, {
          assistantId: message.id,
          toolName: call.name,
        });
      }
      continue;
    }

    if (!historyEnabled
      || index >= boundary
      || message.role !== 'tool'
      || !message.tool_call_id) {
      continue;
    }

    // Request construction removes every protocol tool result before the
    // boundary. Valid transcripts also have an owning assistant call; retain
    // the message-id fact independently so malformed imports cannot make the
    // meter and request builder disagree.
    archivedToolMessageIds.add(message.id);
    const owner = precedingCalls.get(message.tool_call_id);
    if (!owner) continue;

    const group = stubGroups.get(owner.assistantId) ?? { count: 0, tools: [] };
    group.count += 1;
    group.tools.push(owner.toolName);
    stubGroups.set(owner.assistantId, group);
  }

  const archivedStubs = new Map<string, string>();
  for (const [assistantId, group] of stubGroups) {
    archivedStubs.set(
      assistantId,
      buildArchivedToolStub(group.count, assistantId, group.tools),
    );
  }

  return { callNames, archivedToolMessageIds, archivedStubs };
}
