/**
 * About modal — shows app info and the LC team.
 *
 * Portal to document.body, same pattern as ToolPermissionModal
 * and WorkspaceManager.  Open/close controlled by parent via
 * `open`/`onClose` props.
 */
import { createPortal } from 'react-dom';
import { useOverlayEscape } from '../../utils/overlay-stack.ts';
import { LC_VERSION } from '../../app-metadata.ts';
import { LC_TEAM_LEAD_URL, LC_CONTRIBUTORS_URL, openSupportLink } from '../settings/support-links.ts';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function AboutModal({ open, onClose }: Props) {
  // Esc → close, but only while this is the innermost overlay. See
  // utils/overlay-stack.ts: this modal and KeyboardShortcutsModal are
  // siblings in App.tsx, which is precisely the pairing that used to
  // misbehave.
  useOverlayEscape(onClose, open);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-modal-title"
      onClick={onClose}
    >
      <div
        className="modal-card about-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="about-modal-hero">
          <img src="/icons/favicon.png" alt="" className="about-modal-logo" width="48" height="48" />
          <h2 id="about-modal-title">LC</h2>
          <p className="about-modal-tagline">
            A local workbench for supervised, tool-assisted work with LLM models.
          </p>
          <p className="about-modal-version">
            v{LC_VERSION} &middot; Apache-2.0
          </p>
        </div>

        <div className="about-modal-section">
          {/* <h4>LC Team</h4> */}
          <ul className="about-modal-team">
            <li>
              <span className="about-modal-team-role">Lead &amp; Engineering</span>
              <span className="about-modal-team-name">
                <a
                  href={LC_TEAM_LEAD_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    e.preventDefault();
                    void openSupportLink(LC_TEAM_LEAD_URL);
                  }}
                >
                  @rathaROG
                </a>
                </span>
            </li>
            <li>
              <span className="about-modal-team-role">General Coding</span>
              <span className="about-modal-team-name">DeepSeek V4 Pro Max (0813)</span>
            </li>
            <li>
              <span className="about-modal-team-role">Audit Executing &amp; Coding</span>
              <span className="about-modal-team-name">Claude Opus 5 xHigh</span>
            </li>
            <li>
              <span className="about-modal-team-role">Audit Executing &amp; Coding</span>
              <span className="about-modal-team-name">DeepSeek V4 Flash Max (0731)</span>
            </li>
            <li>
              <span className="about-modal-team-role">Audit Executing &amp; Coding</span>
              <span className="about-modal-team-name">Gemini 3.7/3.8 Flash High</span>
            </li>
            <li>
              <span className="about-modal-team-role">Audit Executing &amp; Coding</span>
              <span className="about-modal-team-name">GLM 5.3 Max</span>
            </li>
            <li>
              <span className="about-modal-team-role">Audit Executing &amp; Coding</span>
              <span className="about-modal-team-name">GPT-5.6 Luna xHigh</span>
            </li>
            <li>
              <span className="about-modal-team-role">Audit Executing &amp; Coding</span>
              <span className="about-modal-team-name">GPT-5.6 Sol xHigh/Ultra</span>
            </li>
            <li>
              <span className="about-modal-team-role">Audit Executing &amp; Coding</span>
              <span className="about-modal-team-name">GPT-6 Astra xHigh</span>
            </li>
            <li>
              <span className="about-modal-team-role">Audit Executing &amp; Coding</span>
              <span className="about-modal-team-name">Muse Spark 1.2/1.3 xHigh</span>
            </li>
            <li>
              <span className="about-modal-team-role">Audit Executing &amp; Coding</span>
              <span className="about-modal-team-name">Qwen 3.8 Max</span>
            </li>
            <li>
              <span className="about-modal-team-role">Review Executing</span>
              <span className="about-modal-team-name">GLM 5.2 Max</span>
            </li>
            <li>
              <span className="about-modal-team-role">Review Executing</span>
              <span className="about-modal-team-name">Kimi K3 Max</span>
            </li>
            <li>
              <span className="about-modal-team-role">Review Executing</span>
              <span className="about-modal-team-name">MiniMax M3</span>
            </li>
            <li>
              <span className="about-modal-team-role">Review Executing</span>
              <span className="about-modal-team-name">Qwen 3.8 27B xHigh</span>
            </li>
          </ul>
        </div>

        <p className="about-github-contributors">
          {/* href is kept for the URL affordance (hover/right-click), but the
              navigation itself has to go through the opener plugin: a bare
              target="_blank" is silently dropped by the Tauri webview. */}
          <a
            href={LC_CONTRIBUTORS_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              e.preventDefault();
              void openSupportLink(LC_CONTRIBUTORS_URL);
            }}
          >
            GitHub contributors
          </a>
        </p>
      </div>
    </div>,
    document.body,
  );
}


