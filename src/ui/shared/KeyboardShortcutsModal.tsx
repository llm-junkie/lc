/**
 * Keyboard Shortcuts modal — lists all global keyboard shortcuts.
 *
 * Portal to document.body, same pattern as AboutModal.
 * Open/close controlled by parent via `open`/`onClose` props.
 */
import { Fragment } from 'react';
import { createPortal } from 'react-dom';
import { useOrderedOverlayLayer, useOverlayEscape } from '../../utils/overlay-stack.ts';

interface ShortcutEntry {
  keys: string | string[];
  action: string;
}

interface ShortcutSection {
  title: string;
  items: ShortcutEntry[];
}

const MAC_SHORTCUTS = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad/i.test(navigator.platform);
const PRIMARY_KEY = MAC_SHORTCUTS ? 'Cmd' : 'Ctrl';
const ALT_KEY = MAC_SHORTCUTS ? 'Option' : 'Alt';
const TODO_KEYS = `${PRIMARY_KEY} ${ALT_KEY} P`;

const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    title: 'App General',
    items: [
      { keys: `${PRIMARY_KEY} N`, action: 'New chat' },
      { keys: `${PRIMARY_KEY} ,`, action: 'Open settings' },
      { keys: `${PRIMARY_KEY} /`, action: 'Toggle side panel > Parameters' },
      { keys: `${PRIMARY_KEY} Shift /`, action: 'Toggle side panel > Workspace' },
      { keys: 'F1', action: 'Show this panel' },
      { keys: 'Shift F1', action: 'Open support report' },
      { keys: 'F5', action: 'Reload app' },
      { keys: 'Escape', action: 'Close panel / overlay / settings' },
    ],
  },
  {
    title: 'Chat Composer',
    items: [
      { keys: `${PRIMARY_KEY} K`, action: 'Focus composer' },
      { keys: `${PRIMARY_KEY} B`, action: 'Open Whiteboard' },
      { keys: '/', action: 'Focus composer (when not typing)' },
      { keys: 'Enter', action: 'Send message' },
      { keys: 'Shift Enter', action: 'Add a newline in message' },
      { keys: `${PRIMARY_KEY} M`, action: 'Toggle model picker' },
      { keys: 'F11', action: 'Focus mode' },
    ],
  },
  {
    title: 'Reasoning, tools, and to do preview',
    items: [
      { keys: `${PRIMARY_KEY} P`, action: 'Open reasoning for the last matching bubble' },
      { keys: `${PRIMARY_KEY} Shift P`, action: 'Open tools for the last matching bubble' },
      { keys: TODO_KEYS, action: 'Open the to do list for the last matching bubble' },
      { keys: [`${PRIMARY_KEY} ↑`, `${PRIMARY_KEY} ↓`], action: 'Cycle through the assistant\'s bubbles' },
    ],
  },
];

interface Props {
  open: boolean;
  onClose: () => void;
  /** Opens the support report on top of this sheet (Shift F1). */
  onOpenSupportReport: () => void;
}

export function KeyboardShortcutsModal({ open, onClose, onOpenSupportReport }: Props) {
  // Esc → close, but only while this is the innermost overlay. The sheet is
  // opened on top of whatever the user is already in (F1 is exempt from the
  // modal gate), so it is normally the top of the stack and correctly owns
  // Escape. See utils/overlay-stack.ts.
  useOverlayEscape(onClose, open);
  const orderedLayerRef = useOrderedOverlayLayer(open);

  if (!open) return null;

  return createPortal(
    <div
      ref={orderedLayerRef}
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kbd-modal-title"
      onClick={onClose}
    >
      <div
        className="modal-card kbd-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="kbd-modal-header">
          <h3 id="kbd-modal-title">Keyboard Shortcuts <span className="kbd-modal-title-hint">F1</span></h3>
          <button
            type="button"
            className="icon-btn"
            aria-label="Open support report"
            title="Support report (Shift F1)"
            onClick={onOpenSupportReport}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="4" />
              <path d="M15 9L19 5" />
              <path d="M5 19L9 15" />
              <path d="M9 9L5 5" />
              <path d="M19 19L15 15" />
            </svg>
          </button>
        </div>

        <div className="kbd-modal-list">
          {SHORTCUT_SECTIONS.map((section, si) => (
            <div className="kbd-modal-section" key={section.title}>
              {si > 0 && <div className="kbd-modal-separator" />}
              <h4 className="kbd-modal-section-title">{section.title}</h4>
              {section.items.map((s) => {
                const keys = Array.isArray(s.keys) ? s.keys : [s.keys];
                return (
                  <div className="kbd-modal-row" key={keys.join(' ')}>
                    {keys.map((key, i) => (
                      <Fragment key={key}>
                        {i > 0 && <span className="kbd-modal-key-sep">/</span>}
                        <kbd className="kbd-modal-key">{key}</kbd>
                      </Fragment>
                    ))}
                    <span className="kbd-modal-action">{s.action}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
