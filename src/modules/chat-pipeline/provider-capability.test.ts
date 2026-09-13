import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NATIVE_LM_STUDIO_TOOLS_MESSAGE,
  providerSupportsToolCalling,
  resolveWorkspaceProviderPresentation,
  structuredToolPayload,
} from './provider-capability.ts';
import type { Conversation } from '../../types';

const tools = {
  enabled: true,
  file_io_enabled: true,
  shell_enabled: false,
  web_access_enabled: false,
  tool_history_enabled: true,
  skills_enabled: false,
  whiteboard_enabled: true,
  tool_grants: [],
  web_access_grants_initialized: true,
  allowed_roots: ['C:\\workspace'],
  dir_permissions: {},
  max_tool_rounds_per_turn: 32,
  max_tool_calls_per_batch: 16,
  sse_read_timeout_min: 5,
} satisfies NonNullable<Conversation['tools']>;
import { permissionPopupRequired } from './approval-control.ts';
import { validateApprovedPatchPreflight } from './patch-authorization.ts';

describe('provider tool capability', () => {
  it('keeps compatible protocols tool-capable', () => {
    assert.equal(providerSupportsToolCalling(undefined), true);
    assert.equal(providerSupportsToolCalling('openai'), true);
    assert.equal(providerSupportsToolCalling('anthropic'), true);
  });

  it('marks native LM Studio REST as not tool-capable', () => {
    assert.equal(providerSupportsToolCalling('lm-studio'), false);
    assert.deepEqual(resolveWorkspaceProviderPresentation(tools, 'lm-studio'), {
      toolCallingSupported: false,
      workspaceMasterDisabled: true,
      workspaceMasterChecked: false,
      toolsIndicatorOn: false,
      workspacePromptEnabled: false,
      expectsToolCalls: false,
      warning: NATIVE_LM_STUDIO_TOOLS_MESSAGE,
    });
    assert.equal(structuredToolPayload(tools, 'lm-studio'), undefined);
  });

  it('keeps compatible Workspace presentation and tool parsing enabled', () => {
    for (const variant of ['openai', 'anthropic'] as const) {
      const state = resolveWorkspaceProviderPresentation(tools, variant);
      assert.equal(state.workspaceMasterDisabled, false);
      assert.equal(state.workspaceMasterChecked, true);
      assert.equal(state.toolsIndicatorOn, true);
      assert.equal(state.workspacePromptEnabled, true);
      assert.equal(state.expectsToolCalls, true);
      assert.equal(state.warning, undefined);
      assert.ok(structuredToolPayload(tools, variant)?.some(
        (tool) => tool.function.name === 'lc_whiteboard',
      ));
    }
  });

  it('keeps a foundation-only Workspace tool-capable', () => {
    const foundationOnly = {
      ...tools,
      file_io_enabled: false,
      tool_history_enabled: false,
      whiteboard_enabled: false,
    };
    const state = resolveWorkspaceProviderPresentation(foundationOnly, 'openai');
    assert.equal(state.workspacePromptEnabled, true);
    assert.equal(state.expectsToolCalls, true);
    assert.deepEqual(
      structuredToolPayload(foundationOnly, 'openai')?.map((tool) => tool.function.name),
      ['lc_get_current_time', 'lc_todo_write', 'lc_ask_user'],
    );
  });
});

describe('permission popup control', () => {
  it('keeps shell approval-controlled except for the concealed override', () => {
    assert.equal(permissionPopupRequired('shell', 'always_prompt', ['git']), true);
    assert.equal(permissionPopupRequired('shell', 'always_prompt', ['*******']), false);
    assert.equal(permissionPopupRequired('file_io', 'prompt', ['*******']), true);
  });
});

describe('approved patch preflight binding', () => {
  it('accepts every discovered canonical target without broadening', () => {
    assert.deepEqual(validateApprovedPatchPreflight(
      ['C:\\outside\\a.txt', 'D:\\other\\b.txt'],
      {
        plan_id: 'plan',
        affected_paths: ['c:/outside/a.txt', 'd:/other/b.txt'],
        actions: [],
        diagnostics: [],
      },
    ), { ok: true, planId: 'plan' });
  });

  it('rejects a broadened, missing, or diagnostic preflight plan', () => {
    const changed = validateApprovedPatchPreflight(['C:\\outside\\a.txt'], {
      plan_id: 'plan', affected_paths: ['C:\\outside'], actions: [], diagnostics: [],
    });
    assert.equal(changed.ok, false);
    const diagnostic = validateApprovedPatchPreflight(['C:\\outside\\a.txt'], {
      plan_id: '', affected_paths: ['C:\\outside\\a.txt'], actions: [], diagnostics: ['bad hunk'],
    });
    assert.equal(diagnostic.ok, false);
  });
});
