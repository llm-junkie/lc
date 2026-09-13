/** Permission modal for tool calls requiring user approval.
 *  Bridges the non-React orchestrator with React via a module-level
 *  handler.  Portalled to document.body for correct fixed positioning
 *  alongside other backdrop-filter surfaces. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ToolCallRecord } from '../../modules/tool-engine/types';
import { fileTargetsOf } from '../../modules/chat-pipeline/batch-contention.ts';
import { useOrderedOverlayLayer, useOverlayKeys } from '../../utils/overlay-stack.ts';
import { grantedDirectoriesForDecision } from './permission-modal-state.ts';
import {
  enqueueGenerationInteraction,
  type GenerationInteractionIdentity,
} from '../../modules/chat-pipeline/interaction-coordinator.ts';

export type PermissionDecision =
  | 'allow_once'
  | 'allow_session'
  | 'deny'
  | 'aborted'
  | 'unavailable';

/** Extended result carrying the directory scopes included in approval.
 *  `grantedDirs` is empty for deny/unavailable. */
export interface PermissionResult {
  decision: PermissionDecision;
  /** All displayed scopes for whole-call approval; empty for deny/unavailable. */
  grantedDirs: string[];
  /** Unix ms when the modal host committed the popup; absent if never shown. */
  shownAt?: number;
  /** Unix ms when the decision settled. */
  resolvedAt?: number;
}

type Resolver = (r: PermissionResult) => void;

interface PendingPermissionRequest {
  call: ToolCallRecord;
  dirs: string[];
  presentation?: PermissionPresentation;
  signal?: AbortSignal;
  resolve: Resolver;
  timeout: ReturnType<typeof setTimeout>;
  detachAbort: () => void;
}

/** Module-level bridge: the modal registers itself here on mount;
 *  `showPermissionModal` calls whatever's registered. */
type PermissionPresentation = Pick<GenerationInteractionIdentity, 'conversationTitle' | 'interactionId'> & {
  modelId: string;
};

let handler: ((call: ToolCallRecord, dirs: string[], signal?: AbortSignal, presentation?: PermissionPresentation) => Promise<PermissionResult>) | null =
  null;
const pendingRequests: PendingPermissionRequest[] = [];

export function registerPermissionHandler(
  h: typeof handler,
): () => void {
  handler = h;
  if (!h) return () => {};

  // A tool call can arrive during the React commit/effect gap or while the
  // app-level modal is being remounted. Release queued requests only after
  // the handler is live so a missing grant always reaches the popup.
  const queued = pendingRequests.splice(0);
  for (const request of queued) {
    clearTimeout(request.timeout);
    request.detachAbort();
    if (request.signal?.aborted) {
      request.resolve({ decision: 'aborted', grantedDirs: [] });
      continue;
    }
    void Promise.resolve()
      .then(() => h(request.call, request.dirs, request.signal, request.presentation))
      .then(request.resolve)
      .catch(() => request.resolve({ decision: 'unavailable', grantedDirs: [] }));
  }

  // Only the registration that installed this exact handler may clear it.
  // This prevents an old React/HMR cleanup from unregistering a newer modal.
  return () => {
    if (handler === h) handler = null;
  };
}

/** Called by the orchestrator. Returns a Promise that resolves
 *  with the user's decision and the displayed scopes included on approval. If no
 *  handler is registered (modal not mounted — shouldn't happen in
 *  production but defensive), resolves to unavailable with no dirs. */
function presentPermissionModal(
  call: ToolCallRecord,
  dirs: string[] = [],
  signal?: AbortSignal,
  presentation?: PermissionPresentation,
): Promise<PermissionResult> {
  if (signal?.aborted) {
    return Promise.resolve({ decision: 'aborted', grantedDirs: [], resolvedAt: Date.now() });
  }
  if (handler) {
    return handler(call, dirs, signal, presentation).then((result) => ({
      ...result,
      resolvedAt: result.resolvedAt ?? Date.now(),
    }));
  }
  return new Promise<PermissionResult>((resolve) => {
    let settled = false;
    const settle: Resolver = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(request.timeout);
      request.detachAbort();
      const index = pendingRequests.indexOf(request);
      if (index >= 0) pendingRequests.splice(index, 1);
      resolve({ ...result, resolvedAt: result.resolvedAt ?? Date.now() });
    };
    const onAbort = () => settle({ decision: 'aborted', grantedDirs: [] });
    const request: PendingPermissionRequest = {
      call,
      dirs,
      presentation,
      signal,
      resolve: settle,
      timeout: setTimeout(() => {
        settle({ decision: 'unavailable', grantedDirs: [] });
      }, 5_000),
      detachAbort: () => signal?.removeEventListener('abort', onAbort),
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pendingRequests.push(request);
  });
}

