import { useEffect, useRef, useState } from 'react';
import { ThemeProvider } from './ui/shared/ThemeProvider.tsx';
import { Sidebar } from './ui/layout/Sidebar.tsx';
import { ChatView } from './ui/chat/ChatView.tsx';
import { SettingsPage } from './ui/settings/SettingsPage.tsx';
import { AboutModal } from './ui/shared/AboutModal.tsx';
import { CustomThemeModal } from './ui/shared/CustomThemeModal.tsx';
import { KeyboardShortcutsModal } from './ui/shared/KeyboardShortcutsModal.tsx';
import { SupportReportModal } from './ui/settings/SupportReportModal.tsx';
import { Toaster } from './ui/shared/Toaster.tsx';
import { ErrorBoundary } from './ui/shared/ErrorBoundary.tsx';
import { LinkGuard } from './ui/shared/LinkGuard.tsx';
import { Lightbox } from './ui/preview/Lightbox.tsx';
import { TextPreview } from './ui/preview/TextPreview.tsx';
import { ToolPermissionModal } from './ui/tools/ToolPermissionModal.tsx';
import { AskUserModal } from './ui/tools/AskUserModal.tsx';
import { requestWhiteboardOverlayExit } from './ui/tools/whiteboard-overlay-guard.ts';
import {
  reportConversationPersistenceFailure,
  reportConversationPersistenceWarning,
  useConversations,
} from './store/conversations.ts';
import { recoverJournaledGenerations } from './store/generation-journal.ts';
import { installApplicationGenerationExitCleanup } from './ui/chat/generation-lifecycle.ts';
import {
  activeGenerationSessions,
  configureGenerationCapacity,
  endGenerationSession,
} from './modules/chat-pipeline/generation-session-manager.ts';
import { useSettings } from './store/settings.ts';
import { openConversationStorage } from './store/db.ts';
import { reclaimRestartOrphanedAttachments } from './store/attachment-gc.ts';
import { useFileResolution, isPreviewablePath } from './platform/fileResolution.ts';
import { useZoomLifecycle } from './modules/chat-pipeline/zoom.ts';
import { useKeyboardShortcuts } from './modules/chat-pipeline/shortcuts.ts';
import { useCodeTheme } from './utils/useCodeTheme.ts';
import { useAutoArchiveSweep } from './modules/server-profiles/archive-sweep.ts';
import { useModelBootstrap } from './modules/server-profiles/bootstrap.ts';
import { keychainWarm } from './platform/keychain.ts';
import { bootstrapBraveSearchKey, bootstrapMarginaliaKey } from './platform/search-key-bootstrap.ts';
import { isTauri } from './utils/saveBlob.ts';
import { invoke } from '@tauri-apps/api/core';
import { toast } from './utils/toast.ts';
import { recordDiagnosticEvent } from './utils/diagnostic-events.ts';
import type { StartupLifecycle } from './startup/startup-runtime';
import { initializeNormalStartup } from './startup/normal-startup.ts';

interface AppProps {
  startup?: StartupLifecycle;
}

