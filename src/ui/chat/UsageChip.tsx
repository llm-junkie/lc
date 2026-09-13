/**
 * The single usage chip on a completed reply, and the popover it opens.
 *
 * One chip carries output tokens, the cache figure, and duration
 * (`output 588 · cache 11,431 · 14.6s`); clicking it opens the breakdown. The
 * popover title states whose figures they are, so a reader can never lose
 * track of that. Everything else — writes, misses, the TTL breakdown, unusable
 * counters, and LC's prefix inference — stays on the hover title, attributed
 * line by line.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UsageReport } from './usage-detail';

interface Props {
  report: UsageReport;
  /** Full chip text, composed by the caller from reply metadata. */
  chipText: string;
  /** Attributed detail lines, shown on hover. */
  details: string[];
}

export function UsageChip({ report, chipText, details }: Props) {
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
    setOpen((value) => !value);
  }, [resolvePos]);

  // Close on chat scroll, click-away, and Escape. The scroll part is unlike
  // the token meter's popover: this popover is position:fixed, so scrolling
  // the .messages container would leave it floating over content it no longer
  // describes. The other two match the token meter's muscle memory.
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
        title={details.join('\n') || report.title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        {chipText}
      </button>

      {open && createPortal(
        <div
          ref={popoverRef}
          className="token-meter-tooltip provider-report-tooltip"
          role="dialog"
          aria-label={report.title}
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            transform: 'translate(-50%, -100%)',
            zIndex: 100,
          }}
        >
          <div className="token-meter-tooltip-title">
            <span>{report.title}</span>
          </div>
          {report.groups.map((rows, index) => (
            <div
              className="token-meter-tooltip-rows provider-report-group"
              // Groups are a fixed layout, not a reorderable list.
              key={index}
            >
              {rows.map((row) => (
                <div className="token-meter-row" key={row.label}>
                  <span className="token-meter-label">{row.label}</span>
                  <span className="token-meter-value">{row.value}</span>
                </div>
              ))}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
