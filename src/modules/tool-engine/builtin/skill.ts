import { z } from 'zod';
import type { SkillDefinition } from '../../../types';
import type { JsonSchema } from '../../llm-client/types';
import { getBuiltinSkill, isBuiltinId } from '../../builtin-skills.ts';
import { materializeSkillForExposure } from '../../lc-tools-skill.ts';
import { compareSkillsAlphabetically } from '../../skills.ts';
import type { ToolHandler } from '../types';

export const SKILL_ID_MAX_CHARACTERS = 256;
export const SKILL_ID_LIMIT_MESSAGE =
  `id accepts at most ${SKILL_ID_MAX_CHARACTERS} characters. Use an enabled skill ID from list mode.`;

const schema = z.object({
  /** Omit to list available skills; provide an ID to retrieve full Markdown. */
  id: z.string().max(SKILL_ID_MAX_CHARACTERS, SKILL_ID_LIMIT_MESSAGE).optional(),
});

export type SkillInput = z.infer<typeof schema>;

export interface SkillListItem {
  id: string;
  name: string;
  description: string;
  revision: number;
  /** Discriminator so the model can distinguish LC-owned from user-imported guidance. */
  source: 'builtin' | 'custom';
}

/** Maximum enabled skills that one list result can return. */
export const SKILL_LIST_MAX_ITEMS = 100;
/** Maximum UTF-8 bytes in the complete serialized lc_skill data result. */
export const SKILL_RESULT_MAX_BYTES = 2 * 1024 * 1024;

export type SkillOutput =
  | { mode: 'list'; skills: SkillListItem[] }
  | { mode: 'skill'; skill: SkillDefinition; source: 'builtin' | 'custom' }
  | { mode: 'error'; code: 'skill_unavailable'; id: string; message: string }
  | {
    mode: 'error';
    code: 'skill_limit_exceeded';
    total: number;
    limit: number;
    message: string;
  }
  | {
    mode: 'error';
    code: 'skill_result_too_large';
    limit_bytes: number;
    message: string;
  };

export function skillListLimitMessage(total: number): string {
  return `The enabled Skills list has ${total} items. The limit is ${SKILL_LIST_MAX_ITEMS}. Ask the user to disable or delete skills in Workspace. Then retry.`;
}

export const SKILL_RESULT_TOO_LARGE_MESSAGE =
  `The lc_skill result exceeds the ${SKILL_RESULT_MAX_BYTES}-byte limit. Ask the user to shorten or remove enabled skills in Workspace. Then retry.`;
export const SKILL_UNAVAILABLE_MESSAGE =
  'The requested skill is not available in the user-enabled Skills list.';

function serializedUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function resultTooLarge(): SkillOutput {
  return {
    mode: 'error',
    code: 'skill_result_too_large',
    limit_bytes: SKILL_RESULT_MAX_BYTES,
    message: SKILL_RESULT_TOO_LARGE_MESSAGE,
  };
}

function withinResultBudget(output: SkillOutput): SkillOutput {
  return serializedUtf8Bytes(output) <= SKILL_RESULT_MAX_BYTES
    ? output
    : resultTooLarge();
}

const CACHED_SCHEMA = Object.freeze(schema.toJSONSchema()) as unknown as JsonSchema;

/**
 * Resolve enabled skill IDs to their full SkillDefinitions.
 * Built-in IDs (lc:builtin:*) are resolved from the built-in registry.
 * Custom IDs (UUIDs) are resolved from the conversation's custom_skills list.
 */
function resolveSkills(
  ids: readonly string[],
  customSkills: SkillDefinition[] | undefined,
): { skill: SkillDefinition; source: 'builtin' | 'custom' }[] {
  const resolved: { skill: SkillDefinition; source: 'builtin' | 'custom' }[] = [];
  const customById = new Map((customSkills ?? []).map((s) => [s.id, s]));

  for (const id of ids) {
    if (isBuiltinId(id)) {
      const builtin = getBuiltinSkill(id);
      if (builtin) resolved.push({ skill: builtin, source: 'builtin' });
    } else {
      const custom = customById.get(id);
      if (custom) resolved.push({ skill: custom, source: 'custom' });
    }
  }
  return resolved;
}

function compareResolvedSkills(
  a: { skill: SkillDefinition; source: 'builtin' | 'custom' },
  b: { skill: SkillDefinition; source: 'builtin' | 'custom' },
): number {
  if (a.source !== b.source) return a.source === 'builtin' ? -1 : 1;
  return compareSkillsAlphabetically(a.skill, b.skill);
}

export const skill: ToolHandler<SkillInput, SkillOutput> = {
  name: 'lc_skill',
  description:
    'Discover and retrieve user-enabled Markdown skills.\n' +
    'Call lc_skill with {} to list skill IDs, names, and descriptions.\n' +
    'Call lc_skill with {"id":"xxx"} to retrieve the full Markdown guidance for one skill.\n' +
    `id accepts at most ${SKILL_ID_MAX_CHARACTERS} characters.\n` +
    'LC rebuilds the LC Tool Cheat Sheet from current tool exposure for every retrieval.\n' +
    `A list accepts at most ${SKILL_LIST_MAX_ITEMS} enabled skills.\n` +
    `The complete serialized result has a ${SKILL_RESULT_MAX_BYTES}-byte UTF-8 limit.\n` +
    'At the start of each turn that needs LC guidance, retrieve the enabled cheat sheet with lc_skill.\n' +
    'Do not reuse an older result.',
  uiDescription: 'Discover and retrieve user-enabled Markdown guidance.',
  input: schema,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (input, ctx) => {
    const requestedId = input.id?.trim() || undefined;
    const resolved = resolveSkills(
      ctx.config.skillIds ?? [],
      ctx.config.customSkills,
    ).sort(compareResolvedSkills);

    if (!requestedId) {
      if (resolved.length > SKILL_LIST_MAX_ITEMS) {
        return {
          mode: 'error',
          code: 'skill_limit_exceeded',
          total: resolved.length,
          limit: SKILL_LIST_MAX_ITEMS,
          message: skillListLimitMessage(resolved.length),
        };
      }
      return withinResultBudget({
        mode: 'list',
        skills: resolved.map(({ skill, source }) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          revision: skill.revision,
          source,
        })),
      });
    }

    const match = resolved.find(({ skill: s }) => s.id === requestedId);
    if (!match) {
      return withinResultBudget({
        mode: 'error',
        code: 'skill_unavailable',
        id: requestedId,
        message: SKILL_UNAVAILABLE_MESSAGE,
      });
    }
    return withinResultBudget({
      mode: 'skill',
      skill: match.source === 'builtin'
        ? materializeSkillForExposure(match.skill, ctx.config.exposedToolNames ?? [])
        : { ...match.skill },
      source: match.source,
    });
  },
};
