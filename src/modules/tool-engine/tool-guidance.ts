import type { ToolResultIssue } from './types';
import {
  COMMON_GLOB_DIALECT,
  FIXED_GREP_EXCLUDED_EXTENSIONS,
  FIXED_SEARCH_EXCLUDED_DIRS,
  GREP_COMPLETENESS_CONTRACT,
} from './builtin/tool-contract-metadata.ts';

const EXCLUDED_DIRS_GUIDANCE = FIXED_SEARCH_EXCLUDED_DIRS.map((name) => `\`${name}\``).join(', ');
const EXCLUDED_EXTENSIONS_GUIDANCE = FIXED_GREP_EXCLUDED_EXTENSIONS.map((name) => `\`${name}\``).join(', ');

export const RUNNER_ERROR_CODES = Object.freeze([
  'unknown_tool',
  'invalid_arguments',
] as const);

export const POLICY_ERROR_CODES = Object.freeze([
  'not_exposed',
  'path_resolution_failed',
  'path_outside_roots',
  'grant_required',
  'permission_ui_unavailable',
  'denied_by_user',
] as const);

export const NATIVE_ERROR_CODES = Object.freeze([
  'aborted',
  'timeout',
  'binary_detected',
  'encoding_not_utf8',
  'invalid_regex',
  'read_failed',
  'too_large',
] as const);

export const READ_PDF_SELECTION_ERROR_CODES = Object.freeze({
  pages: 'invalid_page_selection',
  forceRender: 'invalid_render_selection',
} as const);

export interface ToolGuidanceSection {
  title: string;
  aliases: readonly string[];
  guidance: string;
}

export interface ToolRecoveryGuidance {
  remedy: string;
  helpQuery?: string;
}

export interface ToolGuidanceCatalog {
  tool: string;
  purpose: string;
  aliases: readonly string[];
  essential: string;
  basic: string;
  sections: readonly ToolGuidanceSection[];
  keywords: readonly string[];
  declaredErrorCodes: readonly string[];
  issueMessages?: Readonly<Record<string, string>>;
  recovery: Readonly<Record<string, ToolRecoveryGuidance>>;
  signals: Readonly<Record<string, string>>;
}

export interface ToolNameEntry {
  name: string;
  purpose: string;
  aliases: readonly string[];
  operational: boolean;
}

export const TOOL_NAME_ENTRIES = Object.freeze([
  { name: 'lc_read_file', purpose: 'Read text files and focused line ranges.', aliases: ['read text'], operational: true },
  { name: 'lc_read_image', purpose: 'Read or analyze raster images.', aliases: ['read image'], operational: true },
  { name: 'lc_read_pdf', purpose: 'Read and summarize PDF files.', aliases: ['read pdf'], operational: true },
  { name: 'lc_write_file', purpose: 'Create, overwrite, or append complete file content.', aliases: ['write file'], operational: true },
  { name: 'lc_list_dir', purpose: 'List one directory without recursive traversal.', aliases: ['list directory'], operational: true },
  { name: 'lc_web_fetch', purpose: 'Fetch content from one known public URL.', aliases: ['fetch url'], operational: true },
  { name: 'lc_get_current_time', purpose: 'Get the current time in an optional timezone.', aliases: ['current time'], operational: true },
  { name: 'lc_run_shell', purpose: 'Run one approval-controlled executable.', aliases: ['run command'], operational: true },
  { name: 'lc_todo_write', purpose: 'Replace the complete task list for the current work.', aliases: ['write todos'], operational: true },
  { name: 'lc_ask_user', purpose: 'Ask the user a small set of structured questions.', aliases: ['ask user', 'ask question'], operational: false },
  { name: 'lc_whiteboard', purpose: 'Read both conversation boards or change only the model board.', aliases: ['whiteboard', 'conversation boards'], operational: true },
  { name: 'lc_grep', purpose: 'Search file contents with regular expressions.', aliases: ['grep', 'search text', 'content search', 'search contents'], operational: true },
  { name: 'lc_edit_file', purpose: 'Replace one exact text occurrence in each target.', aliases: ['edit file'], operational: true },
  { name: 'lc_web_search', purpose: 'Search the web for sources or current facts.', aliases: ['web search'], operational: true },
  { name: 'lc_web_research', purpose: 'Search, fetch, and synthesize cited web evidence.', aliases: ['web research'], operational: true },
  { name: 'lc_stat', purpose: 'Read file or directory metadata.', aliases: ['file stat'], operational: true },
  { name: 'lc_glob_files', purpose: 'Search file and directory names recursively.', aliases: ['glob files'], operational: true },
  { name: 'lc_apply_patch', purpose: 'Apply coordinated file changes from one patch.', aliases: ['apply patch'], operational: true },
  { name: 'lc_tool_history', purpose: 'Retrieve archived results from completed turns.', aliases: ['tool history'], operational: false },
  { name: 'lc_skill', purpose: 'Retrieve enabled Markdown skills.', aliases: ['skill'], operational: false },
  { name: 'lc_tool_help', purpose: 'Get bounded guidance for one exposed tool.', aliases: ['tool help', 'help'], operational: false },
] as const satisfies readonly ToolNameEntry[]);

