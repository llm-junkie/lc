import type { JsonSchema } from '../../llm-client/types';
import {
  ASK_USER_INPUT_SCHEMA,
  ASK_USER_TOOL_NAME,
  type AskUserInput,
  type AskUserOutput,
} from '../ask-user.ts';
import {
  abortedEnvelope,
  errorEnvelope,
  type ToolHandler,
  type ToolResultEnvelope,
} from '../types.ts';

const CACHED_SCHEMA = Object.freeze(ASK_USER_INPUT_SCHEMA.toJSONSchema()) as unknown as JsonSchema;

export const ASK_USER_ISSUES = Object.freeze({
  unavailable: {
    code: 'ask_user_ui_unavailable',
    message: 'LC could not open the user question window.',
    retryable: true,
    remedy: 'Retry after the LC window is ready.',
  },
  busy: {
    code: 'ask_user_ui_busy',
    message: 'Another conversation has an open user question.',
    retryable: false,
    remedy: 'End this tool round and wait for the open question.',
  },
});

export const askUser: ToolHandler<AskUserInput, ToolResultEnvelope<AskUserOutput>> = {
  name: ASK_USER_TOOL_NAME,
  description:
    'Ask the user when a missing choice can materially change the work.\n' +
    'Send from 1 through 3 questions.\n' +
    'Each question must have from 2 through 5 single-select choices.\n' +
    'The user can select one choice, enter a custom answer, or skip.\n' +
    'Call lc_ask_user alone in a tool-call batch.\n' +
    'Wait for its result before you continue.',
  uiDescription: 'Ask the user a small set of structured questions.',
  input: ASK_USER_INPUT_SCHEMA,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (input, context) => {
    if (!context.askUser) return errorEnvelope([{ ...ASK_USER_ISSUES.unavailable }], 0);
    const result = await context.askUser(input);
    if (result.decision === 'submitted') {
      return {
        status: 'ok',
        data: result.data,
        issues: [],
        warnings: [],
      };
    }
    if (result.decision === 'aborted') return abortedEnvelope(0);
    const issue = result.decision === 'busy' ? ASK_USER_ISSUES.busy : ASK_USER_ISSUES.unavailable;
    return errorEnvelope([{ ...issue }], 0);
  },
};
