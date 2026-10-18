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
    'Read matches in content mode, files in files_with_matches mode, and counts in count mode. ' +
    'An empty matches array does not mean no matches in files_with_matches or count mode. ' +
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
        'The content mode fills matches. The files_with_matches mode fills files. The count mode fills counts with one count per file. ' +
        'The other result arrays remain empty. Do not infer absence from an array that this mode does not fill. ' +
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
        'The visited_entries counter counts walked entries. The files_selected counter counts candidate files after traversal filters. ' +
        'Some candidates can remain unread when a limit stops the search. Selection does not prove that a file was searched. ' +
        'The bytes_read counter counts file bytes read by the search. ' +
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
    files_with_matches:
      'Matching file paths are in files. The matches array is unused and empty in files_with_matches mode.',
    count:
      'Per-file match totals are in counts. The matches array is unused and empty in count mode.',
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
    'Never write returned U+FFFD text back without source verification.',
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
        'A whole-file read checks both source bytes and returned UTF-8 bytes against max_bytes. ' +
        'A selected range checks its returned UTF-8 bytes. The default cap is 1 MiB, and max_bytes can raise it to 32 MiB. ' +
        'LC returns an error instead of a partial body when either applicable check exceeds the cap.',
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
      'WARNING: Returned text contains U+FFFD and may not preserve the original text. ' +
      'Do not call a write, edit, patch, or shell tool with this text. ' +
      'Stop and request verified source text before any rewrite.',
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

/** Shared construction keeps canonical identity and recovery ownership in one place. */
function operationalCatalog(
  tool: string, essential: string, basic: string, sections: readonly ToolGuidanceSection[],
  recovery: Readonly<Record<string, ToolRecoveryGuidance>> = {},
): ToolGuidanceCatalog {
  const entry = TOOL_NAME_ENTRIES.find((candidate) => candidate.name === tool)!;
  return defineCatalog({
    tool, purpose: entry.purpose, aliases: entry.aliases, essential, basic, sections,
    keywords: sections.map((section) => section.title.toLocaleLowerCase('en-US')),
    declaredErrorCodes: [...SHARED_CODES],
    recovery: {
      invalid_arguments: { remedy: 'Correct the invalid arguments and submit a new call.', helpQuery: sections[0].aliases[0] },
      ...recovery,
    },
    signals: {},
  });
}

export const WRITE_FILE_GUIDANCE = operationalCatalog('lc_write_file',
  'Write or append UTF-8 text. Pass at most 20 files entries with path and content. ' +
  'One top-level mode applies to all entries. create is default and refuses existing files. ' +
  'overwrite replaces content. append adds content. LC creates missing parent directories. ' +
  'When overwriting a file that you read, pass its returned sha256 as expected_sha256. ' +
  'A changed file is refused. A deleted target can still be recreated by create or overwrite. ' +
  'Batch entries commit independently. A later failure does not roll back earlier changes. Inspect every result.',
  'Use create for a new file. Use lc_edit_file for a targeted replacement. ' +
  'Each files entry owns its content and optional expected_sha256. Keep mode outside the entries.',
  [
    { title: 'Modes and paths', aliases: ['mode', 'create', 'overwrite', 'append'], guidance:
      'The create mode refuses existing files. The overwrite mode replaces content or creates a missing file. ' +
      'The append mode adds content. LC creates missing parent directories without a separate directory call. ' +
      'Use separate files entries for different content. One mode applies to the complete batch.' },
    { title: 'Hash protection', aliases: ['expected sha256', 'concurrency', 'deleted target'], guidance:
      'Use the sha256 from lc_read_file as expected_sha256 when overwriting a file that you read. ' +
      'A mismatch refuses the write. Read again before you prepare a replacement. ' +
      'If the target was deleted, create and overwrite can recreate it despite expected_sha256. append refuses that missing target.' },
    { title: 'Partial batches', aliases: ['partial', 'results', 'rollback'], guidance:
      'Entries commit independently. Inspect every error and bytes_written value. ' +
      'A later failure does not undo an earlier write. Retry only the intended failed entries after checking their current state. ' +
      'The lines_removed value can be null when the prior file was not measured within the scan budget.' },
  ]);

