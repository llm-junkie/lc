/**
 * get_current_time — return the current time.
 *
 * Pure JavaScript (no Tauri command). The time lookup does not require
 * a native call. The model cannot influence what `new Date()` returns.
 *
 * (Decision from the v2 review exchange; the architecture spec
 * previously listed this as a Tauri command, which was a leftover
 * from an earlier draft.)
 */
import { z } from 'zod';
import type { ToolHandler } from '../types';
import type { JsonSchema } from '../../llm-client/types';

export const CURRENT_TIME_TZ_MAX_CHARACTERS = 255;

export const CURRENT_TIME_TZ_LIMIT_MESSAGE =
  `tz accepts at most ${CURRENT_TIME_TZ_MAX_CHARACTERS} characters. Shorten the IANA timezone name.`;

const schema = z.object({
  tz: z.string().max(CURRENT_TIME_TZ_MAX_CHARACTERS, CURRENT_TIME_TZ_LIMIT_MESSAGE).optional(),
  format: z.enum(['iso', 'rfc2822', 'unix_ms']).optional(),
});

export type GetCurrentTimeInput = z.infer<typeof schema>;

export interface GetCurrentTimeOutput {
  time: string;
  tz: string;
  unix_ms: number;
  /** Non-null when the requested tz was not a valid IANA timezone —
   *  the response was produced in the fallback timezone instead. */
  tz_warning: string | null;
}

const CACHED_SCHEMA = Object.freeze(schema.toJSONSchema()) as unknown as JsonSchema;

/** Normalize Intl's short-offset forms into ISO 8601 timezone suffixes. */
export function normalizeIsoOffset(offset: string): string {
  const raw = offset.startsWith('GMT') ? offset.slice(3) : offset;
  if (!raw) return 'Z';

  const match = /^([+-])(\d{1,2})(?::(\d{2}))?$/.exec(raw);
  if (!match) return raw;

  const [, sign, hours, minutes = '00'] = match;
  return `${sign}${hours.padStart(2, '0')}:${minutes}`;
}

/** Format RFC 2822 using the requested timezone and a numeric offset. */
export function formatRfc2822(date: Date, tz: string): string {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
    timeZoneName: 'shortOffset',
  });
  const parts = dtf.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const isoOffset = normalizeIsoOffset(get('timeZoneName'));
  const rfcOffset = isoOffset === 'Z' ? '+0000' : isoOffset.replace(':', '');
  return `${get('weekday')}, ${get('day')} ${get('month')} ${get('year')} ` +
    `${get('hour')}:${get('minute')}:${get('second')} ${rfcOffset}`;
}

export function invalidTimezoneWarning(systemTz: string): string {
  return `The tz value is not a valid IANA timezone. LC used ${systemTz}. ` +
    'Use "UTC", "America/New_York", "Asia/Kolkata", or "Europe/London".';
}

function formatTime(date: Date, tz: string, format: 'iso' | 'rfc2822' | 'unix_ms' | undefined): string {
  if (format === 'unix_ms') return String(date.getTime());
  if (format === 'rfc2822') return formatRfc2822(date, tz);
  // Default: ISO 8601 in the requested timezone with UTC offset.
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
      timeZoneName: 'shortOffset',
    });
    const parts = dtf.formatToParts(date);
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
    const offset = get('timeZoneName'); // e.g. "GMT", "GMT+2", or "GMT+07:00"
    const normalizedOffset = normalizeIsoOffset(offset);
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${normalizedOffset}`;
  } catch {
    return date.toISOString();
  }
}

export function resolveTz(requested: string | undefined): { tz: string; tz_warning?: string } {
  const systemTz = (() => {
    try {
      return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  })();

  if (!requested || !requested.trim()) return { tz: systemTz };
  const trimmed = requested.trim();

  // Validate by asking Intl directly. `supportedValuesOf()` intentionally
  // omits valid aliases and some runtime-supported primary identifiers
  // (including UTC, Asia/Kolkata, and Asia/Kathmandu in some runtimes).
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format();
    return { tz: trimmed };
  } catch {
    // Invalid timezone; fall through to the explicit fallback warning.
  }

  // Invalid timezone — fall back to system tz with a warning.
  return {
    tz: systemTz,
    tz_warning: invalidTimezoneWarning(systemTz),
  };
}

export const getCurrentTime: ToolHandler<GetCurrentTimeInput, GetCurrentTimeOutput> = {
  name: 'lc_get_current_time',
  description:
    'Return the current time in ISO 8601, RFC 2822, or Unix millisecond format.\n' +
    'The RFC 2822 format uses the requested timezone and a numeric offset.\n' +
    'Use tz to request an IANA timezone name.\n' +
    `tz accepts at most ${CURRENT_TIME_TZ_MAX_CHARACTERS} characters.\n` +
    'Examples are "Europe/Brussels" and "America/New_York".\n' +
    'The default timezone is the local operating-system timezone.\n' +
    'The default format is ISO 8601.',
  uiDescription: 'Current time in ISO 8601, RFC 2822, or Unix ms.',
  input: schema,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (input) => {
    const date = new Date();
    const resolved = resolveTz(input.tz);
    const result: GetCurrentTimeOutput = {
      time: formatTime(date, resolved.tz, input.format),
      tz: resolved.tz,
      unix_ms: date.getTime(),
      tz_warning: resolved.tz_warning ?? null,
    };
    return result;
  },
};
