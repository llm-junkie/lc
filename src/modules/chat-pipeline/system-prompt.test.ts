import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WHITEBOARD_SYSTEM_PROMPT_RULES, buildPromptText, buildShellSection, selectSystemPromptText } from './system-prompt.ts';
import {
  NATIVE_LM_STUDIO_TOOLS_MESSAGE,
  structuredToolPayload,
  workspaceToolPromptEnabled,
} from './provider-capability.ts';
import { LMStudioRestAdapter } from '../llm-client/adapters/lmstudio-rest.ts';
import { OpenAIAdapter } from '../llm-client/adapters/openai.ts';
import { OpenAIResponsesAdapter } from '../llm-client/adapters/openai-responses.ts';
import { AnthropicAdapter } from '../llm-client/adapters/anthropic.ts';
import { HANDLERS_BY_NAME, materialize } from '../tool-engine/registry.ts';
import { ToolCallAccumulator } from '../llm-client/tool-accumulator.ts';
import type { ToolDefinition } from '../llm-client/types';
import type { Conversation } from '../../types';
import { WHITEBOARD_MODEL_VISIBLE_TEXT_FIXTURE } from '../../whiteboard/contract-fixtures.ts';

const tools = {
  enabled: true,
  file_io_enabled: true,
  shell_enabled: true,
  web_access_enabled: true,
  tool_grants: [],
  web_access_grants_initialized: true,
  tool_history_enabled: true,
  skills_enabled: true,
  enabled_skill_ids: ['lc:builtin:lc-tools'],
  allowed_roots: ['c:/workspace', 'd:/outside'],
  dir_permissions: {},
  shell_allowlist: 'cmd,dir,findstr,tasklist',
  max_tool_calls_per_batch: 4,
  max_tool_rounds_per_turn: 32,
  sse_read_timeout_min: 5,
} satisfies NonNullable<Conversation['tools']>;