export const EDIT_FILE_GUIDANCE = operationalCatalog('lc_edit_file',
  'Replace exact text in files. Use path, old_string, and new_string for one file, or files entries for a batch. ' +
  'Do not combine these forms. A batch accepts from 1 through 20 files. ' +
  'old_string must appear exactly once. Copy indentation exactly. Matching ignores line-ending differences. ' +
  'Batch entries commit independently. A later failure does not roll back earlier changes. ' +
  'Inspect replaced, occurrences, hint, and error for each entry. Use lc_write_file to create files.',
  'Use an exact substring from a recent read. Include from 3 through 5 context lines when needed for uniqueness. ' +
  'new_string can be empty to delete the match. Each edit uses a temporary file and rename.',
  [
    { title: 'Input forms', aliases: ['syntax', 'flat', 'batch'], guidance:
      'The flat form requires path, old_string, and new_string. ' +
      'The batch form requires files entries with those same fields. Do not mix the forms. ' +
      'Example: lc_edit_file({ files: [{ path: "C:/work/app.ts", old_string: "old", new_string: "new" }] })' },
    { title: 'Match diagnostics', aliases: ['occurrences', 'match lines', 'near match lines'], guidance:
      'If occurrences is 0, inspect hint and near_match_lines for whitespace differences. ' +
      'If occurrences exceeds 1, match_lines identifies at most 20 matching locations. ' +
      'Overlapping occurrences also make a match ambiguous. Add exact context before retrying. ' +
      'A missing, binary, or oversized file reports error instead of match diagnostics.' },
    { title: 'Missing files', aliases: ['create if missing', 'new file'], guidance:
      'The top-level create_if_missing flag applies to every entry. Its default is false. ' +
      'If true and a target is missing, LC creates it with new_string as its complete content. LC ignores old_string in that case.' },
  ]);

export const APPLY_PATCH_GUIDANCE = operationalCatalog('lc_apply_patch',
  'Apply coordinated Add, Update, Move, or Delete changes. Use lc_edit_file for one simple replacement. ' +
  'Read existing targets first. Limits are 1 MiB per patch, 32 MiB per target, and 64 MiB per prepared plan. ' +
  'Paths are filesystem paths, not JSON literals. Use one bare @@ per update hunk. ' +
  'Prefix context lines with a space, removed lines with -, and added lines with +. ' +
  'Keep replacement lines in the same hunk. A blank context line still needs its leading space.\n' +
  '*** Begin Patch\n*** Update File: C:/work/app.txt\n@@\n-old\n+new\n*** End Patch\n' +
  'Add and Move never overwrite destinations. Call help for their syntax. ' +
  'Inspect fully_applied and every files entry. A late failure can leave earlier files changed. ' +
  'Read affected files again before retrying.',
  'Prepare one patch with Begin Patch and End Patch markers. Use exact lines copied from each file. ' +
  'Deterministic preparation failures occur before writes. Later write failures or cancellation can preserve an applied prefix. ' +
  'This tool has no dry_run option.',
  [
    { title: 'Patch syntax', aliases: ['syntax', 'add', 'move', 'delete'], guidance:
      'Add File content follows its header directly. Prefix every added line with +. Add File does not use @@. ' +
      'Move to must immediately follow Update File. It is not a standalone header. ' +
      'Delete File has no content body. Add and Move refuse existing destinations.\n' +
      '*** Begin Patch\n*** Add File: C:/work/new.txt\n+new content\n' +
      '*** Update File: C:/work/old.txt\n*** Move to: C:/work/renamed.txt\n' +
      '*** Delete File: C:/work/remove.txt\n*** End Patch' },
    { title: 'Hunk matching', aliases: ['context', 'whitespace', 'fallback'], guidance:
      'Use exact file lines when possible. Keep the old and new lines for one replacement in the same @@ hunk. ' +
      'A fallback match can succeed with a warning. Inspect each warning before treating the patch as exact.' },
    { title: 'Preparation and partial writes', aliases: ['preflight', 'fully applied', 'retry', 'dry run'], guidance:
      'LC validates the authorized plan and prepares deterministic changes before writing. ' +
      'A preparation failure writes nothing. A later write failure or cancellation can leave earlier entries committed. ' +
      'Inspect fully_applied and every files entry. Read affected files again before preparing a retry. ' +
      'There is no dry_run parameter or rollback guarantee.' },
  ]);

