/**
 * Image lightbox with zoom, pan, and fit-to-screen.
 *
 * Click any image attachment in a message bubble to open a
 * full-screen preview. Esc and backdrop click both close.
 * Wheel zooms, click-drag pans when zoomed, double-click
 * toggles between fit and 2× zoom.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatBytes } from '../../utils/format.ts';
import { useOverlayEscape } from '../../utils/overlay-stack.ts';
import { useScrollLock } from '../../utils/scroll-lock.ts';

interface Props {
  src: string;
  alt: string;
  name: string;
  size?: number;
  onClose: () => void;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 10;
const ZOOM_STEP = 0.5;

export function Lightbox({ src, alt, name, size, onClose }: Props) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 });

  // Reset zoom on image change.
  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [src]);

  // Esc to close, only while this is the innermost overlay.
  useOverlayEscape(onClose);

  // Lock body scroll while open. Shared counter, so releasing out of order
  // cannot unlock the page under an overlay that is still up.
  useScrollLock();

  const zoomIn = useCallback(() => {
    setScale((s) => Math.min(s + ZOOM_STEP, MAX_SCALE));
  }, []);

  const zoomOut = useCallback(() => {
    setScale((s) => {
      const next = s - ZOOM_STEP;
      if (next <= MIN_SCALE) {
        setOffset({ x: 0, y: 0 });
        return MIN_SCALE;
      }
      return next;
    });
  }, []);

  const fitScreen = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // Wheel zoom.
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      setScale((s) => {
        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
        const next = s + delta;
        if (next <= MIN_SCALE) {
          setOffset({ x: 0, y: 0 });
          return MIN_SCALE;
        }
        return Math.min(next, MAX_SCALE);
      });
    },
    [],
  );

  // Pan: mouse down starts a drag.  We add window-level listeners
  // directly so we don't drop the drag if the cursor leaves the image.
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (scale <= 1) return;
      e.preventDefault();
      dragging.current = true;
      dragStart.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };

      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        setOffset({
          x: dragStart.current.ox + (ev.clientX - dragStart.current.x),
          y: dragStart.current.oy + (ev.clientY - dragStart.current.y),
        });
      };
      const onUp = () => {
        dragging.current = false;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [scale, offset],
  );

  // Double-click toggle: fit ↔ 2×.
  const onDoubleClick = useCallback(() => {
    if (scale > 1) {
      fitScreen();
    } else {
      setScale(2);
      setOffset({ x: 0, y: 0 });
    }
  }, [scale, fitScreen]);

  const isFit = scale === 1;
  const isMaxed = scale >= MAX_SCALE;

  return createPortal(
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true" aria-label="Image preview">
      {/* Toolbar */}
      <div className="lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
        <button className="lightbox-tool-btn" onClick={fitScreen} disabled={isFit} title="Fit to screen" aria-label="Fit to screen" type="button">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </button>
        <button className="lightbox-tool-btn" onClick={zoomOut} disabled={isFit} title="Zoom out" aria-label="Zoom out" type="button">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            <line x1="8" y1="11" x2="14" y2="11" />
          </svg>
        </button>
        <span className="lightbox-zoom-label">{Math.round(scale * 100)}%</span>
        <button className="lightbox-tool-btn" onClick={zoomIn} disabled={isMaxed} title="Zoom in" aria-label="Zoom in" type="button">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            <line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
          </svg>
        </button>
      </div>

      {/* Close button */}
      <button
        className="lightbox-close"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Close"
        type="button"
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
          <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
        </svg>
      </button>

      {/* Stage */}
      <div
        className="lightbox-stage"
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
      >
        <img
          src={src}
          alt={alt}
          className="lightbox-img"
          draggable={false}
          style={{
            transform: scale !== 1
              ? `translate(${offset.x}px, ${offset.y}px) scale(${scale})`
              : undefined,
            cursor: scale > 1 ? 'grab' : undefined,
          }}
        />
      </div>

      {/* Footnote — absolute at bottom center, always on top */}
      <div className="lightbox-footnote" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-footnote-name" title={name}>{name}</span>
        {size != null && (
          <>
            <span className="lightbox-footnote-sep">·</span>
            <span className="lightbox-footnote-size">{formatBytes(size)}</span>
          </>
        )}
        <span className="lightbox-footnote-sep">·</span>
        <span className="lightbox-footnote-hint">local file</span>
      </div>
    </div>,
    document.body,
  );
}
