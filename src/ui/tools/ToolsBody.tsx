import { useState } from 'react';
import type { ToolPermissionAudit } from '../../types';

/** Renders tool call rows for the active message: status icon,
 *  name, duration, args (expandable JSON), and result (truncated). */

export interface ToolCallItem {
  call: {
    id: string;
    name: string;
    arguments: string;
    created_at?: number;
  };
  result?: {
    output: string;
    is_error: boolean;
    duration_ms: number;
    permission?: ToolPermissionAudit;
  };
  isRunning: boolean;
}

export interface ToolsBodyProps {
  items: ToolCallItem[];
}

const TRUNCATE_AT_BYTES = 16 * 1024; // 16 KiB

function formatArgs(args: string): string {
  if (!args) return '{}';
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

const ARGS_CAP = 8 * 1024;       // 8 KiB
const ARGS_HEAD = 5 * 1024;     // keep first 5 KiB
const ARGS_TAIL = 3 * 1024;     // keep last 3 KiB

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= TRUNCATE_AT_BYTES) return { text, truncated: false };
  return {
    text:
      text.slice(0, TRUNCATE_AT_BYTES - 5_000) +
      '\n…\n' +
      text.slice(text.length - 5_000),
    truncated: true,
  };
}

function truncateArgs(text: string): { text: string; truncated: boolean } {
  if (text.length <= ARGS_CAP) return { text, truncated: false };
  return {
    text:
      text.slice(0, ARGS_HEAD) +
      '\n…\n' +
      text.slice(text.length - ARGS_TAIL),
    truncated: true,
  };
}

function LazyDetails({ summary, children, className }: {
  summary: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className={className} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{summary}</summary>
      {open && children}
    </details>
  );
}

function statusIcon(item: ToolCallItem): { glyph: string; label: string } {
  if (item.isRunning) return { glyph: '⏳', label: 'running' };
  if (!item.result) return { glyph: '⏳', label: 'pending' };
  if (item.result.is_error) return { glyph: '✗', label: 'error' };
  return { glyph: '✓', label: 'ok' };
}

function permissionDecisionLabel(decision: ToolPermissionAudit['decision']): string {
  switch (decision) {
    case 'allow_once': return 'Allowed once';
    case 'allow_session': return 'Allowed for conversation';
    case 'deny': return 'Denied';
    case 'aborted': return 'Aborted';
    case 'unavailable': return 'Popup unavailable';
  }
}

function permissionSummary(decision: ToolPermissionAudit['decision']): {
  label: string;
  tone: 'allowed' | 'denied' | 'neutral';
} {
  switch (decision) {
    case 'allow_once':
    case 'allow_session':
      return { label: 'Allowed', tone: 'allowed' };
    case 'deny':
      return { label: 'Denied', tone: 'denied' };
    case 'aborted':
      return { label: 'Aborted', tone: 'neutral' };
    case 'unavailable':
      return { label: 'Unavailable', tone: 'neutral' };
  }
}

function formatPermissionDelay(start: number, end: number | undefined): string {
  if (end == null) return 'not recorded';
  const duration = Math.max(0, end - start);
  return duration < 1_000 ? `${duration} ms` : `${(duration / 1_000).toFixed(2)} s`;
}

function PermissionBlock({ audit }: { audit: ToolPermissionAudit }) {
  const decisionTime = audit.shown_at ?? audit.requested_at;
  const decisionTimeLabel = audit.shown_at == null ? 'Resolution wait' : 'Popup open';
  return (
    <div className="tools-body-permission-grid">
      <span>Decision</span><strong>{permissionDecisionLabel(audit.decision)}</strong>
      <span>Requested</span><code>{new Date(audit.requested_at).toISOString()}</code>
      <span>Shown</span><code>{audit.shown_at == null ? 'not shown' : new Date(audit.shown_at).toISOString()}</code>
      <span>Resolved</span><code>{new Date(audit.resolved_at).toISOString()}</code>
      <span>Queue wait</span><code>{formatPermissionDelay(audit.requested_at, audit.shown_at)}</code>
      <span>{decisionTimeLabel}</span><code>{formatPermissionDelay(decisionTime, audit.resolved_at)}</code>
      <span>Prompt ID</span><code>{audit.prompt_id}</code>
      <span>Displayed call</span>
      <code>{audit.displayed_call.tool_name} · {audit.displayed_call.tool_call_id}</code>
      <span>Scopes</span>
      {audit.scopes.length > 0
        ? <ul>{audit.scopes.map((scope) => <li key={scope}><code>{scope}</code></li>)}</ul>
        : <code>(none)</code>}
    </div>
  );
}

