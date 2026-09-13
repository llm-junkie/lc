/**
 * LC built-in skill registry.
 *
 * Built-in skills are shipped with LC and use stable LC-owned IDs
 * (e.g. `lc:builtin:lc-tools`). They are NOT editable,
 * deletable, or importable through the custom-skill picker.
 *
 * The registry is loaded from the inlined Markdown content in
 * `builtin-skill-content.ts`. Content is never fetched from a remote
 * source.
 */

import type { SkillDefinition } from '../types';
import { compareSkillsAlphabetically, parseSkillMarkdown } from './skills.ts';
import { BUILTIN_SKILL_SOURCES } from './builtin-skill-content.ts';

/** Fully parsed built-in skills, keyed by stable LC-owned ID. */
const BUILTIN_BY_ID = new Map<string, SkillDefinition>();

/** Ordered list of built-in SkillDefinitions for UI rendering. */
const BUILTIN_LIST: SkillDefinition[] = [];

// Parse each built-in source at module load time.
for (const { raw, filename } of BUILTIN_SKILL_SOURCES) {
  try {
    const skill = parseSkillMarkdown(raw, filename);
    BUILTIN_BY_ID.set(skill.id, skill);
    BUILTIN_LIST.push(skill);
  } catch (err) {
    console.error(`[builtin-skills] Failed to parse ${filename}:`, err);
  }
}

BUILTIN_LIST.sort(compareSkillsAlphabetically);

/** Check whether an ID belongs to a built-in skill. */
export function isBuiltinId(id: string): boolean {
  return id.startsWith('lc:builtin:');
}

/** Get a built-in skill by its LC-owned ID. Returns undefined if not found. */
export function getBuiltinSkill(id: string): SkillDefinition | undefined {
  if (!isBuiltinId(id)) return undefined;
  return BUILTIN_BY_ID.get(id);
}

/** Get all built-in skills, sorted alphabetically by display name. */
export function getBuiltinSkillList(): readonly SkillDefinition[] {
  return BUILTIN_LIST;
}

/** Resolve a skill ID to its SkillDefinition, checking built-ins only. */
export function resolveBuiltinSkill(id: string): SkillDefinition | undefined {
  return BUILTIN_BY_ID.get(id);
}

/** Check if a skill ID is a known built-in. */
export function isKnownBuiltin(id: string): boolean {
  return BUILTIN_BY_ID.has(id);
}