export const LIST_DIR_GUIDANCE = operationalCatalog('lc_list_dir',
  'List immediate entries of up to 20 directories. This tool does not search recursively. ' +
  'Use pattern to filter entry names with a glob. Every directory must resolve before the batch starts. ' +
  'One unresolved directory rejects the whole call. Use lc_stat for uncertain paths. ' +
  'max_entries defaults to 1000 with a hard limit of 5000 per directory. Inspect each truncated flag. ' +
  'Use lc_glob_files for recursive name searches.',
  'Put directory paths in paths. include_hidden=false omits only dot-prefixed entries. ' +
  'There is no fixed directory skip list. Names such as node_modules, dist, and vendor remain listable.',
  [
    { title: 'Name filters', aliases: ['pattern', 'glob', 'hidden'], guidance:
      `${COMMON_GLOB_DIALECT} The pattern matches one entry name. ` +
      'This call does not traverse child directories. include_hidden controls dot-prefixed names only.' },
    { title: 'Batch preflight', aliases: ['paths', 'missing directory', 'preflight'], guidance:
      'Every directory must resolve before execution. path_resolution_failed names an unresolved directory. ' +
      'Correct or remove that path before retrying the complete batch. lc_read_file instead reports missing files per entry.' },
  ], { path_resolution_failed: { remedy: 'Correct or remove the unresolved directory, then submit the complete batch again.', helpQuery: 'preflight' } });

export const GLOB_FILES_GUIDANCE = operationalCatalog('lc_glob_files',
  'Find files and directories recursively by glob under one root. Use lc_grep to search contents. ' +
  'The root must resolve before execution. Fixed excluded directories are pruned. ' +
  'Zero matches does not prove that an excluded path is absent. Each match includes is_dir. ' +
  'max_results defaults to 1000 and cannot exceed 5000. ' +
  'truncated marks a limit or cancellation and preserves collected matches. ' +
  'A traversal error fails the call and names the affected path. Check its existence and readability.',
  'Match root-relative paths with forward slashes. Use ** for recursive segments. ' +
  'include_hidden=false suppresses matching dot-prefixed basenames but still traverses hidden directories. ' +
  'An ordinary descendant such as .github/workflows/build.yml can match.',
  [
    { title: 'Patterns and hidden names', aliases: ['pattern', 'glob', 'hidden'], guidance:
      `${COMMON_GLOB_DIALECT} Matching uses root-relative paths normalized to "/". ` +
      'include_hidden filters only the matching basename. It does not prevent traversal into hidden directories.' },
    { title: 'Excluded directories', aliases: ['excluded', 'skip list', 'zero matches'], guidance:
      `Excluded directory basenames: ${EXCLUDED_DIRS_GUIDANCE}.\n` +
      'Traversal always prunes these directories. Use lc_list_dir or a known direct path to inspect an excluded directory.' },
    { title: 'Completeness', aliases: ['truncated', 'cancelled', 'limits'], guidance:
      'Limits include result count, visited entries, and deadline. The result limit sets truncated only after one more match is found. ' +
      'Cancellation returns a normal result and preserves matches collected before cancellation. ' +
      'truncated=false proves completeness within the traversal exclusions. ' +
      GREP_COMPLETENESS_CONTRACT },
  ], { path_resolution_failed: { remedy: 'Choose an existing root directory before retrying.', helpQuery: 'patterns' } });

