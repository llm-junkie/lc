/**
 * Compact file-change facts are persisted on tool messages. Diff previews are
 * rebuilt from the matching tool arguments when the conversation is rendered,
 * which keeps persisted tool results small and also upgrades older messages.
 */

import { FILE_IO_MUTATING_NAMES } from './registry-names.ts';
import { decodeLcResultJson } from './tool-result-content.ts';

export type FileChangeType = 'added' | 'modified' | 'deleted' | 'renamed';
export type FileDiffLineType = 'context' | 'added' | 'removed';

export interface FileDiffLine {
  type: FileDiffLineType;
  content: string;
}

export interface FileChangeHunk {
  /** Human-readable hunk label. Native patch hunks do not carry line numbers. */
  label: string;
  lines: FileDiffLine[];
  /** Mutating LC tool that produced this operation preview. */
  toolName?: string;
  /** Completion time of the persisted tool-result message, as Unix ms. */
  timestamp?: number;
  /** True when the source change was capped for responsive rendering. */
  truncated?: boolean;
}

export interface FileChangePreviewSource {
  toolName: string;
  toolArguments: string;
  /** Completion time of the matching persisted tool-result message. */
  timestamp?: number;
  /** Path identity at the time this particular operation ran. */
  path: string;
  moveTo?: string;
  added: number;
  removed: number;
  changeType?: FileChangeType;
}

export interface FileLineChange {
  path: string;
  added: number;
  removed: number;
  /** Destination path for a successful rename/move, when applicable. */
  moveTo?: string;
  changeType?: FileChangeType;
  /** Transient display data. Newly-persisted rows omit this field. */
  hunks?: FileChangeHunk[];
  /** Transient, compact recipes resolved only while the modal is open. */
  previewSources?: FileChangePreviewSource[];
  /** Explains why only counts, rather than removed source lines, are available. */
  previewUnavailableReason?: string;
}

export interface FileLineChanges {
  added: number;
  removed: number;
  files: FileLineChange[];
}

const MUTATING_FILE_TOOLS: ReadonlySet<string> = new Set(FILE_IO_MUTATING_NAMES);
const MAX_HUNK_LINES = 500;

function asNonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return asObject(value);
  try {
    return asObject(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function parseToolOutput(output: string): Record<string, unknown> | undefined {
  return asObject(decodeLcResultJson(output)?.data);
}

function inferChangeType(toolName: string, entry: Record<string, unknown>): FileChangeType {
  if (toolName === 'lc_apply_patch') {
    if (entry.action === 'add') return 'added';
    if (entry.action === 'delete') return 'deleted';
    if (entry.action === 'move') return 'renamed';
    return 'modified';
  }
  if (toolName === 'lc_edit_file') return entry.created === true ? 'added' : 'modified';
  if (toolName === 'lc_write_file') return entry.mode === 'create' ? 'added' : 'modified';
  return 'modified';
}

/**
 * Return the aggregate line changes for one completed mutating file tool.
 * `undefined` means the call did not successfully mutate a file, so the
 * assistant bubble should not show a badge.
 */
export function summarizeFileLineChanges(
  toolName: string,
  output: string,
): FileLineChanges | undefined {
  if (!MUTATING_FILE_TOOLS.has(toolName)) return undefined;

  const root = parseToolOutput(output);
  if (!root) return undefined;
  const entries = root[toolName === 'lc_apply_patch' ? 'files' : 'results'];
  if (!Array.isArray(entries)) return undefined;

  let mutated = false;
  const files: FileLineChange[] = [];

  for (const item of entries) {
    const entry = asObject(item);
    if (!entry) continue;
    if (typeof entry.error === 'string' && entry.error.length > 0) continue;
    if (toolName === 'lc_edit_file' && entry.replaced !== true) continue;
    if (entry.lines_added === undefined && entry.lines_removed === undefined) continue;

    // The presence of a successful entry matters separately from the totals:
    // a pure rename legitimately reports +0/-0 but still changed files.
    mutated = true;
    const path = typeof entry.path === 'string' && entry.path.length > 0
      ? entry.path
      : '(unknown file)';
    files.push({
      path,
      added: asNonNegativeInt(entry.lines_added),
      removed: asNonNegativeInt(entry.lines_removed),
      changeType: inferChangeType(toolName, entry),
      ...(typeof entry.move_to === 'string' && entry.move_to.length > 0
        ? { moveTo: entry.move_to }
        : {}),
    });
  }

  return mutated ? mergeFileLineChanges(files) : undefined;
}

function pathKey(path: string): string {
  let key = path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (key.startsWith('./')) key = key.slice(2);
  if (key.length > 1) key = key.replace(/\/$/, '');
  // Windows drive and UNC paths are case-insensitive. Preserve case for
  // relative and POSIX paths, where differently-cased names may be distinct.
  if (/^[a-z]:\//i.test(key) || key.startsWith('//')) key = key.toLocaleLowerCase();
  return key;
}

function changeAliases(change: FileLineChange): string[] {
  return [change.path, change.moveTo]
    .filter((path): path is string => !!path && path !== '(unknown file)')
    .map(pathKey);
}

function mergeChangeType(
  previous: FileChangeType | undefined,
  next: FileChangeType | undefined,
): FileChangeType | undefined {
  if (!previous) return next;
  if (!next) return previous;
  if (next === 'deleted') return 'deleted';
  if (previous === 'deleted' && next === 'added') return 'modified';
  if (next === 'renamed' || previous === 'renamed') return 'renamed';
  if (previous === 'added') return 'added';
  return 'modified';
}

function joinReasons(first?: string, second?: string): string | undefined {
  if (!first) return second;
  if (!second || first === second) return first;
  return `${first} ${second}`;
}

/**
 * Fold chronologically ordered file changes into one logical row per file.
 * Aliases follow rename chains, so `old.ts -> new.ts` followed by an edit of
 * `new.ts` stays a single entry.
 */
export function mergeFileLineChanges(changes: readonly FileLineChange[]): FileLineChanges {
  const files: FileLineChange[] = [];
  const aliasToIndex = new Map<string, number>();

  for (const change of changes) {
    const aliases = changeAliases(change);
    const existingIndex = aliases
      .map((alias) => aliasToIndex.get(alias))
      .find((index): index is number => index !== undefined);

    if (existingIndex === undefined) {
      const next: FileLineChange = {
        ...change,
        ...(change.hunks ? { hunks: [...change.hunks] } : {}),
      };
      const index = files.push(next) - 1;
      for (const alias of aliases) aliasToIndex.set(alias, index);
      continue;
    }

    const existing = files[existingIndex];
    existing.added += change.added;
    existing.removed += change.removed;
    existing.changeType = mergeChangeType(existing.changeType, change.changeType);
    if (change.moveTo) existing.moveTo = change.moveTo;
    if (change.hunks?.length) existing.hunks = [...(existing.hunks ?? []), ...change.hunks];
    if (change.previewSources?.length) {
      existing.previewSources = [...(existing.previewSources ?? []), ...change.previewSources];
    }
    const previewUnavailableReason = joinReasons(
      existing.previewUnavailableReason,
      change.previewUnavailableReason,
    );
    if (previewUnavailableReason) existing.previewUnavailableReason = previewUnavailableReason;

    for (const alias of [...changeAliases(existing), ...aliases]) {
      aliasToIndex.set(alias, existingIndex);
    }
  }

  return {
    files,
    added: files.reduce((total, file) => total + file.added, 0),
    removed: files.reduce((total, file) => total + file.removed, 0),
  };
}

function splitTextLines(content: string): string[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (content.endsWith('\n') || content.endsWith('\r')) lines.pop();
  return lines;
}

function capHunk(label: string, lines: FileDiffLine[]): FileChangeHunk {
  if (lines.length <= MAX_HUNK_LINES) return { label, lines };
  return { label, lines: lines.slice(0, MAX_HUNK_LINES), truncated: true };
}

function linesOf(type: FileDiffLineType, content: string): FileDiffLine[] {
  return splitTextLines(content).map((line) => ({ type, content: line }));
}

interface ParsedPatchFile {
  path: string;
  moveTo?: string;
  hunks: FileChangeHunk[];
}

function parseApplyPatch(patch: string): ParsedPatchFile[] {
  const files: ParsedPatchFile[] = [];
  let current: ParsedPatchFile | undefined;
  let hunkLines: FileDiffLine[] = [];
  let hunkLabel = '';

  const flushHunk = () => {
    if (!current || hunkLines.length === 0) return;
    current.hunks.push(capHunk(hunkLabel || `Change ${current.hunks.length + 1}`, hunkLines));
    hunkLines = [];
    hunkLabel = '';
  };
  const flushFile = () => {
    flushHunk();
    if (current) files.push(current);
    current = undefined;
  };

  for (const line of patch.replace(/\r\n?/g, '\n').split('\n')) {
    const fileHeader = line.match(/^\*\*\* (Add|Update|Delete) File:\s*(.+)$/);
    if (fileHeader) {
      flushFile();
      current = { path: fileHeader[2].trim(), hunks: [] };
      if (fileHeader[1] === 'Add') hunkLabel = 'New file';
      continue;
    }
    if (!current) continue;

    const moveHeader = line.match(/^\*\*\* Move to:\s*(.+)$/);
    if (moveHeader) {
      current.moveTo = moveHeader[1].trim();
      continue;
    }
    if (line.startsWith('*** End Patch')) {
      flushFile();
      continue;
    }
    if (line.startsWith('@@')) {
      flushHunk();
      const detail = line.slice(2).trim();
      hunkLabel = detail || `Change ${current.hunks.length + 1}`;
      continue;
    }
    if (line.startsWith('+')) hunkLines.push({ type: 'added', content: line.slice(1) });
    else if (line.startsWith('-')) hunkLines.push({ type: 'removed', content: line.slice(1) });
    else if (line.startsWith(' ')) hunkLines.push({ type: 'context', content: line.slice(1) });
  }
  flushFile();
  return files;
}

function findInputFile(files: unknown, path: string): Record<string, unknown> | undefined {
  if (!Array.isArray(files)) return undefined;
  const wanted = pathKey(path);
  return files
    .map(asObject)
    .find((file) => typeof file?.path === 'string' && pathKey(file.path) === wanted);
}

function editInputFiles(input: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(input.files)) return input.files.map(asObject).filter(Boolean) as Record<string, unknown>[];
  if (typeof input.path !== 'string') return [];
  return [{ path: input.path, old_string: input.old_string, new_string: input.new_string }];
}

/**
 * Add transient diff hunks to persisted change facts using the matching tool
 * arguments. This is intentionally pure so historical conversations receive
 * the richer preview without a data migration.
 */
export function addFileChangePreviews(
  toolName: string,
  toolArguments: unknown,
  changes: readonly FileLineChange[],
): FileLineChange[] {
  const input = parseJsonObject(toolArguments);
  if (!input) return changes.map((change) => ({ ...change }));

  if (toolName === 'lc_apply_patch' && typeof input.patch === 'string') {
    const parsedFiles = parseApplyPatch(input.patch);
    return changes.map((change) => {
      const aliases = new Set(changeAliases(change));
      const parsed = parsedFiles.find((file) =>
        [file.path, file.moveTo].filter(Boolean).some((path) => aliases.has(pathKey(path!))),
      );
      if (parsed?.hunks.length) return { ...change, hunks: parsed.hunks };
      const reason = change.changeType === 'deleted'
        ? 'The patch records that this file was deleted, but not its previous contents.'
        : 'No textual hunk was available for this change.';
      return { ...change, previewUnavailableReason: reason };
    });
  }

  if (toolName === 'lc_edit_file') {
    const inputs = editInputFiles(input);
    return changes.map((change) => {
      const editInput = findInputFile(inputs, change.path);
      if (!editInput || typeof editInput.new_string !== 'string') return { ...change };
      const lines = change.changeType === 'added'
        ? linesOf('added', editInput.new_string)
        : [
            ...(typeof editInput.old_string === 'string' ? linesOf('removed', editInput.old_string) : []),
            ...linesOf('added', editInput.new_string),
          ];
      return { ...change, hunks: [capHunk(change.changeType === 'added' ? 'New file' : 'Replacement', lines)] };
    });
  }

  if (toolName === 'lc_write_file') {
    return changes.map((change) => {
      const writeInput = findInputFile(input.files, change.path);
      if (!writeInput || typeof writeInput.content !== 'string') return { ...change };
      const mode = typeof input.mode === 'string' ? input.mode : 'create';
      const reason = change.removed > 0
        ? 'The previous file contents were not retained. The preview shows the resulting content only.'
        : undefined;
      return {
        ...change,
        hunks: [capHunk(mode === 'append' ? 'Appended content' : 'Resulting content', linesOf('added', writeInput.content))],
        ...(reason ? { previewUnavailableReason: reason } : {}),
      };
    });
  }

  return changes.map((change) => ({ ...change }));
}

/** Resolve every operation that contributed to one merged file, on demand. */
export function materializeFileChangePreview(change: FileLineChange): FileLineChange {
  if (!change.previewSources?.length) return change;

  let hunks = [...(change.hunks ?? [])];
  let previewUnavailableReason = change.previewUnavailableReason;
  for (const source of change.previewSources) {
    const [preview] = addFileChangePreviews(
      source.toolName,
      source.toolArguments,
      [{
        path: source.path,
        ...(source.moveTo ? { moveTo: source.moveTo } : {}),
        added: source.added,
        removed: source.removed,
        changeType: source.changeType,
      }],
    );
    if (preview.hunks?.length) {
      hunks = [
        ...hunks,
        ...preview.hunks.map((hunk) => ({
          ...hunk,
          toolName: source.toolName,
          ...(source.timestamp !== undefined ? { timestamp: source.timestamp } : {}),
        })),
      ];
    }
    previewUnavailableReason = joinReasons(previewUnavailableReason, preview.previewUnavailableReason);
  }

  return {
    ...change,
    ...(hunks.length ? { hunks } : {}),
    ...(previewUnavailableReason ? { previewUnavailableReason } : {}),
  };
}