export function ToolsBody({ items }: ToolsBodyProps) {
  if (items.length === 0) {
    return (
      <div className="tools-body-empty">
        No tool calls in this turn.
      </div>
    );
  }
  return (
    <div className="tools-body-list">
      {items.map((item) => {
        const { glyph, label } = statusIcon(item);
        const dur = item.result?.duration_ms;
        const permission = item.result?.permission;
        const permissionStatus = permission && permissionSummary(permission.decision);
        return (
          <div
            key={item.call.id}
            className={`tools-body-row tools-body-row-${label}`}
          >
            <div className="tools-body-head">
              <span className="tools-body-name">{item.call.name}</span>
              <span className="tools-body-status" aria-label={label}>
                {glyph}
              </span>
              {item.call.created_at != null && (
                <span className="tools-body-time">
                  {new Date(item.call.created_at).toLocaleString()}
                </span>
              )}
              {dur != null && (
                <span className="tools-body-duration">
                  {dur < 1 ? '<1 ms' : dur < 1000 ? `${Math.round(dur)} ms` : `${(dur / 1000).toFixed(2)} s`}
                </span>
              )}
            </div>
            {(() => {
              const rawLen = item.call.arguments.length;
              const argsTrunc = rawLen > ARGS_CAP;
              return (
                <LazyDetails className="tools-body-details" summary={<>args{argsTrunc ? ` (${rawLen.toLocaleString()} chars — capped)` : ''}</>}>
                  <pre className="tools-body-args">
                    {truncateArgs(formatArgs(item.call.arguments)).text}
                  </pre>
                </LazyDetails>
              );
            })()}
            {permission && permissionStatus && (
              <LazyDetails
                className="tools-body-details"
                summary={(
                  <>
                    permission ·{' '}
                    <strong className={`tools-body-permission-status is-${permissionStatus.tone}`}>
                      {permissionStatus.label}
                    </strong>
                  </>
                )}
              >
                <PermissionBlock audit={permission} />
              </LazyDetails>
            )}
            {item.result && (
              <LazyDetails className="tools-body-details" summary={<span className="tools-body-result-label">result</span>}>
                <ResultBlock output={item.result.output} />
              </LazyDetails>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ResultBlock({ output }: { output: unknown }) {
  // `output` is typed `string` in ToolCallItem, but the symptom of
  // the recent bug was `[object Object]` rendered here — meaning
  // something on the path had coerced an object via String() and
  // the wrapper made it through. Be defensive: stringify, then
  // pretty-print any embedded JSON object so the user sees the
  // actual entries instead of "[object Object]".
  let pretty: string;
  if (typeof output === 'string') {
    pretty = output;
  } else if (output == null) {
    pretty = '';
  } else if (typeof output === 'object') {
    try {
      pretty = JSON.stringify(output, null, 2);
    } catch {
      pretty = '[unserializable]';
    }
  } else {
    pretty = String(output);
  }
  // If the string IS JSON of an object/array, pretty-print it.
  // Skip JSON.parse for large strings (>100KB) — parsing and
  // re-stringifying a 1.5MB base64 blob blocks the main thread
  // and the result gets truncated anyway. Truncate directly.
  if (pretty.length < 100_000 && (pretty.startsWith('{') || pretty.startsWith('['))) {
    try {
      const parsed = JSON.parse(pretty);
      if (typeof parsed === 'object' && parsed !== null) {
        pretty = JSON.stringify(parsed, null, 2);
      }
    } catch {
      /* not actually JSON — show raw */
    }
  }
  const { text, truncated } = truncate(pretty);
  return (
    <>
      <pre className="tools-body-result-pre">{text}</pre>
      {truncated && (
        <div className="tools-body-truncated">
          (display capped at 16 KiB)
        </div>
      )}
    </>
  );
}