export const READ_IMAGE_GUIDANCE = operationalCatalog('lc_read_image',
  'Read raster images. Pass at most 20 paths. Ordinary delivery requires a vision-capable chat model. ' +
  'analyze=true uses a configured vision sub-agent and returns text. It processes only the first 10 paths. ' +
  'Dropped paths produce truncated=true, counts, and an actionable warning. Use instruction to guide analysis. ' +
  'The input cap defaults to 10 MiB per image. max_bytes can raise it to 50 MiB. ' +
  'Inspect each error and warning. Read SVG as text with lc_read_file.',
  'Ordinary delivery sends cached images to the chat model. Analysis returns descriptions and per-image errors. ' +
  'analyzed_count counts images admitted to a vision request. described_count counts usable descriptions. ' +
  'Split analysis requests above 10 paths.',
  [
    { title: 'Modes and encoding', aliases: ['analyze', 'encoding', 'downscale'], guidance:
      'Analysis defaults to medium_jpeg and limits each encoded image to 5 MiB. ' +
      'The low_jpeg mode uses quality 30. The medium_jpeg mode uses quality 60. The original mode preserves raw bytes. ' +
      'Set downscale from 0.1 through 1.0 to reduce dimensions before encoding. ' +
      'Use fewer paths, a smaller downscale value, or JPEG encoding when delivery exceeds a limit.' },
    { title: 'Formats and dimensions', aliases: ['format', 'svg', 'pixels', 'minimum size'], guidance:
      'Supported formats are png, jpeg, gif, webp, and bmp. The decoded content determines mime, not the filename. ' +
      'TIFF and ICO are unsupported. SVG uses lc_read_file. ' +
      'Before downscaling, LC rejects images above 100 megapixels or a dimension above 16,384 pixels. ' +
      'LC has no minimum dimension. A vision provider can reject small images. LC cannot enlarge them.' },
    { title: 'Cache delivery', aliases: ['cache', 'expired', 'evicted'], guidance:
      'The delivery cache expires after five minutes. It holds at most eight batches and 64 MiB of data URLs. ' +
      'An expired or evicted batch produces a warning on the next model turn. Retry with fewer or smaller images.' },
    { title: 'Analysis limits', aliases: ['description', 'timeout', 'response size'], guidance:
      'Analysis is time-limited and can time out. Provider response bodies have a 1 MiB cap. ' +
      'Non-success response details have a 16 KiB cap. Usable descriptions have a 64 KiB UTF-8 cap. ' +
      'A blank or oversized description becomes a per-image error.' },
  ]);

export const RUN_SHELL_GUIDANCE = operationalCatalog('lc_run_shell',
  'Run one approval-controlled executable allowed by the system prompt. Put its name in cmd and its arguments in args. ' +
  'LC invokes it directly. On Windows, use cmd with args for cmd.exe builtins. ' +
  'An explicit cwd must exist inside an allowed root. ' +
  'stdin, stdout, and stderr each have a 1 MiB cap. Inspect both output truncation flags. ' +
  'The timeout defaults to 30 seconds and cannot exceed 120 seconds. ' +
  'A timeout sets timed_out=true and exit_code=null.',
  'Use the executable-plus-args form. A compatible full command string in cmd is also accepted. ' +
  'The allowlist comes from the system prompt. Do not assume another executable is available.',
  [
    { title: 'Arguments and Windows', aliases: ['cmd', 'args', 'windows'], guidance:
      'Put one executable in cmd and each argument in args. On Windows, explicit cmd /c calls are normalized before approval. ' +
      'LC disables AutoRun, requests Unicode builtin output, and preserves the /c command tail.' },
    { title: 'Working directory and environment', aliases: ['cwd', 'env', 'variables'], guidance:
      'An explicit cwd must already be a directory inside an allowed root. An omitted cwd uses the first allowed root. ' +
      'With no roots, LC uses the system temporary directory. ' +
      'LC copies a small safe set of parent variables and clears dangerous loader and runtime variables. ' +
      'Overrides cannot restore those variables or use secret-shaped names.' },
    { title: 'Input and output limits', aliases: ['stdin', 'stdout', 'stderr', 'timeout'], guidance:
      'stdin preserves empty and whitespace-only input exactly. LC enforces its 1 MiB UTF-8 limit natively. ' +
      'stdout and stderr each have separate truncation flags. Check exit_code and timed_out before treating a command as successful.' },
  ]);

export const STAT_GUIDANCE = operationalCatalog('lc_stat',
  'Get file or directory metadata without reading content. Pass at most 100 absolute paths. ' +
  'Each result reports existence, type, and applicable size and modification time. ' +
  'Inspect error before interpreting exists=false. Unavailable or inapplicable metadata is null. ' +
  'Use this instead of lc_read_file when only metadata is needed.',
  'Check existence before a directory-wide call when its path is uncertain. Metadata does not prove file contents or encoding.',
  [{ title: 'Metadata and errors', aliases: ['paths', 'exists', 'null'], guidance:
    'Every declared metadata and error field is present. A null value means unavailable or inapplicable. ' +
    'An access error differs from a confirmed missing path. Inspect each result independently.' }]);

