import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type {} from '../../../scripts/evaluate-tool-guidance.ts';
import { ASK_USER_OUTPUT_SCHEMA } from './ask-user.ts';
import {
  EVALUATION_TASKS, evaluationConfigSchema, evaluationDefinitions, evaluationMessages, fixtureResult,
} from '../../../scripts/tool-guidance-evaluation.ts';

describe('tool guidance evaluation controls', () => {
  test('changes only pilot descriptions between paired surfaces', () => {
    for (const history of [false, true]) {
      const tiered = evaluationDefinitions('tiered', history);
      const untiered = evaluationDefinitions('untiered', history);
      assert.equal(tiered.length, history ? 21 : 20);
      assert.deepEqual(tiered.map((tool) => tool.function.name), untiered.map((tool) => tool.function.name));
      const changed = tiered.filter((tool, index) => tool.function.description !== untiered[index].function.description);
      assert.deepEqual(changed.map((tool) => tool.function.name).sort(), ['lc_grep', 'lc_read_file', 'lc_read_pdf']);
      tiered.forEach((tool, index) => assert.deepEqual(tool.function.parameters, untiered[index].function.parameters));
    }
  });

  test('withholds the expected answer from selection and recovery prompts', () => {
    for (const task of EVALUATION_TASKS.filter((task) => task.id !== 'archived-read')) {
      for (const history of [false, true]) assert.doesNotMatch(JSON.stringify(evaluationMessages(task, history)), /ORCHID|17 days/);
    }
    const archived = EVALUATION_TASKS.find((task) => task.id === 'archived-read')!;
    assert.match(JSON.stringify(evaluationMessages(archived, false)), /ORCHID/);
    assert.doesNotMatch(JSON.stringify(evaluationMessages(archived, true)), /ORCHID/);
    assert.match(JSON.stringify(evaluationMessages(archived, true)), /prior_turn/);
  });

  test('seeds actual strict-schema recovery instead of a hand-authored error', () => {
    const task = EVALUATION_TASKS.find((candidate) => candidate.id === 'schema-recovery')!;
    const messages = evaluationMessages(task, false);
    const error = JSON.parse(messages.at(-1)!.content as string);
    assert.equal(error.issues[0].code, 'invalid_arguments');
    assert.equal(error.issues[0].retryable, false);
    assert.match(JSON.stringify(error), /5000/);
  });

  test('preserves PDF quotation provenance and exact-text controls', () => {
    const task = EVALUATION_TASKS.find((candidate) => candidate.id === 'pdf-quotation')!;
    const normal = fixtureResult(task, 'lc_read_pdf', { paths: ['C:/workspace/terms.pdf'] }, 1);
    assert.doesNotMatch(JSON.stringify(normal), /17 days/);
    for (const control of [{ include_text: true }, { summarize: false }]) {
      const exact = fixtureResult(task, 'lc_read_pdf', { paths: ['C:/workspace/terms.pdf'], ...control }, 1);
      assert.match(JSON.stringify(exact), /Payment is due within 17 days/);
      assert.match(JSON.stringify(exact), /text_layer/);
    }
  });

  test('keeps partial failures and replacement warnings visible', () => {
    const task = EVALUATION_TASKS.find((candidate) => candidate.id === 'partial-read')!;
    const partial = fixtureResult(task, 'lc_read_file', { paths: ['C:/workspace/readme.txt', 'C:/workspace/missing.txt'] }, 1);
    assert.equal((partial as { status: string }).status, 'partial');
    assert.match(JSON.stringify(partial), /read_failed/);
    const lossy = fixtureResult(task, 'lc_read_file', { paths: ['C:/workspace/legacy.txt'] }, 1);
    assert.match(JSON.stringify(lossy), /Do not call a write, edit, patch, or shell tool/);
    const mutation = fixtureResult(task, 'lc_write_file', { files: [{ path: 'C:/workspace/copy.txt', content: 'x' }] }, 1);
    assert.equal((mutation as { status: string }).status, 'error');
    const skipped = fixtureResult(task, 'lc_ask_user', { questions: [{ id: 1 }] }, 1) as { data: unknown };
    assert.equal(ASK_USER_OUTPUT_SCHEMA.safeParse(skipped.data).success, true);
    assert.deepEqual(skipped.data, { answers: [{ id: 1, skipped: true }] });
  });

  test('accepts equivalent Windows path separators and case without changing the result', () => {
    const task = EVALUATION_TASKS[0];
    assert.deepEqual(
      fixtureResult(task, 'lc_read_file', { paths: ['C:/workspace/readme.txt'] }, 1),
      fixtureResult(task, 'lc_read_file', { paths: ['c:\\WORKSPACE\\readme.txt'] }, 1),
    );
    const lossy = fixtureResult(task, 'lc_read_file', { paths: ['C:\\workspace\\legacy.txt'] }, 1);
    assert.match(JSON.stringify(lossy), /U\+FFFD/);
    const stat = fixtureResult(task, 'lc_stat', { paths: ['C:\\workspace\\large.txt'] }, 1);
    assert.match(JSON.stringify(stat), /"exists":true/);
  });

  test('preserves mode-specific search, history, and skill envelopes', () => {
    const task = EVALUATION_TASKS[0];
    const grep = fixtureResult(task, 'lc_grep', { searches: [{ path: 'C:/workspace/src', pattern: 'RELEASE_CODE' }], output_mode: 'files_with_matches' }, 1) as { data: { results: Array<{ files: string[]; matches: unknown[] }> } };
    assert.deepEqual(grep.data.results[0].files, ['C:/workspace/src/version.ts']);
    assert.deepEqual(grep.data.results[0].matches, []);
    for (const input of [{}, { tool_name: 'lc_read_file' }, { query: 'readme.txt' }]) {
      assert.doesNotMatch(JSON.stringify(fixtureResult(task, 'lc_tool_history', input, 1)), /ORCHID/);
    }
    assert.match(JSON.stringify(fixtureResult(task, 'lc_tool_history', { tool_call_id: 'prior_read' }, 1)), /ORCHID/);
    const skill = fixtureResult(task, 'lc_skill', { id: 'lc:builtin:lc-tools' }, 1) as { data: { mode: string; skill: { content: string } } };
    assert.equal(skill.data.mode, 'skill');
    assert.match(skill.data.skill.content, /LC Tool Cheat Sheet/);
  });

  test('rejects inline credentials, duplicate roles, and unbounded local profiles', () => {
    const profile = { role: 'local', baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture', contextTokens: 16384 };
    assert.equal(evaluationConfigSchema.safeParse({ profiles: [profile] }).success, true);
    for (const profiles of [
      [{ ...profile, apiKey: 'do-not-persist' }], [profile, profile], [{ ...profile, contextTokens: undefined }],
      [{ ...profile, baseUrl: 'https://user:secret@example.test/v1' }],
      [{ ...profile, baseUrl: 'https://example.test/v1?key=secret' }],
    ]) assert.equal(evaluationConfigSchema.safeParse({ profiles }).success, false);
  });
});
