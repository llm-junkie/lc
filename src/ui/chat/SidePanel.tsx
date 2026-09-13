import { useEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import type { Conversation, ConversationSkill, GenerationParams } from '../../types';
import { DEFAULT_PARAMS } from '../../types.ts';
import { cn } from '../../utils/cn.ts';
import { modalWasOpenAtKeyDown } from '../../utils/shortcuts.ts';
import { useOverlayEscape } from '../../utils/overlay-stack.ts';
import { PRESETS, isServerDefaultParams, resolveParameterPreset } from '../../utils/presets.ts';
import { BUILTIN_TOOLS, FILE_IO_NAMES, FILE_IO_READ_ONLY_NAMES, WEB_ACCESS_NAMES, formatPathForDisplay, resolveExposure, setWebAccessEnabled, setSkillsEnabled, setWorkspaceEnabled } from '../../modules/tool-engine/index.ts';
import { readToolGrants } from '../../modules/tool-engine/grant-state.ts';
import { useSettings, getDefaultShellAllowlist } from '../../store/settings.ts';
import { ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE } from '../../store/conversations.ts';
import { useProfileStore } from '../../modules/server-profiles/index.ts';
import { errorMessage } from '../../modules/llm-client/index.ts';
import { debugLog } from '../../utils/debug.ts';
import { getBuiltinSkillList } from '../../modules/builtin-skills.ts';
import { DEFAULT_SKILL_IDS, materializeSkillForExposure } from '../../modules/lc-tools-skill.ts';
import { compareSkillsAlphabetically, parseSkillMarkdown } from '../../modules/skills.ts';
import { toast } from '../../utils/toast.ts';
import { uid } from '../../utils/uid.ts';
import { Markdown } from '../../utils/markdown.tsx';
import { resolveWorkspaceProviderPresentation } from '../../modules/chat-pipeline/provider-capability.ts';
import { DEFAULT_TOOL_BATCH_LIMIT } from '../../modules/chat-pipeline/tool-batch-limit.ts';
import { useShiftHeld } from './use-shift-held.ts';
import { WHITEBOARD_UI_TEXT } from '../tools/whiteboard-ui-text.ts';

/** Per-conversation tools config — shape mirrors `Conversation.tools`
 *  so the parent can pass the live value and the panel patches
 *  shallowly. This drives the master toggle + per-tool
 *  checkboxes + tool batch/round limit sliders + roots link. */
export type ToolsConfig = NonNullable<Conversation['tools']>;

interface Props {
  /** Visibility and presentation are owned by the selected conversation. */
  open: boolean;
  activeTab: 'params' | 'tools';
  onTabChange: (tab: 'params' | 'tools') => void;
  onClose: () => void;
  workspaceSections?: Readonly<Record<string, boolean>>;
  onWorkspaceSectionChange?: (key: string, next: boolean) => void;
  workspaceExpandedDir?: string | null;
  onWorkspaceExpandedDirChange?: (path: string | null) => void;
  params: GenerationParams;
  onChange: (next: GenerationParams) => void;
  /** Per-conversation tools config. Optional so the panel can
   *  render a clear empty state when Workspace has not been configured. */
  tools?: ToolsConfig;
  onToolsChange?: (
    next: ToolsConfig,
  ) => void | boolean | Promise<void | boolean>;
  /** Open the active conversation's Whiteboard overlay. */
  onOpenWhiteboard?: () => void;
  /** Open the allowed-roots editor. Provided when the parent
   *  mounts the AllowedRootsEditor modal and wants the panel
   *  to be its entry point. */
  onOpenRootsEditor?: () => void;
  /** Called when the user clicks "See current system instructions".
   *  ChatView provides the async builder so the preview always
   *  matches exactly what gets sent to the model. */
  onGetSystemPrompt?: () => Promise<string>;
  /** Conversation-owned custom skills. */
  customSkills?: ConversationSkill[];
  /** Called when custom skills are imported or deleted. */
  onCustomSkillsChange?: (next: ConversationSkill[]) => void;
  /** Selected provider protocol, used to derive Workspace capability UI. */
  apiVariant?: string;
  /** Freeze execution-affecting controls while the current generation owns them. */
  locked?: boolean;
}

const DEFAULT_TOOLS: ToolsConfig = {
  enabled: false,
  tool_grants: [],
  web_access_grants_initialized: false,
  file_io_enabled: false,
  shell_enabled: false,
  web_access_enabled: false,
  tool_history_enabled: false,
  skills_enabled: false,
  skills_initialized: false,
  whiteboard_enabled: false,
  enabled_skill_ids: [],
  allowed_roots: [],
  dir_permissions: {},
  max_tool_rounds_per_turn: 128,
  sse_read_timeout_min: 5,
  max_tool_calls_per_batch: DEFAULT_TOOL_BATCH_LIMIT,
};

/**
 * Per-directory File I/O rows, split the way the grant model reads them:
 * the read-only group first, then the mutating group, each sorted by name
 * and drawn with a rule between the two. Registry order is deliberately
 * not used here — it is a handler-construction order, not a grant order.
 */
const FILE_IO_TOOL_GROUPS = (() => {
  const fileIo = BUILTIN_TOOLS.filter(
    (t) => (FILE_IO_NAMES as readonly string[]).includes(t.name),
  );
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return [
    fileIo.filter((t) => FILE_IO_READ_ONLY_NAMES.has(t.name)).sort(byName),
    fileIo.filter((t) => !FILE_IO_READ_ONLY_NAMES.has(t.name)).sort(byName),
  ];
})();

const REASONING_EFFORT_VALUES = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const REASONING_EFFORT_DETAILS = [
  'Disable thinking/reasoning', 
  'Enable thinking with low reasoning',
  'Enable thinking with medium reasoning',
  'Enable thinking with high reasoning',
  'Enable thinking with xhigh reasoning',
  'Enable thinking with max (xhigh for OpenAI) reasoning'
] as const;

function withWhiteboardDefault(tools: ToolsConfig): ToolsConfig {
  return {
    ...tools,
    whiteboard_enabled: tools.whiteboard_enabled ?? false,
  };
}

function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn('toggle', checked && 'on', disabled && 'disabled')}
      onClick={() => !disabled && onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
    >
      <span className="toggle-thumb" />
    </button>
  );
}

function ToolGrantNote() {
  return (
    <p className="side-section-hint">
      Note: Checked tools are pre-approved. No permission popup appears.
    </p>
  );
}

/** Freezes the execution-affecting controls inside it while the current
 *  generation owns them. Applied per header control and per section body
 *  instead of to the whole `.side-body`, so a section's expand/collapse
 *  control — which stays outside every zone — remains usable during a
 *  response. Expanding a category is local view state and mutates nothing.
 *  The zone renders no box of its own (`display: contents`), so section
 *  layout is identical whether or not the panel is locked. */
function LockZone({ locked, children }: { locked: boolean; children: ReactNode }) {
  return (
    <div className="side-lock-zone" inert={locked || undefined} aria-disabled={locked || undefined}>
      {children}
    </div>
  );
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  hint?: string;
  format?: (n: number) => string;
  disabled?: boolean;
  /** When true, suppress the label+value row — caller renders it elsewhere. */
  hideLabel?: boolean;
  /** Values the slider should gently snap to (stop magnets). */
  magnets?: number[];
  /** Optional control rendered beside the visible label. */
  labelAccessory?: ReactNode;
}

