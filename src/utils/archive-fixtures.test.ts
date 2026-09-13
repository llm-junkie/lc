/**
 * LC 7z fixtures — extraction, conversation archive integrity, and known
 * production stress shapes.
 *
 * Run with:
 *   node --experimental-strip-types --test src/utils/archive-fixtures.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARCHIVE_FIXTURES,
  CHAT_ARCHIVE,
  SUPPORT_ARCHIVE,
  ensureExtracted,
  extractedDir,
} from '../../scripts/fixture-lc-archives.mjs';

const A13_CONVERSATION_ID = 'd50a0eb2-075e-4f21-91a6-47189d7891a2';
const COMPLETE_TESTS_CONVERSATION_ID = '04d18cf8-b665-41d8-b425-c7df12978b41';
// `baseUrl` is deliberately absent: the fixtures predate it, and this list
// names the fields a reply of that vintage must still carry.
const CURRENT_META_FIELDS = [
  'model', 'endpoint', 'serverName', 'presetName', 'params', 'avgTps',
  'totalTokens', 'durationMs', 'finish_reason', 'provider_finish_reason',
];

interface FixtureToolCall {
  id: string;
}

interface FixtureAttachment {
  file?: string;
}

interface FixtureMessage {
  id: string;
  role: string;
  content: string;
  sortOrder: number;
  reasoning?: string;
  tool_call_id?: string;
  tool_calls?: FixtureToolCall[];
  attachments?: FixtureAttachment[];
  meta?: Record<string, unknown>;
  usage?: unknown;
  prefix?: unknown;
}

interface FixtureConversation {
  id: string;
  title: string;
  archived: boolean;
  messageCount: number;
  messages: FixtureMessage[];
  model: string;
  tools: {
    enabled: boolean;
    enabled_skill_ids?: string[];
    allowed_roots: string[];
  };
}

interface FixtureConversationArchive {
  format: string;
  version: number;
  conversations: FixtureConversation[];
}

async function loadConversationArchive() {
  const dir = (await ensureExtracted())[CHAT_ARCHIVE];
  const archive = JSON.parse(
    readFileSync(join(dir, 'conversations.json'), 'utf8'),
  ) as FixtureConversationArchive;
  return { archive, dir };
}

function requireConversation(
  archive: FixtureConversationArchive,
  id: string,
): FixtureConversation {
  const conversation = archive.conversations.find((candidate) => candidate.id === id);
  assert.ok(conversation, `missing fixture conversation: ${id}`);
  return conversation;
}

function hasCurrentAssistantMetadata(message: FixtureMessage): boolean {
  return CURRENT_META_FIELDS.every((field) => message.meta?.[field] !== undefined)
    && message.usage !== undefined
    && message.prefix !== undefined;
}

test('each LC archive extracts into its own subdir, and re-runs are no-ops', async () => {
  const dirs = await ensureExtracted();
  assert.equal(dirs[CHAT_ARCHIVE], extractedDir(CHAT_ARCHIVE));
  assert.equal(dirs[SUPPORT_ARCHIVE], extractedDir(SUPPORT_ARCHIVE));
  assert.notEqual(
    dirs[CHAT_ARCHIVE],
    dirs[SUPPORT_ARCHIVE],
    'extractions must never share a directory',
  );

  const sentinel = join(dirs[SUPPORT_ARCHIVE], '.extracted-ok');
  const before = statSync(sentinel).mtimeMs;
  await ensureExtracted();
  assert.equal(statSync(sentinel).mtimeMs, before, 'second ensureExtracted() must not re-extract');
});

test('bulk conversation archive preserves two production chats and two templates', async () => {
  const { archive, dir } = await loadConversationArchive();
  assert.equal(archive.format, 'llm-client:archive');
  assert.equal(archive.version, 1);
  assert.equal(archive.conversations.length, 4);
  assert.equal(new Set(archive.conversations.map((conversation) => conversation.id)).size, 4);

  const byTitle = new Map(archive.conversations.map(
    (conversation) => [conversation.title, conversation] as const,
  ));
  assert.deepEqual(
    new Set(byTitle.keys()),
    new Set(['LC - A13 by Qwen 3.8 Max', 'LC - Complete Tests', 'LC template', 'Test template']),
  );
  assert.equal(requireConversation(archive, A13_CONVERSATION_ID).messageCount, 207);
  assert.equal(requireConversation(archive, COMPLETE_TESTS_CONVERSATION_ID).messageCount, 218);
  assert.match(readFileSync(join(dir, 'README.txt'), 'utf8'), /4 conversations/);
});

test('the committed conversation fixture is the complete v1 archive shape', async () => {
  const { archive, dir } = await loadConversationArchive();
  assert.equal(archive.version, 1);
  const whiteboard = JSON.parse(readFileSync(join(dir, 'whiteboard.json'), 'utf8'));
  assert.deepEqual(whiteboard, {
    format: 'llm-client:whiteboard',
    version: 1,
    conversations: [],
  });
});

test('bulk archive retains the two empty archived template conversations', async () => {
  const { archive } = await loadConversationArchive();
  const byTitle = new Map(archive.conversations.map(
    (conversation) => [conversation.title, conversation] as const,
  ));

  const lcTemplate = byTitle.get('LC template');
  const testTemplate = byTitle.get('Test template');
  if (!lcTemplate || !testTemplate) {
    throw new Error('fixture must contain both archived templates');
  }

  for (const conversation of [lcTemplate, testTemplate]) {
    assert.equal(conversation.archived, true);
    assert.equal(conversation.messageCount, 0);
    assert.deepEqual(conversation.messages, []);
    assert.equal(conversation.model, 'deepseek-v4-flash');
    assert.equal(conversation.tools.enabled, true);
    assert.deepEqual(conversation.tools.enabled_skill_ids, ['lc:builtin:lc-tools']);
  }

  assert.deepEqual(lcTemplate.tools.allowed_roots, ['d:/dev/home/clients/lc/web']);
  assert.deepEqual(testTemplate.tools.allowed_roots, []);
});

test('bulk archive has unique ordered messages and complete tool-call/result linkage', async () => {
  const { archive } = await loadConversationArchive();
  const allMessageIds: string[] = [];
  let totalToolCalls = 0;
  let totalToolResults = 0;

  for (const conversation of archive.conversations) {
    assert.equal(conversation.messageCount, conversation.messages.length);
    assert.equal(
      new Set(conversation.messages.map((message) => message.sortOrder)).size,
      conversation.messages.length,
    );
    assert.ok(conversation.messages.every(
      (message, index, messages) => {
        if (index === 0) return true;
        const previous = messages[index - 1];
        return previous !== undefined && message.sortOrder > previous.sortOrder;
      },
    ));

    const calls = conversation.messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.tool_calls ?? []);
    const results = conversation.messages.filter((message) => message.role === 'tool');
    const callIds = new Set(calls.map((call) => call.id));
    const resultIds = new Set(results.map((message) => message.tool_call_id));
    assert.deepEqual(resultIds, callIds, `${conversation.title}: tool linkage differs`);

    totalToolCalls += calls.length;
    totalToolResults += results.length;
    allMessageIds.push(...conversation.messages.map((message) => message.id));
  }

  assert.equal(new Set(allMessageIds).size, allMessageIds.length);
  assert.equal(totalToolCalls, 395);
  assert.equal(totalToolResults, 395);
});

test('every archived attachment exists and every extracted attachment is referenced', async () => {
  const { archive, dir } = await loadConversationArchive();
  const referenced = new Set<string>();
  for (const conversation of archive.conversations) {
    for (const message of conversation.messages) {
      for (const attachment of message.attachments ?? []) {
        if (typeof attachment?.file === 'string' && attachment.file.startsWith('attachments/')) {
          referenced.add(attachment.file);
        }
      }
    }
  }

  assert.equal(referenced.size, 6);
  for (const file of referenced) {
    assert.ok(existsSync(join(dir, file)), `missing referenced attachment: ${file}`);
  }
  const extractedFiles = new Set(readdirSync(join(dir, 'attachments')));
  const referencedNames = new Set([...referenced].map((file) => file.replace(/^attachments\//, '')));
  assert.deepEqual(extractedFiles, referencedNames);
});

test('assistant bubbles cover legacy, error, and fully current metadata shapes', async () => {
  const { archive } = await loadConversationArchive();
  const a13 = requireConversation(archive, A13_CONVERSATION_ID);
  const complete = requireConversation(archive, COMPLETE_TESTS_CONVERSATION_ID);
  const a13Assistants = a13.messages.filter((message) => message.role === 'assistant');
  const completeAssistants = complete.messages.filter((message) => message.role === 'assistant');

  const legacy = a13Assistants.filter((message) => !hasCurrentAssistantMetadata(message));
  const current = a13Assistants.filter(hasCurrentAssistantMetadata);
  assert.equal(a13Assistants.length, 8);
  assert.equal(legacy.length, 7);
  assert.equal(current.length, 1);
  const currentAssistant = current[0];
  const newestA13Assistant = a13Assistants.at(-1);
  if (!currentAssistant || !newestA13Assistant) {
    throw new Error('fixture must contain the expected A13 assistant messages');
  }
  assert.equal(currentAssistant.id, newestA13Assistant.id, 'the newest A13 bubble is the current shape');
  assert.equal(legacy.filter((message) => message.meta?.finish_reason === 'error').length, 1);
  assert.equal(completeAssistants.length, 7);
  assert.ok(completeAssistants.every(hasCurrentAssistantMetadata));
});

test('conversation fixture retains its intended markdown and long-reasoning stress shapes', async () => {
  const { archive } = await loadConversationArchive();
  const a13 = requireConversation(archive, A13_CONVERSATION_ID);
  const complete = requireConversation(archive, COMPLETE_TESTS_CONVERSATION_ID);
  const reasoningLengths = a13.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.reasoning?.length ?? 0)
    .sort((left, right) => right - left);
  const completeAnswerLengths = complete.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content.length);

  const longestReasoning = reasoningLengths[0];
  const secondLongestReasoning = reasoningLengths[1];
  if (longestReasoning === undefined || secondLongestReasoning === undefined) {
    throw new Error('fixture must contain at least two assistant reasoning traces');
  }
  assert.ok(longestReasoning >= 895_000);
  assert.ok(secondLongestReasoning >= 548_000);
  assert.ok(Math.max(...completeAnswerLengths) >= 30_000);
});

test('every declared archive fixture extracted with its expected entries', async () => {
  const dirs = await ensureExtracted();
  for (const { archive, expect } of ARCHIVE_FIXTURES) {
    for (const entry of expect) {
      assert.ok(existsSync(join(dirs[archive], entry)), `${archive}: missing ${entry}`);
    }
  }
});