export interface PermissionInteractionContext {
  identity: GenerationInteractionIdentity;
  /** Exact model ID used for the request that produced the tool call. */
  modelId: string;
  validateOwnership: () => boolean;
  onQueueWaitStart?: () => void;
  onQueueWaitEnd?: () => void;
}

/** Called by the orchestrator; globally FIFO when generation identity is supplied. */
export function showPermissionModal(
  call: ToolCallRecord,
  dirs: string[] = [],
  signal?: AbortSignal,
  context?: PermissionInteractionContext,
): Promise<PermissionResult> {
  if (!context || !signal) return presentPermissionModal(call, dirs, signal);
  return enqueueGenerationInteraction<PermissionResult>({
    identity: context.identity,
    signal,
    validateOwnership: context.validateOwnership,
    present: (presentationSignal) => presentPermissionModal(call, dirs, presentationSignal, {
      interactionId: context.identity.interactionId,
      conversationTitle: context.identity.conversationTitle,
      modelId: context.modelId,
    }),
    abortedResult: () => ({ decision: 'aborted', grantedDirs: [], resolvedAt: Date.now() }),
    unavailableResult: () => ({ decision: 'unavailable', grantedDirs: [], resolvedAt: Date.now() }),
    onQueueWaitStart: context.onQueueWaitStart,
    onQueueWaitEnd: context.onQueueWaitEnd,
  });
}

/** Pretty-print the args object for the modal body. Pure JSON
 *  serialization is fine — model-emitted tool args are JSON by
 *  construction. */
function formatArgs(args: string): string {
  if (!args) return '(no arguments)';
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

/** Tools whose permission target is unambiguously one or more files. Directory
 * search tools and lc_stat are excluded because their paths may be directories. */
const DIRECT_FILE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'lc_read_file',
  'lc_read_image',
  'lc_read_pdf',
  'lc_write_file',
  'lc_edit_file',
  'lc_apply_patch',
]);

function permissionFilePaths(call: ToolCallRecord | null): string[] {
  if (!call || !DIRECT_FILE_TOOL_NAMES.has(call.name)) return [];
  try {
    return Array.from(new Set(fileTargetsOf(call.name, JSON.parse(call.arguments))));
  } catch {
    return [];
  }
}

