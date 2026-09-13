import type {
  EditFileResult,
  GlobFilesResult,
  GrepSearchResult,
  ReadFileResult,
  RunShellResult,
} from './sandbox-bridge';

/** Compile-time fixtures pin native field presence at the raw bridge boundary. */
export const NATIVE_RESULT_CONTRACT_FIXTURES = {
  runShellTimeout: {
    stdout: '', stderr: '', exit_code: null, duration_ms: 1, timed_out: true,
    stdout_truncated: false, stderr_truncated: true,
  } satisfies RunShellResult,
  editDiagnostic: {
    path: 'file', replaced: false, occurrences: 2, file_exists: true,
    bytes_before: 1, bytes_after: 1, created: false, hint: 'ambiguous',
    match_lines: [1, 3], near_match_lines: [2],
  } satisfies EditFileResult,
  // Success entries carry `encoding`; a transcoded read announces it.
  readTranscoded: {
    path: 'log.txt', content: 'needle\n', total_lines: 1, size_bytes: 16,
    truncated: false, sha256: 'ab', encoding: 'utf-16le',
  } satisfies ReadFileResult['results'][number],
  grepDiagnostics: {
    path: 'root', pattern: 'needle', matches: [], truncated: true,
    truncated_reason: 'visited', files: [], counts: [],
    visited_entries: 3, files_selected: 2, bytes_read: 10,
    skipped_large: 1, skipped_binary: 1, skipped_symlink: 1, skipped_unreadable: 1,
    files_transcoded: 1,
  } satisfies GrepSearchResult,
  // Cancellation is a truncated result, never an `error`.
  grepCancelled: {
    path: 'root', pattern: 'needle', matches: [], truncated: true,
    truncated_reason: 'cancelled', files: [], counts: [],
    visited_entries: 0, files_selected: 0, bytes_read: 0,
    skipped_large: 0, skipped_binary: 0, skipped_symlink: 0, skipped_unreadable: 0, files_transcoded: 0,
  } satisfies GrepSearchResult,
  // context_lines attaches numbered, capped context around each match.
  grepContext: {
    path: 'root', pattern: 'needle',
    matches: [{
      file: 'a.txt', line: 3, content: 'needle', content_truncated: false,
      before: [{ line: 1, content: 'one', content_truncated: false }, { line: 2, content: 'two', content_truncated: true }],
      after: [{ line: 4, content: 'four', content_truncated: false }],
    }],
    truncated: false, files: [], counts: [],
    visited_entries: 2, files_selected: 1, bytes_read: 40,
    skipped_large: 0, skipped_binary: 0, skipped_symlink: 0, skipped_unreadable: 0, files_transcoded: 0,
  } satisfies GrepSearchResult,
  // files_with_matches mode: `files` carries the result, `matches` is empty.
  grepFilesMode: {
    path: 'root', pattern: 'needle', matches: [], files: ['root/a.txt', 'root/b.txt'], counts: [],
    truncated: false,
    visited_entries: 3, files_selected: 2, bytes_read: 20,
    skipped_large: 0, skipped_binary: 0, skipped_symlink: 0, skipped_unreadable: 0, files_transcoded: 0,
  } satisfies GrepSearchResult,
  globDiagnostics: {
    matches: [{ path: 'dir', is_dir: true, size_bytes: null }],
    // A cancelled traversal is still this result shape and retains matches.
    truncated: true, pattern_used: '**/*', visited_entries: 1,
  } satisfies GlobFilesResult,
};
