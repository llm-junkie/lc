import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Conversation, Message } from '../types';
import { persistedMessageSnapshot } from '../store/db.ts';
import {
  ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE,
  markStreaming,
  unmarkStreaming,
} from '../store/conversations.ts';
import {
  buildArchive,
  readArchive,
  readArchiveStaged,
  type ArchivedWhiteboardVersion,
} from './exportArchive.ts';

const EMPTY_WHITEBOARD_CARRIER = strToU8(JSON.stringify({
  format: 'llm-client:whiteboard',
  version: 1,
  conversations: [],
}));

function makeConversation(): Conversation {
  return {
    id: 'conv_skill_archive_test',
    title: 'skill archive chat',
    createdAt: 1700000000000,
    updatedAt: 1700000010000,
    archived: false,
    model: 'test-model',
    serverId: 'local',
    params: {
      temperature: 0.5,
      top_p: 0.95,
      top_k: 40,
      max_tokens: 4096,
      repeat_penalty: 1.1,
      system_prompt: '',
    },
    messages: [
      { id: 'm1', role: 'user' as const, content: 'hello', createdAt: 1700000000000 },
    ],
    messageCount: 1,
    tools: {
      enabled: true,
      tool_grants: [],
      web_access_grants_initialized: true,
      file_io_enabled: false,
      shell_enabled: false,
      web_access_enabled: false,
      skills_enabled: true,
      skills_initialized: true,
      enabled_skill_ids: ['custom-skill-uuid'],
      allowed_roots: [],
      dir_permissions: {},
      max_tool_rounds_per_turn: 128,
      max_tool_calls_per_batch: 16,
      sse_read_timeout_min: 5,
    },
    custom_skills: [{
      id: 'custom-skill-uuid',
      source: 'custom' as const,
      name: 'Release checklist',
      description: 'Keep release notes complete.',
      content: '# Release checklist\n\nUse the required release sections.',
      revision: 7,
      createdAt: 1700000020000,
      updatedAt: 1700000030000,
    }],
  };
}

const RETAINED_WHITEBOARD_ROWS: ArchivedWhiteboardVersion[] = [
  {
    conversationId: 'conv_skill_archive_test',
    id: 'u_1114221300000',
    owner: 'user',
    content: '',
    createdAt: 1_700_000_000_000,
    sequence: 1,
    sourceMessageId: null,
    sourceToolCallId: null,
  },
  {
    conversationId: 'conv_skill_archive_test',
    id: 'm_1114221300000',
    owner: 'model',
    content: '',
    createdAt: 1_700_000_000_000,
    sequence: 2,
    sourceMessageId: null,
    sourceToolCallId: null,
  },
  {
    conversationId: 'conv_skill_archive_test',
    id: 'u_1114221320000',
    owner: 'user',
    content: '# User constraints',
    createdAt: 1_700_000_001_000,
    sequence: 3,
    sourceMessageId: 'm1',
    sourceToolCallId: null,
  },
  {
    conversationId: 'conv_skill_archive_test',
    id: 'm_1114221325000',
    owner: 'model',
    content: '# Model handoff',
    createdAt: 1_700_000_002_000,
    sequence: 4,
    sourceMessageId: 'm2',
    sourceToolCallId: 'call-whiteboard',
  },
];

function makeWhiteboardConversation(): Conversation {
  const conversation = makeConversation();
  conversation.messages = [
    {
      id: 'm1',
      role: 'user',
      content: 'continue',
      createdAt: 1_700_000_001_000,
      user_board: 'u_1114221320000',
    },
    {
      id: 'm2',
      role: 'assistant',
      content: 'done',
      createdAt: 1_700_000_002_000,
      whiteboard_refs: {
        user_board: 'u_1114221320000',
        model_initial_board: 'm_1114221300000',
        model_latest_board: 'm_1114221325000',
      },
      tool_calls: [{
        created_at: 0,
        id: 'call-whiteboard',
        name: 'lc_whiteboard',
        arguments: '{"action":"replace","content":"# Model handoff"}',
      }],
    },
  ];
  conversation.messageCount = conversation.messages.length;
  return conversation;
}

function makeV1ArchiveBytes(
  conversation: Conversation,
  whiteboard: unknown,
  extraEntries: Record<string, Uint8Array> = {},
): Uint8Array {
  return zipSync({
    'conversations.json': strToU8(JSON.stringify({
      format: 'llm-client:archive',
      version: 1,
      exportedAt: Date.now(),
      conversations: [conversation],
    })),
    'whiteboard.json': strToU8(JSON.stringify(whiteboard)),
    ...extraEntries,
  });
}

