/**
 * Preset and generation-control chip shown on an assistant reply.
 *
 * The snapshot belongs to the reply rather than the live conversation, so
 * opening an old reply always describes the request that produced it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GenerationParamsSnapshot } from '../../types';
import { presetLabel } from '../../utils/presets.ts';

interface Props {
  presetName: string;
  params?: GenerationParamsSnapshot;
}

interface ParameterRow {
  label: string;
  value: string;
}

function group(value: number | undefined): string {
  if (value === undefined) return '-';
  const sign = value < 0 ? '-' : '';
  const digits = Math.abs(Math.trunc(value)).toString();
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function value(value: number | string | undefined, enabled: boolean): string {
  return enabled && value !== undefined ? String(value) : '-';
}

export function GenerationParamsChip({ presetName, params }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const rows: ParameterRow[] = [
    { label: 'Preset', value: presetName },
    {
      label: 'Thinking/reasoning',
      value: params?.reasoning_enabled ? (params.reasoning_effort ?? '-') : '-',
    },
    { label: 'Max output tokens', value: value(group(params?.max_tokens), params?.max_tokens_enabled === true) },
    { label: 'Temperature', value: value(params?.temperature, params?.temperature_enabled === true) },
    { label: 'Top-p', value: value(params?.top_p, params?.top_p_enabled === true) },
    { label: 'Top-k', value: value(group(params?.top_k), params?.top_k_enabled === true) },
    { label: 'Repeat penalty', value: value(params?.repeat_penalty, params?.repeat_penalty_enabled === true) },
  ];

  const resolvePos = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return { top: 0, left: 0 };
    return { top: rect.top - 8, left: rect.left + rect.width / 2 + 24 };
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

  const chipText = presetLabel(presetName, params);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="bubble-meta-chip clickable"
        title="Show generation parameters"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        {chipText}
      </button>

      {open && createPortal(
        <div
          ref={popoverRef}
          className="token-meter-tooltip provider-report-tooltip generation-params-tooltip"
          role="dialog"
          aria-label="Parameters"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            transform: 'translate(-50%, -100%)',
            zIndex: 100,
          }}
        >
          <div className="token-meter-tooltip-title">Parameters</div>
          <div className="token-meter-tooltip-rows">
            {rows.map((row) => (
              <div className="token-meter-row" key={row.label}>
                <span className="token-meter-label">{row.label}</span>
                <span className="token-meter-value">{row.value}</span>
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