function Slider({ label, value, min, max, step, onChange, hint, format, disabled, hideLabel, magnets, labelAccessory }: SliderProps) {
  const id = `slider-${label.replace(/\s+/g, '-')}`;
  const handleChange = (raw: number) => {
    if (magnets && magnets.length > 0) {
      const threshold = (max - min) * 0.02; // snap within 2% of range
      for (const m of magnets) {
        if (Math.abs(raw - m) <= threshold) { onChange(m); return; }
      }
    }
    onChange(raw);
  };
  return (
    <div className={cn('slider', disabled && 'disabled')}>
      {!hideLabel && (
        <div className="slider-head">
          <span className="slider-label-group">
            <label className="slider-label" htmlFor={id}>{label}</label>
            {labelAccessory}
          </span>
          <span className="slider-value">{format ? format(value) : value}</span>
        </div>
      )}
      <input
        id={id}
        aria-label={hideLabel ? label : undefined}
        type="range"
        list={magnets ? `${id}-ticks` : undefined}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => handleChange(parseFloat(e.target.value))}
      />
      {magnets && (
        <datalist id={`${id}-ticks`}>
          {magnets.map((m) => <option key={m} value={m} />)}
        </datalist>
      )}
      {hint && <div className="slider-hint">{hint}</div>}
    </div>
  );
}

const TEMPERATURE_RECOMMENDATIONS = [
  ['Claude 5', 'Omit · non-default rejected'],
  ['DeepSeek V4', 'Ignored when thinking'],
  ['Gemini 3.x', 'Omit · not configurable on native REST'],
  ['Gemma 4', '1.0'],
  ['GLM 5.x', '1.0'],
  ['GPT 5.x', 'Omit · mode-dependent'],
  ['Kimi K2.7 / K3', '1.0'],
  ['MiniMax M2.x / M3', '1.0'],
  ['Qwen 3.5–3.6', '1.0 thinking · 0.6 precise coding'],
  ['Qwen 3.7', '0.6 thinking · 0.7 non-thinking'],
  ['Qwen 3.8', '1.0 thinking'],
] as const;

/** Click-open reference kept beside Temperature. The recommendation record and
 *  its provider sources live in docs/data-model.md. */