describe('system prompt contract', () => {
  it('orders policy sections, omits serialized schemas, and labels custom instructions last', () => {
    const prompt = buildPromptText({
      tools,
      params: { system_prompt: 'CUSTOM SENTINEL' },
    }, 'c:/Users/name', 'Windows');

    const ordered = [
      '[Environment]', '[Authorization]', '[Tool usage]', '[Tool limits]',
      '[Paths on Windows]', '[Shell capability]', '[Skills]',
      '[Custom system instructions]',
    ].map((section) => prompt.indexOf(section));
    assert.ok(ordered.every((index) => index >= 0));
    assert.deepEqual(ordered, [...ordered].sort((a, b) => a - b));
    assert.ok(prompt.endsWith('[Custom system instructions]\nCUSTOM SENTINEL'));
    assert.doesNotMatch(prompt, /"parameters"\s*:/);
    assert.doesNotMatch(prompt, /"type"\s*:\s*"function"/);
    assert.ok(prompt.includes('Home directory: C:\\Users\\name'));
    assert.ok(prompt.includes('Configured file roots: C:\\workspace, D:\\outside'));
    assert.match(prompt, /outside the configured roots/);
    assert.match(prompt, /lc_run_shell\.cwd uses a different authorization rule/);
    assert.match(prompt, /Use standard Windows backslashes/);
    assert.ok(prompt.includes('Escape each backslash as \\\\ in JSON.'));
    assert.ok(prompt.includes('Example: C:\\\\Users\\\\name\\\\file.txt.'));
    assert.match(prompt, /A batch can contain at most 4 tool calls\./);
    assert.match(prompt, /LC runs accepted calls concurrently\./);
    assert.match(prompt, /Batch only independent file calls\./);
    assert.match(prompt, /Wait for each result before the next dependent file call\./);
    assert.match(prompt, /LC rejects an oversized batch without execution and ends the response\./);
    assert.match(prompt, /A turn can contain at most 32 tool-call rounds\./);
    assert.match(prompt, /lc_ask_user pauses and returns user input for this turn\./);
    assert.match(prompt, /LC does not control user-provided skills\./i);
    assert.match(prompt, /These skills can mention unavailable tools\./i);
    assert.match(prompt, /Use only currently exposed tools\./i);
    assert.match(
      prompt,
      /Use lc_skill with lc:builtin:lc-tools for cross-tool choices and workflows\. Use lc_tool_help for detailed guidance about one tool\./,
    );
  });

  it('emits only guidance for enabled File I/O and Shell categories', () => {
    const promptFor = (file_io_enabled: boolean, shell_enabled: boolean) => buildPromptText({
      tools: { ...tools, file_io_enabled, shell_enabled, web_access_enabled: false, tool_history_enabled: false, skills_enabled: false },
      params: { system_prompt: '' },
    }, 'C:\\Users\\name', 'Windows');

    const fileOnly = promptFor(true, false);
    assert.ok(fileOnly.includes('Configured file roots: C:\\workspace, D:\\outside'));
    assert.match(fileOnly, /exact canonical scope/);
    assert.match(fileOnly, /Use lc_tool_help for detailed guidance about one tool/);
    assert.match(fileOnly, /Batch only independent file calls\./);
    assert.match(fileOnly, /Wait for each result before the next dependent file call\./);
    assert.doesNotMatch(fileOnly, /lc_run_shell\.cwd/);
    assert.doesNotMatch(fileOnly, /\[Shell capability\]/);

    const shellOnly = promptFor(false, true);
    assert.ok(shellOnly.includes('Configured file roots: C:\\workspace, D:\\outside'));
    assert.match(shellOnly, /lc_run_shell\.cwd/);
    assert.match(shellOnly, /first configured root/);
    assert.doesNotMatch(shellOnly, /independent file calls|dependent file call/);
    assert.doesNotMatch(shellOnly, /exact canonical scope/);
    assert.doesNotMatch(shellOnly, /Home directory:/);

    const both = promptFor(true, true);
    assert.match(both, /exact canonical scope/);
    assert.match(both, /lc_run_shell\.cwd/);
    assert.match(both, /Wait for each result before the next dependent file call\./);

    const neither = promptFor(false, false);
    assert.doesNotMatch(neither, /Configured file roots:/);
    assert.doesNotMatch(neither, /\[Authorization\]/);
    assert.match(neither, /\[Tool usage\]/);
    assert.match(neither, /\[Tool limits\]/);
    assert.doesNotMatch(neither, /lc_tool_help/);
    assert.doesNotMatch(neither, /\[Shell capability\]/);
  });

  it('keeps a Skills-only prompt within the exposure boundary', () => {
    const prompt = buildPromptText({
      tools: {
        ...tools,
        file_io_enabled: false,
        shell_enabled: false,
        web_access_enabled: false,
        tool_history_enabled: false,
        skills_enabled: true,
      },
      params: { system_prompt: '' },
    }, 'C:\\Users\\name', 'Windows');

    assert.match(prompt, /\[Skills\]/);
    assert.match(prompt, /LC does not control user-provided skills\./i);
    assert.match(prompt, /These skills can mention unavailable tools\./i);
    assert.match(prompt, /Use only currently exposed tools\./i);
    assert.match(prompt, /retrieve lc:builtin:lc-tools with lc_skill/i);
    assert.match(prompt, /Do not reuse an older result.*because Workspace exposure may have changed\./i);
    assert.doesNotMatch(prompt, /Configured file roots:/);
    assert.doesNotMatch(prompt, /lc_run_shell/);
    assert.doesNotMatch(prompt, /lc_tool_history/);
    assert.doesNotMatch(prompt, /lc_tool_help/);
  });

  it('does not request LC Tools refreshes when that skill is unavailable', () => {
    const prompt = buildPromptText({
      tools: { ...tools, enabled_skill_ids: [] },
      params: { system_prompt: '' },
    }, 'C:\\Users\\name', 'Windows');

    assert.match(prompt, /\[Skills\]/);
    assert.doesNotMatch(prompt, /live cheat sheet/i);
    assert.doesNotMatch(prompt, /retrieve lc:builtin:lc-tools/i);
  });

  it('selects custom-only content when Workspace policy is provider-disabled', () => {
    const conv = { tools, params: { system_prompt: '  custom only  ' } };
    assert.equal(selectSystemPromptText(conv, false, 'C:\\Users\\name', 'Windows'), 'custom only');
    assert.match(selectSystemPromptText(conv, true, 'C:\\Users\\name', 'Windows'), /\[Environment\]/);
  });

  it('emits ask-user provenance only while the foundation tool is exposed', () => {
    const enabled = buildPromptText({
      tools: { ...tools, file_io_enabled: false, shell_enabled: false, web_access_enabled: false },
      params: { system_prompt: '' },
    }, 'C:\\Users\\name', 'Windows');
    assert.match(enabled, /lc_ask_user pauses and returns user input for this turn/);

    const disabled = buildPromptText({
      tools: { ...tools, enabled: false },
      params: { system_prompt: '' },
    }, 'C:\\Users\\name', 'Windows');
    assert.doesNotMatch(disabled, /lc_ask_user|returns user input for this turn/);
  });

  it('emits the three exact Whiteboard rules only while the tool is exposed', () => {
    assert.deepEqual(WHITEBOARD_SYSTEM_PROMPT_RULES, WHITEBOARD_MODEL_VISIBLE_TEXT_FIXTURE.systemPrompt);
    const enabled = buildPromptText({
      tools: {
        ...tools,
        file_io_enabled: false,
        shell_enabled: false,
        web_access_enabled: false,
        tool_history_enabled: false,
        skills_enabled: false,
        whiteboard_enabled: true,
      },
      params: { system_prompt: '' },
    }, 'C:\\Users\\name', 'Windows');
    const section = `[Whiteboard]\n${WHITEBOARD_SYSTEM_PROMPT_RULES.join('\n')}`;
    assert.match(enabled, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const disabled = buildPromptText({
      tools: { ...tools, whiteboard_enabled: false },
      params: { system_prompt: '' },
    }, 'C:\\Users\\name', 'Windows');
    assert.doesNotMatch(disabled, /\[Whiteboard\]|lc_whiteboard|user board is fixed/i);
  });

  it('derives Windows executable/builtin guidance from the effective list', () => {
    const guidance = buildShellSection(['cmd', 'dir', 'findstr', 'tasklist'], true);
    assert.match(guidance, /Executable names invoked directly: cmd, findstr, tasklist/);
    assert.match(guidance, /builtin names: dir/);
    assert.match(guidance, /LC has no `cmd` executable\./);
    assert.match(guidance, /Windows built-ins, `cmd` starts native `cmd\.exe` with `\/c`/);
    assert.doesNotMatch(guidance, /builtin names:.*findstr/);

    const unrestricted = buildShellSection(['*******'], true);
    assert.match(unrestricted, /canonical executable-plus-args form/);
    assert.match(unrestricted, /LC has no `cmd` executable\./);
    assert.match(unrestricted, /Windows built-ins, `cmd` starts native `cmd\.exe` with `\/c`/);
    assert.match(unrestricted, /"cmd":"cmd"/);
    assert.doesNotMatch(unrestricted, /\*\*\*\*\*/);
  });
});

describe('provider tool payload contract', () => {
  it('sends one structured definition payload to compatible protocols', () => {
    const openaiPayload = structuredToolPayload(tools, 'openai');
    const anthropicPayload = structuredToolPayload(tools, 'anthropic');
    assert.ok(openaiPayload && anthropicPayload);
    assert.equal(new Set(openaiPayload.map((tool) => tool.function.name)).size, openaiPayload.length);
    assert.equal(new Set(anthropicPayload.map((tool) => tool.function.name)).size, anthropicPayload.length);

    const requestBase = {
      model: 'compatible-model',
      messages: [{ role: 'user' as const, content: 'hello' }],
      stream: true,
      reasoningEnabled: false,
    };
    const openaiWire = new OpenAIAdapter().buildRequest({ ...requestBase, tools: openaiPayload });
    const responsesWire = new OpenAIResponsesAdapter().buildRequest({ ...requestBase, tools: openaiPayload });
    const anthropicWire = new AnthropicAdapter().buildRequest({ ...requestBase, tools: anthropicPayload });
    assert.equal(openaiWire.tools?.length, openaiPayload.length);
    assert.equal(responsesWire.tools?.length, openaiPayload.length);
    assert.equal(anthropicWire.tools?.length, anthropicPayload.length);

    for (let index = 0; index < openaiPayload.length; index++) {
      const source: ToolDefinition['function'] = openaiPayload[index].function;
      assert.deepEqual(openaiWire.tools?.[index], openaiPayload[index]);
      assert.deepEqual(responsesWire.tools?.[index], {
        type: 'function', name: source.name, description: source.description, parameters: source.parameters,
      });
      assert.deepEqual(anthropicWire.tools?.[index], {
        name: source.name, description: source.description, input_schema: source.parameters,
      });
    }
  });

  it('gates all native LM Studio tool instructions and definitions', () => {
    assert.equal(workspaceToolPromptEnabled(tools, 'lm-studio'), false);
    assert.equal(structuredToolPayload(tools, 'lm-studio'), undefined);
    assert.match(NATIVE_LM_STUDIO_TOOLS_MESSAGE, /OpenAI-compatible or Anthropic-compatible/);

    const wire = new LMStudioRestAdapter().buildRequest({
      model: 'local',
      messages: [{ role: 'system', content: 'custom only' }, { role: 'user', content: 'hello' }],
      stream: true,
      tools: structuredToolPayload(tools, 'lm-studio'),
      reasoningEnabled: false,
    });
    assert.equal(wire.system_prompt, 'custom only');
    assert.deepEqual(wire.input, [{ type: 'text', content: 'hello' }]);
    assert.equal('tools' in wire, false);
  });

  it('continues native LM Studio state instead of replaying an OpenAI transcript', () => {
    const wire = new LMStudioRestAdapter().buildRequest({
      model: 'local',
      messages: [
        { role: 'system', content: 'first-turn system' },
        { role: 'user', content: 'old input' },
        { role: 'assistant', content: 'old output', lmstudio_response_id: 'resp_old' },
        { role: 'user', content: 'new input' },
      ],
      stream: true,
      reasoningEnabled: false,
    });
    assert.equal(wire.previous_response_id, 'resp_old');
    assert.equal(wire.system_prompt, undefined, 'stored state already contains the system prompt');
    assert.deepEqual(wire.input, [{ type: 'text', content: 'new input' }]);
  });

  it('adopts the input item type a native server names in its rejection', () => {
    const adapter = new LMStudioRestAdapter();
    const request = {
      model: 'local',
      messages: [{ role: 'user' as const, content: 'hello' }],
      stream: true,
      reasoningEnabled: false,
    };
    // Shipped LM Studio builds accept 'text'; the documented value is
    // 'message'. The default is what a released server takes.
    assert.deepEqual(adapter.buildRequest(request).input, [{ type: 'text', content: 'hello' }]);

    adapter.useTextItemType('message');
    assert.deepEqual(adapter.buildRequest(request).input, [{ type: 'message', content: 'hello' }]);
  });

  it('captures the native response_id from a CRLF-framed chat.end event', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'event: message.delta\r\ndata: {"content":"hi"}\r\n\r\n' +
          'event: chat.end\r\ndata: {"result":{"response_id":"resp_new"}}\r\n\r\n',
        ));
        controller.close();
      },
    });
    const result = await new LMStudioRestAdapter().parseStream(
      body,
      { onDelta: () => {} },
      1000,
      new ToolCallAccumulator(),
    );
    assert.equal(result.content, 'hi');
    assert.equal(result.lmstudio_response_id, 'resp_new');
    assert.equal(result.finish_reason, 'stop');
  });
});

