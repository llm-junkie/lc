/**
 * Typed sandbox bridge — wraps all Tauri tool commands behind a
 * single interface so tool handlers never call `invoke()` directly.
 *
 * Benefits:
 *   - TypeScript can check argument shapes at compile time.
 *   - Tests can swap in `createMockBridge()` with no Rust runtime.
 *   - Adding a new tool command is one new method + one Rust impl.
 */
import { invoke } from '@tauri-apps/api/core';

// ── read_file ──────────────────────────────────────────────────────

export interface ReadFileArgs {
  paths: string[];
  start_line?: number;
  end_line?: number;
  max_bytes?: number;
  allowed_roots: string[];
  /** Operation/group identity for the native cancellation registry. */
  call_id: string;
  group_id: string;
}

export interface ReadFileEntry {
  path: string;
  content: string;
  total_lines: number;
  size_bytes: number;
  truncated: boolean;
  sha256?: string;
  /**
   * Success entries only, like `sha256`. The encoding the content was
   * decoded from: `utf-8` unchanged, or `utf-16le` / `utf-16be` when
   * the file was transcoded. Writing transcoded content back with
   * every write tool refuses that file, because storing UTF-8 would
   * change its encoding.
   */
  encoding?: "utf-8" | "utf-16le" | "utf-16be";
  /** Stable code for an error entry. Absent on success. */
  error_code?: string;
  error?: string;
}

export interface ReadFileResult {
  results: ReadFileEntry[];
}

// ── read_image ─────────────────────────────────────────────────────

export interface ReadImageArgs {
  paths: string[];
  max_bytes?: number;
  encoding?: 'original' | 'low_jpeg' | 'medium_jpeg';
  downscale?: number;
  analyze?: boolean;
  instruction?: string;
  allowed_roots: string[];
}

export interface ReadImageEntry {
  path: string;
  mime: string;
  size_bytes: number;
  original_size_bytes: number;
  original_wh?: [number, number] | null;
  wh_downscale?: number;
  encoding: string;
  truncated: boolean;
  /** Raw bridge payload consumed by the handler's side-channel cache. */
  data_url?: string;
  error?: string;
}

export interface ReadImageResult {
  images: ReadImageEntry[];
  analyzed?: boolean;
  description?: string;
}

// ── read_pdf ───────────────────────────────────────────────────────

/** Resolved profile handed to native sub-agent processing; never persisted. */
export interface NativeModelConfig {
  server_url: string;
  model: string;
  api_key?: string;
  api_variant?: string;
  api_style?: string;
  request_headers: Array<[string, string]>;
}

export interface ReadPdfArgs {
  summarize?: boolean;
  instruction?: string;
  text_model?: NativeModelConfig;
  vision_model?: NativeModelConfig;
  vision_available?: boolean;
  paths: string[];
  depth?: 'text_only' | 'full';
  /** 1-based page numbers. Parsed JS-side so the range grammar stays
   *  unit-testable there; Rust receives explicit indices. */
  pages?: number[];
  force_render?: number[];
  include_text?: boolean;
  max_bytes?: number;
  dpi?: number;
  max_render_pages?: number;
  max_text_pages?: number;
  allowed_roots: string[];
  /** Operation/group identity for the native cancellation registry. */
  call_id?: string;
  group_id?: string;
  /** Remaining wall-clock budget for this call, in milliseconds. */
  deadline_ms?: number;
}

/** Public native PDF output; rendered payloads are never bridge fields. */
export interface ReadPdfPage {
  page: number;
  chars: number;
  provenance: 'text_layer' | 'none';
  kind: string | null;
  image_rendered: boolean;
  render_reason: string | null;
  planned_render_reason: string | null;
  render_skipped: string | null;
  tables_md: string[];
  text: string | null;
  error: string | null;
}

export interface ReadPdfFile {
  path: string;
  pages_total: number;
  pages_processed: number[];
  has_text_layer: boolean;
  depth: 'text_only' | 'full';
  summary: string | null;
  pages: ReadPdfPage[];
  pages_rendered: number;
  truncated: boolean;
  error: string | null;
}

export interface ReadPdfResult {
  files: ReadPdfFile[];
  warnings: string[];
}

// ── write_file ─────────────────────────────────────────────────────

