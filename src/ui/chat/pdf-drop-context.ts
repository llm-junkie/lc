import { resolveExposure } from '../../modules/tool-engine/index.ts';
import { useConversations } from '../../store/conversations.ts';
import type { PdfDropContext } from './pdf-drop-notice';

/**
 * Resolve PDF-tool availability at gesture time. The main composer and the
 * message edit surface both use this snapshot so their guidance cannot drift.
 */
export function activePdfDropContext(): PdfDropContext {
  const state = useConversations.getState();
  const conv = state.activeId ? state.byId[state.activeId] : undefined;
  const tools = conv?.tools;
  return {
    toolExposed: resolveExposure(tools ?? { enabled: false }).exposedNames.has('lc_read_pdf'),
    allowedRoots: tools?.allowed_roots ?? [],
  };
}
