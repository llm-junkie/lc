import type { ToolCallRecord } from '../tool-engine/types';

/** Commands implemented by cmd.exe rather than standalone Windows programs. */
export const WINDOWS_CMD_BUILTINS = new Set([
  'assoc', 'break', 'call', 'cd', 'chdir', 'cls', 'color', 'copy', 'date', 'del',
  'dir', 'echo', 'endlocal', 'erase', 'exit', 'for', 'ftype', 'goto', 'if', 'md',
  'mkdir', 'mklink', 'move', 'path', 'pause', 'popd', 'prompt', 'pushd', 'rd', 'rem',
  'ren', 'rename', 'rmdir', 'set', 'setlocal', 'shift', 'start', 'time', 'title', 'type',
  'ver', 'verify', 'vol',
]);

type ShellInput = {
  cmd: string;
  args?: string[];
  [key: string]: unknown;
};

type TokenSpan = { raw: string; value: string; start: number; end: number };

function tokenSpans(text: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index++;
    if (index >= text.length) break;
    const start = index;
    let quoted = false;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') quoted = !quoted;
      else if (!quoted && /\s/.test(char)) break;
      index++;
    }
    const end = index;
    const raw = text.slice(start, end);
    const value = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
      ? raw.slice(1, -1)
      : raw;
    spans.push({ raw, value, start, end });
  }
  return spans;
}

function basename(executable: string): string {
  return executable.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
}

function isCmd(executable: string): boolean {
  const name = basename(executable);
  return name === 'cmd' || name === 'cmd.exe';
}

function stripOneOuterQuotePair(value: string): string {
  const trimmed = value.trim();
  const quoteCount = [...trimmed].filter((char) => char === '"').length;
  return quoteCount === 2 && trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

function quoteTailToken(token: string): string {
  if (token === '' || (/\s/.test(token) && !token.includes('"'))) return `"${token}"`;
  return token;
}

function joinTailTokens(tokens: string[]): string {
  if (tokens.length === 1) return stripOneOuterQuotePair(tokens[0]);
  return tokens.map(quoteTailToken).join(' ');
}

/**
 * Normalize an explicit Windows cmd.exe /c request before approval and audit.
 *
 * This is deliberately not a general Windows command-line parser. It only:
 * - separates the cmd executable from a backward-compatible full `cmd` string;
 * - preserves everything after `/c` as one command tail;
 * - adds `/d` (disable AutoRun) and `/u` (Unicode builtin output).
 */
export function normalizeWindowsCmdInput(input: ShellInput): ShellInput {
  const cmdText = input.cmd.trim();
  const cmdTokens = tokenSpans(cmdText);
  const executableToken = cmdTokens[0];
  if (!executableToken || !isCmd(executableToken.value)) return input;

  const remainderStart = executableToken.end;
  const remainder = cmdText.slice(remainderStart).trimStart();
  const remainderTokens = tokenSpans(remainder);
  const cInRemainder = remainderTokens.findIndex((token) => token.value.toLowerCase() === '/c');

  let flags: string[];
  let tail: string;
  if (cInRemainder >= 0) {
    flags = remainderTokens.slice(0, cInRemainder).map((token) => token.value);
    const cToken = remainderTokens[cInRemainder];
    const rawTail = stripOneOuterQuotePair(remainder.slice(cToken.end));
    const appended = input.args?.length ? joinTailTokens(input.args) : '';
    tail = [rawTail, appended].filter(Boolean).join(' ');
  } else {
    const combined = [
      ...remainderTokens.map((token) => token.value),
      ...(input.args ?? []),
    ];
    const cIndex = combined.findIndex((token) => token.toLowerCase() === '/c');
    if (cIndex < 0) return input;
    flags = combined.slice(0, cIndex);
    tail = joinTailTokens(combined.slice(cIndex + 1));
  }

  const retainedFlags = flags.filter((flag) => {
    const lower = flag.toLowerCase();
    return lower !== '/d' && lower !== '/u' && lower !== '/a';
  });
  return {
    ...input,
    cmd: executableToken.value,
    args: ['/d', '/u', ...retainedFlags, '/c', tail],
  };
}

export function normalizeWindowsShellCall(
  call: ToolCallRecord,
  windows = isWindowsPlatform(),
): ToolCallRecord {
  if (!windows || call.name !== 'lc_run_shell') return call;
  try {
    const parsed = JSON.parse(call.arguments) as unknown;
    if (!parsed || typeof parsed !== 'object') return call;
    const input = parsed as Partial<ShellInput>;
    if (typeof input.cmd !== 'string') return call;
    const normalized = normalizeWindowsCmdInput(input as ShellInput);
    return normalized === input
      ? call
      : { ...call, arguments: JSON.stringify(normalized) };
  } catch {
    return call;
  }
}

export function isWindowsPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /win/i.test(navigator.platform || navigator.userAgent || '');
}