export interface WriteFileArgs {
  files: Array<{
    path: string;
    content: string;
    /**
     * Optional SHA-256 of the content this write assumes is present, as
     * returned by `lc_read_file`. The native side rejects the write when the
     * current file hashes differently (optimistic concurrency control).
     */
    expected_sha256?: string;
  }>;
  mode?: 'create' | 'overwrite' | 'append';
  allowed_roots: string[];
}

export interface WriteFileEntry {
  path: string;
  bytes_written: number;
  mode: 'create' | 'overwrite' | 'append';
  lines_added?: number;
  lines_removed?: number;
  error?: string;
}

export interface WriteFileResult {
  results: WriteFileEntry[];
}

// ── list_dir ───────────────────────────────────────────────────────

export interface ListDirArgs {
  paths: string[];
  pattern?: string;
  include_hidden?: boolean;
  max_entries?: number;
  allowed_roots: string[];
}

export interface ListDirEntry {
  name: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
  size?: number;
  mtime?: number;
}

export interface ListDirDirResult {
  path: string;
  entries: ListDirEntry[];
  truncated: boolean;
  error?: string;
}

export interface ListDirResult {
  results: ListDirDirResult[];
}

// ── stat ───────────────────────────────────────────────────────────

export interface StatArgs {
  paths: string[];
  allowed_roots: string[];
}

export interface StatEntry {
  path: string;
  exists: boolean;
  is_dir: boolean;
  is_file: boolean;
  canonical: string | null;
  size_bytes: number | null;
  mtime_ms: number | null;
  error: string | null;
}

export interface StatResult {
  results: StatEntry[];
}

// ── run_shell ──────────────────────────────────────────────────────

export interface RunShellArgs {
  cmd: string;
  args?: string[];
  cwd?: string;
  timeout_ms?: number;
  env?: Record<string, string>;
  allowed_roots: string[];
  allowlist: string;
  /** Phase 2.1: Operation-level identity (maps to Rust registry key). */
  call_id: string;
  /** Phase 2.1: Execution-group identity — shared by all native children
   *  of one model tool call. Used for group-level abort. */
  group_id?: string;
  stdin?: string;
}

export interface RunShellResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

// ── grep ───────────────────────────────────────────────────────────

export interface GrepArgs {
  searches: Array<{ path: string; pattern: string; include?: string }>;
  include?: string;
  /** Glob pattern to skip files (same dialect as `include`). Batch-wide. */
  exclude?: string;
  ignore_case?: boolean;
  max_results?: number;
  /** Lines of context before and after each match. Content mode only. */
  context_lines?: number;
  output_mode?: "content" | "files_with_matches" | "count";
  /** Per-file match cap. A further match sets `truncated=true` with `per_file_matches`. */
  max_matches_per_file?: number;
  /** Search inside the fixed skip directories (node_modules, .git, ...). */
  include_excluded_dirs?: boolean;
  allowed_roots: string[];
  /** Phase 2.1: Operation-level identity for cancellation registration. */
  call_id?: string;
  /** Execution group shared by native children of one model tool call. */
  group_id?: string;
  /** Max directory entries to visit across the entire call (default 50k, hard cap 200k). */
  max_visited_entries?: number;
  /** Max total bytes to read across all files (default 100 MB, hard cap 500 MB). */
  max_bytes_read?: number;
  /** Wall-clock budget in milliseconds from native call start. */
  deadline_ms?: number;
}

export interface GrepContextLine {
  line: number;
  /** Context line, capped at 2000 characters like match content. */
  content: string;
  content_truncated?: boolean;
}

export interface GrepMatch {
  file: string;
  line: number;
  /** Matching line, capped at 2000 characters. */
  content: string;
  /** Present only when `content` was cut; absence means the line is complete. */
  content_truncated?: boolean;
  /**
   * Present only when the source file was transcoded, so absence means
   * UTF-8. The bytes on disk are not what `content` shows, and the
   * writers refuse that file.
   */
  encoding?: 'utf-16le' | 'utf-16be';
  /** Present only when `context_lines` was requested and lines exist before the match. */
  before?: GrepContextLine[];
  /** Present only when `context_lines` was requested and lines exist after the match. */
  after?: GrepContextLine[];
}