const SHARED_CODES = [
  ...RUNNER_ERROR_CODES,
  ...POLICY_ERROR_CODES,
  ...NATIVE_ERROR_CODES,
] as const;

function defineCatalog(catalog: ToolGuidanceCatalog): ToolGuidanceCatalog {
  const nameEntry = TOOL_NAME_ENTRIES.find((entry) => entry.name === catalog.tool);
  if (!nameEntry || !nameEntry.operational) {
    throw new Error(`${catalog.tool} is not a canonical operational tool name.`);
  }
  if (catalog.sections.length > 12) {
    throw new Error(`${catalog.tool} has more than 12 help sections.`);
  }
  if (catalog.aliases.length > 12) {
    throw new Error(`${catalog.tool} has more than 12 catalog aliases.`);
  }
  if (catalog.keywords.length > 12) {
    throw new Error(`${catalog.tool} has more than 12 help keywords.`);
  }
  const aliases = new Set<string>();
  for (const alias of catalog.aliases) {
    const key = alias.normalize('NFKC').trim().toLocaleLowerCase('en-US');
    if (!key || aliases.has(key)) throw new Error(`${catalog.tool} has an invalid catalog alias.`);
    aliases.add(key);
  }
  const titles = new Set<string>();
  for (const section of catalog.sections) {
    const key = section.title.trim().toLocaleLowerCase('en-US');
    if (!key || titles.has(key)) throw new Error(`${catalog.tool} has a duplicate help section.`);
    titles.add(key);
    if (section.aliases.length > 12) {
      throw new Error(`${catalog.tool} help section ${section.title} has more than 12 aliases.`);
    }
    const sectionAliases = new Set<string>();
    for (const alias of section.aliases) {
      const aliasKey = alias.normalize('NFKC').trim().toLocaleLowerCase('en-US');
      if (!aliasKey || sectionAliases.has(aliasKey)) {
        throw new Error(`${catalog.tool} help section ${section.title} has an invalid alias.`);
      }
      sectionAliases.add(aliasKey);
    }
  }
  const declared = new Set(catalog.declaredErrorCodes);
  for (const code of Object.keys(catalog.recovery)) {
    if (!declared.has(code)) {
      throw new Error(`${catalog.tool} maps undeclared error code ${code}.`);
    }
  }
  for (const code of Object.keys(catalog.issueMessages ?? {})) {
    if (!declared.has(code)) {
      throw new Error(`${catalog.tool} maps an issue message for undeclared error code ${code}.`);
    }
  }
  return Object.freeze(catalog);
}