export default function App({ startup }: AppProps) {
  const processStartedAt = useRef(Date.now());
  const [normalReady, setNormalReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [kbdShortcutsOpen, setKbdShortcutsOpen] = useState(false);
  const [supportReportOpen, setSupportReportOpen] = useState(false);
  const [previewReturnToFileChanges, setPreviewReturnToFileChanges] = useState<string | null>(null);
  const maxConcurrentGenerations = useSettings((state) => state.maxConcurrentGenerations);

  useEffect(() => {
    configureGenerationCapacity(maxConcurrentGenerations);
  }, [maxConcurrentGenerations]);

  // ── Extracted concerns (each was an inline useEffect in App.tsx) ────
  useModelBootstrap(normalReady);
  useZoomLifecycle();
  useAutoArchiveSweep(normalReady);
  useCodeTheme();
  useKeyboardShortcuts({ setSettingsOpen, setKbdShortcutsOpen, setSupportReportOpen });

  // ── Conversation hydration: load metadata from Dexie on startup ────
  useEffect(() => {
    void initializeNormalStartup(startup, {
      openStorage: openConversationStorage,
      hydrateConversationMetadata: () => useConversations.getState().hydrate(),
    }).then((result) => {
      if (result.ok === false) {
        reportConversationPersistenceFailure(
          result.code === 'conversation-storage-unavailable'
            ? 'open conversation storage'
            : 'load conversation metadata',
          result.cause,
        );
        return;
      }
      // `initializeNormalStartup` records `ready` before it resolves. Optional
      // model and archive work can start only after that durable boundary.
      setNormalReady(true);
      recordDiagnosticEvent({
        subsystem: 'storage',
        operation: 'hydrate',
        outcome: 'ok',
        code: 'storage-ready',
      });
      void reclaimRestartOrphanedAttachments(processStartedAt.current).catch((error) => {
        reportConversationPersistenceWarning(
          'reclaim restart-orphaned attachments',
          error,
        );
      });
      // Crash recovery runs after metadata is hydrated and never blocks it.
      // The pass is journal-discovered and transcript-lazy: it patches only
      // the assistant rows the journal names, so a background conversation is
      // repaired without loading its history. The remaining tool and
      // Whiteboard repairs happen when that conversation is first opened.
      void recoverJournaledGenerations().then((recovery) => {
        if (recovery.interrupted.length === 0) return;
        recordDiagnosticEvent({
          subsystem: 'storage',
          operation: 'recovery-action',
          outcome: 'ok',
          code: 'generation-recovery-ok',
        });
      }, (error) => {
        reportConversationPersistenceWarning('recover interrupted generations', error);
      });
    });
  }, [startup]);

  // ── Page exit: terminalize every live generation ───────────────────
  // Owned by the application rather than by ChatView. A response's lifetime is
  // not the chat component's lifetime: that component unmounts whenever the
  // user navigates, and once a session can outlive the selected conversation a
  // handler owned by the foreground view would terminalize the wrong set.
  useEffect(() => installApplicationGenerationExitCleanup(
    activeGenerationSessions,
    endGenerationSession,
  ), []);

  // ── Brave Search API key: load from encrypted keychain on startup ──
  useEffect(() => {
    if (!isTauri) return;
    // Pre-warm the PBKDF2 key derivation so the first real read doesn't block.
    keychainWarm();
    // Loads the keys into memory and clears any plaintext copy that older
    // builds left in localStorage. See platform/search-key-bootstrap.ts.
    void bootstrapBraveSearchKey();
    void bootstrapMarginaliaKey();
  }, []);

  // ── File preview / resolution ──────────────────────────────────────
  const { preview, setPreview, resolveFilePath, findFileInRoots, previewFile } = useFileResolution();

  // File-change rows live inside chat bubbles, while the existing preview
  // panel is owned by App. Route those clicks through the same global
  // TextPreview instance used by other file interactions.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; returnToFileChanges?: string }>).detail;
      const path = detail?.path;
      if (!path) return;
      setPreviewReturnToFileChanges(detail?.returnToFileChanges ?? null);
      const returnToFileChanges = detail?.returnToFileChanges;
      const notifyPreviewClosed = () => {
        setPreviewReturnToFileChanges(null);
        if (returnToFileChanges) {
          window.dispatchEvent(new CustomEvent('lc:preview-file-closed', {
            detail: { messageId: returnToFileChanges },
          }));
        }
      };
      void (async () => {
        const resolvedPath = await resolveFilePath(path);
        if (resolvedPath) {
          const opened = await previewFile(resolvedPath);
          if (!opened) notifyPreviewClosed();
        } else {
          notifyPreviewClosed();
          toast.error(`Could not find file: ${path}`);
        }
      })();
    };
    window.addEventListener('lc:preview-file', handler);
    return () => window.removeEventListener('lc:preview-file', handler);
  }, [previewFile, resolveFilePath]);

  const closePreview = () => {
    const messageId = previewReturnToFileChanges;
    setPreview(null);
    setPreviewReturnToFileChanges(null);
    if (messageId) {
      window.dispatchEvent(new CustomEvent('lc:preview-file-closed', {
        detail: { messageId },
      }));
    }
  };

  // ── Tauri launch: clear activeId on fresh launch (not reload) ──────
  useEffect(() => {
    if (!isTauri) return;
    if (sessionStorage.getItem('lc:running')) {
      // Reload — keep activeId as-is.
    } else {
      useConversations.setState({ activeId: null });
    }
    sessionStorage.setItem('lc:running', '1');
    if (!normalReady) return;
    const timer = setTimeout(() => {
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('sync_models_dev').catch(() => {});
      });
    }, 5000);
    return () => clearTimeout(timer);
  }, [normalReady]);

  // ── Agentic-tools settings event ───────────────────────────────────
  useEffect(() => {
    const handler = () => {
      void requestWhiteboardOverlayExit('settings-open').then((allowed) => {
        if (allowed) setSettingsOpen(true);
      });
    };
    window.addEventListener('lc-open-agentic-tools-settings', handler);
    return () => window.removeEventListener('lc-open-agentic-tools-settings', handler);
  }, []);

  // ── Layout ─────────────────────────────────────────────────────────
  return (
    <ThemeProvider>
      <ErrorBoundary>
        <div className="app">
          <Sidebar
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenAbout={() => setAboutOpen(true)}
            onOpenKeyboardShortcuts={() => setKbdShortcutsOpen(true)}
          />
          <main className="main">
            <ChatView />
          </main>
          <ToolPermissionModal />
          <AskUserModal />
          <SettingsPage
            open={settingsOpen}
            onClose={() => {
              setSettingsOpen(false);
            }}
            onOpenAbout={() => setAboutOpen(true)}
            onOpenSupportReport={() => setSupportReportOpen(true)}
            hasSubOverlay={aboutOpen || kbdShortcutsOpen || supportReportOpen}
          />
          <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
          <KeyboardShortcutsModal
            open={kbdShortcutsOpen}
            onClose={() => setKbdShortcutsOpen(false)}
            onOpenSupportReport={() => setSupportReportOpen(true)}
          />
          <SupportReportModal open={supportReportOpen} onClose={() => setSupportReportOpen(false)} />
          <CustomThemeModal />
          <LinkGuard
            onOpenUrl={(url) => {
              if (isTauri) {
                void import('@tauri-apps/plugin-opener')
                  .then(({ openUrl }) => openUrl(url))
                  .catch(() => toast.error('Could not open link in default browser'));
              } else {
                window.open(url, '_blank', 'noopener,noreferrer');
              }
            }}
            resolveFilePath={resolveFilePath}
            onFindFile={findFileInRoots}
            isPreviewable={isPreviewablePath}
            onShowInExplorer={(path) => {
              invoke('reveal_in_explorer', { path }).catch(() => {
                toast.error(`Could not reveal: ${path}`);
              });
            }}
            onPreviewFile={previewFile}
          />
          {preview && preview.type === 'image' && (
            <Lightbox
              src={preview.src}
              alt={preview.name}
              name={preview.name}
              size={preview.size}
              onClose={closePreview}
            />
          )}
          {preview && preview.type === 'text' && (
            <TextPreview
              name={preview.name}
              mime={preview.mime}
              size={preview.size}
              content={preview.content}
              unavailableReason={preview.reason}
              onClose={closePreview}
            />
          )}
          <Toaster />
        </div>
      </ErrorBoundary>
    </ThemeProvider>
  );
}
