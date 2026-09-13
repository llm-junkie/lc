import type { SkillDefinition } from '../types';
import {
  FILE_IO_NAMES,
  WEB_ACCESS_NAMES,
  SKILLS_NAMES,
  WHITEBOARD_NAMES,
} from './tool-engine/registry-names.ts';

export const LC_TOOLS_SKILL_ID = 'lc:builtin:lc-tools';
export const STE100_SKILL_ID = 'lc:builtin:ste100';

/** Built-ins selected for a newly enabled Skills category. */
export const DEFAULT_SKILL_IDS = [LC_TOOLS_SKILL_ID, STE100_SKILL_ID] as const;

const SECTION_ORDER = [
  'core',
  'file_io',
  'shell',
  'web_access',
  'whiteboard',
  'tool_history',
  'skills',
] as const;

type LcToolsSection = (typeof SECTION_ORDER)[number];

const SECTION_MARKER_RE = /^<!-- lc-tools-section:([a-z_]+) -->$/;

/** Parse and validate the special LC Tools template. Content outside the
 * named sections, missing sections, and duplicate sections are errors. */
export function parseLcToolsSections(content: string): ReadonlyMap<LcToolsSection, string> {
  const lines = content.split(/\r?\n/);
  const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
  const markers: { key: LcToolsSection; line: number }[] = [];

  for (let line = 0; line < lines.length; line += 1) {
    if (!lines[line].includes('lc-tools-section:')) continue;
    const match = SECTION_MARKER_RE.exec(lines[line]);
    if (!match) throw new Error(`Invalid LC Tools section marker on line ${line + 1}.`);
    const rawKey = match[1];
    if (!SECTION_ORDER.includes(rawKey as LcToolsSection)) {
      throw new Error(`Unknown LC Tools section: ${rawKey}`);
    }
    const key = rawKey as LcToolsSection;
    if (markers.some((marker) => marker.key === key)) {
      throw new Error(`Duplicate LC Tools section: ${key}`);
    }
    markers.push({ key, line });
  }

  if (markers.length === 0 || markers[0].line !== firstContentLine) {
    throw new Error('LC Tools content must begin with an lc-tools-section marker.');
  }

  const sections = new Map<LcToolsSection, string>();
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const expected = SECTION_ORDER[index];
    if (marker.key !== expected) {
      throw new Error(`LC Tools sections must be ordered; expected ${expected}, found ${marker.key}.`);
    }
    const endLine = markers[index + 1]?.line ?? lines.length;
    const body = lines.slice(marker.line + 1, endLine).join('\n').trim();
    if (!body) throw new Error(`Empty LC Tools section: ${marker.key}`);
    sections.set(marker.key, body);
  }

  for (const key of SECTION_ORDER) {
    if (!sections.has(key)) throw new Error(`Missing LC Tools section: ${key}`);
  }
  return sections;
}

function enabledSections(exposedToolNames: ReadonlySet<string>): Set<LcToolsSection> {
  const enabled = new Set<LcToolsSection>(['core']);
  if (FILE_IO_NAMES.some((name) => exposedToolNames.has(name))) enabled.add('file_io');
  if (exposedToolNames.has('lc_run_shell')) enabled.add('shell');
  // Web Access is opt-in. Materialize its guidance only from the canonical
  // resolved exposure set, never from Workspace activation alone.
  if (WEB_ACCESS_NAMES.some((name) => exposedToolNames.has(name))) enabled.add('web_access');
  if (WHITEBOARD_NAMES.some((name) => exposedToolNames.has(name))) enabled.add('whiteboard');
  if (exposedToolNames.has('lc_tool_history')) enabled.add('tool_history');
  if (SKILLS_NAMES.some((name) => exposedToolNames.has(name))) enabled.add('skills');
  return enabled;
}

/** Materialize LC Tools for the current exposure snapshot. Other built-in and
 * custom skills remain ordinary static Markdown. */
export function materializeSkillForExposure(
  skill: SkillDefinition,
  exposedToolNames: readonly string[],
): SkillDefinition {
  if (skill.id !== LC_TOOLS_SKILL_ID) return { ...skill };
  const sections = parseLcToolsSections(skill.content);
  const enabled = enabledSections(new Set(exposedToolNames));
  return {
    ...skill,
    content: SECTION_ORDER
      .filter((key) => enabled.has(key))
      .map((key) => sections.get(key)!)
      .join('\n\n'),
  };
}