export const GREP_GUIDANCE = defineCatalog({
  tool: 'lc_grep',
  purpose: 'Search file contents with regular expressions.',
  aliases: ['grep', 'search contents', 'content search'],
  essential:
    'Search file contents with regular expressions. Each searches entry has one path and pattern. ' +
    'A directory path starts a recursive search. Every path must resolve before the batch starts. ' +
    'One unresolved path rejects the complete batch. The batch include glob applies to every search. ' +
    'An entry include glob replaces it. The exclude glob skips matching files. ' +
    `${GREP_COMPLETENESS_CONTRACT} Use lc_glob_files to search names. ` +
    'Example: lc_grep({ searches: [{ path: "...", pattern: "..." }] })',
  basic:
    'Use content mode to return matching lines. Add context_lines when nearby lines can explain a match. ' +
    'Use files_with_matches or count for a smaller broad result. Put the most important search first. ' +
    'Shared budgets are consumed in search order. Check every truncated value and warning before you report absence.',
  sections: [
    {
      title: 'Regular expressions',
      aliases: ['regex', 'literal text', 'escaping'],
      guidance:
        'Every pattern is a regular expression. Escape a metacharacter when you need its literal value. ' +
        'An invalid expression fails that search. Correct the expression before you submit a new call.',
    },
    {
      title: 'Include and exclude globs',
      aliases: ['include', 'exclude', 'glob filters'],
      guidance:
        'The batch include glob applies to every search. A search entry can replace it with its own include glob. ' +
        `The exclude glob applies across the batch. ${COMMON_GLOB_DIALECT} ` +
        'Paths use root-relative forward slashes for directory matching.',
    },
    {
      title: 'Output modes',
      aliases: ['content', 'files with matches', 'count'],
      guidance:
        'The content mode returns matching lines. The files_with_matches mode returns file paths. The count mode returns one count per file. ' +
        'Use context_lines only with content. The max_matches_per_file value samples each file. A proven omitted match sets truncated=true.',
    },
    {
      title: 'Truncation and budgets',
      aliases: ['truncated', 'deadline', 'cancelled', 'result limit', 'budget'],
      guidance:
        'truncated=true means that the search stopped or omitted a proven match. A null value means completeness was not determined. ' +
        'The reason identifies cancellation, time, results, bytes, traversal, or per-file sampling. Narrow the path or split the searches.',
    },
    {
      title: 'Encoding and replacement characters',
      aliases: ['encoding', 'utf-8', 'utf-16', 'u+fffd', 'replacement character'],
      guidance:
        'LC transcodes UTF-16 only when a byte-order mark is present. LC can search mostly valid UTF-8 with isolated invalid bytes. ' +
        'A returned match can contain U+FFFD. Do not write that match text back to the file.',
    },
    {
      title: 'Excluded files',
      aliases: ['hidden files', 'binary files', 'large files', 'excluded directories'],
      guidance:
        'Recursive searches prune fixed directory basenames. Set include_excluded_dirs to true only when the target can be inside them.\n' +
        `Excluded directory basenames: ${EXCLUDED_DIRS_GUIDANCE}.\n` +
        'LC always skips fixed binary extensions.\n' +
        `Excluded extensions: ${EXCLUDED_EXTENSIONS_GUIDANCE}.\n` +
        'Files larger than 1 MiB are also skipped. Hidden files are searched. ' +
        'A zero result does not prove absence from a skipped class.',
    },
    {
      title: 'Diagnostic counters',
      aliases: ['visited entries', 'files selected', 'bytes read', 'skipped'],
      guidance:
        'visited_entries counts walked entries. files_selected counts files after filters. bytes_read counts file bytes read by the search. ' +
        'The skipped counters identify large, binary, symbolic-link, and unreadable files.',
    },
  ],
  keywords: ['regex', 'include', 'exclude', 'output modes', 'truncation', 'budgets', 'encoding', 'U+FFFD', 'excluded files', 'diagnostic counters'],
  declaredErrorCodes: [...SHARED_CODES],
  recovery: {
    invalid_arguments: {
      remedy: 'Correct the invalid grep arguments and submit a new call.',
      helpQuery: 'regex',
    },
    invalid_regex: {
      remedy: 'Correct the regular expression and submit a new call.',
      helpQuery: 'regex',
    },
    path_resolution_failed: {
      remedy: 'Correct or remove the unresolved path, then submit the complete batch again.',
    },
  },
  signals: {
    replacement_character:
      'WARNING: A grep match contains U+FFFD. Do not write that match text back. Ask the user to convert the file before a write.',
    truncated:
      'WARNING: The grep result is incomplete. Read truncated_reason, then narrow the path or split the searches.',
    completeness_unknown:
      'WARNING: Grep could not determine completeness. Read truncated_reason, then narrow the path or split the searches.',
  },
});