function makeAttachmentArchiveBytes(
  actualBytes = 100_000,
  declaredBytes = actualBytes,
): Uint8Array {
  const conversation = makeConversation() as Conversation & Record<string, unknown>;
  conversation.messages = [{
    id: 'attachment-message',
    role: 'user',
    content: 'inspect attachment',
    createdAt: 1_700_000_000_000,
    attachments: [{
      id: 'attachment-id',
      name: 'payload.bin',
      mime: 'application/octet-stream',
      isImage: false,
      size: declaredBytes,
      file: 'attachments/attachment-id-payload.bin',
    }],
  }] as unknown as Message[];
  return zipSync({
    'conversations.json': strToU8(JSON.stringify({
      format: 'llm-client:archive',
      version: 1,
      exportedAt: Date.now(),
      conversations: [conversation],
    })),
    'whiteboard.json': EMPTY_WHITEBOARD_CARRIER,
    'attachments/attachment-id-payload.bin': [
      new Uint8Array(actualBytes).fill(65),
      { level: 0 },
    ],
  });
}

function findZipEntry(bytes: Uint8Array, target: string): {
  centralOffset: number;
  localOffset: number;
  localDataOffset: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let centralOffset = -1;
  let localOffset = -1;
  let localDataOffset = -1;
  for (let offset = 0; offset <= bytes.length - 46; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) {
      const nameBytes = view.getUint16(offset + 26, true);
      const extraBytes = view.getUint16(offset + 28, true);
      const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameBytes));
      if (name === target) {
        localOffset = offset;
        localDataOffset = offset + 30 + nameBytes + extraBytes;
      }
    }
    if (signature === 0x02014b50) {
      const nameBytes = view.getUint16(offset + 28, true);
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameBytes));
      if (name === target) centralOffset = offset;
    }
  }
  assert.notEqual(centralOffset, -1);
  assert.notEqual(localOffset, -1);
  assert.notEqual(localDataOffset, -1);
  return { centralOffset, localOffset, localDataOffset };
}

test('conversation archive round-trip preserves custom skills and enabled IDs', async () => {
  const original = makeConversation();
  const blob = await buildArchive([original]);
  const zipEntries = unzipSync(new Uint8Array(await blob.arrayBuffer()));

  assert.ok(zipEntries['skills/manifest.json']);
  assert.ok(zipEntries['skills/lc_skill_release-checklist.md']);
  const readme = strFromU8(zipEntries['README.txt']);
  assert.match(readme, /^LC: conversation archive\n/);
  assert.doesNotMatch(readme, /^LC .*LLM Client/m);
  assert.match(readme, /Settings → Conversations → Import/);
  assert.doesNotMatch(readme, /Settings → Data → Import/);
  const markdown = strFromU8(zipEntries['skills/lc_skill_release-checklist.md']);
  assert.match(markdown, /^---\nname: Release checklist\n/);
  assert.doesNotMatch(markdown, /^id:/m);

  const imported = await readArchive({
    arrayBuffer: () => blob.arrayBuffer(),
  } as File);
  assert.equal(imported.length, 1);
  assert.deepEqual(imported[0].conversation.custom_skills, original.custom_skills);
  assert.equal(imported[0].conversation.tools?.skills_initialized, true);
  assert.deepEqual(imported[0].conversation.tools?.enabled_skill_ids, ['custom-skill-uuid']);
});

test('conversation archive v1 round-trips retained Whiteboard rows in its mandatory carrier', async () => {
  const original = makeWhiteboardConversation();
  let loadedConversationId = '';
  const blob = await buildArchive(
    [original],
    undefined,
    async (conversationId) => {
      loadedConversationId = conversationId;
      return RETAINED_WHITEBOARD_ROWS;
    },
  );
  assert.equal(loadedConversationId, original.id);

  const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  assert.ok(entries['whiteboard.json']);
  const carrier = JSON.parse(strFromU8(entries['whiteboard.json']));
  assert.deepEqual(carrier, {
    format: 'llm-client:whiteboard',
    version: 1,
    conversations: [{
      conversationId: original.id,
      versions: RETAINED_WHITEBOARD_ROWS,
    }],
  });
  assert.equal(JSON.stringify(carrier).includes('working'), false);
  assert.equal(JSON.stringify(carrier).includes('pending'), false);
  assert.equal(JSON.stringify(carrier).includes('provisional'), false);

  const imported = await readArchive({ arrayBuffer: () => blob.arrayBuffer() } as File);
  assert.deepEqual(imported[0].whiteboardVersions, RETAINED_WHITEBOARD_ROWS);
  assert.equal(imported[0].conversation.messages[0].user_board, 'u_1114221320000');
  assert.deepEqual(imported[0].conversation.messages[1].whiteboard_refs, {
    user_board: 'u_1114221320000',
    model_initial_board: 'm_1114221300000',
    model_latest_board: 'm_1114221325000',
  });
});