/**
 * Why a search stopped early or completeness was not determined.
 * Causes can coincide, so the native side resolves them in this fixed
 * precedence: cancelled > deadline > results > match_bytes > bytes >
 * visited > per_file_matches.
 *
 * `results` means the result budget emptied. The search checks the rest
 * of the current file and one more candidate. It reports `true` if that
 * check finds a further match. It reports `null` if completeness stays
 * unknown.
 */
export type GrepTruncationReason =
  | 'cancelled'
  | 'deadline'
  | 'results'
  | 'match_bytes'
  | 'bytes'
  | 'visited'
  | 'per_file_matches';

export interface GrepSearchResult {
  path: string;
  pattern: string;
  matches: GrepMatch[];
  /** True means proven truncation. Null means completeness was not determined. */
  truncated: boolean | null;
  truncated_reason?: GrepTruncationReason;
  /**
   * A real search-side failure only, such as an invalid regex. An
   * unresolvable path never reaches this field: the whole-call pre-flight
   * rejects the batch before the search runs. Cancellation is reported as
   * `truncated_reason: 'cancelled'`, never here.
   */
  error?: string;
  /** Stable code for a per-search error. Absent on success. */
  error_code?: string;
  /**
   * Diagnostics are required, not optional: an absent field must never
   * have to be told apart from a zero one. Every entry carries all of
   * them, including error and cancelled entries.
   */
  visited_entries: number;
  /** Files chosen for content search after all filters. Not a match count. */
  files_selected: number;
  bytes_read: number;
  skipped_large: number;
  skipped_binary: number;
  skipped_symlink: number;
  skipped_unreadable: number;
  /** Files decoded from UTF-16 before searching. Their matches carry `encoding`. */
  files_transcoded: number;
  /**
   * Present exactly when the call used output_mode "files_with_matches":
   * one entry per matching file, in the order they were searched.
   * `matches` is empty in that mode.
   */
  files?: string[];
  /**
   * Present exactly when the call used output_mode "count": per-file
   * match counts. `matches` is empty in that mode.
   */
  counts?: Array<{ file: string; count: number }>;
}

export interface GrepResult {
  results: GrepSearchResult[];
}

// ── edit ───────────────────────────────────────────────────────────

export interface EditFileEntry {
  path: string;
  old_string: string;
  new_string: string;
}

export interface EditArgs {
  files: EditFileEntry[];
  create_if_missing?: boolean;
  allowed_roots: string[];
}

export interface EditFileResult {
  path: string;
  replaced: boolean;
  occurrences: number;
  file_exists: boolean;
  bytes_before: number;
  bytes_after: number;
  lines_added?: number;
  lines_removed?: number;
  created?: boolean;
  hint?: string;
  match_lines?: number[];
  near_match_lines?: number[];
  error?: string;
}

export interface EditResult {
  results: EditFileResult[];
}

// ── web_fetch ──────────────────────────────────────────────────────

export interface WebFetchArgs {
  url: string;
  max_bytes?: number;
  timeout_ms?: number;
  strip_mode?: 'clean' | 'minimal' | 'raw';
  /** Phase 2.1: Operation-level identity (maps to Rust registry key). */
  call_id: string;
  /** Phase 2.1: Execution-group identity — shared by all native children
   *  of one model tool call. Used for group-level abort. */
  group_id?: string;
}

export interface WebFetchResult {
  status: number;
  final_url: string;
  content_type: string;
  body: string;
  truncated: boolean;
}

// ── web_search ─────────────────────────────────────────────────────

export interface WebSearchArgs {
  query: string;
  max_results?: number;
  /** "pd" | "pw" | "pm" | "py" or custom range like "2024-01-01to2024-06-30".
   *  Brave only — reported in `ignored_params` on other providers. */
  freshness?: string;
  /** Which backend to query. Resolved from user settings, never from the
   *  model. See `src/modules/tool-engine/search-provider.ts`. */
  provider?: 'brave' | 'searxng' | 'marginalia';
  /** API key for brave/marginalia. Unused by searxng. */
  api_key?: string;
  /** Base URL of the user's SearXNG instance. Unused by the others. */
  base_url?: string;
  /** Request up to 5 additional alternative excerpts per result.
   *  Brave only — reported in `ignored_params` on other providers. */
  extra_snippets?: boolean;
  call_id?: string;
  group_id?: string;
  deadline_ms?: number;
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  /** Up to 5 additional alternative excerpts (only when extra_snippets is true). */
  extra_snippets?: string[];
}