export const READ_FILE_GUIDANCE = defineCatalog({
  tool: 'lc_read_file',
  purpose: 'Read text files and focused line ranges.',
  aliases: ['read text', 'text reader'],
  essential:
    'Read text files and focused line ranges. Pass from one through 20 absolute paths. ' +
    'One line range applies to every path. The default output cap is 1 MiB. max_bytes can increase it to 32 MiB. ' +
    'An oversized read fails without a partial body. A successful result includes size, line count, encoding, and SHA-256. ' +
    'Use that SHA-256 for a later safe write. Use lc_read_image for images and lc_read_pdf for PDFs. ' +
    'An encoding failure includes a direct recovery action.',
  basic:
    'Use start_line and end_line to inspect a focused range. A focused range can read a large source when its selected output fits. ' +
    'The returned SHA-256 describes the source bytes. Re-read the file before a mutation when the source can have changed.',
  sections: [
    {
      title: 'Line ranges',
      aliases: ['start line', 'end line', 'focused read'],
      guidance:
        'Line numbers are one-based. start_line selects the first returned line. end_line selects the last returned line. ' +
        'The same range applies to each path. Narrow the range when selected output exceeds max_bytes.',
    },
    {
      title: 'Size limits',
      aliases: ['max bytes', 'large files', 'oversized read'],
      guidance:
        'A whole-file read and a selected range use the same default 1 MiB cap. max_bytes can raise the cap to 32 MiB. ' +
        'LC returns an error instead of a partial body when selected output exceeds the cap.',
    },
    {
      title: 'Encoding',
      aliases: ['utf-8', 'utf-16', 'byte-order mark', 'latin-1'],
      guidance:
        'LC returns UTF-8 without changing it. LC transcodes UTF-16 only when a byte-order mark is present. ' +
        'Writers refuse that transcoded source because a write would change its encoding. Ask the user to convert unsupported text to UTF-8.',
    },
    {
      title: 'Binary files',
      aliases: ['nul byte', 'images', 'pdfs'],
      guidance:
        'A NUL byte in the first 8 KiB identifies binary content. UTF-16 without a byte-order mark also reaches this result. ' +
        'Use lc_read_image for images and lc_read_pdf for PDFs. Ask the user how to handle other binary data.',
    },
    {
      title: 'Safe writes',
      aliases: ['sha-256', 'expected sha256', 'concurrency'],
      guidance:
        'A successful read returns SHA-256 for the source bytes. Pass it as expected_sha256 when lc_write_file overwrites that source. ' +
        'If the hash no longer matches, read the file again before a new write.',
    },
    {
      title: 'Replacement characters',
      aliases: ['u+fffd', 'lossy text', 'write-back'],
      guidance:
        'U+FFFD can indicate that source bytes were replaced during decoding. Do not write returned text that contains U+FFFD back automatically. ' +
        'Ask the user to verify or convert the source first.',
    },
  ],
  keywords: ['line ranges', 'size limits', 'encoding', 'UTF-16', 'binary files', 'safe writes', 'SHA-256', 'U+FFFD'],
  declaredErrorCodes: [...SHARED_CODES],
  recovery: {
    invalid_arguments: {
      remedy: 'Correct the invalid read arguments and submit a new call.',
      helpQuery: 'line ranges size limits',
    },
    encoding_not_utf8: {
      remedy: 'LC has no conversion tool. Ask the user to convert the file to UTF-8.',
    },
    binary_detected: {
      remedy: 'Use the dedicated reader for a known image or PDF. Ask the user about other binary data.',
      helpQuery: 'binary files',
    },
    too_large: {
      remedy: 'Narrow the line range or increase max_bytes within the 32 MiB limit.',
      helpQuery: 'size limits',
    },
  },
  signals: {
    replacement_character:
      'WARNING: Returned text contains U+FFFD. Do not write this text back automatically. Ask the user to verify or convert the source.',
  },
});