test('conversation archive refuses to omit retained rows behind message references', async () => {
  await assert.rejects(
    buildArchive([makeWhiteboardConversation()]),
    /Whiteboard references but its retained versions were not loaded/,
  );
});

test('conversation archive v1 requires the root whiteboard.json carrier', async () => {
  const archive = {
    format: 'llm-client:archive',
    version: 1,
    exportedAt: Date.now(),
    conversations: [makeConversation()],
  };
  const bytes = zipSync({
    'conversations.json': strToU8(JSON.stringify(archive)),
  });

  await assert.rejects(
    () => readArchive({ arrayBuffer: async () => bytes.buffer } as File),
    /missing whiteboard\.json/i,
  );
});

test('conversation archive rejects enabled Whiteboard state without retained baselines', async () => {
  const original = makeConversation();
  original.tools = { ...original.tools!, whiteboard_enabled: true };
  const carrier = {
    format: 'llm-client:whiteboard',
    version: 1,
    conversations: [],
  };

  const bytes = makeV1ArchiveBytes(original, carrier);
  await assert.rejects(
    () => readArchive({ arrayBuffer: async () => bytes.buffer } as File),
    /enabled conversation .* has no retained Whiteboard baselines/,
  );
});

test('conversation archive validates Whiteboard groups, owner prefixes, and sequences', async () => {
  const original = makeWhiteboardConversation();
  const validCarrier = () => ({
    format: 'llm-client:whiteboard',
    version: 1,
    conversations: [{
      conversationId: original.id,
      versions: structuredClone(RETAINED_WHITEBOARD_ROWS),
    }],
  });

  const cases: Array<{
    name: string;
    mutate: (carrier: ReturnType<typeof validCarrier>) => void;
    error: RegExp;
  }> = [
    {
      name: 'unknown conversation group',
      mutate: (carrier) => { carrier.conversations[0].conversationId = 'unknown-conversation'; },
      error: /unknown conversation/,
    },
    {
      name: 'row outside its group',
      mutate: (carrier) => { carrier.conversations[0].versions[0].conversationId = 'other'; },
      error: /different conversation group/,
    },
    {
      name: 'owner prefix mismatch',
      mutate: (carrier) => { carrier.conversations[0].versions[0].id = 'm_1114221399999'; },
      error: /owner prefix/,
    },
    {
      name: 'duplicate sequence',
      mutate: (carrier) => { carrier.conversations[0].versions[3].sequence = 3; },
      error: /duplicate or non-monotonic retained sequences/,
    },
    {
      name: 'working state in carrier',
      mutate: (carrier) => {
        Object.assign(carrier.conversations[0], { working: { owner: 'model' } });
      },
      error: /conversation group has an invalid shape/,
    },
    {
      name: 'missing model baseline',
      mutate: (carrier) => { carrier.conversations[0].versions.splice(1, 1); },
      error: /does not begin with the empty user and model initialization baselines/,
    },
    {
      name: 'non-empty user baseline',
      mutate: (carrier) => { carrier.conversations[0].versions[0].content = '# Not a baseline'; },
      error: /does not begin with the empty user and model initialization baselines/,
    },
    {
      name: 'sourced model baseline',
      mutate: (carrier) => { carrier.conversations[0].versions[1].sourceMessageId = 'm2'; },
      error: /does not begin with the empty user and model initialization baselines/,
    },
  ];

  for (const fixture of cases) {
    const carrier = validCarrier();
    fixture.mutate(carrier);
    const bytes = makeV1ArchiveBytes(original, carrier);
    await assert.rejects(
      () => readArchive({ arrayBuffer: async () => bytes.buffer } as File),
      fixture.error,
      fixture.name,
    );
  }
});

