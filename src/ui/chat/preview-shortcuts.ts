import type { PreviewTab } from '../tools/PreviewOverlay';
import type { TodoSnapshot, TodoSnapshotIndex } from '../../modules/tool-engine';

export interface PreviewTabSelection {
  activeTab: PreviewTab;
  openMessageId: string | null;
  tabOverridden: true;
}

/** A tab click changes content type, not the selected assistant bubble. */
export function previewSelectionForTabClick(
  tab: PreviewTab,
  activeMessageId: string | undefined,
): PreviewTabSelection {
  return {
    activeTab: tab,
    openMessageId: activeMessageId ?? null,
    tabOverridden: true,
  };
}

/** Resolve only snapshots belonging to the selected user turn. The broader
 * `effectiveByAssistantId` map intentionally carries task state across turns
 * for model context, but the preview must not present that as this bubble's UI. */
export function previewTodoSnapshotsAtMessage(
  index: TodoSnapshotIndex,
  activeMessageId: string | undefined,
  latestOnly = false,
): readonly TodoSnapshot[] | undefined {
  const snapshots = activeMessageId
    ? index.turnSnapshotsByAssistantId.get(activeMessageId)
    : undefined;
  if (!latestOnly || !snapshots?.length) return snapshots;
  return [snapshots.at(-1)!];
}

export interface PreviewShortcutEvent {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  isComposing: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  getModifierState?: (key: string) => boolean;
}

export function previewTabForPhase(
  currentTab: PreviewTab,
  manuallySelected: boolean,
  toolsRunning: boolean,
  hasStreamingReasoning: boolean,
): PreviewTab {
  if (manuallySelected) return currentTab;
  if (toolsRunning) return 'tools';
  if (hasStreamingReasoning) return 'reasoning';
  return currentTab;
}

export function previewShortcutTab(
  event: PreviewShortcutEvent,
  isMac: boolean,
): PreviewTab | undefined {
  if (event.isComposing) return undefined;

  if (isMac && event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey) {
    return event.code === 'KeyP' ? 'todo' : undefined;
  }

  if (!isMac && event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey) {
    if (event.getModifierState?.('AltGraph')) return undefined;
    return event.code === 'KeyP' && (event.key === 'p' || event.key === 'P')
      ? 'todo'
      : undefined;
  }

  const primary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary || event.altKey || (event.key !== 'p' && event.key !== 'P')) return undefined;
  return event.shiftKey ? 'tools' : 'reasoning';
}

/**
 * Resolve Ctrl/Cmd+Arrow navigation without assuming that the currently
 * displayed bubble belongs to the active tab's candidate set. A user can, for
 * example, open Reasoning on a bubble and then click To do list; that bubble
 * stays selected and may show an empty state. In that state a single directly
 * owning older todo bubble is still a real navigation target.
 */
export function previewNavigationIndex(
  candidateCount: number,
  currentIndex: number,
  direction: 'previous' | 'next',
): number | undefined {
  if (!Number.isInteger(candidateCount) || candidateCount <= 0) return undefined;
  if (currentIndex < 0 || currentIndex >= candidateCount) {
    return direction === 'next' ? 0 : candidateCount - 1;
  }
  if (candidateCount === 1) return undefined;
  return direction === 'next'
    ? (currentIndex + 1) % candidateCount
    : (currentIndex - 1 + candidateCount) % candidateCount;
}