export const READ_PDF_GUIDANCE = defineCatalog({
  tool: 'lc_read_pdf',
  purpose: 'Read and summarize PDF files.',
  aliases: ['read pdf', 'pdf reader'],
  essential:
    'Read PDFs. First 4 paths only, with a warning for dropped paths. ' +
    'text_only is default. Summaries are paraphrases. include_text:true returns source text. ' +
    'summarize:false always returns text and skips summaries. It requires text_only and no force_render. ' +
    'Use "1-5,12" syntax for pages and force_render. Omit either field to use its default. ' +
    'Malformed ranges fail. full adds selected page images and requires vision. Chart values are estimates.',
  basic:
    'Start with text_only for ordinary prose. Use full for relevant figures, charts, equations, tables, or scanned pages. ' +
    'Use force_render when LC missed a visual page. Inspect provenance, render fields, truncation, and warnings before you use the summary.',
  sections: [
    {
      title: 'Summary-free reads',
      aliases: ['summarize', 'skip summary', 'text without summary'],
      guidance:
        'summarize defaults to true. Set it to false to return extracted text and page metadata with summary null. ' +
        'This overrides include_text false or omitted, without a correction warning. LC makes no model requests in this mode. ' +
        'Use text_only and omit force_render. Requesting full or a nonempty force_render in this mode gives invalid_arguments. ' +
        'A scan still has no extracted text. For visual interpretation, use summarize true and depth full with a vision-capable model.',
    },
    {
      title: 'Exact text and provenance',
      aliases: ['include text', 'quotation', 'source wording', 'provenance'],
      guidance:
        'A summary is model-generated and must not be quoted as document wording. Set include_text to true for exact page text. ' +
        'text_layer provenance identifies file text. none identifies content derived from pixels.',
    },
    {
      title: 'Page ranges',
      aliases: ['pages', 'selection', 'force render'],
      guidance:
        'Use one-based pages such as "1-5,12". An omitted or blank pages value selects every page. ' +
        'An omitted or blank force_render value lets LC select visual pages. Invalid syntax fails closed.',
    },
    {
      title: 'Vision requirements',
      aliases: ['full depth', 'vision model', 'rendering', 'scans'],
      guidance:
        'full needs a vision-capable model for rendered pages. Without vision, LC uses text_only and returns a warning. ' +
        'A scanned PDF has no text layer. Configure a vision model before you request full for a scan.',
    },
    {
      title: 'Summary limits',
      aliases: ['map reduce', 'sub-agent', 'output limit', 'no summary'],
      guidance:
        'Rust runs at most two file summaries concurrently and collects results in input order. It makes no extra cross-file summary request. ' +
        'Each summary call requests a 4,000-token provider ceiling and enforces a 64 KiB local UTF-8 limit. A blank, oversized, or unusable answer produces a warning. ' +
        'Narrow the pages or select a different configured model when summary generation fails.',
    },
    {
      title: 'Tables and charts',
      aliases: ['tables', 'charts', 'figures', 'equations'],
      guidance:
        'Table cell text comes from the file, but LC infers the row and column structure. ' +
        'A rendered chart can preserve layout while vision can misread digits. Treat chart values as estimates.',
    },
    {
      title: 'Truncation and budgets',
      aliases: ['truncated', 'render skipped', 'deadline', 'page budget'],
      guidance:
        'truncated means that LC omitted pages or work at a limit. Inspect planned_render_reason and render_skipped for each page. ' +
        'Narrow the pages or call the tool again for omitted pages. The complete serialized result has a 4 MiB limit. ' +
        'A larger result gives result_too_large instead of partial text. Narrow pages or split the request.',
    },
  ],
  keywords: ['exact text', 'provenance', 'page ranges', 'force render', 'vision requirements', 'scans', 'summary limits', 'summarize', 'summary-free reads', 'tables', 'charts', 'truncation'],
  declaredErrorCodes: [...SHARED_CODES, ...Object.values(READ_PDF_SELECTION_ERROR_CODES)],
  recovery: {
    invalid_arguments: {
      remedy: 'Correct the named PDF field and submit a new call.',
      helpQuery: 'summary-free reads',
    },
    invalid_page_selection: {
      remedy: 'Omit pages to read every page. Otherwise, use one-based pages such as "1-5,12".',
      helpQuery: 'page ranges',
    },
    invalid_render_selection: {
      remedy: 'Omit force_render to force no extra pages. Otherwise, use one-based pages such as "1-5,12".',
      helpQuery: 'force render',
    },
    too_large: {
      remedy: 'Increase max_bytes within 100 MiB or use a smaller PDF.',
    },
    timeout: {
      remedy: 'Narrow the page range before you submit a new call.',
      helpQuery: 'truncation budgets',
    },
  },
  signals: {},
});