test('conversation archive validates every message and row reference before attachment persistence', async () => {
  const original = makeWhiteboardConversation();
  original.messages[0].attachments = [{
    id: 'attachment-before-validation',
    name: 'notes.txt',
    mime: 'text/plain',
    isImage: false,
    size: 5,
    stored: 'idb',
    // Archive-only field supplied below after widening the wire object.
  }];
  const archivedConversation = structuredClone(original) as Conversation & {
    messages: Array<Conversation['messages'][number] & {
      attachments?: Array<NonNullable<Conversation['messages'][number]['attachments']>[number] & {
        file: string;
      }>;
    }>;
  };
  archivedConversation.messages[0].attachments![0].file = 'attachments/note.txt';
  archivedConversation.messages[1].whiteboard_refs!.model_latest_board = 'm_1114221399999';
  const carrier = {
    format: 'llm-client:whiteboard',
    version: 1,
    conversations: [{
      conversationId: original.id,
      versions: RETAINED_WHITEBOARD_ROWS,
    }],
  };
  const bytes = makeV1ArchiveBytes(archivedConversation, carrier, {
    'attachments/note.txt': strToU8('hello'),
  });

  // The Node test has no IndexedDB attachment store. Receiving the precise
  // reference error therefore also proves validation ran before putAttachment.
  await assert.rejects(
    () => readArchive({ arrayBuffer: async () => bytes.buffer } as File),
    /whiteboard_refs\.model_latest_board references missing model retained row/,
  );
});

test('conversation archive strips transient streaming ownership state', async () => {
  const original = makeConversation();
  original.messages.push({
    id: 'm2',
    role: 'assistant',
    content: 'partial response',
    reasoning: 'partial reasoning',
    createdAt: 1700000010000,
    streaming: true,
  });
  original.messageCount = original.messages.length;

  const blob = await buildArchive([original]);
  const imported = await readArchive({
    arrayBuffer: () => blob.arrayBuffer(),
  } as File);
  const assistant = imported[0].conversation.messages[1];

  assert.equal(assistant.content, 'partial response');
  assert.equal(assistant.reasoning, 'partial reasoning');
  assert.equal(assistant.streaming, undefined);
});

test('conversation archive import drops transient message and attachment state', async () => {
  const conversation = makeConversation();
  conversation.messages = [{
    id: 'transient-import-message',
    role: 'assistant',
    content: 'complete response',
    createdAt: 1_700_000_000_000,
    streaming: true,
    attachments: [{
      id: 'transient-import-attachment',
      name: 'note.txt',
      mime: 'text/plain',
      isImage: false,
      size: 5,
      stored: 'inline',
      dataUrl: 'data:text/plain;base64,d3Jvbmc=',
      file: 'attachments/transient-import-attachment-note.txt',
    } as unknown as NonNullable<Message['attachments']>[number] & { file: string }],
  }];
  const bytes = makeV1ArchiveBytes(
    conversation,
    {
      format: 'llm-client:whiteboard',
      version: 1,
      conversations: [],
    },
    { 'attachments/transient-import-attachment-note.txt': strToU8('right') },
  );

  const [imported] = await readArchiveStaged({
    arrayBuffer: async () => bytes.buffer,
    size: bytes.length,
  } as File);
  const [message] = imported.conversation.messages;

  assert.equal(message.streaming, undefined);
  assert.equal(message.attachments?.[0]?.dataUrl, undefined);
  assert.equal(message.attachments?.[0]?.stored, 'idb');
  assert.equal(await imported.stagedAttachments?.[0]?.blob.text(), 'right');
});

test('conversation archive rejects a partial in-memory history without a loader', async () => {
  const original = makeConversation();
  original.messageCount = 2;

  await assert.rejects(
    buildArchive([original]),
    /is not fully loaded; reload it before exporting/,
  );
});

