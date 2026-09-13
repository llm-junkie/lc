/** Provider-level capabilities that must be resolved before prompt/request assembly. */
import type { Conversation } from '../../types';
import type { ToolDefinition } from '../llm-client/types';
import { materialize, resolveExposure } from '../tool-engine/index.ts';

export function providerSupportsToolCalling(apiVariant: string | undefined): boolean {
  return (apiVariant ?? 'openai') !== 'lm-studio';
}

export function workspaceToolPromptEnabled(
  tools: Conversation['tools'] | undefined,
  apiVariant: string | undefined,
): boolean {
  return providerSupportsToolCalling(apiVariant)
    && resolveExposure(tools ?? {}).exposedNames.size > 0;
}

export const NATIVE_LM_STUDIO_TOOLS_MESSAGE =
  "LM Studio's native REST API endpoint does not support workspace tools. Use OpenAI-compatible or Anthropic-compatible to enable workspace.";

export interface WorkspaceProviderPresentation {
  toolCallingSupported: boolean;
  workspaceMasterDisabled: boolean;
  workspaceMasterChecked: boolean;
  toolsIndicatorOn: boolean;
  workspacePromptEnabled: boolean;
  expectsToolCalls: boolean;
  warning?: string;
}

/** One provider decision shared by request construction and Workspace UI state. */
export function resolveWorkspaceProviderPresentation(
  tools: Conversation['tools'] | undefined,
  apiVariant: string | undefined,
): WorkspaceProviderPresentation {
  const toolCallingSupported = providerSupportsToolCalling(apiVariant);
  const workspacePromptEnabled = workspaceToolPromptEnabled(tools, apiVariant);
  return {
    toolCallingSupported,
    workspaceMasterDisabled: !toolCallingSupported,
    workspaceMasterChecked: toolCallingSupported && Boolean(tools?.enabled),
    toolsIndicatorOn: toolCallingSupported && Boolean(tools?.enabled),
    workspacePromptEnabled,
    expectsToolCalls: workspacePromptEnabled,
    ...(toolCallingSupported ? {} : { warning: NATIVE_LM_STUDIO_TOOLS_MESSAGE }),
  };
}

/** Resolve the single structured payload for tool-capable provider adapters. */
export function structuredToolPayload(
  tools: Conversation['tools'] | undefined,
  apiVariant: string | undefined,
): ToolDefinition[] | undefined {
  if (!providerSupportsToolCalling(apiVariant) || !tools?.enabled) return undefined;
  const handlers = [...resolveExposure(tools).exposedHandlers];
  return handlers.length > 0 ? materialize(handlers) : undefined;
}
