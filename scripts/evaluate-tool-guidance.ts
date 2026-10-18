/** Run with: npx tsx scripts/evaluate-tool-guidance.ts --config <path> --output <new directory> */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { LLMClient } from '../src/modules/llm-client/client.ts';
import { HANDLERS_BY_NAME } from '../src/modules/tool-engine/registry.ts';
import { validateToolCalls } from '../src/modules/tool-engine/runner.ts';
import { createToolHelpGovernorState, governToolHelpCalls } from '../src/modules/tool-engine/tool-help-governor.ts';
import { formatToolBatchLimitMessage } from '../src/modules/chat-pipeline/tool-batch-limit.ts';
import {
  EVALUATION_TASKS, MUTATION_TOOLS, countEvaluationTokens, evaluationConfigSchema,
  evaluationDefinitions, evaluationMessages, fixtureResult, type Surface,
} from './tool-guidance-evaluation.ts';
import type { ToolHelpData } from '../src/modules/tool-engine/tool-help.ts';
import type { ToolResultEnvelope } from '../src/modules/tool-engine/types.ts';
import type { NormalizedUsage } from '../src/modules/llm-client/cache-usage.ts';

const { values } = parseArgs({ options: {
  config: { type: 'string' }, output: { type: 'string' }, prepare: { type: 'boolean', default: false },
  tasks: { type: 'string' },
} });
if (!values.config || !values.output) throw new Error('Specify --config <JSON file> and --output <new directory>. Use --prepare for an offline preview.');
const config = evaluationConfigSchema.parse(JSON.parse(fs.readFileSync(values.config, 'utf8')));
const requestedTasks = values.tasks?.split(',');
if (requestedTasks?.some((id) => !EVALUATION_TASKS.some((task) => task.id === id))) throw new Error('Unknown task ID.');
const tasks = EVALUATION_TASKS.filter((task) => !requestedTasks || requestedTasks.includes(task.id));
// Secrets stay in this process. Only source locations appear in saved metadata.
const keys = new Map<string, string>();
if (!values.prepare) {
  for (const profile of config.profiles) {
    const key = profile.apiKeyFile
      ? fs.readFileSync(profile.apiKeyFile, 'utf8').split(/\r?\n/, 1)[0].trim()
      : profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : '';
    if ((profile.apiKeyFile || profile.apiKeyEnv) && !key) throw new Error(`Missing credential for ${profile.role}.`);
    keys.set(profile.role, key ?? '');
  }
}
const output = path.resolve(values.output);
const redact = (value: string): string => {
  for (const key of keys.values()) if (key) value = value.replaceAll(key, '[redacted]');
  return value;
};
// Never overwrite an earlier run or its review.
fs.mkdirSync(output, { recursive: false });
const surfaces = Object.fromEntries([false, true].map((history) => [String(history), {
  untiered: evaluationDefinitions('untiered', history), tiered: evaluationDefinitions('tiered', history),
}]));
const inputs = { tasks, surfaces, messages: Object.fromEntries(tasks.map((task) => [
  task.id, { historyOff: evaluationMessages(task, false), historyOn: evaluationMessages(task, true) },
])) };
const serializedInputs = JSON.stringify(inputs, null, 2);
fs.writeFileSync(path.join(output, 'inputs.json'), serializedInputs);
const sourceHash = createHash('sha256').update(serializedInputs).digest('hex');
const metadata = {
  startedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  sourceHash, config, plannedRuns: config.profiles.length * 4 * tasks.length * config.repetitions,
  harnessHashes: Object.fromEntries(['evaluate-tool-guidance.ts', 'tool-guidance-evaluation.ts'].map((file) => [
    file, createHash('sha256').update(fs.readFileSync(new URL(file, import.meta.url))).digest('hex'),
  ])),
  missingRoles: ['frontier', 'small-hosted', 'local'].filter((role) => !config.profiles.some((profile) => profile.role === role)),
  notes: [
    'Only synthetic task data leaves this process. Operational tools are never executed.',
    'Live requests use LC LLMClient adapters. Calls pass LC strict runtime schemas and the real help governor.',
    'Untiered is a reconstruction from the same current pilot catalog, not the historical baseline.',
    'Token fixtures use o200k_base for both surfaces. Provider usage/cache counters remain separately labelled.',
    'contextTokens records the configured local-server limit. Verify that server setting before acceptance.',
    'Automated observations do not establish a quality pass. Review every transcript against its task rubric.',
  ],
};
fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2));
if (values.prepare) {
  console.log(`Prepared ${metadata.plannedRuns} comparisons without model requests. Phase 3 remains open.`);
  process.exit(0);
}

