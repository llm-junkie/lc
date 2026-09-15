// Copyright 2026 LC Contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/** Mechanical tool-surface probes. Run with: npx tsx scripts/check-tool-surface.ts */
import assert from 'node:assert/strict';
import { encode } from 'gpt-tokenizer';
import { BUILTIN_TOOLS, HANDLERS_BY_NAME, materialize } from '../src/modules/tool-engine/registry.ts';
import { validateToolCalls } from '../src/modules/tool-engine/runner.ts';
import { buildPromptText } from '../src/modules/chat-pipeline/system-prompt.ts';
import { OpenAIAdapter } from '../src/modules/llm-client/adapters/openai.ts';
import { OpenAIResponsesAdapter } from '../src/modules/llm-client/adapters/openai-responses.ts';
import { AnthropicAdapter } from '../src/modules/llm-client/adapters/anthropic.ts';
import { GeminiRestAdapter } from '../src/modules/llm-client/adapters/gemini-rest.ts';

const samples: Record<string, Record<string, unknown>[]> = {
  lc_read_image: [{ paths: ['C:/work/image.png'] }],
  lc_read_pdf: [{ paths: ['C:/work/document.pdf'] }],
  lc_read_file: [{ paths: ['C:/work/file.txt'] }],
  lc_write_file: [{ files: [{ path: 'C:/work/file.txt', content: '' }] }],
  lc_list_dir: [{ paths: ['C:/work'] }],
  lc_web_fetch: [{ url: 'https://example.com' }],
  lc_get_current_time: [{}],
  lc_run_shell: [{ cmd: 'echo' }],
  lc_todo_write: [{ todos: [{ id: 1, title: 'Inspect', status: 'completed' }] }],
  lc_ask_user: [{ questions: [{ id: 1, question: 'Choose a format.', choices: [{ title: 'Text' }, { title: 'JSON' }] }] }],
  lc_whiteboard: [{ action: 'read' }, { action: 'replace', content: 'text' }, { action: 'edit', old_string: 'text', new_string: 'new' }],
  lc_grep: [{ searches: [{ path: 'C:/work', pattern: 'needle' }] }],
  lc_edit_file: [{ path: 'C:/work/file.txt', old_string: 'old', new_string: '' }, { files: [{ path: 'C:/work/file.txt', old_string: 'old', new_string: '' }] }],
  lc_web_search: [{ query: 'fixture' }],
  lc_web_research: [{ query: 'fixture' }],
  lc_stat: [{ paths: ['C:/work/file.txt'] }],
  lc_glob_files: [{ root: 'C:/work', pattern: '**/*.txt' }],
  lc_apply_patch: [{ patch: '*** Begin Patch\n*** Add File: C:/work/new.txt\n+new\n*** End Patch' }],
  lc_tool_help: [{ tool: 'lc_read_file' }],
  lc_tool_history: [{}],
  lc_skill: [{}],
};
type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema };
function optionalPaths(schema: Schema, sample: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  if (schema.type === 'array' && Array.isArray(sample)) return sample.flatMap((item, i) => optionalPaths(schema.items ?? {}, item, [...prefix, i]));
  if (!schema.properties || !sample || typeof sample !== 'object') return [];
  return Object.entries(schema.properties).flatMap(([key, child]) => [
    ...(schema.required?.includes(key) ? [] : [[...prefix, key]]),
    ...optionalPaths(child, (sample as Record<string, unknown>)[key], [...prefix, key]),
  ]);
}
function set(value: Record<string, unknown>, path: (string | number)[], replacement: unknown): void {
  let parent: unknown = value;
  for (const key of path.slice(0, -1)) parent = (parent as Record<string | number, unknown>)[key];
  const target = parent as Record<string | number, unknown>;
  if (replacement === undefined) delete target[path.at(-1)!];
  else target[path.at(-1)!] = replacement;
}
function validate(name: string, args: unknown) {
  return validateToolCalls([{ id: 'probe', name, arguments: JSON.stringify(args), created_at: 0 }], HANDLERS_BY_NAME)[0];
}
assert.deepEqual(BUILTIN_TOOLS.map((tool) => tool.name), Object.keys(samples));
assert.equal(validate('lc_read_file', { paths: ['C:/work/file.txt'] }).error, undefined);
assert.equal(validate('lc_read_file', { paths: [] }).error?.[0].code, 'invalid_arguments');
const absence: { tool: string; form: number; field: string; cases: number; failures: unknown[] }[] = [];
const noEffect: { tool: string; field: string; value: unknown }[] = [];
for (const tool of BUILTIN_TOOLS) {
  assert.equal(validate(tool.name, 42).error?.[0].code, 'invalid_arguments');
  for (const [form, sample] of samples[tool.name].entries()) {
    assert.equal(validate(tool.name, sample).error, undefined, `${tool.name} form ${form}`);
    const schema = tool.toJsonSchema() as Schema;
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (property.type === 'array' && Object.hasOwn(sample, key)) {
        assert.equal(validate(tool.name, { ...sample, [key]: [] }).error?.[0].code, 'invalid_arguments', `${tool.name}.${key} empty batch`);
      }
      if (!schema.required?.includes(key) && (
        property.type === 'boolean' || key === 'args' || key === 'preferred_domains' || key === 'env' || key === 'context_lines'
      )) {
        const value = property.type === 'boolean' ? false : key === 'context_lines' ? 0 : key === 'env' ? {} : [];
        const result = validate(tool.name, { ...sample, [key]: value });
        assert.equal(result.error, undefined);
        assert.deepEqual((result.parsed as Record<string, unknown>)[key], value);
        noEffect.push({ tool: tool.name, field: key, value });
      }
    }
    for (const path of optionalPaths(tool.toJsonSchema() as Schema, sample)) {
      // Action-selected fields are conditionally required. Dedicated fixtures test their empty-content contract.
      if (path.length === 1 && Object.hasOwn(sample, path[0]) && (
        tool.name === 'lc_whiteboard' || tool.name === 'lc_edit_file'
      )) continue;
      const baseline = structuredClone(sample);
      set(baseline, path, undefined);
      const expected = validate(tool.name, baseline);
      const failures: unknown[] = [];
      for (const filler of [undefined, null, '', ' \t\n']) {
        const input = structuredClone(sample);
        set(input, path, filler);
        const result = validate(tool.name, input);
        const stdin = tool.name === 'lc_run_shell' && path.join('.') === 'stdin' && typeof filler === 'string';
        try {
          assert.equal(result.error, undefined);
          assert.deepEqual(result.parsed, stdin ? { ...expected.parsed as object, stdin: filler } : expected.parsed);
        } catch { failures.push({ filler: filler ?? 'absent', result }); }
      }
      absence.push({ tool: tool.name, form, field: path.join('.'), cases: 4, failures });
    }
  }
}
const definitions = materialize(BUILTIN_TOOLS);
const config = {
  enabled: true, file_io_enabled: true, shell_enabled: true, web_access_enabled: true,
  tool_grants: [], web_access_grants_initialized: true, tool_history_enabled: true,
  skills_enabled: true, whiteboard_enabled: true, enabled_skill_ids: ['lc:builtin:lc-tools'],
  allowed_roots: ['C:/workspace', 'D:/outside'], dir_permissions: {},
  shell_allowlist: 'cmd,dir,findstr,tasklist', max_tool_calls_per_batch: 4,
  max_tool_rounds_per_turn: 32, sse_read_timeout_min: 5,
};
const prompt = buildPromptText({ tools: config, params: { system_prompt: '' } }, 'C:/Users/name', 'Windows');
const params = { model: 'fixture-model', stream: true, reasoningEnabled: false,
  messages: [{ role: 'system' as const, content: prompt }, { role: 'user' as const, content: 'fixture' }], tools: definitions };