export const WHITEBOARD_ERROR_CODES = Object.freeze([
  'invalid_arguments',
  'whiteboard_not_initialized',
  'whiteboard_version_missing',
  'whiteboard_read_failed',
  'whiteboard_write_failed',
  'whiteboard_old_string_not_found',
  'whiteboard_old_string_not_unique',
  'whiteboard_too_large',
  'whiteboard_batch_conflict',
  'aborted',
] as const);

export const WHITEBOARD_ISSUE_MESSAGES = Object.freeze({
  invalid_arguments: 'The action and supplied fields do not form one valid whiteboard operation.',
  whiteboard_not_initialized: 'The enabled conversation has no valid initial board records.',
  whiteboard_version_missing: 'A pinned or current whiteboard version is unavailable.',
  whiteboard_read_failed: 'LC could not read the pinned or current board record.',
  whiteboard_write_failed: 'LC could not save the new model-board content.',
  whiteboard_old_string_not_found: 'old_string does not occur in the current model board.',
  whiteboard_old_string_not_unique: 'old_string occurs more than once in the current model board.',
  whiteboard_too_large: 'The resulting model board exceeds 32 KiB of UTF-8 text.',
  whiteboard_batch_conflict: 'The batch declares more than one lc_whiteboard call.',
  aborted: 'The owning generation ended before the whiteboard operation completed.',
} as const);