export const CURRENT_TIME_GUIDANCE = operationalCatalog('lc_get_current_time',
  'Return the current time in ISO 8601, RFC 2822, or Unix milliseconds. ' +
  'tz accepts an IANA timezone such as Europe/Brussels. The default is the local operating-system timezone. ' +
  'The default format is iso. Inspect tz_warning when a requested timezone is invalid.',
  'Omit tz for the local timezone or use UTC for a portable timestamp. The unix_ms format is independent of timezone.',
  [{ title: 'Formats and timezones', aliases: ['tz', 'format', 'rfc2822'], guidance:
    'tz accepts at most 255 characters. RFC 2822 uses the requested timezone and a numeric offset. ' +
    'An invalid IANA timezone falls back to the system timezone with tz_warning. Use the returned tz to interpret time.' }]);

export const TODO_WRITE_GUIDANCE = operationalCatalog('lc_todo_write',
  'Track multi-step work. Send the complete list on every call. It replaces the prior list. ' +
  'Use from 1 through 20 todos with unique positive integer IDs. Preserve IDs when updating or reordering. ' +
  'Mark active tasks in progress and completed work promptly. Add completion_evidence when a result supports completion. ' +
  'LC warns when completed tasks omit it. Use blocked with a short reason when work cannot continue. ' +
  'Do not use notes as general working memory.',
  'Skip this tool for a trivial one-step action. IDs need not be sequential. ' +
  'Keep unchanged tasks in each replacement list. A completed label is not independent proof that the work succeeded.',
  [{ title: 'Updates and evidence', aliases: ['todos', 'status', 'completion evidence'], guidance:
    'Send the complete current list, including unchanged tasks. Preserve existing IDs across updates and reordering. ' +
    'Use completion_evidence for an actual supporting result. Missing evidence produces a warning, not a rejected update. ' +
    'Use a short blocked reason only when work cannot continue.' }]);

export const WEB_FETCH_GUIDANCE = operationalCatalog('lc_web_fetch',
  'Fetch one known public URL. Use lc_web_search to discover URLs. ' +
  'Inspect HTTP status, final_url, content_type, body, and truncated. final_url reflects redirects. ' +
  'The default strip_mode is minimal. Use clean to remove scripts or raw to retain the received body. ' +
  'The default max_bytes is 1 MiB, with a 32 MiB cap. ' +
  'The default timeout_ms is 10 seconds, with a 30-second cap. Private and loopback IP ranges are blocked.',
  'Start with minimal for HTML. It retains script contents outside removed page sections. ' +
  'Check truncated before claiming that the complete page was returned.',
  [
    { title: 'HTML modes', aliases: ['strip mode', 'minimal', 'clean', 'raw'], guidance:
      'minimal removes style, head, navigation, footer, and noscript sections, including scripts inside them. ' +
      'Scripts outside those sections remain available. It strips tags, decodes entities, and collapses whitespace. ' +
      'clean also removes script blocks. raw returns the body exactly as received within the byte cap. ' +
      'LC formats JSON in every mode except raw.' },
    { title: 'Limits and URLs', aliases: ['max bytes', 'timeout', 'redirects', 'private address'], guidance:
      'The output byte cap can truncate the body. Use the returned final_url after redirects. ' +
      'Private and loopback addresses are blocked for SSRF protection. Do not retry a blocked address through a different URL spelling.' },
  ]);

// The same provider facts feed active descriptions and on-demand catalog sections.
export const SEARCH_PROVIDER_GUIDANCE = Object.freeze({
  brave: 'Brave Search supports freshness values pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD. ' +
    'Set extra_snippets=true to request additional excerpts.',
  searxng: 'SearXNG aggregates mainstream engines. freshness supports pd, pw, pm, and py. ' +
    'Custom date ranges and extra_snippets are unsupported. Inspect ignored_params for ignored supplied parameters.',
  marginalia: 'Marginalia covers independent, text-oriented sites with limited mainstream coverage. ' +
    'An absent result does not mean the information does not exist. ' +
    'freshness and extra_snippets are unsupported. Inspect ignored_params for ignored supplied parameters.',
});