export interface WebSearchResult {
  results: WebSearchHit[];
  source: string;
}

// ── analyze_images (vision sub-agent) ──────────────────────────────

export interface AnalyzeImagesArgs {
  paths: string[];
  encoding?: 'original' | 'low_jpeg' | 'medium_jpeg';
  downscale?: number;
  max_bytes?: number;
  /** Operation/group identity used by the native cancellation registry. */
  call_id: string;
  group_id: string;
  allowed_roots: string[];
  server_url: string;
  model: string;
  api_key?: string;
  /** "openai" | "anthropic" | "lm-studio" — which protocol adapter to use. */
  api_variant?: string;
  /** "chat" | "responses" — only meaningful when api_variant is "openai". */
  api_style?: string;
  /** Fully resolved extra headers for the native provider request. */
  request_headers?: Array<[string, string]>;
  system_prompt: string;
  /** User's custom instruction (without image labels).
   *  Used for per-image calls so each image gets the user's intent. */
  user_instruction?: string;
  /** Provider token ceiling for each per-image response. */
  max_tokens?: number;
}

export interface AnalyzeImagesResult {
  images: ReadImageEntry[];
  analyzed: boolean;
  description: string | null;
  truncated: boolean;
  total_requested: number;
  processed_count: number;
  analyzed_count: number;
  described_count: number;
  dropped_count: number;
  warning?: string;
}

// ── apply_patch ────────────────────────────────────────────────────

export interface ApplyPatchArgs {
  patch: string;
  allowed_roots: string[];
  /** Native preflight plan ID — required and revalidated before mutation. */
  plan_id: string;
  /** Operation/group identity for the native cancellation registry. */
  call_id: string;
  group_id: string;
}

export interface ApplyPatchFileResult {
  path: string;
  action: 'add' | 'update' | 'delete' | 'move';
  move_to?: string;
  hunks_applied: number;
  lines_added?: number;
  lines_removed?: number;
  warnings: string[];
  error?: string;
}

export interface ApplyPatchResult {
  files: ApplyPatchFileResult[];
  summary: string;
  fully_applied: boolean;
}

// ── apply_patch preflight ──────────────────────────────────────────

export interface ApplyPatchPreflightArgs {
  patch: string;
  allowed_roots: string[];
}

export interface ApplyPatchTargetsArgs {
  patch: string;
}

export interface PatchAction {
  action: string;
  path: string;
  move_to?: string;
}

export interface ApplyPatchPreflightResult {
  plan_id: string;
  affected_paths: string[];
  actions: PatchAction[];
  diagnostics: string[];
}

export interface ApplyPatchTargetsResult {
  affected_paths: string[];
  actions: PatchAction[];
  diagnostics: string[];
}

// ── glob_files ─────────────────────────────────────────────────────

export interface GlobFilesArgs {
  pattern: string;
  root: string;
  allowed_roots: string[];
  include_hidden?: boolean;
  max_results?: number;
  call_id?: string;
  group_id?: string;
  deadline_ms?: number;
}

export interface GlobFilesResult {
  matches: Array<{
    path: string;
    is_dir: boolean;
    size_bytes?: number | null;
  }>;
  /** True when traversal stopped early; cancellation preserves partial matches. */
  truncated: boolean;
  pattern_used: string;
  visited_entries?: number;
}

// ── SandboxBridge ──────────────────────────────────────────────────

export interface SandboxBridge {
  readFile(args: ReadFileArgs): Promise<ReadFileResult>;
  readImage(args: ReadImageArgs): Promise<ReadImageResult>;
  readPdf(args: ReadPdfArgs): Promise<ReadPdfResult>;
  analyzeImages(args: AnalyzeImagesArgs): Promise<AnalyzeImagesResult>;
  writeFile(args: WriteFileArgs): Promise<WriteFileResult>;
  listDir(args: ListDirArgs): Promise<ListDirResult>;
  stat(args: StatArgs): Promise<StatResult>;
  runShell(args: RunShellArgs): Promise<RunShellResult>;
  grep(args: GrepArgs): Promise<GrepResult>;
  edit(args: EditArgs): Promise<EditResult>;
  webFetch(args: WebFetchArgs): Promise<WebFetchResult>;
  webSearch(args: WebSearchArgs): Promise<WebSearchResult>;
  globFiles(args: GlobFilesArgs): Promise<GlobFilesResult>;
  applyPatch(args: ApplyPatchArgs): Promise<ApplyPatchResult>;
  /** Parse and canonicalize patch targets without authorizing access. */
  applyPatchTargets(args: ApplyPatchTargetsArgs): Promise<ApplyPatchTargetsResult>;
  /** Phase 3.5: parse patch and resolve paths without mutating filesystem. */
  applyPatchPreflight(args: ApplyPatchPreflightArgs): Promise<ApplyPatchPreflightResult>;
  abortToolCalls(args: { callIds: string[] }): Promise<number>;
  abortGroup(args: { groupId: string }): Promise<number>;
}