export const WHITEBOARD_GUIDANCE = defineCatalog({
  tool: 'lc_whiteboard',
  purpose: 'Read both conversation boards or change only the model board.',
  aliases: ['whiteboard', 'conversation boards'],
  essential:
    'Read both conversation boards or change only the model board.\n' +
    'Send one whiteboard call per batch and wait for its result.\n' +
    'Read before mutation only when you do not know the current exact model content.\n' +
    'The user board is fixed for this turn.\n' +
    'Model reads include your latest applied change in this turn.\n' +
    'Each board has a 32 KiB UTF-8 limit.',
  basic:
    'Use read to inspect both boards. Use replace for complete model-board Markdown. ' +
    'Use edit for one exact model-board match. The user board is read-only for the model. ' +
    'Send only one whiteboard call per batch and wait for its result. ' +
    'Read before a mutation only when you do not know the current exact model content.',
  sections: [
    {
      title: 'Ownership',
      aliases: ['user board', 'model board', 'write access'],
      guidance:
        'The model can read both boards. The model can change only the model board. ' +
        'The user controls the user board.',
    },
    {
      title: 'Read visibility',
      aliases: ['read', 'current content', 'visibility'],
      guidance:
        'A read returns the user version fixed at turn start and the latest applied model content in this turn. ' +
        'It never returns an unsent pending user edit.',
    },
    {
      title: 'Replace',
      aliases: ['complete content', 'clear board'],
      guidance:
        'Replace sends the complete model-board Markdown. An empty string clears the model board. ' +
        'Unchanged content creates no new turn version.',
    },
    {
      title: 'Exact edit',
      aliases: ['edit', 'old string', 'new string', 'match'],
      guidance:
        'Edit requires one non-empty exact old_string occurrence. new_string can be empty. ' +
        'Matching does not interpret Markdown. Read first when the current exact content is unknown.',
    },
    {
      title: 'Size limits',
      aliases: ['32 kib', 'utf-8', 'bytes', 'too large'],
      guidance:
        'The resulting model board must contain at most 32 KiB of UTF-8 text. LC reports measured bytes and never truncates the board.',
    },
    {
      title: 'Turn versions',
      aliases: ['pinned user', 'latest model', 'references'],
      guidance:
        'The user board stays fixed during one model turn. User edits made now appear in the next turn. ' +
        'Model reads include the latest applied model change in the active turn.',
    },
  ],
  keywords: ['ownership', 'read visibility', 'replace', 'exact edit', 'size limits', 'turn versions'],
  declaredErrorCodes: [...WHITEBOARD_ERROR_CODES],
  issueMessages: WHITEBOARD_ISSUE_MESSAGES,
  recovery: {
    invalid_arguments: {
      remedy: 'Send one valid read, replace, or edit input. Do not send fields from another action.',
    },
    whiteboard_not_initialized: {
      remedy: 'Retry once after LC repairs initialization. If it repeats, continue without the board.',
    },
    whiteboard_version_missing: {
      remedy: 'Do not retry the missing ID. Report that the retained version is unavailable.',
    },
    whiteboard_read_failed: {
      remedy: 'Retry the read once. Continue without the board if the read fails again.',
    },
    whiteboard_write_failed: {
      remedy: 'Retry after LC storage is available. Read the board before a later exact edit.',
    },
    whiteboard_old_string_not_found: {
      remedy: 'Call lc_whiteboard with action read before you retry the edit.',
      helpQuery: 'exact edit',
    },
    whiteboard_old_string_not_unique: {
      remedy: 'Use a longer exact string that occurs once.',
      helpQuery: 'exact edit',
    },
    whiteboard_too_large: {
      remedy: 'Reduce the resulting Markdown to 32 KiB or less.',
      helpQuery: 'size limits',
    },
    whiteboard_batch_conflict: {
      remedy: 'Send one intended whiteboard call in a later batch and wait for its result.',
    },
    aborted: {
      remedy: 'Read the current boards in a later turn before you continue.',
    },
  },
  signals: {},
});

export const PILOT_GUIDANCE_CATALOGS: ReadonlyMap<string, ToolGuidanceCatalog> = new Map([
  [GREP_GUIDANCE.tool, GREP_GUIDANCE],
  [READ_FILE_GUIDANCE.tool, READ_FILE_GUIDANCE],
  [READ_PDF_GUIDANCE.tool, READ_PDF_GUIDANCE],
  [WHITEBOARD_GUIDANCE.tool, WHITEBOARD_GUIDANCE],
]);

export function guidanceCatalog(tool: string): ToolGuidanceCatalog | undefined {
  return PILOT_GUIDANCE_CATALOGS.get(tool);
}

export function guidanceSignal(tool: string, signal: string): string | undefined {
  return guidanceCatalog(tool)?.signals[signal];
}

export function guidanceIssueMessage(tool: string, code: string): string | undefined {
  return guidanceCatalog(tool)?.issueMessages?.[code];
}

export function addCatalogRecovery(tool: string, issue: ToolResultIssue): ToolResultIssue {
  const recovery = guidanceCatalog(tool)?.recovery[issue.code];
  if (!recovery) return issue;
  return {
    ...issue,
    ...(issue.remedy ? {} : { remedy: recovery.remedy }),
    ...(issue.help || issue.suggested_call || !recovery.helpQuery
      ? {}
      : { help: { tool, query: recovery.helpQuery } }),
  };
}