const counts = (value: unknown) => {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return { bytes: Buffer.byteLength(serialized), tokens: encode(serialized).length };
};
const wire = [];
for (const [name, adapter] of [
  ['chat', new OpenAIAdapter()], ['responses', new OpenAIResponsesAdapter()],
  ['messages', new AnthropicAdapter()], ['interactions', new GeminiRestAdapter('https://generativelanguage.googleapis.com/v1beta')],
] as const) {
  const request = adapter.buildRequest(params);
  type WireTool = { function?: { name: string; description: string; parameters: unknown }; name?: string; description?: string; parameters?: unknown; input_schema?: unknown };
  const wireTools = (request as unknown as { tools: WireTool[] }).tools;
  const roundtrip = wireTools.map((tool) => ({
    name: tool.function?.name ?? tool.name,
    description: tool.function?.description ?? tool.description,
    parameters: tool.function?.parameters ?? tool.parameters ?? tool.input_schema,
  }));
  assert.deepEqual(roundtrip, definitions.map((tool) => tool.function), `${name} preserves all definitions`);
  assert.throws(() => assert.deepEqual(roundtrip.slice(1), definitions.map((tool) => tool.function)), 'missing definition control');
  wire.push({ envelope: name, tools: counts(wireTools), fullRequest: counts(request) });
}
console.log(JSON.stringify({ runtime: process.version, tokenizer: 'gpt-tokenizer', toolCount: definitions.length,
  optionalFields: absence.length, optionalCases: absence.length * 4, absence, noEffect,
  canonical: counts(definitions), schemas: counts(definitions.map((tool) => tool.function.parameters)),
  systemPrompt: counts(prompt), fixedSurface: counts(`${prompt}\n${JSON.stringify(definitions)}`), wire }, null, 2));
assert.equal(absence.flatMap((row) => row.failures).length, 0);