function TemperatureInfoButton() {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, above: false });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const popoverId = 'temperature-recommendations';

  const toggle = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const above = rect.bottom + 350 > window.innerHeight;
      setPosition({
        top: above ? rect.top - 8 : rect.bottom + 8,
        left: rect.left + rect.width / 2,
        above,
      });
    }
    setOpen((current) => !current);
  };

  useEffect(() => {
    if (!open) return;
    const scroller = triggerRef.current?.closest('.side-body');
    const close = () => setOpen(false);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    scroller?.addEventListener('scroll', close);
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', close);
    return () => {
      scroller?.removeEventListener('scroll', close);
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="temperature-info-trigger"
        title="Show recommended temperatures"
        aria-label="Show recommended temperatures"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={toggle}
      >
        i
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          id={popoverId}
          className="token-meter-tooltip provider-report-tooltip temperature-info-popover"
          role="dialog"
          aria-label="Recommended temperatures"
          style={{
            position: 'fixed',
            top: position.top,
            left: position.left,
            transform: position.above ? 'translate(-50%, -100%)' : 'translateX(-50%)',
            zIndex: 100,
          }}
        >
          <div className="token-meter-tooltip-title">Recommended temperatures</div>
          <div className="token-meter-tooltip-rows provider-report-group">
            {TEMPERATURE_RECOMMENDATIONS.map(([family, recommendation]) => (
              <div className="token-meter-row" key={family}>
                <span className="token-meter-label">{family}</span>
                <span className="token-meter-value">{recommendation}</span>
              </div>
            ))}
          </div>
          <div className="temperature-info-note">
            🛈 Guidance varies by model and mode. Toggle off to use the server default.
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/** A single custom-skill row. Subscribes to shared Shift state only while
 *  hovered, and keeps the hook outside the parent's map callback. */
function CustomSkillRow({
  skill,
  checked,
  disabled,
  onToggle,
  onDelete,
  onPreview,
}: {
  skill: ConversationSkill;
  checked: boolean;
  disabled: boolean;
  onToggle: (v: boolean) => void;
  onDelete: () => void;
  onPreview: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const shiftHeld = useShiftHeld(hovered);

  return (
    <div
      className="side-skill-row"
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
    >
      <Toggle
        checked={checked}
        onChange={onToggle}
        label={`Make ${skill.name} available to the model`}
        disabled={disabled}
      />
      <div
        className="side-skill-copy side-skill-clickable"
        onClick={onPreview}
        title="Click to preview"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') onPreview(); }}
      >
        <span className="side-tool-name">{skill.name}</span>
        <span className="side-tool-desc">{skill.description}</span>
      </div>
      <button
        type="button"
        className={cn('side-skill-delete', shiftHeld && 'danger')}
        style={{ visibility: hovered ? 'visible' : 'hidden' }}
        disabled={disabled}
        onClick={(event) => {
          if (!event.shiftKey) {
            toast.info("Hold 'Shift' to activate 'Delete' button");
            return;
          }
          onDelete();
        }}
        aria-label={`Delete custom skill ${skill.name}`}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 7h16" />
          <path d="M9 7V4h6v3" />
          <path d="M6 7l1 13h10l1-13" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
        </svg>
      </button>
    </div>
  );
}

export function SidePanel({
  open,
  activeTab,
  onTabChange,
  onClose,
  workspaceSections,
  onWorkspaceSectionChange,
  workspaceExpandedDir,
  onWorkspaceExpandedDirChange,
  params,
  onChange,
  tools,
  onToolsChange,
  onOpenWhiteboard,
  onOpenRootsEditor,
  onGetSystemPrompt,
  customSkills,
  onCustomSkillsChange,
  apiVariant,
  locked = false,
}: Props) {
  const builtinSkills = getBuiltinSkillList();
  // Deduplicate custom skills by id — prevents React duplicate-key errors
  // if the store ever accumulates duplicate entries.
  const dedupedCustomSkills = useMemo(() => {
    const seen = new Set<string>();
    const unique: ConversationSkill[] = [];
    for (const skill of customSkills ?? []) {
      if (seen.has(skill.id)) continue;
      seen.add(skill.id);
      unique.push(skill);
    }
    return unique.sort(compareSkillsAlphabetically);
  }, [customSkills]);

  const [draft, setDraft] = useState<GenerationParams>(params);
  const [primaryParamsCollapsed, setPrimaryParamsCollapsed] = useState(false);
  const [additionalParamsCollapsed, setAdditionalParamsCollapsed] = useState(true);
  const initTimeout = () => {
    // Use the first toggled-on profile's timeout as the default.
    const firstToggled = useProfileStore.getState().profiles.find((p) => p.active);
    return firstToggled?.sse_read_timeout_min ?? 5;
  };
  const [toolsDraft, setToolsDraft] = useState<ToolsConfig>(
    tools
      ? withWhiteboardDefault(tools)
      : { ...DEFAULT_TOOLS, sse_read_timeout_min: initTimeout() },
  );
  const workspacePresentation = resolveWorkspaceProviderPresentation(toolsDraft, apiVariant);
  const isWindows = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('win');
  // Which directory (if any) currently shows its expanded tool checkbox sublist.
  // At most one directory is expanded at a time to keep memory footprint low.
  const expandedDir = workspaceExpandedDir ?? null;
  const setExpandedDir = (next: SetStateAction<string | null>) => {
    const value = typeof next === 'function' ? next(expandedDir) : next;
    onWorkspaceExpandedDirChange?.(value);
  };
  // Collapse/expanded-directory presentation belongs to ConversationUiState,
  // so returning to a chat restores the exact Workspace view without making
  // any execution-affecting setting global.
  const collapsed = (key: string) => workspaceSections?.[key] ?? true;
  const setCollapsed = (key: string, current: boolean) => (next: SetStateAction<boolean>) => {
    const value = typeof next === 'function' ? next(current) : next;
    onWorkspaceSectionChange?.(key, value);
  };
  const whiteboardCollapsed = collapsed('whiteboard');
  const shellCollapsed = collapsed('shell');
  const roundLimitCollapsed = collapsed('roundLimit');
  const batchLimitCollapsed = collapsed('batchLimit');
  const timeoutCollapsed = collapsed('timeout');
  const dirsCollapsed = collapsed('directories');
  const webAccessCollapsed = collapsed('webAccess');
  const skillsCollapsed = collapsed('skills');
  const setWhiteboardCollapsed = setCollapsed('whiteboard', whiteboardCollapsed);
  const setShellCollapsed = setCollapsed('shell', shellCollapsed);
  const setRoundLimitCollapsed = setCollapsed('roundLimit', roundLimitCollapsed);
  const setBatchLimitCollapsed = setCollapsed('batchLimit', batchLimitCollapsed);
  const setTimeoutCollapsed = setCollapsed('timeout', timeoutCollapsed);
  const setDirsCollapsed = setCollapsed('directories', dirsCollapsed);
  const setWebAccessCollapsed = setCollapsed('webAccess', webAccessCollapsed);
  const setSkillsCollapsed = setCollapsed('skills', skillsCollapsed);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // System prompt preview overlay.
  const [sysPromptPreview, setSysPromptPreview] = useState<string | null>(null);
  // Skill markdown preview overlay.
  const [skillPreview, setSkillPreview] = useState<{ id: string; name: string; content: string } | null>(null);

  useEffect(() => setDraft(params), [params]);
  useEffect(() => {
    if (tools) {
      setToolsDraft(withWhiteboardDefault(tools));
    } else {
      // Inherit the stream idle timeout from the first toggled-on
      // server profile so new conversations start with a sensible default.
      const firstToggled = useProfileStore.getState().profiles.find((p) => p.active);
      setToolsDraft({ ...DEFAULT_TOOLS, sse_read_timeout_min: firstToggled?.sse_read_timeout_min ?? 5 });
    }
  }, [tools]);

  // Escape closes the panel — but not when a modal is open above it. The
  // panel is docked chrome, not the innermost surface, so a modal that the
  // user is dismissing must not take the panel with it. Without this check
  // the panel closes itself even though the global shortcut bus is already
  // gated, because this is a second, independent `window` listener.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !modalWasOpenAtKeyDown()) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  // Compute which chip (if any) reflects the current draft. Exactly one
  // of {isServer, activePresetName, isCustom} is true at any time — the
  // row is a state indicator showing which mode the params are in.
  //   - "Server default": all *_enabled fields are false; the server
  //     uses its own built-in defaults. The numeric values are unused in
  //     this mode, so they are not compared — otherwise a slider the user
  //     nudged before switching everything off would pin the row to
  //     "Custom" while the composer and reply footnote said otherwise.
  //   - A preset: the generation-relevant fields exactly match a preset.
  //   - "Custom": at least one *_enabled is true, but it doesn't match
  //     any preset — the user has tweaked values that don't correspond
  //     to a known preset.
  // system_prompt and stop are intentionally excluded from this
  // comparison — they're orthogonal text fields the user can edit
  // independently of the preset selection.
  const activePreset = resolveParameterPreset(draft);
  const activePresetName = activePreset?.name ?? null;
  const isServer = !activePreset && isServerDefaultParams(draft);
  const isCustom = !activePreset && !isServer;
  return (
    <>
    <div className="side-overlay">
      <aside className={cn('side-panel', 'open')} onClick={(e) => e.stopPropagation()}>
        <header>
          <div className="side-panel-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'tools'}
              className={cn('side-panel-tab', activeTab === 'tools' && 'is-active')}
              onClick={() => onTabChange('tools')}
            >
              {/* Tools glyph — crossed wrench + screwdriver
                  from D:\Downloads\tools.svg. Solid fill. */}
              <svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                fill="currentColor"
                aria-hidden
              >
                <path d="M5.33 3.271a3.5 3.5 0 0 1 4.254 4.963l10.709 10.71-1.414 1.414-10.71-10.71a3.502 3.502 0 0 1-4.962-4.255L5.444 7.63a1.5 1.5 0 1 0 2.121-2.121L5.329 3.27zm10.367 1.884l3.182-1.768 1.414 1.414-1.768 3.182-1.768.354-2.12 2.121-1.415-1.414 2.121-2.121.354-1.768zm-6.718 8.132l1.414 1.414-5.303 5.303a1 1 0 0 1-1.492-1.327l.078-.087 5.303-5.303z" />
              </svg>
              Workspace
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'params'}
              className={cn('side-panel-tab', activeTab === 'params' && 'is-active')}
              onClick={() => onTabChange('params')}
            >
              {/* Sliders glyph — same one as the preset/Server
                  default chip in the Composer action row, so the
                  tab icon and the chip icon match visually. */}
              <svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M4 6h10" />
                <path d="M17 6h3" />
                <path d="M4 12h3" />
                <path d="M10 12h10" />
                <path d="M4 18h12" />
                <path d="M19 18h1" />
                <circle cx="15" cy="6" r="1.8" fill="var(--bg-elev-1)" />
                <circle cx="8" cy="12" r="1.8" fill="var(--bg-elev-1)" />
                <circle cx="17" cy="18" r="1.8" fill="var(--bg-elev-1)" />
              </svg>
              Parameters
            </button>
          </div>
          <button className="icon-btn-alt" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path
                fill="currentColor"
                d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
          </button>
        </header>

        {activeTab === 'params' && (
        <div
          className={cn('preset-row', locked && 'generation-config-locked')}
          inert={locked || undefined}
          aria-disabled={locked || undefined}
          title={locked ? ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE : undefined}
        >
          <button
            className={cn('chip', isServer && 'active')}
            onClick={() => {
              // Server default removes the preset's editable instruction as
              // well as every generation override. Stop sequences remain an
              // independent conversation setting.
              const next: GenerationParams = {
                ...DEFAULT_PARAMS,
                system_prompt: '',
                stop: draft.stop,
              };
              setDraft(next);
              onChange(next);
            }}
          >
            Server default
          </button>
          {PRESETS.map((p) => (
            <button
              key={p.name}
              className={cn('chip', activePresetName === p.name && 'active')}
              onClick={() => {
                // Start from DEFAULT_PARAMS (clean slate) and overlay the
                // preset so disabled controls retain predictable stored
                // values. The preset's instruction belongs in the existing
                // editable System prompt field, while stop remains orthogonal.
                const next: GenerationParams = {
                  ...DEFAULT_PARAMS,
                  ...p.params,
                  system_prompt: p.systemPrompt,
                  stop: draft.stop,
                };
                setDraft(next);
                onChange(next);
              }}
            >
              {p.name}
            </button>
          ))}
          {/*
            "Custom" is purely a status indicator — it's a span, not a
            button, so it has no click affordance, no keyboard focus,
            and no chance of accidentally looking interactive. It still
            gets the `.active` class when the current values don't
            match any preset or the server defaults, so the user can
            see at a glance that the params are bespoke.
          */}
          <span
            className={cn('chip', 'chip-indicator', isCustom && 'active')}
            title="The current values don't match any preset."
          >
            Custom
          </span>
        </div>
        )}

        {activeTab === 'tools' && onToolsChange && (
          <div
            className={cn('side-master', locked && 'generation-config-locked')}
            inert={locked || undefined}
            aria-disabled={locked || undefined}
            title={locked ? ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE : undefined}
          >
            {workspacePresentation.warning && (
              <p className="side-section-hint side-shell-warning" role="status" style={{ margin: "6px 12px 6px 10px" }}>{workspacePresentation.warning}</p>
            )}
            <div className="side-master-toggle" title="Allow the model to use enabled Workspace tools.">
              <span className="side-permissions-label">Activate Workspace tools</span>
              <Toggle
                checked={workspacePresentation.workspaceMasterChecked}
                onChange={async (v) => {
                  const previous = toolsDraft;
                  const expandFileIoForActivation =
                    v && toolsDraft.file_io_enabled !== true;
                  const expandWhiteboardForActivation =
                    v && toolsDraft.whiteboard_enabled !== true;
                  const next = setWorkspaceEnabled(toolsDraft, v);
                  setToolsDraft(next);
                  try {
                    const accepted = await onToolsChange(next);
                    if (accepted === false) {
                      setToolsDraft((current) => current === next ? previous : current);
                    } else {
                      if (expandFileIoForActivation) setDirsCollapsed(false);
                      if (expandWhiteboardForActivation) setWhiteboardCollapsed(false);
                    }
                  } catch (error) {
                    setToolsDraft((current) => current === next ? previous : current);
                    toast.error(`${WHITEBOARD_UI_TEXT.couldNotEnable} ${errorMessage(error)}`);
                  }
                }}
                label="Allow model to use tools"
                disabled={workspacePresentation.workspaceMasterDisabled}
              />
            </div>
            <div className="side-master-toggle" title="This option compacts completed-turn tool output and retains it for targeted recall.">
              <span className="side-permissions-label">Activate Tool History compaction</span>
              <Toggle
                checked={toolsDraft.tool_history_enabled ?? false}
                onChange={(v) => {
                  const next: ToolsConfig = {
                    ...toolsDraft,
                    tool_history_enabled: v,
                  };
                  setToolsDraft(next);
                  onToolsChange(next);
                }}
                label="Archive past results"
                disabled={!toolsDraft.enabled}
              />
            </div>
          </div>
        )}

        {/* The lock lives on the `LockZone`s inside, not on this container:
            the body keeps the locked styling/tooltip while each section's
            collapse control stays reachable. */}
        <div
          className={cn('side-body', locked && 'generation-config-locked')}
          title={locked ? ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE : undefined}
        >
          {activeTab === 'tools' && onToolsChange && (
            <>

              <div className={cn('side-section', !toolsDraft.enabled && 'disabled')}>
                <div className="side-section-header">
                  <button
                    type="button"
                    className="side-collapse-btn"
                    onClick={() => setRoundLimitCollapsed((p) => !p)}
                    aria-label={roundLimitCollapsed ? 'Expand tool-call round limit' : 'Collapse tool-call round limit'}
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden
                      style={{ transform: roundLimitCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                      <path d="M4.5 6L8 9.5 11.5 6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <h3>Max tool-call rounds per turn</h3>
                  </button>
                    <span className="iter-value">{toolsDraft.max_tool_rounds_per_turn}</span>
                </div>
                {!roundLimitCollapsed && (
                <LockZone locked={locked}>
                <Slider
                  hideLabel
                  label="Max tool-call rounds per turn"
                  value={toolsDraft.max_tool_rounds_per_turn ?? 128}
                  min={8}
                  max={256}
                  step={4}
                  magnets={[32, 64, 128]}
                  hint="Maximum rounds in one response. Each round may contain one call or a batch."
                  format={(n) => String(n)}
                  disabled={!toolsDraft.enabled}
                  onChange={(n) => {
                    const next = {
                      ...toolsDraft,
                      max_tool_rounds_per_turn: Math.round(n),
                    };
                    setToolsDraft(next);
                    onToolsChange(next);
                  }}
                />
                </LockZone>
                )}
              </div>

              <div className={cn('side-section', !toolsDraft.enabled && 'disabled')}>
                <div className="side-section-header">
                  <button
                    type="button"
                    className="side-collapse-btn"
                    onClick={() => setBatchLimitCollapsed((p) => !p)}
                    aria-label={batchLimitCollapsed ? 'Expand tool batch limit' : 'Collapse tool batch limit'}
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden
                      style={{ transform: batchLimitCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                      <path d="M4.5 6L8 9.5 11.5 6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <h3>Max tool calls per batch</h3>
                  </button>
                    <span className="iter-value">{toolsDraft.max_tool_calls_per_batch ?? DEFAULT_TOOL_BATCH_LIMIT}</span>
                </div>
                {!batchLimitCollapsed && (
                <LockZone locked={locked}>
                <Slider
                  hideLabel
                  label="Max tool calls per batch"
                  value={toolsDraft.max_tool_calls_per_batch ?? DEFAULT_TOOL_BATCH_LIMIT}
                  min={1}
                  max={64}
                  step={1}
                  magnets={[8, 16, 32]}
                  hint="Accepted calls run concurrently. An oversized batch is rejected and ends the response."
                  format={(n) => String(n)}
                  disabled={!toolsDraft.enabled}
                  onChange={(n) => {
                    const next = {
                      ...toolsDraft,
                      max_tool_calls_per_batch: Math.round(n),
                    };
                    setToolsDraft(next);
                    onToolsChange(next);
                  }}
                />
                </LockZone>
                )}
              </div>

              <div className={cn('side-section', !toolsDraft.enabled && 'disabled')}>
                <div className="side-section-header">
                  <button
                    type="button"
                    className="side-collapse-btn"
                    onClick={() => setTimeoutCollapsed((p) => !p)}
                    aria-label={timeoutCollapsed ? 'Expand stream timeout' : 'Collapse stream timeout'}
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden
                      style={{ transform: timeoutCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                      <path d="M4.5 6L8 9.5 11.5 6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <h3>Stream idle timeout</h3>
                  </button>
                    <span className="iter-value">{toolsDraft.sse_read_timeout_min} min</span>
                </div>
                {!timeoutCollapsed && (
                <LockZone locked={locked}>
                <Slider
                  hideLabel
                  label="Stream idle timeout"
                  value={toolsDraft.sse_read_timeout_min}
                  min={1}
                  max={60}
                  step={1}
                  magnets={[5, 15, 30]}
                  hint="Overrides the per-server default (Settings → Server Profiles). If no token arrives within this window, LC flags the session as stalled and automatically disconnects. Raise for models that pause during prolonged tooling sessions."
                  format={(n) => `${n} min`}
                  disabled={!toolsDraft.enabled}
                  onChange={(n) => {
                    const next = {
                      ...toolsDraft,
                      sse_read_timeout_min: Math.round(n),
                    };
                    setToolsDraft(next);
                    onToolsChange(next);
                  }}
                />
                </LockZone>
                )}
              </div>

              <div className={cn('side-section side-whiteboard-section side-generation-lock-exempt', !toolsDraft.enabled && 'disabled')}>
                <div className="side-section-header">
                  <button
                    type="button"
                    className="side-collapse-btn"
                    onClick={() => setWhiteboardCollapsed((p) => !p)}
                    aria-label={whiteboardCollapsed ? 'Expand Whiteboard' : 'Collapse Whiteboard'}
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden
                      style={{ transform: whiteboardCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                      <path d="M4.5 6L8 9.5 11.5 6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <h3>{WHITEBOARD_UI_TEXT.title}</h3>
                  </button>
                  <LockZone locked={locked}>
                    <Toggle
                      checked={toolsDraft.whiteboard_enabled ?? false}
                      onChange={async (enabled) => {
                        const next: ToolsConfig = {
                          ...toolsDraft,
                          whiteboard_enabled: enabled,
                        };
                        try {
                          const accepted = await onToolsChange(next);
                          if (accepted === false) return;
                          if (enabled) setWhiteboardCollapsed(false);
                          setToolsDraft(next);
                        } catch (error) {
                          toast.error(`${WHITEBOARD_UI_TEXT.couldNotEnable} ${errorMessage(error)}`);
                        }
                      }}
                      label={WHITEBOARD_UI_TEXT.enable}
                      disabled={!toolsDraft.enabled || locked}
                    />
                  </LockZone>
                </div>
                {!whiteboardCollapsed && (
                  <div className="side-section-hint-row">
                    <p className="side-section-hint">{WHITEBOARD_UI_TEXT.description}</p>
                    {onOpenWhiteboard && (
                      <button
                        type="button"
                        className="ghost-btn small"
                        disabled={!toolsDraft.enabled || !toolsDraft.whiteboard_enabled}
                        onClick={onOpenWhiteboard}
                        title={WHITEBOARD_UI_TEXT.open}
                      >
                        {WHITEBOARD_UI_TEXT.open}
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className={cn('side-section side-skills-section', !toolsDraft.enabled && 'disabled')}>
                <div className="side-section-header">
                  <button
                    type="button"
                    className="side-collapse-btn"
                    onClick={() => setSkillsCollapsed((p) => !p)}
                    aria-label={skillsCollapsed ? 'Expand Skills' : 'Collapse Skills'}
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden
                      style={{ transform: skillsCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                      <path d="M4.5 6L8 9.5 11.5 6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <h3>Skills</h3>
                  </button>
                  <LockZone locked={locked}>
                    <Toggle
                      checked={toolsDraft.skills_enabled ?? false}
                      onChange={(v) => {
                        if (v) setSkillsCollapsed(false);
                        const next = setSkillsEnabled(toolsDraft, v, DEFAULT_SKILL_IDS);
                        setToolsDraft(next);
                        onToolsChange(next);
                      }}
                      label="Expose lc_skill to the model"
                      disabled={!toolsDraft.enabled}
                    />
                  </LockZone>
                </div>
                {!skillsCollapsed && (
                  <LockZone locked={locked}>
                    <div className="side-section-hint-row">
                      <p className="side-section-hint">
                        Guidance for the model to discover with{' '}
                        <code style={{ color: 'var(--warning)' }}>lc_skill</code>.
                      </p>
                      <button
                        type="button"
                        className="ghost-btn small"
                        disabled={!toolsDraft.enabled || !toolsDraft.skills_enabled}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        Import
                      </button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".md,.markdown"
                        multiple
                        hidden
                        onChange={(event) => {
                          const files = event.target.files;
                          if (!files || files.length === 0) return;
                          void (async () => {
                            try {
                              const currentCustoms = dedupedCustomSkills;
                              const currentIds = new Set(toolsDraft.enabled_skill_ids ?? []);
                              const newSkills: ConversationSkill[] = [...currentCustoms];
                              let added = 0;
                              for (const file of Array.from(files)) {
                                const text = await file.text();
                                const parsed = parseSkillMarkdown(text, file.name);
                                const now = Date.now();
                                // Generate a conversation-scoped UUID for the custom skill.
                                const newUid = uid();
                                const customSkill: ConversationSkill = {
                                  id: newUid,
                                  source: 'custom',
                                  name: parsed.name,
                                  description: parsed.description,
                                  content: parsed.content,
                                  revision: parsed.revision,
                                  createdAt: now,
                                  updatedAt: now,
                                };
                                newSkills.push(customSkill);
                                currentIds.add(newUid);
                                added++;
                              }
                              // Update both custom_skills and enabled_skill_ids.
                              onCustomSkillsChange?.(newSkills);
                              const next = {
                                ...toolsDraft,
                                enabled_skill_ids: Array.from(currentIds),
                              };
                              setToolsDraft(next);
                              onToolsChange(next);
                              toast.success(`Imported ${added} custom skill${added === 1 ? '' : 's'} for this conversation.`);
                            } catch (err) {
                              toast.error(err instanceof Error ? err.message : 'Could not import skill.');
                            } finally {
                              if (fileInputRef.current) fileInputRef.current.value = '';
                            }
                          })();
                        }}
                      />
                    </div>
                    <div className={cn('side-dir-perms', (!toolsDraft.enabled || !toolsDraft.skills_enabled) && 'disabled')}>
                      <div className="side-tools-list">
                        {builtinSkills.map((skill) => {
                          const enabledIds = toolsDraft.enabled_skill_ids ?? [];
                          const checked = enabledIds.includes(skill.id);
                          const previewContent = materializeSkillForExposure(
                            skill,
                            [...resolveExposure(toolsDraft).exposedNames],
                          ).content;
                          return (
                            <div key={`builtin-${skill.id}`} className="side-skill-row side-skill-builtin">
                              <Toggle
                                checked={checked}
                                onChange={(v) => {
                                  const nextIds = new Set(enabledIds);
                                  if (v) nextIds.add(skill.id);
                                  else nextIds.delete(skill.id);
                                  const next = { ...toolsDraft, enabled_skill_ids: Array.from(nextIds) };
                                  setToolsDraft(next);
                                  onToolsChange(next);
                                }}
                                label={`Make ${skill.name} available to the model`}
                                disabled={!toolsDraft.enabled || !toolsDraft.skills_enabled}
                              />
                              <div
                                className="side-skill-copy side-skill-clickable"
                                onClick={() => setSkillPreview({ id: skill.id, name: skill.name, content: previewContent })}
                                title="Click to preview"
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => { if (e.key === 'Enter') setSkillPreview({ id: skill.id, name: skill.name, content: previewContent }); }}
                              >
                                <span className="side-tool-name">{skill.name}</span>
                                <span className="side-tool-desc">{skill.description}</span>
                              </div>
                            </div>
                          );
                        })}

                        {dedupedCustomSkills.length > 0 && (
                          <div className="side-skill-divider" role="separator" aria-label="Custom skills" />
                        )}

                        {dedupedCustomSkills.map((skill) => {
                          const enabledIds = toolsDraft.enabled_skill_ids ?? [];
                          const checked = enabledIds.includes(skill.id);
                          return (
                            <CustomSkillRow
                              key={`custom-${skill.id}`}
                              skill={skill}
                              checked={checked}
                              disabled={!toolsDraft.enabled || !toolsDraft.skills_enabled}
                              onToggle={(v) => {
                                const nextIds = new Set(enabledIds);
                                if (v) nextIds.add(skill.id);
                                else nextIds.delete(skill.id);
                                const next = { ...toolsDraft, enabled_skill_ids: Array.from(nextIds) };
                                setToolsDraft(next);
                                onToolsChange(next);
                              }}
                              onDelete={() => {
                                const nextCustoms = dedupedCustomSkills.filter((s) => s.id !== skill.id);
                                const nextIds = new Set(enabledIds);
                                nextIds.delete(skill.id);
                                onCustomSkillsChange?.(nextCustoms);
                                const next = { ...toolsDraft, enabled_skill_ids: Array.from(nextIds) };
                                setToolsDraft(next);
                                onToolsChange(next);
                              }}
                              onPreview={() => setSkillPreview({ id: skill.id, name: skill.name, content: skill.content })}
                            />
                          );
                        })}
                      </div>
                    </div>
                  </LockZone>
                )}
              </div>

              <div className={cn('side-section side-shell-section', !toolsDraft.enabled && 'disabled')}>
                <div className="side-section-header">
                  <button
                    type="button"
                    className="side-collapse-btn"
                    onClick={() => setShellCollapsed((p) => !p)}
                    aria-label={shellCollapsed ? 'Expand Shell binaries' : 'Collapse Shell binaries'}
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden
                      style={{ transform: shellCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                      <path d="M4.5 6L8 9.5 11.5 6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <h3>Shell binaries</h3>
                  </button>
                  <LockZone locked={locked}>
                    {(() => {
                      const shellExposed = toolsDraft.shell_enabled;
                      return (
                        <Toggle
                          checked={shellExposed}
                          onChange={(v) => {
                            if (v) setShellCollapsed(false);
                            const next = {
                              ...toolsDraft,
                              shell_enabled: v,
                            };
                            setToolsDraft(next);
                            onToolsChange?.(next);
                          }}
                          label="Expose lc_run_shell to the model"
                          disabled={!toolsDraft.enabled}
                        />
                      );
                    })()}
                  </LockZone>
                </div>
                {!shellCollapsed && (
                  <LockZone locked={locked}>
                <p className="side-section-hint">
                  Only the following binaries may be executed:
                </p>
                {(() => {
                  const globalShell = useSettings.getState().tools.shell_allowlist;
                  const isSet = toolsDraft.shell_allowlist !== undefined;
                  const def = getDefaultShellAllowlist();
                  return (
                    <textarea
                      id="workspace-shell-allowlist"
                      name="workspace-shell_allowlist"
                      className="shell-allowlist-textarea"
                      value={isSet ? toolsDraft.shell_allowlist : globalShell}
                      onChange={(e) => {
                        const next = { ...toolsDraft, shell_allowlist: e.target.value };
                        setToolsDraft(next);
                        onToolsChange?.(next);
                      }}
                      placeholder={def
                        ? `${def.split(',').slice(0, 5).join(',')},… (comma-separated, no spaces)`
                        : 'None'}
                      rows={3}
                      disabled={!toolsDraft.enabled}
                      readOnly={!toolsDraft.shell_enabled}
                      aria-readonly={!toolsDraft.shell_enabled}
                    />
                  );
                })()}
                <p className="side-section-hint side-shell-warning">
                  ⚠︎ Binaries can access any file on your system — they run outside LC's filesystem sandbox. Only expose the necessary binaries that you trust for the scope of your work. Avoid sensitive binaries or scripts beyond your control.
                </p>
                  </LockZone>
                )}
              </div>

              <div className={cn('side-section side-file-section', !toolsDraft.enabled && 'disabled')}>
                <div className="side-section-header">
                  <button
                    type="button"
                    className="side-collapse-btn"
                    onClick={() => setDirsCollapsed((p) => !p)}
                    aria-label={dirsCollapsed ? 'Expand File I/O' : 'Collapse File I/O'}
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden
                      style={{ transform: dirsCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                      <path d="M4.5 6L8 9.5 11.5 6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <h3>File I/O</h3>
                  </button>
                  <div className="side-section-header-right">
                    <LockZone locked={locked}>
                    <Toggle
                      checked={toolsDraft.file_io_enabled}
                      onChange={(v) => {
                        // Exposure only. Directory checkmarks are preserved.
                        // Auto-expand the section when toggled on.
                        if (v) setDirsCollapsed(false);
                        const next: ToolsConfig = {
                          ...toolsDraft,
                          file_io_enabled: v,
                        };
                        setToolsDraft(next);
                        onToolsChange(next);
                      }}
                      label="Expose File I/O tools to the model"
                      disabled={!toolsDraft.enabled}
                    />
                    </LockZone>
                  </div>
                </div>
                {!dirsCollapsed && (
                  <>
                <LockZone locked={locked}>
                <div className="side-section-hint-row">
                  <p className="side-section-hint">
                    Click Add to add a working directory.
                  </p>
                  {onOpenRootsEditor && (
                    <button
                      type="button"
                      className="ghost-btn small"
                      onClick={onOpenRootsEditor}
                      disabled={!toolsDraft.enabled || !toolsDraft.file_io_enabled}
                    >
                      Add
                    </button>
                  )}
                </div>
                </LockZone>
                <ul className="side-roots-preview">
                  {toolsDraft.allowed_roots.length === 0 && (
                    <li className="muted small2">None. Click <strong>Add</strong> to add some.</li>
                  )}
                  {toolsDraft.allowed_roots.map((root) => {
                    const displayedRoot = formatPathForDisplay(root, isWindows);
                    const isExpanded = expandedDir === root;
                    const grantCount = (toolsDraft.dir_permissions[root] ?? []).filter(
                      (t) => (FILE_IO_NAMES as readonly string[]).includes(t),
                    ).length;
                    return (
                      <li key={root}>
                        <div
                          role="button"
                          tabIndex={(!toolsDraft.enabled || !toolsDraft.file_io_enabled) ? -1 : 0}
                          className={cn(
                            'side-root-expand-btn',
                            (!toolsDraft.enabled || !toolsDraft.file_io_enabled) && 'disabled',
                          )}
                          onClick={() => {
                            if (!toolsDraft.enabled || !toolsDraft.file_io_enabled) return;
                            setExpandedDir(isExpanded ? null : root);
                          }}
                          onKeyDown={(e) => {
                            if (!toolsDraft.enabled || !toolsDraft.file_io_enabled) return;
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setExpandedDir(isExpanded ? null : root);
                            }
                          }}
                          aria-expanded={isExpanded}
                          aria-label={
                            isExpanded
                              ? `Collapse permissions for ${displayedRoot}`
                              : `Expand permissions for ${displayedRoot}`
                          }
                          aria-disabled={!toolsDraft.enabled || !toolsDraft.file_io_enabled}
                        >
                          <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden
                            style={{
                              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                              transition: 'transform 0.15s',
                              flexShrink: 0,
                            }}>
                            <path d="M6 4.5L9.5 8 6 11.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                          <code>{displayedRoot}</code>
                          <span className="root-grant-count">{grantCount}</span>
                          <LockZone locked={locked}>
                          <button
                            type="button"
                            className="workspace-manager-remove"
                            disabled={!toolsDraft.enabled || !toolsDraft.file_io_enabled}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!toolsDraft.enabled || !toolsDraft.file_io_enabled) return;
                              const nextRoots = toolsDraft.allowed_roots.filter((r) => r !== root);
                              const nextDirPerms = { ...toolsDraft.dir_permissions };
                              delete nextDirPerms[root];
                              const next = {
                                ...toolsDraft,
                                allowed_roots: nextRoots,
                                dir_permissions: nextDirPerms,
                              };
                              setToolsDraft(next);
                              onToolsChange(next);
                              if (expandedDir === root) setExpandedDir(null);
                            }}
                            aria-label={`Remove ${displayedRoot}`}
                          >
                            ×
                          </button>
                          </LockZone>
                        </div>
                        {isExpanded && (
                          <LockZone locked={locked}>
                          <div className={cn('side-dir-perms', !toolsDraft.file_io_enabled && 'disabled')}>
                            <div className="side-tools-list">
                              {FILE_IO_TOOL_GROUPS.map((group, groupIndex) => (
                                <div key={groupIndex} className="side-tools-group">
                                  {group.map((t) => {
                                    const dirPerms = toolsDraft.dir_permissions[root] ?? [];
                                    const checked = dirPerms.includes(t.name);
                                    return (
                                      <label key={t.name} className="side-tool-row">
                                        <div className="side-tool-head">
                                          <input
                                            type="checkbox"
                                            checked={checked}
                                            disabled={!toolsDraft.enabled || !toolsDraft.file_io_enabled}
                                            onChange={(e) => {
                                              const perms = new Set(toolsDraft.dir_permissions[root] ?? []);
                                              if (e.target.checked) perms.add(t.name);
                                              else perms.delete(t.name);
                                              const nextDirPerms = {
                                                ...toolsDraft.dir_permissions,
                                                [root]: Array.from(perms),
                                              };
                                              const next = {
                                                ...toolsDraft,
                                                dir_permissions: nextDirPerms,
                                              };
                                              setToolsDraft(next);
                                              onToolsChange(next);
                                            }}
                                          />
                                          <span className="side-tool-name">{t.name}</span>
                                        </div>
                                        <span className="side-tool-desc">{t.uiDescription ?? (typeof t.description === 'function' ? t.description() : t.description)}</span>
                                      </label>
                                    );
                                  })}
                                </div>
                              ))}
                            </div>
                          </div>
                          </LockZone>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <ToolGrantNote />
                  </>
                )}
              </div>

              <div className={cn('side-section side-network-section', !toolsDraft.enabled && 'disabled')}>
                <div className="side-section-header">
                  <button
                    type="button"
                    className="side-collapse-btn"
                    onClick={() => setWebAccessCollapsed((p) => !p)}
                    aria-label={webAccessCollapsed ? 'Expand Web Access' : 'Collapse Web Access'}
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden
                      style={{ transform: webAccessCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                      <path d="M4.5 6L8 9.5 11.5 6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <h3>Web Access</h3>
                  </button>
                  <LockZone locked={locked}>
                    {(() => {
                      return (
                        <Toggle
                          checked={toolsDraft.web_access_enabled}
                          onChange={(v) => {
                            if (v) setWebAccessCollapsed(false);
                            const next = setWebAccessEnabled(toolsDraft, v, WEB_ACCESS_NAMES);
                            setToolsDraft(next);
                            onToolsChange?.(next);
                          }}
                          label="Expose Web Access tools to the model"
                          disabled={!toolsDraft.enabled}
                        />
                      );
                    })()}
                  </LockZone>
                </div>
                {!webAccessCollapsed && (
                  <LockZone locked={locked}>
                <div className={cn('side-dir-perms', !toolsDraft.web_access_enabled && 'disabled')}>
                  <div className="side-tools-list">
                    {BUILTIN_TOOLS.filter((t) =>
                      (WEB_ACCESS_NAMES as readonly string[]).includes(t.name),
                    ).sort((a, b) => a.name.localeCompare(b.name)).map((t) => {
                      const checked = readToolGrants(toolsDraft, WEB_ACCESS_NAMES).has(t.name);
                      return (
                        <label key={t.name} className="side-tool-row">
                          <div className="side-tool-head">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!toolsDraft.enabled || !toolsDraft.web_access_enabled}
                              onChange={(e) => {
                                const nextGrants = new Set(toolsDraft.tool_grants ?? []);
                                if (e.target.checked) nextGrants.add(t.name);
                                else nextGrants.delete(t.name);
                                const next = {
                                  ...toolsDraft,
                                  tool_grants: Array.from(nextGrants),
                                  web_access_grants_initialized: true,
                                };
                                setToolsDraft(next);
                                onToolsChange?.(next);
                              }}
                            />
                            <span className="side-tool-name">{t.name}</span>
                          </div>
                          <span className="side-tool-desc">{t.uiDescription ?? (typeof t.description === 'function' ? t.description() : t.description)}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
                <p className="side-section-hint">
                  Note: Checked tools are pre-approved. No permission popup appears.
                </p>
                  </LockZone>
                )}
              </div>
            </>
          )}

          {activeTab === 'params' && (
          <>
          <div className="side-section primary-params-section">
            <div className="side-section-header">
              <button
                type="button"
                className="side-collapse-btn"
                onClick={() => setPrimaryParamsCollapsed((current) => !current)}
                aria-expanded={!primaryParamsCollapsed}
                aria-label={primaryParamsCollapsed
                  ? 'Expand primary parameters'
                  : 'Collapse primary parameters'}
              >
                <svg
                  viewBox="0 0 16 16"
                  width="12"
                  height="12"
                  aria-hidden
                  style={{
                    transform: primaryParamsCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                    transition: 'transform 0.15s',
                  }}
                >
                  <path d="M4.5 6L8 9.5 11.5 6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <h3>Primary parameters</h3>
              </button>
            </div>
            {!primaryParamsCollapsed && (
              <LockZone locked={locked}>
                <div className="parameter-section-body">
                  {apiVariant === 'gemini' && <p className="side-section-hint">
                    Gemini REST does not accept temperature, top-p, top-k, or repeat penalty overrides.
                  </p>}
                  <div className="slider-row">
                    <Toggle checked={draft.reasoning_enabled ?? false} onChange={(v) => update(draft, { reasoning_enabled: v }, setDraft, onChange)} label="Override thinking/reasoning effort" />
                    <div className={cn('param-row', !draft.reasoning_enabled && 'disabled')}>
                      <div className="slider-head">
                        <span className="slider-label" title="Override server's default thinking & reasoning effort/budget">Thinking → reasoning effort/budget</span>
                        {/* <span className="slider-value">{draft.reasoning_effort ?? 'medium'}</span> */}
                      </div>
                      {draft.reasoning_enabled && (
                        <div className="chip-row">
                          {REASONING_EFFORT_VALUES.map((v, i) => (
                            <button
                              key={v}
                              className={cn('chip', draft.reasoning_effort === v && 'active')}
                              onClick={() => update(draft, { reasoning_effort: v }, setDraft, onChange)}
                              type="button"
                              title={REASONING_EFFORT_DETAILS[i]}
                            >
                              {v}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="slider-hint">Override the default thinking and reasoning effort/budget.</div>
                    </div>
                  </div>

                  <div className="slider-row">
                    <Toggle disabled={apiVariant === 'gemini'} checked={apiVariant !== 'gemini' && (draft.temperature_enabled ?? false)} onChange={(v) => update(draft, { temperature_enabled: v }, setDraft, onChange)} label="Override temperature" />
                    <Slider label="Temperature" labelAccessory={<TemperatureInfoButton />} value={Math.min(1, draft.temperature)} min={0} max={1} step={0.01} magnets={[0.6]} hint="Override the default temperature: Focused <--o-----> Creative." disabled={apiVariant === 'gemini' || !draft.temperature_enabled} onChange={(n) => update(draft, { temperature: Math.min(1, n) }, setDraft, onChange)} />
                  </div>

                  {/* On the Anthropic budget_tokens path, max output and reasoning are
                      carved from the same allowance, so a low limit here silently
                      shrinks the effort selected above (modules.md,
                      "max_tokens and the thinking budget"). */}
                  <div className="slider-row">
                    <Toggle checked={draft.max_tokens_enabled ?? false} onChange={(v) => update(draft, { max_tokens_enabled: v }, setDraft, onChange)} label="Override max output tokens" />
                    <Slider label="Max output tokens" value={draft.max_tokens} min={1024} max={512000} step={256} hint="Override the default maximum output tokens of the model's reply." disabled={!draft.max_tokens_enabled} magnets={[64000, 96000, 128000, 192000, 256000, 384000]} onChange={(n) => update(draft, { max_tokens: n }, setDraft, onChange)} />
                  </div>

                  <label className="system-prompt">
                    <div className="slider-head">
                      <span className="slider-label">System prompt</span>
                    </div>
                    <textarea
                      rows={5}
                      placeholder="You are a helpful assistant…"
                      value={draft.system_prompt}
                      onChange={(e) => update(draft, { system_prompt: e.target.value }, setDraft, onChange)}
                    />
                  </label>
                </div>
              </LockZone>
            )}
          </div>

          <div className="side-section additional-params-section">
            <div className="side-section-header">
              <button
                type="button"
                className="side-collapse-btn"
                onClick={() => setAdditionalParamsCollapsed((current) => !current)}
                aria-expanded={!additionalParamsCollapsed}
                aria-label={additionalParamsCollapsed
                  ? 'Expand additional parameters'
                  : 'Collapse additional parameters'}
              >
                <svg
                  viewBox="0 0 16 16"
                  width="12"
                  height="12"
                  aria-hidden
                  style={{
                    transform: additionalParamsCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                    transition: 'transform 0.15s',
                  }}
                >
                  <path d="M4.5 6L8 9.5 11.5 6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <h3>Additional parameters</h3>
              </button>
            </div>
            {!additionalParamsCollapsed && (
              <LockZone locked={locked}>
                <div className="additional-params-body">
                  <div className="slider-row">
                    <Toggle disabled={apiVariant === 'gemini'} checked={apiVariant !== 'gemini' && (draft.repeat_penalty_enabled ?? false)} onChange={(v) => update(draft, { repeat_penalty_enabled: v }, setDraft, onChange)} label="Override repeat penalty" />
                    <Slider label="Repeat penalty" value={draft.repeat_penalty} min={0.5} max={2} step={0.05} hint="Override the default repeat penalty of the model's reply: 1.0 = off." disabled={apiVariant === 'gemini' || !draft.repeat_penalty_enabled} onChange={(n) => update(draft, { repeat_penalty: n }, setDraft, onChange)} />
                  </div>

                  <div className="slider-row">
                    <Toggle disabled={apiVariant === 'gemini'} checked={apiVariant !== 'gemini' && (draft.top_p_enabled ?? false)} onChange={(v) => update(draft, { top_p_enabled: v }, setDraft, onChange)} label="Override top-p" />
                    <Slider label="Top-p" value={draft.top_p} min={0} max={1} step={0.01} hint="Override the default top-p: 1.0 disables; 0.9 is a common default." disabled={apiVariant === 'gemini' || !draft.top_p_enabled} onChange={(n) => update(draft, { top_p: n }, setDraft, onChange)} />
                  </div>

                  <div className="slider-row">
                    <Toggle disabled={apiVariant === 'gemini'} checked={apiVariant !== 'gemini' && (draft.top_k_enabled ?? false)} onChange={(v) => update(draft, { top_k_enabled: v }, setDraft, onChange)} label="Override top-k" />
                    <Slider label="Top-k" value={draft.top_k} min={0} max={200} step={1} hint="Override the default top-k: 0 disables; 40 is a sensible common default." format={(n) => (n === 0 ? 'off' : String(n))} disabled={apiVariant === 'gemini' || !draft.top_k_enabled} onChange={(n) => update(draft, { top_k: n }, setDraft, onChange)} />
                  </div>

                  <label className="system-prompt">
                    <div className="slider-head">
                      <span className="slider-label">Stop sequences</span>
                      <span className="slider-value">{(draft.stop ?? '').split(/[\n,]/g).filter((s) => s.trim()).length || 0}</span>
                    </div>
                    <textarea
                      rows={2}
                      placeholder={'<|im_end|>\n### Instruction:'}
                      value={draft.stop ?? ''}
                      onChange={(e) => update(draft, { stop: e.target.value }, setDraft, onChange)}
                    />
                    <div className="slider-hint">
                      Comma- or newline-separated. Generation halts when any of these strings appear in the output.
                    </div>
                  </label>
                </div>
              </LockZone>
            )}
          </div>
          </>
          )}
        </div>
        {activeTab === 'tools' && onToolsChange && (
          <div className="side-section-nobg side-final-section">
            <button
              type="button"
              className="ghost-btn"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={async () => {
                if (!onGetSystemPrompt) {
                  setSysPromptPreview('(no callback configured)');
                  return;
                }
                try {
                  setSysPromptPreview(await onGetSystemPrompt());
                } catch (e) {
                  const msg = `Error building system prompt: ${errorMessage(e)}`;
                  debugLog.error(msg, e);
                  setSysPromptPreview(msg);
                }
              }}
            >
              See current system instructions
            </button>
            <button
              type="button"
              className="ghost-btn"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={() => {
                useSettings.getState().requestOpenAgenticTools();
                window.dispatchEvent(new CustomEvent('lc-open-agentic-tools-settings'));
              }}
            >
              Open Settings {'>'} Workspace
            </button>
          </div>
        )}
      </aside>
    </div>
    {sysPromptPreview !== null && (
      <SysPromptPreview
        content={sysPromptPreview}
        structuredToolsSent={workspacePresentation.workspacePromptEnabled}
        onClose={() => setSysPromptPreview(null)}
      />)}
    {skillPreview !== null && (
      <SkillPreview
        id={skillPreview.id}
        name={skillPreview.name}
        content={skillPreview.content}
        onClose={() => setSkillPreview(null)}
      />)}
  </>);
}

/** Skill markdown preview modal — reuses text-preview panel styling. */
function SkillPreview({ id, name, content, onClose }: { id: string; name: string; content: string; onClose: () => void }) {
  useOverlayEscape(onClose);

  return (
    <div
      className="text-preview"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div className="text-preview-panel" onClick={(e) => e.stopPropagation()}>
        <div className="text-preview-header">
          <div className="text-preview-title">
            <span className="text-preview-name" title={name}>{name}</span>
            <span
              className="text-preview-id-badge"
              title={`Copy skill ID: ${id}`}
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(id).then(
                  () => toast.success('Skill ID copied'),
                  () => toast.error('Failed to copy'),
                );
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  navigator.clipboard.writeText(id).then(
                    () => toast.success('Skill ID copied'),
                    () => toast.error('Failed to copy'),
                  );
                }
              }}
            >
              <span>{id}</span>
              <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden>
                <path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
              </svg>
            </span>
          </div>
          <button className="text-preview-close" onClick={onClose} aria-label="Close" type="button">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
        <div className="text-preview-body">
          <Markdown>{content}</Markdown>
        </div>
      </div>
    </div>
  );
}

/** System prompt preview modal — native Escape handler to avoid
 *  closing the parent SidePanel via the global shortcuts handler. */
function SysPromptPreview({
  content,
  structuredToolsSent,
  onClose,
}: {
  content: string;
  structuredToolsSent: boolean;
  onClose: () => void;
}) {
  // Only acts while this is the innermost overlay — opening the F1 sheet on
  // top of this preview used to close both on a single Escape.
  useOverlayEscape(onClose);

  return (
    <div
      className="sys-prompt-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div className="sys-prompt-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sys-prompt-modal-header">
          <h3>System instructions for the model</h3>
          <button className="icon-btn-alt" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
        <pre className="sys-prompt-modal-code">{content}</pre>
        {structuredToolsSent && (
          <p className="sys-prompt-modal-note">Note: "Exposed tool definitions" is a human-readable summary — full JSON schemas with parameter descriptions are sent separately via <code>req.tools</code>.</p>
        )}
      </div>
    </div>
  );
}

function update(
  draft: GenerationParams,
  patch: Partial<GenerationParams>,
  setDraft: (p: GenerationParams) => void,
  onChange: (p: GenerationParams) => void,
) {
  const next = { ...draft, ...patch };
  setDraft(next);
  onChange(next);
}
