import type { SkillDefinition } from '../types';
import { uid } from '../utils/uid.ts';

export const MAX_SKILL_BYTES = 256 * 1024;

const SKILL_NAME_COLLATOR = new Intl.Collator('en', {
  sensitivity: 'base',
  numeric: true,
});

/** Order skills by display name, with the stable ID as a deterministic tiebreaker. */
export function compareSkillsAlphabetically(
  a: Pick<SkillDefinition, 'id' | 'name'>,
  b: Pick<SkillDefinition, 'id' | 'name'>,
): number {
  return SKILL_NAME_COLLATOR.compare(a.name, b.name) || a.id.localeCompare(b.id);
}

function simpleHash(text: string): string {
  // Deterministic, non-security digest used only for duplicate detection.
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseFrontMatter(text: string): { metadata: Record<string, string>; body: string } {
  const normalized = text.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) return { metadata: {}, body: normalized };
  const firstBreak = normalized.indexOf('\n');
  if (firstBreak < 0) return { metadata: {}, body: normalized };
  const end = normalized.indexOf('\n---', firstBreak + 1);
  if (end < 0) return { metadata: {}, body: normalized };

  const metadata: Record<string, string> = {};
  const header = normalized.slice(firstBreak + 1, end).replace(/\r/g, '');
  for (const line of header.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (!/^[a-zA-Z][\w-]*$/.test(key)) continue;
    metadata[key] = unquote(line.slice(colon + 1));
  }
  const after = normalized.slice(end + '\n---'.length);
  return { metadata, body: after.replace(/^\r?\n/, '') };
}

function filenameTitle(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'Untitled skill';
  return base.replace(/\.(?:md|markdown)$/i, '').trim() || 'Untitled skill';
}

function firstHeading(body: string): string | undefined {
  return body.split(/\r?\n/).find((line) => /^#\s+\S/.test(line.trim()))?.replace(/^#\s+/, '').trim();
}

function firstParagraph(body: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const paragraph: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (paragraph.length) break;
      continue;
    }
    if (trimmed.startsWith('#')) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(trimmed);
  }
  if (!paragraph.length) return undefined;
  return paragraph.join(' ').slice(0, 160);
}

function assertSkillSize(content: string): void {
  if (new TextEncoder().encode(content).byteLength > MAX_SKILL_BYTES) {
    throw new Error(`Skill content exceeds the ${Math.round(MAX_SKILL_BYTES / 1024)} KB limit.`);
  }
}

export function makeSkill(input: {
  name: string;
  description?: string;
  content: string;
  id?: string;
  createdAt?: number;
  updatedAt?: number;
  revision?: number;
}): SkillDefinition {
  const name = input.name.trim();
  const content = input.content.replace(/^\uFEFF/, '').trim();
  if (!name) throw new Error('Skill name is required.');
  if (!content) throw new Error('Skill Markdown content is required.');
  assertSkillSize(content);
  const now = Date.now();
  return {
    id: input.id?.trim() || uid(),
    name,
    description: (input.description ?? firstParagraph(content) ?? 'User-authored Markdown guidance.').trim().slice(0, 240),
    content,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    revision: Math.max(1, input.revision ?? 1),
    contentHash: simpleHash(content),
  };
}

export function parseSkillMarkdown(text: string, filename = 'skill.md'): SkillDefinition {
  const { metadata, body } = parseFrontMatter(text);
  const content = body.trim();
  return makeSkill({
    id: metadata.id,
    name: metadata.name || firstHeading(content) || filenameTitle(filename),
    description: metadata.description || firstParagraph(content),
    content,
    revision: metadata.revision ? Number(metadata.revision) || 1 : 1,
  });
}