/** Real Tauri bridge — delegates to Rust commands via `invoke`. */
export function createTauriBridge(): SandboxBridge {
  return {
    readFile: (args) => invoke<ReadFileResult>('tool_read_file', { req: args }),
    readImage: (args) => invoke<ReadImageResult>('tool_read_image', { req: args }),
    readPdf: (args) => invoke<ReadPdfResult>('tool_read_pdf', { req: args }),
    analyzeImages: (args) => invoke<AnalyzeImagesResult>('tool_analyze_images', { req: args }),
    writeFile: (args) => invoke<WriteFileResult>('tool_write_file', { req: args }),
    listDir: (args) => invoke<ListDirResult>('tool_list_dir', { req: args }),
    stat: (args) => invoke<StatResult>('tool_stat', { req: args }),
    runShell: (args) => invoke<RunShellResult>('tool_run_shell', { req: args }),
    grep: (args) => invoke<GrepResult>('tool_grep', { req: args }),
    edit: (args) => invoke<EditResult>('tool_edit', { req: args }),
    webFetch: (args) => invoke<WebFetchResult>('tool_web_fetch', { req: args }),
    webSearch: (args) => invoke<WebSearchResult>('tool_web_search', { req: args }),
    globFiles: (args) => invoke<GlobFilesResult>('tool_glob_files', { req: args }),
    applyPatch: (args) => invoke<ApplyPatchResult>('tool_apply_patch', { req: args }),
    applyPatchTargets: (args) => invoke<ApplyPatchTargetsResult>('tool_apply_patch_targets', { req: args }),
    applyPatchPreflight: (args) => invoke<ApplyPatchPreflightResult>('tool_apply_patch_preflight', { req: args }),
    abortToolCalls: (args) => invoke<number>('abort_tool_calls', args),
    abortGroup: (args) => invoke<number>('abort_group', args),
  };
}

/** Mock bridge for tests — no Rust runtime needed. */
export function createMockBridge(overrides?: Partial<SandboxBridge>): SandboxBridge {
  return {
    readFile: async () => ({ results: [] }),
    readImage: async () => ({ _image_batch_id: '', images_delivered: 0, images: [] }),
    readPdf: async () => ({ files: [], warnings: [] }),
    analyzeImages: async () => ({
      images: [],
      analyzed: true,
      description: '',
      truncated: false,
      total_requested: 0,
      processed_count: 0,
      analyzed_count: 0,
      described_count: 0,
      dropped_count: 0,
    }),
    writeFile: async () => ({ results: [] }),
    listDir: async () => ({ results: [] }),
    stat: async () => ({ results: [] }),
    runShell: async () => ({
      stdout: '', stderr: '', exit_code: 0, duration_ms: 0, timed_out: false,
      stdout_truncated: false, stderr_truncated: false,
    }),
    grep: async () => ({ results: [] }),
    edit: async () => ({ results: [] }),
    webFetch: async () => ({ status: 200, final_url: '', content_type: '', body: '', truncated: false }),
    webSearch: async () => ({ results: [], source: '' }),
    globFiles: async () => ({ matches: [], truncated: false, pattern_used: '' }),
    applyPatch: async () => ({ files: [], summary: '', fully_applied: true }),
    applyPatchTargets: async () => ({ affected_paths: [], actions: [], diagnostics: [] }),
    applyPatchPreflight: async () => ({ plan_id: '', affected_paths: [], actions: [], diagnostics: [] }),
    abortToolCalls: async () => 0,
    abortGroup: async () => 0,
    ...overrides,
  };
}