function PermissionPathList({
  kind,
  paths,
}: {
  kind: 'directory' | 'file';
  paths: readonly string[];
}) {
  const label = kind === 'file'
    ? 'File:'
    : paths.length === 1
      ? 'Directory:'
      : `Directories (${paths.length}):`;
  const className = kind === 'directory'
    ? 'permission-modal-directories'
    : 'permission-modal-files';
  return (
    <div className={`permission-modal-paths ${className}`}>
      <p className="permission-modal-paths-label">{label}</p>
      <ul className="permission-modal-path-list">
        {paths.map((path) => (
          <li key={path} className="permission-modal-path-item">
            <code>{path}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ToolPermissionModal() {
  const [call, setCall] = useState<ToolCallRecord | null>(null);
  const [dirs, setDirs] = useState<string[]>([]);
  const [conversationTitle, setConversationTitle] = useState('');
  const [modelId, setModelId] = useState('');
  const resolverRef = useRef<Resolver | null>(null);
  const detachAbortRef = useRef<(() => void) | null>(null);
  const shownAtRef = useRef<number | null>(null);
  const showDirs = dirs.length > 0;
  const filesToShow = useMemo(() => permissionFilePaths(call), [call]);

  // A permission decision has no safe Escape default. Register a no-op owner
  // so Escape cannot reach an overlay behind this prompt.
  useOverlayKeys({ Escape: () => {} }, Boolean(call));
  const orderedLayerRef = useOrderedOverlayLayer(Boolean(call));

  // Layout effects run after the dialog is committed but before the browser
  // can paint it or accept a click, making this the closest useful "shown"
  // timestamp for the permission audit.
  useLayoutEffect(() => {
    if (call && shownAtRef.current == null) shownAtRef.current = Date.now();
  }, [call]);

  useEffect(() => {
    const unregister = registerPermissionHandler((c, d, signal, presentation) => {
      return new Promise<PermissionResult>((resolve) => {
        // The orchestrator serializes prompts, but settle an unexpected prior
        // request defensively rather than retaining its call and promise.
        resolverRef.current?.({ decision: 'unavailable', grantedDirs: [] });
        detachAbortRef.current?.();
        const settle: Resolver = (result) => {
          if (resolverRef.current !== settle) return;
          detachAbortRef.current?.();
          detachAbortRef.current = null;
          resolverRef.current = null;
          const shownAt = shownAtRef.current;
          shownAtRef.current = null;
          resolve({
            ...result,
            ...(shownAt != null ? { shownAt } : {}),
            resolvedAt: Date.now(),
          });
          setCall(null);
          setDirs([]);
          setConversationTitle('');
          setModelId('');
        };
        const onAbort = () => settle({ decision: 'aborted', grantedDirs: [] });
        resolverRef.current = settle;
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        detachAbortRef.current = () => signal?.removeEventListener('abort', onAbort);
        shownAtRef.current = null;
        setCall(c);
        setDirs(d ?? []);
        setConversationTitle(presentation?.conversationTitle ?? '');
        setModelId(presentation?.modelId ?? '');
      });
    });
    return () => {
      unregister();
      // The tool-policy contract requires a popup to settle as unavailable if
      // its React host unmounts. This also releases the queued orchestrator state.
      resolverRef.current?.({ decision: 'unavailable', grantedDirs: [] });
      resolverRef.current = null;
      shownAtRef.current = null;
      detachAbortRef.current?.();
      detachAbortRef.current = null;
      setConversationTitle('');
      setModelId('');
    };
  }, []);

  const decide = useCallback(
    (decision: Exclude<PermissionDecision, 'aborted' | 'unavailable'>) => {
      const resolve = resolverRef.current;
      resolve?.({
        decision,
        // This modal approves or denies the whole logical call. The model can
        // issue separate calls when it needs finer-grained scopes.
        grantedDirs: grantedDirectoriesForDecision(dirs, decision),
      });
      setCall(null);
      setDirs([]);
    },
    [dirs],
  );

  const dirsToShow = useMemo(() => dirs, [dirs]);

  if (!call) return null;

  return createPortal(
    <div
      ref={orderedLayerRef}
      className="modal-backdrop tool-permission-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="permission-modal-title"
    >
      <div className="modal-card tool-permission-modal">
        <div className="permission-modal-header">
          <h3 id="permission-modal-title">Permission required</h3>
          <button className="icon-btn" onClick={() => decide('deny')} aria-label="Close">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path
                fill="currentColor"
                d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
          </button>
        </div>
        {(conversationTitle || modelId) && (
          <div className="permission-modal-context" aria-label="Request context">
            {conversationTitle && (
              <p>
                Chat:{' '}
                <strong className="permission-modal-context-value" title={conversationTitle}>
                  {conversationTitle}
                </strong>
              </p>
            )}
            {modelId && (
              <p>
                Model:{' '}
                <strong className="permission-modal-context-value" title={modelId}>
                  {modelId}
                </strong>
              </p>
            )}
          </div>
        )}
        <p className="permission-modal-request">
          The model is requesting permission to call{' '}
          <strong className="permission-modal-tool-name">{call.name}</strong>
          .
        </p>

        {showDirs && (
          <PermissionPathList kind="directory" paths={dirsToShow} />
        )}

        {filesToShow.length > 0 && (
          <PermissionPathList kind="file" paths={filesToShow} />
        )}

        <details className="permission-modal-details">
          <summary>Show arguments</summary>
          <pre>{formatArgs(call.arguments)}</pre>
        </details>
        <div className="permission-modal-buttons">
          <button
            type="button"
            className="permission-modal-btn permission-modal-btn-deny"
            onClick={() => decide('deny')}
            autoFocus
          >
            Deny
          </button>
          <button
            type="button"
            className="permission-modal-btn"
            onClick={() => decide('allow_once')}
          >
            {call.name === 'lc_run_shell' ? 'Run once' : 'Allow once'}
          </button>
          {call.name !== 'lc_run_shell' && (
            <button
              type="button"
              className="permission-modal-btn permission-modal-btn-primary"
              onClick={() => decide('allow_session')}
            >
              Allow for this conversation
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
