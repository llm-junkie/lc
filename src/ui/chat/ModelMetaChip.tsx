/**
 * Model, endpoint, and server metadata chip shown on an assistant reply.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReplyEndpoint } from '../../types';
import { endpointLetter, endpointTone } from '../../utils/reply-meta.ts';

interface Props {
  model: string;
  endpoint?: ReplyEndpoint;
  serverName: string;
  baseUrl?: string;
}

export function ModelMetaChip({ model, endpoint, serverName, baseUrl }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const resolvePos = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return { top: 0, left: 0 };
    return { top: rect.top - 8, left: rect.left + rect.width / 2 };
  }, []);

  const toggle = useCallback(() => {
    setPos(resolvePos());
    setOpen((current) => !current);
  }, [resolvePos]);

  useEffect(() => {
    if (!open) return;
    const scroller = triggerRef.current?.closest('.messages') as HTMLElement | null;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onScroll = () => setOpen(false);
    scroller?.addEventListener('scroll', onScroll);
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      scroller?.removeEventListener('scroll', onScroll);
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="bubble-meta-chip clickable"
        title={endpoint ? `Endpoint — ${endpoint}` : 'Show model details — endpoint unknown'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        <>
          {model.length > 24 ? `${model.slice(0, 24)}…` : model}{'\u00A0·\u00A0'}
          <span className={`protocol-letter endpoint-${endpointTone(endpoint)}`}>{endpointLetter(endpoint)}</span>
        </>
      </button>

      {open && createPortal(
        <div
          ref={popoverRef}
          className="token-meter-tooltip provider-report-tooltip model-meta-tooltip"
          role="dialog"
          aria-label="Model details"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            transform: 'translate(-50%, -100%)',
            zIndex: 100,
          }}
        >
          <div className="token-meter-tooltip-title">
            <span className="model-meta-tooltip-model">{model}</span>
          </div>
          {/* One group, so the popover draws no divider: endpoint, server, and
              base URL all answer the same question — where this reply came
              from. The divider used to separate them from the quantization
              row, which LC no longer claims to know. */}
          <div className="token-meter-tooltip-rows provider-report-group">
            <div className="token-meter-row">
              <span className="token-meter-label">Endpoint</span>
              <span className="token-meter-value">{endpoint || '-'}</span>
            </div>
            <div className="token-meter-row">
              <span className="token-meter-label">Server</span>
              <span className="token-meter-value">{serverName}</span>
            </div>
            <div className="token-meter-row">
              <span className="token-meter-label">Base URL</span>
              <span className="token-meter-value model-meta-url" title={baseUrl}>{baseUrl || '-'}</span>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