describe('materialized tool-description contracts', () => {
  const description = (name: string): string => {
    const value = HANDLERS_BY_NAME.get(name)?.description;
    assert.ok(value);
    return typeof value === 'function' ? value() : value;
  };

  it('documents file, image, history, shell, patch, list, and research behavior', () => {
    assert.match(description('lc_read_file'), /default output cap is 1 MiB/i);
    assert.match(description('lc_read_file'), /fails without a partial body/i);

    const image = description('lc_read_image');
    for (const claim of ['20 paths', 'first 10 paths', '10 MiB', '50 MiB', '100 megapixels', '16,384']) {
      assert.ok(image.includes(claim), `missing image claim: ${claim}`);
    }
    assert.match(image, /before downscaling/i);
    assert.match(image, /time-limited/i);

    const history = description('lc_tool_history');
    assert.match(history, /tool_name alone filters this list/i);
    assert.match(history, /If message_id is provided/);
    assert.match(history, /If tool_call_id is provided/);

    const shell = description('lc_run_shell');
    assert.match(shell, /approval-controlled/i);
    assert.match(shell, /first allowed root[\s\S]*system temporary directory/i);
    assert.match(shell, /secret-shaped/i);
    assert.doesNotMatch(shell, /Always prompts/i);
    assert.doesNotMatch(shell, /\*\*\*\*\*/);

    const patch = description('lc_apply_patch');
    assert.match(patch, /1 MiB per patch/);
    assert.match(patch, /32 MiB per target file/);
    assert.match(patch, /64 MiB across the prepared plan/);

    const list = description('lc_list_dir');
    assert.match(list, /no fixed skip list from lc_grep or lc_glob_files/i);
    assert.match(list, /node_modules, dist, and vendor/);

    const research = description('lc_web_research');
    assert.match(research, /preferred_domains/);
    assert.doesNotMatch(research, /heuristically infer/i);
    // The description is provider-aware (see search-provider.ts), so it must
    // not hardcode a backend. With nothing configured — the state in this
    // test environment — it has to say so rather than name one.
    assert.doesNotMatch(research, /Brave/i, 'description must not assume a provider');
    assert.match(research, /No search provider is currently configured/i);
    assert.doesNotMatch(description('lc_todo_write'), /demonstrate thoroughness/i);

    assert.match(description('lc_read_pdf'), /first 4 paths/i);
    assert.match(description('lc_todo_write'), /from 1 through 20 todos/i);
    assert.match(description('lc_ask_user'), /Call lc_ask_user alone in a tool-call batch/i);
    assert.match(description('lc_ask_user'), /Wait for its result before you continue/i);
  });

  it('keeps cached parameter schemas aligned with the descriptions', () => {
    const globSchema = HANDLERS_BY_NAME.get('lc_glob_files')!.toJsonSchema();
    const globRoot = globSchema.properties.root as { description: string };
    assert.doesNotMatch(globRoot.description, /allowed root/i);
    const patchSchema = HANDLERS_BY_NAME.get('lc_apply_patch')!.toJsonSchema();
    const patchProperty = patchSchema.properties.patch as { maxLength: number; description: string };
    assert.equal(patchProperty.maxLength, 1_048_576);
    assert.equal(patchProperty.description, 'Start with *** Begin Patch. End with *** End Patch.');
  });

  it('sends no anyOf/allOf anywhere in the materialized wire payload', () => {
    const serialized = JSON.stringify(materialize([...HANDLERS_BY_NAME.values()]));
    assert.doesNotMatch(serialized, /anyOf|allOf/,
      'strict OpenAI-compat backends reject these keywords');
    const search = HANDLERS_BY_NAME.get('lc_web_search')!.toJsonSchema();
    assert.equal((search.properties.freshness as { type?: unknown }).type, 'string');
    const research = HANDLERS_BY_NAME.get('lc_web_research')!.toJsonSchema();
    assert.equal((research.properties.freshness as { type?: unknown }).type, 'string');
  });

  it('keeps every cached wire schema semantically aligned with its Zod validator', () => {
    // Structural equality fails on key ordering and zod metadata, so compare
    // a normalized projection: strip $schema/description, treat
    // exclusiveMinimum:0 as minimum:1, drop MAX_SAFE_INTEGER ceilings.
    const normalize = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(normalize);
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
          if (key === '$schema' || key === 'description') continue;
          if (key === 'exclusiveMinimum' && value === 0) {
            out.minimum = 1;
            continue;
          }
          if (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) continue;
          out[key] = normalize(value);
        }
        return out;
      }
      return v;
    };
    for (const handler of HANDLERS_BY_NAME.values()) {
      const derived = normalize(handler.input.toJSONSchema());
      const cached = normalize(handler.toJsonSchema());
      assert.deepEqual(derived, cached,
        `${handler.name} cached wire schema drifted from its Zod validator`);
    }
  });
});
