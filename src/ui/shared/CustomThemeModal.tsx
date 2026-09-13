/**
 * Custom theme manager modal.
 *
 * Lists imported custom themes. The user can activate, export, or
 * delete themes; use the settings page Appearance chips (system /
 * built-in light / built-in dark) to switch to a built-in theme.
 */

import React, { useRef, useState } from 'react';
import { useSettings } from '../../store/settings.ts';
import { applyCustomTheme, applyBuiltinTheme } from '../../themes/resolver.ts';
import { importThemes, exportTheme, exportAllThemes } from '../../themes/io.ts';
import type { CustomTheme } from '../../themes/types';
import { cn } from '../../utils/cn.ts';
import { isTauri, tauriInvoke } from '../../utils/saveBlob.ts';

/** OS-level dark/light preference — used for hover-restore fallback. */
function systemPrefers(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function CustomThemeModal() {
  const customThemes = useSettings((s) => s.customThemes);
  const activeCustomId = useSettings((s) => s.activeCustomThemeId);
  const setActiveCustomTheme = useSettings((s) => s.setActiveCustomTheme);
  const addCustomThemes = useSettings((s) => s.addCustomThemes);
  const removeCustomTheme = useSettings((s) => s.removeCustomTheme);
  const open = useSettings((s) => s.customThemeOpen);
  const setOpen = useSettings((s) => s.setCustomThemeOpen);
  const themeFilter = useSettings((s) => s.themeFilter);
  const setThemeFilter = useSettings((s) => s.setThemeFilter);

  const fileRef = useRef<HTMLInputElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Filter entries by theme filter (custom themes only).
  const filteredEntries = customThemes.filter((e) => {
    if (themeFilter === 'all') return true;
    const isLight = e.source.base === 'light';
    return themeFilter === 'light' ? isLight : !isLight;
  });

  if (!open) return null;

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setError(null);
    const result = await importThemes(files);
    if (result.errors.length > 0) {
      setError(result.errors.join('\n'));
    }
    if (result.themes.length > 0) {
      addCustomThemes(result.themes);
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleActivate = (entry: CustomTheme) => {
    if (applyCustomTheme(entry)) {
      setActiveCustomTheme(entry.id);
    }
  };

  const handleDelete = (id: string) => {
    removeCustomTheme(id);
  };

  /** Is this entry currently selected? */
  function isActive(entry: CustomTheme): boolean {
    return entry.id === activeCustomId;
  }

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div
        className="modal-card allowed-roots-editor"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="workspace-manager-header">
          <h3>Custom themes</h3>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button
              type="button"
              className="icon-btn"
              title="Open Spine Theme Builder"
              aria-label="Open spine theme builder"
              onClick={async () => {
                if (!isTauri) {
                  window.open('/spine-builder.html', '_blank', 'noopener,noreferrer');
                  return;
                }
                try {
                  await tauriInvoke('open_in_browser', { path: 'spine-builder.html' });
                } catch (err) {
                  setError(`Could not open Spine Theme Builder: ${String(err)}`);
                }
              }}
            >
              <svg viewBox="0 0 48 48" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m41.4 26.83c1.09-1.1 1.37-2.75.7-4.14-1.36-2.8-3.58-6.44-6.94-9.86-3.56-3.63-7.16-5.72-9.93-7-1.37-.64-2.98-.33-4.05.74L9.17 18.6c-1.42 1.42-1.42 3.7 0 5.12l5.05 5.05-7.54 7.54c-1.36 1.36-1.57 3.6-.28 5.03 1.37 1.52 3.72 1.57 5.16.14l7.68-7.69 5.05 5.05c1.41 1.41 3.7 1.41 5.12 0l11.99-11.99z" />
                <line x1="13.49" y1="14.27" x2="33.73" y2="34.5" />
              </svg>
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setOpen(false)}
              aria-label="Close"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path
                  fill="currentColor"
                  d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <p className="allowed-roots-error" style={{ whiteSpace: 'pre-wrap' }}>
            {error}
          </p>
        )}

        {/* Theme filter toggle */}
        <div className="conv-filter-tabs">
          {(['all', 'light', 'dark'] as const).map((f) => (
            <button
              key={f}
              className={`conv-filter-tab${themeFilter === f ? ' is-active' : ''}`}
              onClick={() => setThemeFilter(f)}
            >
              {f === 'all' ? 'All' : f === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>

        {/* Theme list */}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: 300, overflowY: 'auto' }}>
          {filteredEntries.map((entry) => {
            const active = isActive(entry);
            return (
              <React.Fragment key={entry.id}>
                <li
                  className={cn('profile-row', 'clickable', 'theme-row', active && 'active')}
                  onClick={() => handleActivate(entry)}
                  onMouseEnter={() => {
                    if (isActive(entry)) return;
                    if (leaveTimerRef.current) {
                      clearTimeout(leaveTimerRef.current);
                      leaveTimerRef.current = null;
                    }
                    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                    hoverTimerRef.current = setTimeout(() => {
                      applyCustomTheme(entry);
                    }, 200);
                  }}
                  onMouseLeave={() => {
                    if (hoverTimerRef.current) {
                      clearTimeout(hoverTimerRef.current);
                      hoverTimerRef.current = null;
                    }
                    if (isActive(entry)) return;
                    // Grace period before restoring the activated theme —
                    // bridges the gap between list items so the user never
                    // sees a flash of the original theme in between.
                    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
                    leaveTimerRef.current = setTimeout(() => {
                      const curTheme = useSettings.getState().theme;
                      const curCustomId = useSettings.getState().activeCustomThemeId;
                      if (curCustomId) {
                        const ct = useSettings.getState().customThemes.find((t: CustomTheme) => t.id === curCustomId);
                        if (ct) applyCustomTheme(ct);
                      } else if (curTheme === 'system') {
                        applyBuiltinTheme(systemPrefers());
                      } else {
                        applyBuiltinTheme(curTheme as 'light' | 'dark');
                      }
                    }, 180);
                  }}
                >
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      flexShrink: 0,
                      border: '2px solid var(--border-strong)',
                      background: active ? 'var(--accent)' : 'var(--bg-elev-2)',
                    }}
                  />
                  <div className="profile-info">
                    <span className="profile-name">{entry.name}</span>
                    <span className="profile-note">
                      {entry.source.mode === 'spine'
                        ? `spine · ${entry.source.base}`
                        : 'full'}
                    </span>
                  </div>
                  <div className="profile-actions">
                    <button
                      className="icon-btn small accent"
                      title="Export theme"
                      onClick={(e) => {
                        e.stopPropagation();
                        exportTheme(entry);
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    </button>
                    {(
                      <button
                        className="icon-btn small danger"
                        title="Delete theme"
                        onClick={(e) => { e.stopPropagation(); handleDelete(entry.id); }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </li>
              </React.Fragment>
            );
          })}
        </ul>

        {/* Footer actions */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '8px',
            marginTop: '4px',
            paddingTop: '24px',
            borderTop: '1px solid var(--border)',
          }}
        >
          <button
            className="ghost-btn small"
            onClick={() => exportAllThemes(customThemes)}
            disabled={customThemes.length === 0}
          >
            Export all
          </button>
          <button
            className="primary-btn small"
            onClick={() => fileRef.current?.click()}
          >
            Import
          </button>
        </div>

        {/* Hidden file input */}
        <input
          ref={fileRef}
          type="file"
          accept=".json"
          multiple
          style={{ display: 'none' }}
          onChange={handleImport}
        />
      </div>
    </div>
  );
}