let requestCount = 0;
let completedRuns = 0;
const reviews: Array<Record<string, unknown>> = [];
for (const profile of config.profiles) {
  const client = new LLMClient({
    baseUrl: profile.baseUrl, apiVariant: profile.apiVariant, apiStyle: profile.apiStyle,
    apiKey: keys.get(profile.role), routing: 'direct',
  });
  for (let repetition = 0; repetition < config.repetitions; repetition++) {
    for (const history of [false, true]) {
      for (const [taskIndex, task] of tasks.entries()) {
        // Alternate pair order to avoid assigning every warm prefix to one surface.
        const order: Surface[] = (taskIndex + repetition) % 2 ? ['tiered', 'untiered'] : ['untiered', 'tiered'];
        for (const surface of order) {
          const id = `${profile.role}/${repetition}/${history ? 'history-on' : 'history-off'}/${task.id}/${surface}`;
          const definitions = surfaces[String(history)][surface];
          const exposed = new Set(definitions.map((definition) => definition.function.name));
          const messages = evaluationMessages(task, history);
          const governor = createToolHelpGovernorState();
          const attempts = new Map<string, number>();
          const observations: Array<Record<string, unknown>> = [];
          const usage: NormalizedUsage[] = [];
          let invalidCalls = 0;
          let mutationAttempts = 0;
          let helpTokens = 0;
          let helpCalls = 0;
          let repeatedHelp = 0;
          let firstTool: string | undefined;
          let firstCallValid: boolean | undefined;
          let rounds = 0;
          let outcome = 'round_limit';
          let error: string | undefined;
          const started = Date.now();
          try {
            // Eight accepted tool rounds, followed by one opportunity for the final answer.
            for (let response = 0; response <= 8; response++) {
              if (requestCount >= config.maxRequests) { outcome = 'request_budget'; break; }
              requestCount++;
              let reasoning = '';
              const result = await client.chatStream({
                model: profile.model, messages, tools: definitions, stream: true,
                reasoningEnabled: profile.reasoningEffort !== undefined,
                reasoningEffort: profile.reasoningEffort, maxTokens: profile.maxOutputTokens,
              }, { onDelta: () => {}, onReasoning: (text) => { reasoning += text; } },
              AbortSignal.timeout(config.timeoutMs), config.timeoutMs);
              if (result.usage) usage.push(result.usage);
              messages.push({
                role: 'assistant', content: result.content, tool_calls: result.tool_calls,
                reasoning_content: reasoning || undefined, reasoning_details: result.reasoning_details,
                responses_output_items: result.responses_output_items,
                provider_output_origin: { baseUrl: profile.baseUrl, model: profile.model },
                anthropic_output_blocks: result.anthropic_output_blocks,
                anthropic_block_order: result.anthropic_block_order,
                anthropic_output_origin: { baseUrl: profile.baseUrl, model: profile.model },
              });
              if (result.error_message) { outcome = 'provider_error'; error = result.error_message; break; }
              if (result.finish_reason === 'length') { outcome = 'output_limit'; break; }
              if (!result.tool_calls?.length) { outcome = result.content.trim() ? 'answered' : 'empty_answer'; break; }
              if (response === 8) break;
              if (result.tool_calls.length > 4) {
                outcome = 'batch_limit';
                observations.push({ message: formatToolBatchLimitMessage(result.tool_calls.length, 4) });
                break;
              }
              rounds++;
              const records = result.tool_calls.map((call) => ({
                id: call.id, name: call.function.name, arguments: call.function.arguments, created_at: 0,
              }));
              const validated = validateToolCalls(records, HANDLERS_BY_NAME, exposed);
              const governed = governToolHelpCalls(validated, exposed, governor);
              for (const entry of validated) {
                const name = entry.call.name;
                if (firstCallValid === undefined) firstCallValid = !entry.error;
                if (!firstTool && name !== 'lc_tool_help') firstTool = name;
                if (entry.error) invalidCalls++;
                if (MUTATION_TOOLS.has(name)) mutationAttempts++;
                const attempt = (attempts.get(name) ?? 0) + 1;
                attempts.set(name, attempt);
                const resultEnvelope = governed.get(entry.call) ?? (entry.error
                  ? { status: 'error', issues: entry.error, warnings: [] }
                  : fixtureResult(task, name, entry.parsed as Record<string, unknown>, attempt));
                if (name === 'lc_tool_help') {
                  helpCalls++;
                  helpTokens += countEvaluationTokens(resultEnvelope);
                  const mode = (resultEnvelope as ToolResultEnvelope<ToolHelpData>).data?.mode;
                  if (mode === 'already_returned' || mode === 'limit_reached') repeatedHelp++;
                }
                observations.push({ round: rounds, name, arguments: entry.call.arguments, valid: !entry.error, result: resultEnvelope });
                messages.push({ role: 'tool', tool_call_id: entry.call.id, content: JSON.stringify(resultEnvelope),
                  tool_is_error: (resultEnvelope as ToolResultEnvelope).status === 'error' });
              }
            }
          } catch (caught) {
            outcome = 'transport_error';
            const raw = caught instanceof Error ? caught.message : String(caught);
            error = redact(raw);
          }
          const metrics = {
            firstTool, correctFirstTool: task.expectedFirstTool ? firstTool === task.expectedFirstTool : null,
            firstCallValid: firstCallValid ?? null, invalidCalls, mutationAttempts, helpCalls, repeatedHelp,
            neededHelpNotCalled: surface === 'tiered' && task.needsAdvancedHelp ? helpCalls === 0 : null,
            rounds, helpTokens, elapsedMs: Date.now() - started,
            fixedTokens: countEvaluationTokens(`${messages[0].content}\n${JSON.stringify(definitions)}`),
          };
          fs.appendFileSync(path.join(output, 'runs.jsonl'), `${redact(JSON.stringify({ id, outcome, error, metrics, usage, messages, observations }))}\n`);
          reviews.push({ id, rubric: task.review, selection: null, interpretation: null, recovery: null,
            safety: null, unnecessaryHelp: null, notes: '', outcome });
          completedRuns++;
          console.log(`${id}: ${outcome}, ${rounds} tool rounds, ${helpCalls} help calls`);
          fs.writeFileSync(path.join(output, 'review.json'), JSON.stringify(reviews, null, 2));
          fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({
            completedRuns, plannedRuns: metadata.plannedRuns, requestCount,
            configuredMatrixComplete: completedRuns === metadata.plannedRuns,
            requiredRolesComplete: metadata.missingRoles.length === 0,
            acceptance: 'pending transcript review; no automatic pass',
          }, null, 2));
          if (requestCount >= config.maxRequests) {
            console.error('Request budget reached. The remaining matrix is unexercised.');
            process.exit(2);
          }
        }
      }
    }
  }
}
console.log('Live matrix recorded. Review quality and paired regressions before closing Phase 3.');