const providerSections: ToolGuidanceSection[] = Object.entries(SEARCH_PROVIDER_GUIDANCE).map(([provider, guidance]) => ({
  title: `${provider} filters`, aliases: [provider, `${provider} freshness`], guidance,
}));

export const WEB_SEARCH_GUIDANCE = operationalCatalog('lc_web_search',
  'Search the web using the configured provider. Results include title, URL, and snippet. ' +
  'max_results defaults to 5 and cannot exceed 10. Inspect ignored_params before relying on requested filters.',
  'Use search to discover sources. Use lc_web_fetch for a known URL and lc_web_research for a cited synthesis. ' +
  'The active provider is named in the tool description. The model cannot select a different provider.',
  [{ title: 'Queries and results', aliases: ['query', 'max results', 'snippets'], guidance:
    'Send a nonblank search query. max_results selects from 1 through 10 results. ' +
    'Each result includes its title, URL, snippet, and available extra_snippets. Empty results do not prove universal absence.' }, ...providerSections]);

export const WEB_RESEARCH_GUIDANCE = operationalCatalog('lc_web_research',
  'Search, fetch, and synthesize a topic with cited sources. Use this for research across pages. ' +
  'Provide up to 5 preferred_domains only when known, user-requested, or supplied by an active skill. ' +
  'Domains are relevance hints, not guarantees of authority. max_results requests 1 through 10 usable sources, default 5. ' +
  'Inspect confidence_note and research_info, including ignored_params.',
  'Omit preferred_domains for broad research. A focused search uses them when present. ' +
  'Use lc_web_fetch for one known page. A synthesis is generated text, not a direct quotation from every source.',
  [{ title: 'Sources and synthesis', aliases: ['query', 'sources', 'summary'], guidance:
    'A sub-agent synthesizes the fetched evidence with citations. LC rejects a blank synthesis or one above 64 KiB of UTF-8 text. ' +
    'Inspect confidence_note for weak evidence. Verify source wording before quoting a generated summary.' },
  { title: 'Focused search and cost', aliases: ['preferred domains', 'cross check', 'cost'], guidance:
    'Known preferred_domains focus one search. A normal run uses one search call apart from native transport retries. ' +
    'With supported providers, cross_check=true adds a second broad search when preferred_domains are present. ' +
    'Marginalia ignores cross_check and limits each run to one broad or focused search because its shared key is rate-limited.' },
  ...providerSections]);

export const TOOL_GUIDANCE_CATALOGS: ReadonlyMap<string, ToolGuidanceCatalog> = new Map([
  [GREP_GUIDANCE.tool, GREP_GUIDANCE],
  [READ_FILE_GUIDANCE.tool, READ_FILE_GUIDANCE],
  [READ_PDF_GUIDANCE.tool, READ_PDF_GUIDANCE],
  [WHITEBOARD_GUIDANCE.tool, WHITEBOARD_GUIDANCE],
  [WRITE_FILE_GUIDANCE.tool, WRITE_FILE_GUIDANCE],
  [EDIT_FILE_GUIDANCE.tool, EDIT_FILE_GUIDANCE],
  [LIST_DIR_GUIDANCE.tool, LIST_DIR_GUIDANCE],
  [GLOB_FILES_GUIDANCE.tool, GLOB_FILES_GUIDANCE],
  [READ_IMAGE_GUIDANCE.tool, READ_IMAGE_GUIDANCE],
  [RUN_SHELL_GUIDANCE.tool, RUN_SHELL_GUIDANCE],
  [STAT_GUIDANCE.tool, STAT_GUIDANCE],
  [CURRENT_TIME_GUIDANCE.tool, CURRENT_TIME_GUIDANCE],
  [TODO_WRITE_GUIDANCE.tool, TODO_WRITE_GUIDANCE],
  [WEB_FETCH_GUIDANCE.tool, WEB_FETCH_GUIDANCE],
  [APPLY_PATCH_GUIDANCE.tool, APPLY_PATCH_GUIDANCE],
  [WEB_SEARCH_GUIDANCE.tool, WEB_SEARCH_GUIDANCE],
  [WEB_RESEARCH_GUIDANCE.tool, WEB_RESEARCH_GUIDANCE],
]);

export function guidanceCatalog(tool: string): ToolGuidanceCatalog | undefined {
  return TOOL_GUIDANCE_CATALOGS.get(tool);
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
