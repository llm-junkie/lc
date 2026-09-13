import { useRef, useState, useEffect } from 'react';
import { cn } from '../../utils/cn.ts';
import type { CrossServerModelEntry } from '../../modules/server-profiles';
import { useOverlayEscape } from '../../utils/overlay-stack.ts';
import { endpointForProfile, endpointLetter, endpointTone } from '../../utils/reply-meta.ts';

interface Props {
  value: string;
  onChange: (modelId: string) => void;
  /** Model entries from all cross-server profiles. */
  models: CrossServerModelEntry[];
  loading?: boolean;
  disabled?: boolean;
  /** Label shown when no model is selected. */
  placeholder?: string;
  /** Filter models by capability. If omitted, all models are shown. */
  filter?: 'vision' | 'tools';
}

export function SubAgentModelPicker({ value, onChange, models, loading, disabled, placeholder = 'Same as chat model', filter }: Props) {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  // Filter models by capability.  Only include models that
  // positively have the required capability.  Unknown models
  // (no cached capabilities) are excluded — the cache is
  // auto-populated on launch and on every profile mutation.
  const filteredModels = filter
    ? models.filter(m => {
        const cap = m.capabilities;
        if (filter === 'vision') return cap.vision === true;
        if (filter === 'tools') return cap.tools === true;
        return true;
      })
    : models;

  // Close on outside click / Escape.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Escape closes the dropdown, only while it is the innermost overlay.
  // This lives inside Settings, whose Escape handler runs in the capture
  // phase — so a document-level listener here fired *after* Settings had
  // already closed itself, and one key dismissed both.
  useOverlayEscape(() => setOpen(false), open);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [open]);

  // Resolve display for the current value. A bare model ID means
  // "same as chat model"; a packed reference selects a profile.
  const resolvedRef = value ? unpackModelRef(value) : null;
  const resolvedModelId = resolvedRef?.modelId ?? value ?? '';
  const selected = resolvedRef
    ? filteredModels.find(m => m.profileId === resolvedRef.profileId && m.modelId === resolvedRef.modelId)
    : resolvedModelId
      ? filteredModels.find(m => m.modelId === resolvedModelId)
      : null;
  // Resolve display label.  Only show "Loading…" when there are
  // genuinely no models yet and a load is in progress — otherwise
  // always show the selected model name or the placeholder.
  const displayLabel = (loading && filteredModels.length === 0)
    ? 'Loading…'
    : selected
      ? selected.displayName
      : placeholder;
  const selectedEndpoint = selected
    ? endpointForProfile(selected.apiVariant, selected.apiStyle)
    : null;

  const selectAndClose = (modelId: string) => {
    if (disabled) return;
    onChange(modelId);
    setOpen(false);
  };

  return (
    <div className={cn('sa-model-picker', open && 'open')} ref={popRef}>
      <button
        type="button"
        className="sa-model-picker-trigger"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        title={selected ? `${selected.displayName} · ${selected.profileName}` : placeholder}
      >
        <span className="sa-current-name">{displayLabel}</span>
        {selectedEndpoint && (
          <span
            className={cn('sa-current-endpoint', `endpoint-${endpointTone(selectedEndpoint)}`)}
            title={`Endpoint — ${selectedEndpoint}`}
          >
            {endpointLetter(selectedEndpoint)}
          </span>
        )}
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden className="sa-chev">
          <path fill="currentColor" d="M7 10l5 5 5-5z" />
        </svg>
      </button>

      {open && (
        <div className="sa-model-picker-pop">
          <ul className="sa-model-list">
            <li
              className="sa-model-row sa-model-placeholder"
              onClick={() => selectAndClose('')}
            >
              <span className="sa-model-name">{placeholder}</span>
            </li>
            {filteredModels.map((m) => {
              const endpoint = endpointForProfile(m.apiVariant, m.apiStyle);

              return (
                <li
                  key={`${m.profileId}:${m.modelId}`}
                  className={cn('sa-model-row', packModelRef(m.profileId, m.modelId) === value && 'current')}
                  onClick={() => selectAndClose(packModelRef(m.profileId, m.modelId))}
                >
                  <span className="sa-model-name">{m.displayName}</span>
                  <span
                    className={cn('sa-model-endpoint', `endpoint-${endpointTone(endpoint)}`)}
                    title={`Endpoint — ${endpoint}`}
                  >
                    {endpointLetter(endpoint)}
                  </span>
                  <span className="sa-model-profile">{m.profileName}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}


/** Format: `profileId::modelId` so the caller always knows which
 *  profile owns the model — no guessing at tool execution time. */
export function packModelRef(profileId: string, modelId: string): string {
  return `${profileId}::${modelId}`;
}

/** Inverse of packModelRef. Returns null for an unqualified model ID. */
export function unpackModelRef(value: string): { profileId: string; modelId: string } | null {
  const idx = value.indexOf('::');
  if (idx === -1) return null;
  return { profileId: value.slice(0, idx), modelId: value.slice(idx + 2) };
}
