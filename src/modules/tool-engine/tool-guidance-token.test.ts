import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Conversation } from '../../types';
import { encode } from 'gpt-tokenizer';
import { buildPromptText } from '../chat-pipeline/system-prompt.ts';
import { BUILTIN_TOOLS, materialize } from './registry.ts';
import { buildToolHelpEnvelope } from './tool-help.ts';
import { getBuiltinSkill } from '../builtin-skills.ts';
import { materializeSkillForExposure } from '../lc-tools-skill.ts';
import { PILOT_GUIDANCE_CATALOGS } from './tool-guidance.ts';

// Fixed fixtures are bounded and trusted. Encode each complete fixture without runtime sampling.
const countFixtureTokens = (text: string): number => encode(text).length;

const BASELINE = Object.freeze({
  toolPayload: 8_121,
  schemaPayload: 2_328,
  schemaPayloadWithoutDescriptions: 1_822,
  systemPrompt: 426,
  completeFixedSurface: 8_547,
});

const PRE_WHITEBOARD = Object.freeze({
  toolPayload: 6_456,
  schemaPayload: 2_407,
  schemaPayloadWithoutDescriptions: 2_099,
  systemPromptOneRoot: 496,
  systemPromptTwoRoots: 500,
  systemPromptLinux: 434,
  completeFixedSurface: 6_956,
});

const WHITEBOARD = Object.freeze({
  toolPayload: 6_947,
  schemaPayload: 2_660,
  schemaPayloadWithoutDescriptions: 2_220,
  systemPromptOneRoot: 548,
  systemPromptTwoRoots: 552,
  systemPromptLinux: 486,
  completeFixedSurface: 7_499,
});

const tools = {
  enabled: true,
  file_io_enabled: true,
  shell_enabled: true,
  web_access_enabled: true,
  tool_grants: [],
  web_access_grants_initialized: true,
  tool_history_enabled: true,
  skills_enabled: true,
  whiteboard_enabled: true,
  enabled_skill_ids: ['lc:builtin:lc-tools'],
  allowed_roots: ['C:/workspace', 'D:/outside'],
  dir_permissions: {},
  shell_allowlist: 'cmd,dir,findstr,tasklist',
  max_tool_calls_per_batch: 4,
  max_tool_rounds_per_turn: 32,
  sse_read_timeout_min: 5,
} satisfies NonNullable<Conversation['tools']>;

function removeDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeDescriptions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'description')
      .map(([key, child]) => [key, removeDescriptions(child)]),
  );
}

describe('tool guidance token fixtures', () => {
  test('keeps the recorded pre-guidance measurements', () => {
    assert.deepEqual(BASELINE, {
      toolPayload: 8_121,
      schemaPayload: 2_328,
      schemaPayloadWithoutDescriptions: 1_822,
      systemPrompt: 426,
      completeFixedSurface: 8_547,
    });
  });

  test('keeps the recorded pre-Whiteboard measurements', () => {
    assert.deepEqual(PRE_WHITEBOARD, {
      toolPayload: 6_456,
      schemaPayload: 2_407,
      schemaPayloadWithoutDescriptions: 2_099,
      systemPromptOneRoot: 496,
      systemPromptTwoRoots: 500,
      systemPromptLinux: 434,
      completeFixedSurface: 6_956,
    });
  });

  test('measures the complete Whiteboard payload and dynamic prompts exactly', () => {
    const definitions = materialize(BUILTIN_TOOLS);
    const serializedDefinitions = JSON.stringify(definitions);
    const schemas = definitions.map((definition) => definition.function.parameters);
    const promptTwoRoots = buildPromptText(
      { tools, params: { system_prompt: '' } },
      'C:/Users/name',
      'Windows',
    );
    const promptOneRoot = buildPromptText(
      { tools: { ...tools, allowed_roots: ['C:/workspace'] }, params: { system_prompt: '' } },
      'C:/Users/name',
      'Windows',
    );
    const promptLinux = buildPromptText(
      { tools: { ...tools, allowed_roots: ['/work/a', '/work/b'] }, params: { system_prompt: '' } },
      '/home/name',
      'Linux',
    );

    assert.deepEqual({
      toolPayload: countFixtureTokens(serializedDefinitions),
      schemaPayload: countFixtureTokens(JSON.stringify(schemas)),
      schemaPayloadWithoutDescriptions: countFixtureTokens(JSON.stringify(removeDescriptions(schemas))),
      systemPromptOneRoot: countFixtureTokens(promptOneRoot),
      systemPromptTwoRoots: countFixtureTokens(promptTwoRoots),
      systemPromptLinux: countFixtureTokens(promptLinux),
      completeFixedSurface: countFixtureTokens(`${promptTwoRoots}\n${serializedDefinitions}`),
    }, WHITEBOARD);

    assert.ok(WHITEBOARD.systemPromptTwoRoots <= 560);
    for (const name of ['lc_grep', 'lc_read_file', 'lc_read_pdf', 'lc_whiteboard']) {
      const description = definitions.find((definition) => definition.function.name === name)?.function.description;
      assert.ok(description);
      assert.ok(countFixtureTokens(description) <= 120, `${name} exceeds the pilot description target`);
    }
    const pdfDescription = definitions.find((definition) =>
      definition.function.name === 'lc_read_pdf')?.function.description ?? '';
    assert.match(pdfDescription, /Use "1-5,12" syntax for pages and force_render\./);
    assert.match(pdfDescription, /Omit either field to use its default\./);
    const helpDefinition = definitions.find((definition) => definition.function.name === 'lc_tool_help');
    assert.ok(helpDefinition);
    assert.ok(countFixtureTokens(JSON.stringify(helpDefinition)) <= 220);

    const exposed = new Set(definitions.map((definition) => definition.function.name));
    assert.deepEqual(Object.fromEntries(
      ['lc_grep', 'lc_read_file', 'lc_read_pdf', 'lc_whiteboard'].map((name) => [
        name,
        countFixtureTokens(JSON.stringify(buildToolHelpEnvelope({ tool: name }, exposed))),
      ]),
    ), { lc_grep: 125, lc_read_file: 115, lc_read_pdf: 127, lc_whiteboard: 118 });

    const advancedMaximums: Record<string, number> = {};
    for (const catalog of PILOT_GUIDANCE_CATALOGS.values()) {
      let maximum = 0;
      const queries = [
        ...catalog.keywords,
        ...catalog.sections.flatMap((section) => [section.title, ...section.aliases]),
      ];
      for (const section of catalog.sections) {
        assert.ok(countFixtureTokens(section.guidance) <= 300);
      }
      for (const query of queries) {
        const serialized = JSON.stringify(buildToolHelpEnvelope({ tool: catalog.tool, query }, exposed));
        maximum = Math.max(maximum, countFixtureTokens(serialized));
        assert.ok(new TextEncoder().encode(serialized).byteLength <= 16 * 1024);
        assert.ok(countFixtureTokens(serialized) <= 1_000);
      }
      advancedMaximums[catalog.tool] = maximum;
    }
    assert.deepEqual(advancedMaximums, {
      lc_grep: 351,
      lc_read_file: 209,
      lc_read_pdf: 306,
      lc_whiteboard: 158,
    });

    const skill = getBuiltinSkill('lc:builtin:lc-tools');
    assert.ok(skill);
    const liveSkill = materializeSkillForExposure(skill, [...exposed]);
    assert.equal(countFixtureTokens(liveSkill.content), 889);
    assert.ok(countFixtureTokens(liveSkill.content) >= 600 && countFixtureTokens(liveSkill.content) <= 900);
  });
});
