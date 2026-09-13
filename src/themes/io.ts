/**
 * Theme import/export utilities.
 *
 * Import:
 *   - Accepts .json ThemeFile files
 *   - Single or multiple (via <input multiple>)
 *   - Validates version and required fields
 *   - Generates unique IDs from name + timestamp
 *
 * Export:
 *   - Single theme → .json download
 *   - All themes → individual .json downloads (triggered sequentially)
 */

import { THEME_FILE_VERSION, type CustomTheme, type ThemeFile } from './types.ts';
import { lcExportFileName } from '../utils/exportNames.ts';

/* ------------------------------------------------------------------ */
/*  ID generation                                                     */
/* ------------------------------------------------------------------ */

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function themeId(name: string): string {
  return `${slug(name)}-${Date.now()}`;
}

/* ------------------------------------------------------------------ */
/*  Validation                                                        */
/* ------------------------------------------------------------------ */

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function isValidColor(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  // Hex, rgb(), rgba(), hsl(), hsla(), named colors, transparent, var().
  if (
    /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) ||
    /^(rgba?|hsla?)\(/.test(value) ||
    /^var\(--/.test(value) ||
    /^(transparent|inherit|initial|unset)$/.test(value) ||
    /^(linear-gradient|radial-gradient|conic-gradient)\(/.test(value)
  ) return true;
  // Box-shadow values (e.g. "0 20px 60px rgba(0,0,0,0.45)").
  if (/^\d/.test(value) && /rgba?\(/.test(value)) return true;
  return false;
}

function validateSpine(spine: unknown): string[] {
  const errors: string[] = [];
  if (!spine || typeof spine !== 'object') {
    errors.push('spine must be an object');
    return errors;
  }
  const s = spine as Record<string, unknown>;
  const required = ['--bg', '--bg-elev-1', '--bg-elev-2', '--bg-elev-3', '--accent', '--text'];
  for (const key of required) {
    if (s[key] === undefined) {
      errors.push(`spine missing required key: ${key}`);
    } else if (!isValidColor(s[key])) {
      errors.push(`spine.${key}: invalid color value: ${s[key]}`);
    }
  }
  // Optional keys — validate if present.
  const optional = ['--text-muted', '--text-faint', '--border', '--border-strong'];
  for (const key of optional) {
    if (s[key] !== undefined && !isValidColor(s[key])) {
      errors.push(`spine.${key}: invalid color value: ${s[key]}`);
    }
  }
  return errors;
}

function validateTokens(tokens: unknown, label: string): string[] {
  const errors: string[] = [];
  if (!tokens || typeof tokens !== 'object') {
    errors.push(`${label} must be an object`);
    return errors;
  }
  for (const [k, v] of Object.entries(tokens as Record<string, unknown>)) {
    if (!k.startsWith('--')) {
      errors.push(`${label}: key "${k}" must start with --`);
    } else if (!isValidColor(v)) {
      errors.push(`${label}.${k}: invalid color value: ${v}`);
    }
  }
  return errors;
}

function validateThemeFile(data: unknown): ValidationResult {
  const errors: string[] = [];

  if (!data || typeof data !== 'object') {
    errors.push('Not a valid JSON object');
    return { valid: false, errors };
  }

  const f = data as Record<string, unknown>;

  if (typeof f.name !== 'string' || !f.name.trim()) {
    errors.push('name is required (non-empty string)');
  }
  if (f.version !== THEME_FILE_VERSION) {
    errors.push(`version must be ${THEME_FILE_VERSION}`);
  }
  if (f.mode !== 'spine' && f.mode !== 'full') {
    errors.push('mode must be "spine" or "full"');
  }

  if (f.mode === 'spine') {
    if (f.base !== 'light' && f.base !== 'dark') {
      errors.push('spine mode requires base: "light" or "dark"');
    }
    errors.push(...validateSpine(f.spine));
  }

  if (f.mode === 'full') {
    errors.push(...validateTokens(f.glass, 'glass'));
    errors.push(...validateTokens(f.solid, 'solid'));
  }

  return { valid: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ */
/*  Import from file                                                  */
/* ------------------------------------------------------------------ */

/**
 * Read a File as text and parse it as a ThemeFile.
 * Returns the parsed file or an error string.
 */
function parseFile(file: File): Promise<{ ok: true; data: ThemeFile } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    if (!file.name.endsWith('.json')) {
      resolve({ ok: false, error: `"${file.name}" is not a .json file` });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        const validation = validateThemeFile(data);
        if (!validation.valid) {
          resolve({ ok: false, error: `"${file.name}": ${validation.errors.join('; ')}` });
        } else {
          resolve({ ok: true, data: data as ThemeFile });
        }
      } catch {
        resolve({ ok: false, error: `"${file.name}" is not valid JSON` });
      }
    };
    reader.onerror = () => {
      resolve({ ok: false, error: `Failed to read "${file.name}"` });
    };
    reader.readAsText(file);
  });
}

/**
 * Import themes from File objects (e.g. from <input type="file">).
 * Returns successfully parsed CustomTheme objects and any errors.
 */
export async function importThemes(files: FileList | File[]): Promise<{
  themes: CustomTheme[];
  errors: string[];
}> {
  const themes: CustomTheme[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const file of Array.from(files)) {
    const result = await parseFile(file);
    if (!result.ok) {
      errors.push((result as { ok: false; error: string }).error);
      continue;
    }
    const theme: CustomTheme = {
      id: themeId(result.data.name),
      name: result.data.name,
      source: result.data,
      importedAt: Date.now(),
    };
    // Deduplicate by name within the batch.
    if (seen.has(theme.name)) {
      errors.push(`"${theme.name}" already imported in this batch`);
      continue;
    }
    seen.add(theme.name);
    themes.push(theme);
  }

  return { themes, errors };
}

/* ------------------------------------------------------------------ */
/*  Export to file                                                    */
/* ------------------------------------------------------------------ */

function downloadJSON(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Download a single custom theme as a .json file.
 */
export function exportTheme(theme: CustomTheme): void {
  downloadJSON(lcExportFileName(`theme-${slug(theme.name) || 'custom'}`, 'theme.json'), theme.source);
}

/**
 * Download all custom themes as individual .json files.
 * Triggers downloads sequentially to avoid browser popup-blocking.
 */
export function exportAllThemes(themes: CustomTheme[]): void {
  for (const theme of themes) {
    exportTheme(theme);
  }
}
