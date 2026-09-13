import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareSkillsAlphabetically, makeSkill, parseSkillMarkdown } from './skills.ts';
import { LC_TOOLS_MD, STE100_MD } from './builtin-skill-content.ts';
import { getBuiltinSkill, getBuiltinSkillList } from './builtin-skills.ts';
import {
  materializeSkillForExposure,
  parseLcToolsSections,
} from './lc-tools-skill.ts';
import {
  SKILL_ID_LIMIT_MESSAGE,
  SKILL_ID_MAX_CHARACTERS,
  SKILL_LIST_MAX_ITEMS,
  SKILL_RESULT_MAX_BYTES,
  skill,
} from './tool-engine/builtin/skill.ts';
import type { ToolHandlerContext } from './tool-engine/types';

describe('skill Markdown library', () => {
  it('parses optional front matter without sending metadata as content', () => {
    const parsed = parseSkillMarkdown(
      '---\nname: Excalidraw\ndescription: Keep scene JSON valid.\n---\n\n# Rules\n\nUse stable IDs.',
      'rules.md',
    );
    assert.equal(parsed.name, 'Excalidraw');
    assert.equal(parsed.description, 'Keep scene JSON valid.');
    assert.equal(parsed.content, '# Rules\n\nUse stable IDs.');
  });

  it('ships LC Tool Cheat Sheet as a concise seven-section workflow template', () => {
    const parsed = parseSkillMarkdown(LC_TOOLS_MD, 'lc-tools.md');
    assert.equal(parsed.revision, 1);
    assert.equal(parseLcToolsSections(parsed.content).size, 7);
    assert.match(LC_TOOLS_MD, /LC built this guide from the Workspace categories that are exposed now/i);
    assert.match(LC_TOOLS_MD, /Missing sections are not exposed\.\s*Do not call their tools/i);
    assert.match(LC_TOOLS_MD, /When `lc_tool_help` is exposed,\s*use it for detailed guidance about one tool/i);
    assert.match(LC_TOOLS_MD, /Use `lc_ask_user` only when a missing user decision matters/i);
    assert.match(LC_TOOLS_MD, /Select the narrowest exposed tool and scope/i);
    assert.match(LC_TOOLS_MD, /Wait for each result before the next dependent call/i);
    assert.match(LC_TOOLS_MD, /Treat `\[LC\]` and `WARNING` text as control\s*information/i);
    assert.match(LC_TOOLS_MD, /When LC reports a repeated call,\s*inspect that result before you call the tool again/i);
    assert.match(LC_TOOLS_MD, /When `lc_whiteboard` is exposed, use it as compact working memory/i);
    assert.match(LC_TOOLS_MD, /Shown only while Web Access is explicitly enabled/i);
    assert.match(LC_TOOLS_MD, /Record important goals, constraints, decisions, verified\s*facts, major task state, and next actions/i);
    assert.match(LC_TOOLS_MD, /Do not copy the transcript or raw tool\s*outputs/i);
    assert.match(LC_TOOLS_MD, /Do not use `lc_tool_history` as general memory or to reconstruct old work/i);
    assert.match(LC_TOOLS_MD, /do not retrieve old file reads, writes, patches, shell logs, or web\s*outputs/i);
    assert.match(LC_TOOLS_MD, /Retrieved output enters\s*the current turn and can quickly bloat its context window/i);
    assert.match(LC_TOOLS_MD, /retrieve one known call with a tight `max_result_bytes`/i);
    assert.match(LC_TOOLS_MD, /Do not list or search broadly only to recap the conversation/i);
    assert.doesNotMatch(LC_TOOLS_MD, /preferred_domains|infer one from query keywords/i);
  });

  it('sorts built-in skills alphabetically by display name', () => {
    const builtins = getBuiltinSkillList();
    assert.deepEqual(builtins, [...builtins].sort(compareSkillsAlphabetically));
  });

  it('ships Simplified Technical English as a built-in skill', () => {
    const ste100 = getBuiltinSkill('lc:builtin:ste100');
    assert.ok(ste100, 'STE100 built-in should be registered');
    assert.equal(ste100.name, 'Simplified Technical English');
    assert.equal(ste100.content, parseSkillMarkdown(STE100_MD, 'lc_skill_ste100.md').content);
  });

  it('rejects malformed LC Tools templates', () => {
    const template = parseSkillMarkdown(LC_TOOLS_MD, 'lc-tools.md').content;
    assert.throws(() => parseLcToolsSections('# unsectioned'), /must begin/i);
    assert.throws(
      () => parseLcToolsSections('<!-- lc-tools-section:core -->\n# Core'),
      /Missing LC Tools section/i,
    );
    assert.throws(
      () => parseLcToolsSections(template.replace('lc-tools-section:shell', 'lc-tools-section:unknown')),
      /Unknown LC Tools section/i,
    );
    assert.throws(
      () => parseLcToolsSections(template.replace('lc-tools-section:shell', 'lc-tools-section:file_io')),
      /Duplicate LC Tools section/i,
    );
    const outOfOrder = template
      .replace('lc-tools-section:file_io', 'lc-tools-section:temporary')
      .replace('lc-tools-section:shell', 'lc-tools-section:file_io')
      .replace('lc-tools-section:temporary', 'lc-tools-section:shell');
    assert.throws(() => parseLcToolsSections(outOfOrder), /must be ordered/i);
  });

  it('maps each exposure category to exactly one LC Tools section', () => {
    const template = parseSkillMarkdown(LC_TOOLS_MD, 'lc-tools.md');
    const cases = [
      ['lc_read_file', 'File I/O'],
      ['lc_run_shell', 'Shell'],
      ['lc_web_research', 'Web Access'],
      ['lc_whiteboard', 'Whiteboard'],
      ['lc_tool_history', 'Tool History'],
      ['lc_skill', 'Skills'],
    ] as const;
    const headings = cases.map(([, heading]) => heading);

    for (const [toolName, expectedHeading] of cases) {
      const content = materializeSkillForExposure(template, [toolName]).content;
      assert.match(content, /^# LC Tool Cheat Sheet$/m);
      for (const heading of headings) {
        const sectionPattern = new RegExp(`^## ${heading.replace(/[&/]/g, '\\$&')}$`, 'm');
        if (heading === expectedHeading) assert.match(content, sectionPattern);
        else assert.doesNotMatch(content, sectionPattern);
      }
      assert.doesNotMatch(content, /lc-tools-section:/);
    }
  });

  it('materializes Web Access guidance only from explicit resolved exposure', () => {
    const template = parseSkillMarkdown(LC_TOOLS_MD, 'lc-tools.md');
    const workspaceWithoutWeb = materializeSkillForExposure(template, [
      'lc_todo_write',
      'lc_ask_user',
      'lc_get_current_time',
      'lc_read_file',
      'lc_whiteboard',
      'lc_tool_history',
      'lc_skill',
    ]).content;
    assert.doesNotMatch(workspaceWithoutWeb, /^## Web Access$/m);
    assert.doesNotMatch(workspaceWithoutWeb, /lc_web_fetch|lc_web_search|lc_web_research/);

    const withWebAccess = materializeSkillForExposure(template, [
      'lc_skill',
      'lc_web_search',
    ]).content;
    assert.match(withWebAccess, /^## Web Access$/m);
    assert.match(withWebAccess, /Shown only while Web Access is explicitly enabled/i);
  });

});

describe('lc_skill tool', () => {
  it('lists and retrieves only the conversation-enabled skills', async () => {
    const alphaCustom = makeSkill({ id: 'custom-alpha', name: 'Alpha custom', content: '# Alpha' });
    const zuluCustom = makeSkill({ id: 'custom-zulu', name: 'Zulu custom', content: '# Zulu' });
    const ctx: ToolHandlerContext = {
      sandbox: undefined as unknown as ToolHandlerContext['sandbox'],
      config: {
        skillIds: ['custom-zulu', 'lc:builtin:ste100', 'custom-alpha', 'lc:builtin:lc-tools'],
        exposedToolNames: ['lc_skill'],
        customSkills: [zuluCustom, alphaCustom],
        allowedRoots: [],
        shellAllowlist: [],
        webFetchRatePerMin: 50,
        maxShellTimeoutMs: 120_000,
        maxWebFetchBytes: 32 * 1024 * 1024,
        maxWebFetchTimeoutMs: 30_000,
        searchProvider: null,
        visionModel: '',
        webResearchModel: '',
        pdfSummarizeModel: '',
        llmServerUrl: '',
        llmModel: '',
        llmApiKey: '',
        llmApiStyle: 'chat',
        llmApiVariant: 'openai',
      },
      signal: new AbortController().signal,
      identity: { groupId: 'g', operationId: 'op', modelToolCallId: 'tc', conversationId: 'conv', generationId: 'gen' },
    };

    const list = await skill.run({}, ctx);
    assert.equal(list.mode, 'list');
    if (list.mode === 'list') {
      assert.ok(list.skills.length >= 1);
      // Built-in should be present.
      const builtin = list.skills.find((s) => s.id === 'lc:builtin:lc-tools');
      assert.ok(builtin, 'built-in skill should be listed');
      assert.equal(builtin!.source, 'builtin');
      // Custom should be present.
      const customItem = list.skills.find((s) => s.id === 'custom-alpha');
      assert.ok(customItem, 'custom skill should be listed');
      assert.equal(customItem!.source, 'custom');
      assert.deepEqual(
        list.skills.map((s) => s.id),
        ['lc:builtin:lc-tools', 'lc:builtin:ste100', 'custom-alpha', 'custom-zulu'],
      );
    }

    // Retrieve the custom skill.
    const retrieved = await skill.run({ id: 'custom-alpha' }, ctx);
    assert.equal(retrieved.mode, 'skill');
    if (retrieved.mode === 'skill') {
      assert.equal(retrieved.skill.content, '# Alpha');
      assert.equal(retrieved.source, 'custom');
    }

    const dynamicBuiltin = await skill.run({ id: 'lc:builtin:lc-tools' }, ctx);
    assert.equal(dynamicBuiltin.mode, 'skill');
    if (dynamicBuiltin.mode === 'skill') {
      assert.match(dynamicBuiltin.skill.content, /^# LC Tool Cheat Sheet/m);
      assert.match(dynamicBuiltin.skill.content, /Retrieve a new copy after exposure changes/i);
      assert.match(dynamicBuiltin.skill.content, /When `lc_tool_help` is exposed/i);
      assert.match(dynamicBuiltin.skill.content, /Use `lc_ask_user` only when a missing user decision matters/i);
      assert.match(dynamicBuiltin.skill.content, /^## Skills$/m);
      assert.doesNotMatch(dynamicBuiltin.skill.content, /lc_web_research|lc_read_file|lc_run_shell|lc_tool_history/);
      assert.doesNotMatch(dynamicBuiltin.skill.content, /lc-tools-section:/);
    }

    // Unknown ID should error.
    const unknown = await skill.run({ id: 'nonexistent' }, ctx);
    assert.equal(unknown.mode, 'error');
    if (unknown.mode === 'error') {
      assert.equal(unknown.code, 'skill_unavailable');
    }
  });

  it('materializes only enabled LC Tools category sections', async () => {
    const ctx: ToolHandlerContext = {
      sandbox: undefined as unknown as ToolHandlerContext['sandbox'],
      config: {
        skillIds: ['lc:builtin:lc-tools'],
        exposedToolNames: ['lc_web_research', 'lc_skill'],
        allowedRoots: [],
        shellAllowlist: [],
        webFetchRatePerMin: 50,
        maxShellTimeoutMs: 120_000,
        maxWebFetchBytes: 32 * 1024 * 1024,
        maxWebFetchTimeoutMs: 30_000,
        searchProvider: null,
        visionModel: '',
        webResearchModel: '',
        pdfSummarizeModel: '',
        llmServerUrl: '',
        llmModel: '',
        llmApiKey: '',
        llmApiStyle: 'chat',
        llmApiVariant: 'openai',
      },
      signal: new AbortController().signal,
      identity: { groupId: 'g', operationId: 'op', modelToolCallId: 'tc', conversationId: 'conv', generationId: 'gen' },
    };

    const retrieved = await skill.run({ id: 'lc:builtin:lc-tools' }, ctx);
    assert.equal(retrieved.mode, 'skill');
    if (retrieved.mode === 'skill') {
      assert.match(retrieved.skill.content, /^## Web Access$/m);
      assert.match(retrieved.skill.content, /^## Skills$/m);
      assert.doesNotMatch(retrieved.skill.content, /^## File I\/O$/m);
      assert.doesNotMatch(retrieved.skill.content, /^## Shell$/m);
      assert.doesNotMatch(retrieved.skill.content, /^## Tool History$/m);
    }
  });

  it('returns built-in skills resolved from the registry', async () => {
    const ctx: ToolHandlerContext = {
      sandbox: undefined as unknown as ToolHandlerContext['sandbox'],
      config: {
        skillIds: ['lc:builtin:mermaid-diagram'],
        allowedRoots: [],
        shellAllowlist: [],
        webFetchRatePerMin: 50,
        maxShellTimeoutMs: 120_000,
        maxWebFetchBytes: 32 * 1024 * 1024,
        maxWebFetchTimeoutMs: 30_000,
        searchProvider: null,
        visionModel: '',
        webResearchModel: '',
        pdfSummarizeModel: '',
        llmServerUrl: '',
        llmModel: '',
        llmApiKey: '',
        llmApiStyle: 'chat',
        llmApiVariant: 'openai',
      },
      signal: new AbortController().signal,
      identity: { groupId: 'g', operationId: 'op', modelToolCallId: 'tc', conversationId: 'conv', generationId: 'gen' },
    };

    const list = await skill.run({}, ctx);
    assert.equal(list.mode, 'list');
    if (list.mode === 'list') {
      const mermaid = list.skills.find((s) => s.id === 'lc:builtin:mermaid-diagram');
      assert.ok(mermaid, 'mermaid built-in should be resolved');
      assert.equal(mermaid!.source, 'builtin');
    }

    // Retrieve the built-in.
    const retrieved = await skill.run({ id: 'lc:builtin:mermaid-diagram' }, ctx);
    assert.equal(retrieved.mode, 'skill');
    if (retrieved.mode === 'skill') {
      assert.equal(retrieved.source, 'builtin');
      assert.ok(retrieved.skill.content.length > 0, 'built-in content should not be empty');
    }
  });

  it('rejects a list above the enabled-skill count limit', async () => {
    const customSkills = Array.from({ length: SKILL_LIST_MAX_ITEMS + 1 }, (_, index) =>
      makeSkill({ id: `custom-${index}`, name: `Skill ${index}`, content: `# Skill ${index}` }));
    const exactSkills = customSkills.slice(0, SKILL_LIST_MAX_ITEMS);
    const exactOutput = await skill.run(
      {},
      skillContext(exactSkills.map((entry) => entry.id), exactSkills),
    );
    assert.equal(exactOutput.mode, 'list');
    if (exactOutput.mode === 'list') assert.equal(exactOutput.skills.length, SKILL_LIST_MAX_ITEMS);

    const ctx = skillContext(customSkills.map((entry) => entry.id), customSkills);

    const output = await skill.run({}, ctx);

    assert.deepEqual(output, {
      mode: 'error',
      code: 'skill_limit_exceeded',
      total: SKILL_LIST_MAX_ITEMS + 1,
      limit: SKILL_LIST_MAX_ITEMS,
      message: `The enabled Skills list has ${SKILL_LIST_MAX_ITEMS + 1} items. The limit is ${SKILL_LIST_MAX_ITEMS}. Ask the user to disable or delete skills in Workspace. Then retry.`,
    });
  });

  it('accepts the exact skill ID cap and rejects one character more', () => {
    assert.equal(skill.input.safeParse({ id: 'x'.repeat(SKILL_ID_MAX_CHARACTERS) }).success, true);
    const overCap = skill.input.safeParse({ id: 'x'.repeat(SKILL_ID_MAX_CHARACTERS + 1) });
    assert.equal(overCap.success, false);
    if (!overCap.success) assert.equal(overCap.error.issues[0]?.message, SKILL_ID_LIMIT_MESSAGE);
  });

  it('accepts the exact serialized result limit and rejects one byte more', async () => {
    const base = makeSkill({ id: 'boundary', name: 'Boundary', content: 'x' });
    const baseResult = { mode: 'skill', skill: { ...base, content: '' }, source: 'custom' };
    const overhead = new TextEncoder().encode(JSON.stringify(baseResult)).byteLength;
    const exact = { ...base, content: 'x'.repeat(SKILL_RESULT_MAX_BYTES - overhead) };
    const exactOutput = await skill.run(
      { id: exact.id },
      skillContext([exact.id], [exact]),
    );
    assert.equal(new TextEncoder().encode(JSON.stringify(exactOutput)).byteLength, SKILL_RESULT_MAX_BYTES);
    assert.equal(exactOutput.mode, 'skill');

    const oversized = { ...exact, content: `${exact.content}x` };
    const oversizedOutput = await skill.run(
      { id: oversized.id },
      skillContext([oversized.id], [oversized]),
    );
    assert.deepEqual(oversizedOutput, {
      mode: 'error',
      code: 'skill_result_too_large',
      limit_bytes: SKILL_RESULT_MAX_BYTES,
      message: `The lc_skill result exceeds the ${SKILL_RESULT_MAX_BYTES}-byte limit. Ask the user to shorten or remove enabled skills in Workspace. Then retry.`,
    });

    const unavailableId = 'x'.repeat(SKILL_RESULT_MAX_BYTES);
    const unavailableOutput = await skill.run(
      { id: unavailableId },
      skillContext([], []),
    );
    assert.deepEqual(unavailableOutput, {
      mode: 'error',
      code: 'skill_result_too_large',
      limit_bytes: SKILL_RESULT_MAX_BYTES,
      message: `The lc_skill result exceeds the ${SKILL_RESULT_MAX_BYTES}-byte limit. Ask the user to shorten or remove enabled skills in Workspace. Then retry.`,
    });
  });
});

function skillContext(
  skillIds: string[],
  customSkills: ReturnType<typeof makeSkill>[],
): ToolHandlerContext {
  return {
    sandbox: undefined as unknown as ToolHandlerContext['sandbox'],
    config: {
      skillIds,
      customSkills,
      allowedRoots: [],
      shellAllowlist: [],
      webFetchRatePerMin: 50,
      maxShellTimeoutMs: 120_000,
      maxWebFetchBytes: 32 * 1024 * 1024,
      maxWebFetchTimeoutMs: 30_000,
      searchProvider: null,
      visionModel: '',
      webResearchModel: '',
      pdfSummarizeModel: '',
      llmServerUrl: '',
      llmModel: '',
      llmApiKey: '',
      llmApiStyle: 'chat',
      llmApiVariant: 'openai',
    },
    signal: new AbortController().signal,
    identity: {
      groupId: 'g',
      operationId: 'op',
      modelToolCallId: 'tc',
      conversationId: 'conv',
      generationId: 'gen',
    },
  };
}
