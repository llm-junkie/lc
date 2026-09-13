/**
 * Keyboard shortcuts hook — installs app-wide hotkeys (Ctrl+N, Ctrl+,, etc.).
 *
 * Extracted from App.tsx per Phase 6.
 */
import { useEffect } from 'react';
import { useProfileStore } from '../../modules/server-profiles/index.ts';
import {
  useConversations,
  isConversationCorpusMutationActive,
} from '../../store/conversations.ts';
import { installShortcuts } from '../../utils/shortcuts.ts';
import { installContextMenuPolicy } from '../../utils/context-menu.ts';
import { toast } from '../../utils/toast.ts';
import { requestWhiteboardOverlayExit } from '../../ui/tools/whiteboard-overlay-guard.ts';
import { useConversationUi, type SidePanelTab } from '../../store/conversation-ui.ts';

export function useKeyboardShortcuts(opts: {
  setSettingsOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  setKbdShortcutsOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  setSupportReportOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
}) {
  const { setSettingsOpen, setKbdShortcutsOpen, setSupportReportOpen } = opts;
  const create = useConversations((s) => s.create);

  useEffect(() => {
    const off = installShortcuts();
    // Native right-click menu: kept in text fields (spelling suggestions),
    // suppressed on page content. See utils/context-menu.ts.
    const offContextMenu = installContextMenuPolicy();

    const onNew = async () => {
      if (isConversationCorpusMutationActive()) {
        toast.info('Wait for the current storage operation to finish before starting a new chat.');
        return;
      }
      if (!await requestWhiteboardOverlayExit('new-conversation')) return;
      const store = useProfileStore.getState();
      const firstToggled = store.profiles.find((p) => p.active) ?? store.profiles[0];
      if (!firstToggled) {
        setSettingsOpen(true);
        return;
      }
      create({ serverId: firstToggled.id });
    };

    const onFocus = () => {
      const el = document.querySelector<HTMLTextAreaElement>('.composer textarea');
      el?.focus();
    };

    const onSettings = async () => {
      if (!await requestWhiteboardOverlayExit('settings-open')) return;
      setSettingsOpen((o) => !o);
    };
    const toggleSelectedSidePanel = (tab?: SidePanelTab | false) => {
      const conversationId = useConversations.getState().activeId;
      if (!conversationId) return;
      const ui = useConversationUi.getState();
      const current = ui.get(conversationId);
      if (tab === false) ui.setSidePanel(conversationId, false);
      else if (tab) {
        if (!current.sidePanelOpen) ui.setSidePanel(conversationId, true, tab);
        else if (current.sidePanelTab !== tab) ui.setSidePanel(conversationId, true, tab);
        else ui.setSidePanel(conversationId, false);
      }
    };
    const onToggleSidePanel = () => toggleSelectedSidePanel('params');
    const onToggleSidePanelWorkspace = () => toggleSelectedSidePanel('tools');

    const onEsc = () => {
      setSettingsOpen(false);
      toggleSelectedSidePanel(false);
      document.querySelector<HTMLElement>('.messages')?.focus();
    };

    const onReload = async () => {
      if (!await requestWhiteboardOverlayExit('reload')) return;
      window.location.reload();
    };
    const onShowKbdShortcuts = () => setKbdShortcutsOpen((o) => !o);
    const onShowSupportReport = () => setSupportReportOpen(true);

    window.addEventListener('lc:new-chat', onNew);
    window.addEventListener('lc:focus-composer', onFocus);
    window.addEventListener('lc:open-settings', onSettings);
    window.addEventListener('lc:toggle-sidepanel', onToggleSidePanel);
    window.addEventListener('lc:toggle-sidepanel-workspace', onToggleSidePanelWorkspace);
    window.addEventListener('lc:escape', onEsc);
    window.addEventListener('lc:reload', onReload);
    window.addEventListener('lc:show-keyboard-shortcuts', onShowKbdShortcuts);
    window.addEventListener('lc:show-support-report', onShowSupportReport);

    return () => {
      off();
      offContextMenu();
      window.removeEventListener('lc:new-chat', onNew);
      window.removeEventListener('lc:focus-composer', onFocus);
      window.removeEventListener('lc:open-settings', onSettings);
      window.removeEventListener('lc:toggle-sidepanel', onToggleSidePanel);
      window.removeEventListener('lc:toggle-sidepanel-workspace', onToggleSidePanelWorkspace);
      window.removeEventListener('lc:escape', onEsc);
      window.removeEventListener('lc:reload', onReload);
      window.removeEventListener('lc:show-keyboard-shortcuts', onShowKbdShortcuts);
      window.removeEventListener('lc:show-support-report', onShowSupportReport);
    };
  }, [create, setSettingsOpen, setKbdShortcutsOpen, setSupportReportOpen]);
}
