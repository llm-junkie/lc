export const FIXED_SEARCH_EXCLUDED_DIRS = Object.freeze([
  '.git', 'node_modules', 'target', '__pycache__', '.venv', 'venv', '.env',
  'dist', 'build', '.next', '.nuxt', '.cache', 'coverage', '.idea', '.vscode',
] as const);

export const FIXED_GREP_EXCLUDED_EXTENSIONS = Object.freeze([
  'exe', 'dll', 'so', 'dylib', 'bin', 'png', 'jpg', 'jpeg', 'gif', 'ico',
  'webp', 'bmp', 'woff', 'woff2', 'ttf', 'eot', 'pdf', 'zip', 'tar', 'gz',
  '7z', 'rar',
] as const);

/**
 * Maximum entries accepted by content-rich filesystem batch tools.
 *
 * `lc_read_image`, `lc_read_pdf`, and `lc_stat` own separate contracts. The
 * five tools using this shared limit can otherwise multiply file I/O and
 * result size independently of the turn-level tool-call limit.
 */
export const FILESYSTEM_BATCH_MAX_ENTRIES = 20;

export const COMMON_GLOB_DIALECT =
  'The shared glob engine supports *, **, ?, character classes such as [abc], and brace expansion such as {ts,tsx}.';

export const GREP_COMPLETENESS_CONTRACT =
  'For error-free lc_grep results, truncated=true proves incompleteness, ' +
  'truncated=false proves completeness, and null means completeness is not determined.';
