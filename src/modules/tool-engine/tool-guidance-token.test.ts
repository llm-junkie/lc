import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Conversation } from '../../types';
import { encode } from 'gpt-tokenizer';
import { buildPromptText } from '../chat-pipeline/system-prompt.ts';
import { BUILTIN_TOOLS, materialize } from './registry.ts';
import { buildToolHelpEnvelope } from './tool-help.ts';
import { getBuiltinSkill } from '../builtin-skills.ts';
import { materializeSkillForExposure } from '../lc-tools-skill.ts';
import { TOOL_GUIDANCE_CATALOGS } from './tool-guidance.ts';
import { useSettings } from '../../store/settings.ts';

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
  toolPayload: 6_954,
  schemaPayload: 2_660,
  schemaPayloadWithoutDescriptions: 2_220,
  systemPromptOneRoot: 548,
  systemPromptTwoRoots: 552,
  systemPromptLinux: 486,
  completeFixedSurface: 7_506,
});

// Final rollout: retain essential safety even when it increases the prompt.
const ROLLOUT = Object.freeze({
  toolPayload: 5_114,
  schemaPayload: 2_660,
  schemaPayloadWithoutDescriptions: 2_220,
  systemPromptOneRoot: 580,
  systemPromptTwoRoots: 584,
  systemPromptLinux: 518,
  completeFixedSurface: 5_698,
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
  test('measures every active search-provider payload without omitting its caveats', () => {
    const original = useSettings.getState().tools;
    const prompt = buildPromptText({ tools, params: { system_prompt: '' } }, 'C:/Users/name', 'Windows');
    try {
      for (const [provider, settings, toolTokens, completeTokens] of [
        ['brave', { brave_search_api_key: 'fixture' }, 5200, 5784],
        ['searxng', { searxng_base_url: 'http://localhost:8080' }, 5210, 5794],
        ['marginalia', { marginalia_api_key: 'public' }, 5224, 5808],
      ] as const) {
        useSettings.setState({ tools: Object.assign({ ...original, brave_search_api_key: '', brave_search_api_key_ref: undefined,
          searxng_base_url: '', marginalia_api_key: '', marginalia_api_key_ref: undefined,
          web_search_provider: provider }, settings) });
        const serialized = JSON.stringify(materialize(BUILTIN_TOOLS));
        assert.equal(countFixtureTokens(serialized), toolTokens, provider);
        assert.equal(countFixtureTokens(`${prompt}\n${serialized}`), completeTokens, provider);
        assert.ok(completeTokens <= 5900);
      }
    } finally {
      useSettings.setState({ tools: original });
    }
  });

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

  test('retains the Whiteboard baseline and measures the complete rollout exactly', () => {
    assert.equal(WHITEBOARD.completeFixedSurface, 7_506);
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
    }, ROLLOUT);

    // Additional help-selection and U+FFFD safety rules justify the 600-token cap.
    assert.ok(ROLLOUT.systemPromptTwoRoots <= 600);
    assert.ok(ROLLOUT.completeFixedSurface < WHITEBOARD.completeFixedSurface);
    for (const [name, catalog] of TOOL_GUIDANCE_CATALOGS) {
      const description = definitions.find((definition) => definition.function.name === name)?.function.description;
      assert.ok(description);
      // Grep result modes, patch syntax, and research-provider caveats have explicit exceptions.
      const limit = ['lc_grep', 'lc_apply_patch', 'lc_web_research'].includes(name) ? 250 : 120;
      assert.ok(countFixtureTokens(description) <= limit, `${name} exceeds its description budget`);
      if (!['lc_web_search', 'lc_web_research'].includes(name)) assert.equal(description, catalog.essential);
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
    for (const catalog of TOOL_GUIDANCE_CATALOGS.values()) {
      assert.ok(countFixtureTokens(JSON.stringify(buildToolHelpEnvelope({ tool: catalog.tool }, exposed))) <= 400);
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
      lc_grep: 402,
      lc_read_file: 230,
      lc_read_pdf: 306,
      lc_whiteboard: 158,
      lc_write_file: 226,
      lc_edit_file: 232,
      lc_list_dir: 142,
      lc_glob_files: 276,
      lc_read_image: 271,
      lc_run_shell: 218,
      lc_stat: 78,
      lc_get_current_time: 93,
      lc_todo_write: 99,
      lc_web_fetch: 163,
      lc_apply_patch: 272,
      lc_web_search: 191,
      lc_web_research: 216,
    });

    const skill = getBuiltinSkill('lc:builtin:lc-tools');
    assert.ok(skill);
    const liveSkill = materializeSkillForExposure(skill, [...exposed]);
    assert.equal(countFixtureTokens(liveSkill.content), 890);
    assert.ok(countFixtureTokens(liveSkill.content) >= 600 && countFixtureTokens(liveSkill.content) <= 900);
  });
});