test('conversation archive rejects export while a generation is active', async () => {
  const original = makeConversation();
  const owner = markStreaming(original.id, 'assistant-export-lock');
  try {
    await assert.rejects(
      buildArchive([original]),
      new RegExp(ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  } finally {
    unmarkStreaming(owner.conversationId, owner.generationId);
  }
});

test('conversation archive permits an idle target while another conversation generates', async () => {
  const owner = markStreaming('unrelated-export-lock', 'assistant-export-lock');
  try {
    const blob = await buildArchive([makeConversation()]);
    assert.ok(blob.size > 0);
  } finally {
    unmarkStreaming(owner.conversationId, owner.generationId);
  }
});

test('conversation archive reloads an incomplete history and reconciles its count', async () => {
  const original = makeConversation();
  original.messageCount = 2;
  const durableMessages = [
    ...original.messages,
    {
      id: 'm2',
      role: 'assistant' as const,
      content: 'complete reply',
      createdAt: 1700000010000,
    },
  ];

  const blob = await buildArchive([original], async (conversationId) => {
    assert.equal(conversationId, original.id);
    return durableMessages;
  });
  const imported = await readArchive({
    arrayBuffer: () => blob.arrayBuffer(),
  } as File);

  assert.deepEqual(
    imported[0].conversation.messages.map((message) => message.id),
    ['m1', 'm2'],
  );
  assert.equal(imported[0].conversation.messageCount, 2);
});

test('canonical persisted message shape strips hydrated attachment data URLs', () => {
  const message = persistedMessageSnapshot({
    id: 'attachment-message',
    role: 'user',
    content: 'attached',
    createdAt: 1,
    attachments: [{
      id: 'attachment',
      name: 'notes.txt',
      mime: 'text/plain',
      isImage: false,
      size: 5,
      stored: 'idb',
      dataUrl: 'data:text/plain;base64,SGVsbG8=',
    }],
  });

  assert.equal(message.attachments?.[0]?.dataUrl, undefined);
  assert.equal(message.attachments?.[0]?.stored, 'idb');
});

test('archive import rejects an invalid custom-skill manifest', async () => {
  const archive = {
    format: 'llm-client:archive',
    version: 1,
    exportedAt: Date.now(),
    conversations: [],
  };
  const bytes = zipSync({
    'conversations.json': strToU8(JSON.stringify(archive)),
    'whiteboard.json': EMPTY_WHITEBOARD_CARRIER,
    'skills/manifest.json': strToU8('{"not":"an LC skill manifest"}'),
  });

  await assert.rejects(
    () => readArchive({ arrayBuffer: async () => bytes.buffer } as File),
    /Could not read custom skills from this archive/,
  );
});

test('archive import rejects non-current archive versions', async () => {
  const archive = {
    format: 'llm-client:archive',
    version: 2,
    exportedAt: Date.now(),
    conversations: [],
  };
  const bytes = zipSync({
    'conversations.json': strToU8(JSON.stringify(archive)),
  });

  await assert.rejects(
    () => readArchive({ arrayBuffer: async () => bytes.buffer } as File),
    /unsupported conversation archive version 2/i,
  );
});

test('archive import re-sequences sortOrder for messages that lack it', async () => {
  // A legacy archive whose messages predate `sortOrder`. The field is
  // optional on Message and the archive validator does not require it, so
  // this is a real importable shape — and the timestamp fallback in
  // `messageToRow` must never leak into the persisted indexed column.
  const archive = {
    format: 'llm-client:archive',
    version: 1,
    exportedAt: Date.now(),
    conversations: [{
      id: 'legacy-no-sort',
      title: 'legacy',
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      params: { temperature: 0.5, top_p: 0.95, top_k: 40, max_tokens: 4096, repeat_penalty: 1.1, system_prompt: '' },
      messageCount: 2,
      messages: [
        { id: 'legacy-a', role: 'user', content: 'one', createdAt: 1700000000000 },
        { id: 'legacy-b', role: 'assistant', content: 'two', createdAt: 1700000001000 },
      ],
    }],
  };
  const bytes = zipSync({
    'conversations.json': strToU8(JSON.stringify(archive)),
    'whiteboard.json': EMPTY_WHITEBOARD_CARRIER,
  });

  const imported = await readArchive({ arrayBuffer: async () => bytes.buffer } as File);

  assert.deepEqual(
    imported[0].conversation.messages.map((message) => message.sortOrder),
    [1, 2],
  );
  assert.equal(imported[0].conversation.messages[0].createdAt, 1700000000000);
});

test('archive import enforces explicit file, entry, and entry-size caps', async () => {
  const archive = {
    format: 'llm-client:archive',
    version: 1,
    exportedAt: Date.now(),
    conversations: [],
  };
  const bytes = zipSync({
    'conversations.json': strToU8(JSON.stringify(archive)),
    'whiteboard.json': EMPTY_WHITEBOARD_CARRIER,
  });
  const file = { arrayBuffer: async () => bytes.buffer, size: bytes.length } as unknown as File;

  await assert.rejects(
    () => readArchive(file, { maxFileBytes: bytes.length - 1, maxEntries: 1000, maxEntryBytes: 1_000_000_000 }),
    /too large to be a conversation archive/,
  );
  await assert.rejects(
    () => readArchive(file, { maxFileBytes: 1_000_000_000, maxEntries: 0, maxEntryBytes: 1_000_000_000 }),
    /exceeds the import limits/,
  );
  await assert.rejects(
    () => readArchive(file, { maxFileBytes: 1_000_000_000, maxEntries: 1000, maxEntryBytes: 10 }),
    /exceeds the import limits/,
  );
});

test('archive import rejects understated and corrupt attachment entries', async () => {
  const target = 'attachments/attachment-id-payload.bin';
  const understated = makeAttachmentArchiveBytes();
  const understatedEntry = findZipEntry(understated, target);
  const understatedView = new DataView(
    understated.buffer,
    understated.byteOffset,
    understated.byteLength,
  );
  understatedView.setUint32(understatedEntry.localOffset + 22, 1, true);
  understatedView.setUint32(understatedEntry.centralOffset + 24, 1, true);
  await assert.rejects(
    () => readArchiveStaged({
      arrayBuffer: async () => understated.buffer,
      size: understated.length,
    } as File, {
      maxFileBytes: 1_000_000,
      maxEntries: 10,
      maxEntryBytes: 10_000,
    }),
    /corrupt ZIP entry/,
  );

  const corrupt = makeAttachmentArchiveBytes();
  const corruptEntry = findZipEntry(corrupt, target);
  corrupt[corruptEntry.localDataOffset] ^= 0xff;
  await assert.rejects(
    () => readArchiveStaged({
      arrayBuffer: async () => corrupt.buffer,
      size: corrupt.length,
    } as File),
    /corrupt ZIP entry/,
  );

  const mismatched = makeAttachmentArchiveBytes(1, 100_000);
  await assert.rejects(
    () => readArchiveStaged({
      arrayBuffer: async () => mismatched.buffer,
      size: mismatched.length,
    } as File),
    /attachment whose size does not match its metadata/,
  );
});

test('archive import rejects a zip without conversations.json', async () => {
  const bytes = zipSync({ 'README.txt': strToU8('not an archive') });
  await assert.rejects(
    () => readArchive({ arrayBuffer: async () => bytes.buffer } as File),
    /missing conversations\.json/,
  );
});

test('archive import rejects conversation entries that are not conversation-shaped', async () => {
  const archive: Record<string, unknown> = {
    format: 'llm-client:archive',
    version: 1,
    exportedAt: Date.now(),
    conversations: [{}],
  };
  const bytes = zipSync({
    'conversations.json': strToU8(JSON.stringify(archive)),
    'whiteboard.json': EMPTY_WHITEBOARD_CARRIER,
  });
  await assert.rejects(
    () => readArchive({ arrayBuffer: async () => bytes.buffer } as File),
    /not a conversation archive from LLM Client/,
  );
});

test('archive import rejects messages without required persisted fields', async () => {
  const conversation = makeConversation() as unknown as Record<string, unknown>;
  conversation.messages = [{
    id: 'missing-content',
    role: 'user',
    createdAt: 1,
  }];
  const bytes = makeV1ArchiveBytes(
    conversation as unknown as Conversation,
    {
      format: 'llm-client:whiteboard',
      version: 1,
      conversations: [],
    },
  );

  await assert.rejects(
    () => readArchive({ arrayBuffer: async () => bytes.buffer } as File),
    /not a conversation archive from LLM Client/,
  );
});

test('archive import preserves unknown extra fields in a supported version', async () => {
  const conversation = makeConversation() as Conversation & Record<string, unknown>;
  conversation.futureConversationField = { enabled: true };
  const message = conversation.messages[0] as Message & Record<string, unknown>;
  message.futureMessageField = ['future'];
  const bytes = makeV1ArchiveBytes(
    conversation,
    {
      format: 'llm-client:whiteboard',
      version: 1,
      conversations: [],
    },
  );

  const [imported] = await readArchive({ arrayBuffer: async () => bytes.buffer } as File);
  const restored = imported.conversation as Conversation & Record<string, unknown>;
  assert.deepEqual(restored.futureConversationField, { enabled: true });
  assert.deepEqual(
    (restored.messages[0] as Message & Record<string, unknown>).futureMessageField,
    ['future'],
  );
});

test('archive export refuses output that exceeds its own import entry limit', async () => {
  const conversation = makeConversation();
  conversation.custom_skills = Array.from({ length: 997 }, (_, index) => ({
    id: `custom-skill-${index}`,
    source: 'custom' as const,
    name: `Skill ${index}`,
    description: '',
    content: 'Use this skill.',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  }));

  await assert.rejects(
    () => buildArchive([conversation]),
    /more than 1000 zip entries\. Export conversations individually instead\./,
  );
});

test('archive import rejects attachment arrays that are not attachment-shaped', async () => {
  const archive: Record<string, unknown> = {
    format: 'llm-client:archive',
    version: 1,
    exportedAt: Date.now(),
    conversations: [{
      id: 'bad-attachments',
      title: 'bad attachments',
      createdAt: 1,
      updatedAt: 2,
      params: {},
      messages: [{
        id: 'bad-att-message',
        role: 'user',
        content: 'x',
        createdAt: 1,
        // Not an array — restoration would throw a raw TypeError on this.
        attachments: 'not-an-array',
      }],
    }],
  };
  const bytes = zipSync({
    'conversations.json': strToU8(JSON.stringify(archive)),
    'whiteboard.json': EMPTY_WHITEBOARD_CARRIER,
  });
  await assert.rejects(
    () => readArchive({ arrayBuffer: async () => bytes.buffer } as File),
    /not a conversation archive from LLM Client/,
  );
});

test('archive import re-sequences sortOrder values outside the counter domain', async () => {
  // A message that carries the ~1.75e12 timestamp fallback (a pre-sortOrder
  // row archived through the fallback, or a hand-made archive) must not
  // re-enter the indexed column.
  const archive: Record<string, unknown> = {
    format: 'llm-client:archive',
    version: 1,
    exportedAt: Date.now(),
    conversations: [{
      id: 'timestamp-domain',
      title: 'timestamp domain',
      createdAt: 1,
      updatedAt: 2,
      params: {},
      messages: [
        { id: 'ts-a', role: 'user', content: 'one', createdAt: 1, sortOrder: 1700000000000 },
        { id: 'ts-b', role: 'assistant', content: 'two', createdAt: 2, sortOrder: 1700000001000 },
      ],
    }],
  };
  const bytes = zipSync({
    'conversations.json': strToU8(JSON.stringify(archive)),
    'whiteboard.json': EMPTY_WHITEBOARD_CARRIER,
  });

  const imported = await readArchive({ arrayBuffer: async () => bytes.buffer } as File);

  assert.deepEqual(
    imported[0].conversation.messages.map((message) => message.sortOrder),
    [1, 2],
  );
  assert.equal(imported[0].conversation.messages[0].createdAt, 1);
});

test('archive import re-sequences a whole conversation when any message mixes sortOrder domains', async () => {
  // A single conversation that mixes the timestamp fallback with counter
  // values: per-message re-sequencing would import this as [1, 1, 2] and
  // duplicate the indexed [conversationId+sortOrder] key. The whole
  // conversation must be renumbered in archive order instead.
  const archive: Record<string, unknown> = {
    format: 'llm-client:archive',
    version: 1,
    exportedAt: Date.now(),
    conversations: [{
      id: 'mixed-domain',
      title: 'mixed domain',
      createdAt: 1,
      updatedAt: 3,
      params: {},
      messages: [
        { id: 'mix-a', role: 'user', content: 'one', createdAt: 1, sortOrder: 1700000000000 },
        { id: 'mix-b', role: 'assistant', content: 'two', createdAt: 2, sortOrder: 1 },
        { id: 'mix-c', role: 'assistant', content: 'three', createdAt: 3, sortOrder: 2 },
      ],
    }],
  };
  const bytes = zipSync({
    'conversations.json': strToU8(JSON.stringify(archive)),
    'whiteboard.json': EMPTY_WHITEBOARD_CARRIER,
  });

  const imported = await readArchive({ arrayBuffer: async () => bytes.buffer } as File);

  const orders = imported[0].conversation.messages.map((message) => message.sortOrder);
  assert.deepEqual(orders, [1, 2, 3]);
  assert.equal(new Set(orders).size, orders.length);
});
