/**
 * Conversation archive export/import.
 *
 * Format (a .zip):
 *   README.txt              — short usage notes
 *   conversations.json      — array of Conversation objects (always an
 *                             array, even for a single-chat export —
 *                             a "set" with one item is still a set)
 *   whiteboard.json         — retained Whiteboard versions grouped by
 *                             conversation; working rows are never archived
 *   skills/manifest.json    — custom skill identity and metadata
 *   skills/lc_skill_*.md    — custom skill Markdown bodies
 *   attachments/<id>-<name>  — flat folder, one file per attachment.
 *                             Attachment ids are uuid-style so they
 *                             never collide across conversations.
 *
 * One format covers both per-chat export (the sidebar row button) and
 * bulk export (Settings → Conversations → Export). The only difference is the
 * array length: `[c]` for single, `[c1, c2, ...]` for bulk. No
 * "single" vs "bulk" branching in code or in the file shape.
 *
 * Round-trip is lossless: conversations.json carries the full message
 * tree (content, reasoning, per-reply meta, attachment metadata), the
 * skills manifest/files carry custom skills, and the attachments/ folder
 * carries the actual bytes. On import we write blobs back to IndexedDB by
 * id, reconstruct custom skills, and merge conversations into the live store
 * by id (existing entries updated in place, new ones added).
 *
 * Import and export are bounded (standing constraint 8): a file over 1 GB,
 * more than 1000 zip entries, or any entry over 500 MB is rejected. Import
 * checks each entry before decompression. Every conversation entry must be
 * conversation-shaped (messages and their attachments included). Messages
 * whose `sortOrder` is absent or outside the counter domain are re-sequenced
 * in archive order.
 *
 * Implementation: `fflate` (~7 KB gzipped, pure JS, no native deps).
 * Works identically in web and Tauri.
 */

import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from 'fflate';
import type {
  Conversation,
  ConversationSkill,
  Message,
  WhiteboardOwner,
} from '../types';
import { loadAttachment, putAttachment } from './idb.ts';
import { lcExportFileName } from './exportNames.ts';
import { saveBlobFile } from './saveBlob.ts';
import { isCounterDomainSortOrder, persistedMessageSnapshot } from '../store/db.ts';
import {
  ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE,
  isConversationMessageHistoryComplete,
  isConversationStructurallyLocked,
} from '../store/conversations.ts';
import { parseSkillMarkdown } from '../modules/skills.ts';
import { normalizeGrantState } from '../modules/tool-engine/grant-state.ts';
import { validateGeminiGroups } from '../modules/llm-client/gemini-state.ts';

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

/** Wire format. The `format` discriminator lets the importer refuse
 *  anything that isn't an LC archive without a fragile file-content
 *  sniff. */
export interface ArchiveFile {
  format: 'llm-client:archive';
  version: typeof ARCHIVE_VERSION;
  exportedAt: number;
  conversations: ArchivedConversation[];
}

/** One immutable retained Whiteboard row in the portable archive. Content is
 * always the decompressed Markdown document, never the IndexedDB storage
 * representation. */
export interface ArchivedWhiteboardVersion {
  conversationId: string;
  id: string;
  owner: WhiteboardOwner;
  content: string;
  createdAt: number;
  sequence: number;
  sourceMessageId: string | null;
  sourceToolCallId: string | null;
}

/** Retained rows are grouped explicitly by owning archive conversation. A
 * conversation with no retained rows may be absent from this sparse array. */
export interface ArchivedWhiteboardConversation {
  conversationId: string;
  versions: ArchivedWhiteboardVersion[];
}

/** Mandatory root whiteboard.json carrier for conversation archive v1. */
export interface WhiteboardArchiveFile {
  format: 'llm-client:whiteboard';
  version: typeof ARCHIVE_VERSION;
  conversations: ArchivedWhiteboardConversation[];
}

export type LoadWhiteboardVersions = (
  conversationId: string,
) => Promise<ArchivedWhiteboardVersion[]>;

/** Per-skill entry in the skills manifest. */
export interface SkillManifestEntry {
  /** The conversation this skill belongs to. */
  conversationId: string;
  /** The custom skill's UUID within that conversation. */
  skillId: string;
  /** Always 'custom' — built-ins are never included in archives. */
  source: 'custom';
  /** Path to the skill Markdown file inside the archive. */
  file: string;
  /** Display name. */
  name: string;
  /** Description copied from the conversation-owned skill. */
  description?: string;
  /** Informational revision number. */
  revision?: number;
  /** Original creation timestamp. */
  createdAt?: number;
  /** Original update timestamp. */
  updatedAt?: number;
}

/** The skills/manifest.json inside an archive. */
export interface SkillManifest {
  format: 'llm-client:skill-manifest';
  version: typeof SKILL_MANIFEST_VERSION;
  skills: SkillManifestEntry[];
}

/** Current archive version. The importer rejects other versions. */
export const ARCHIVE_VERSION = 1 as const;

/** Current custom-skill manifest version. The importer rejects other versions. */
const SKILL_MANIFEST_VERSION = 1 as const;

const MAX_ARCHIVE_FILE_BYTES = 1_000_000_000;
const MAX_ARCHIVE_ENTRIES = 1000;
const MAX_ARCHIVE_ENTRY_BYTES = 500_000_000;

const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const ZIP32_MAX_ENTRY_COUNT = 0xffff;
const ZIP32_MAX_VALUE = 0xffffffff;

interface ZipEntryIntegrity {
  name: string;
  crc32: number;
  originalSize: number;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function corruptZipEntry(): never {
  throw new Error('This conversation archive contains a corrupt ZIP entry.');
}

function readZipEntryIntegrity(bytes: Uint8Array): ZipEntryIntegrity[] {
  if (bytes.byteLength < 22) return corruptZipEntry();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumEndOffset = Math.max(0, bytes.byteLength - 22 - ZIP32_MAX_ENTRY_COUNT);
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimumEndOffset; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_END_SIGNATURE) continue;
    const commentBytes = view.getUint16(offset + 20, true);
    if (offset + 22 + commentBytes === bytes.byteLength) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) return corruptZipEntry();

  const disk = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const diskEntries = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralBytes = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  // A valid archive under LC's 1 GB limit does not need multi-disk or ZIP64
  // metadata. Reject those markers instead of parsing ambiguous 64-bit values.
  if (disk !== 0
    || centralDisk !== 0
    || diskEntries !== entryCount
    || entryCount === ZIP32_MAX_ENTRY_COUNT
    || centralBytes === ZIP32_MAX_VALUE
    || centralOffset === ZIP32_MAX_VALUE
    || centralOffset + centralBytes > endOffset) {
    return corruptZipEntry();
  }

  const entries: ZipEntryIntegrity[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset
      || view.getUint32(offset, true) !== ZIP_CENTRAL_ENTRY_SIGNATURE) {
      return corruptZipEntry();
    }
    const flags = view.getUint16(offset + 8, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const originalSize = view.getUint32(offset + 24, true);
    const nameBytes = view.getUint16(offset + 28, true);
    const extraBytes = view.getUint16(offset + 30, true);
    const commentBytes = view.getUint16(offset + 32, true);
    const nextOffset = offset + 46 + nameBytes + extraBytes + commentBytes;
    if (compressedSize === ZIP32_MAX_VALUE
      || originalSize === ZIP32_MAX_VALUE
      || nextOffset > endOffset) {
      return corruptZipEntry();
    }
    const name = strFromU8(
      bytes.subarray(offset + 46, offset + 46 + nameBytes),
      (flags & 0x0800) === 0,
    );
    if (names.has(name)) return corruptZipEntry();
    names.add(name);
    entries.push({ name, crc32, originalSize });
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralBytes) return corruptZipEntry();
  return entries;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function validateUnzippedEntries(
  integrity: ZipEntryIntegrity[],
  entries: Unzipped,
): void {
  if (Object.keys(entries).length !== integrity.length) return corruptZipEntry();
  for (const expected of integrity) {
    if (!Object.prototype.hasOwnProperty.call(entries, expected.name)) {
      return corruptZipEntry();
    }
    const entry = entries[expected.name];
    if (entry.byteLength !== expected.originalSize || crc32(entry) !== expected.crc32) {
      return corruptZipEntry();
    }
  }
}

interface ArchivedConversation extends Omit<Conversation, 'messages' | 'custom_skills'> {
  messages: ArchivedMessage[];
}

interface ArchivedMessage extends Omit<Message, 'attachments'> {
  attachments?: ArchivedAttachment[];
}

interface ArchivedAttachment {
  id: string;
  name: string;
  mime: string;
  isImage: boolean;
  size: number;
  /** Path inside the archive, e.g. "attachments/abc123-random.py" */
  file: string;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Build a .zip Blob for the given conversations. For any conversation whose
 * live messages are not proven complete, calls `loadMessages(id)` to fetch the
 * authoritative rows from Dexie on demand. Without a loader, incomplete input
 * is rejected instead of silently archived. Database loads are sequential,
 * but projected messages accumulate for every conversation. Attachment byte
 * entries, serialized JSON, and the ZIP output can coexist in memory. This
 * implementation uses zipSync; it does not stream the archive.
 *
 * Custom skills owned by each conversation are extracted into a
 * skills/ folder with a manifest.json. The conversations.json omits
 * custom_skills — the importer reconstructs them from the
 * manifest and files.
 */
export async function buildArchive(
  convs: Conversation[],
  loadMsgs?: (id: string) => Promise<Message[]>,
  loadWhiteboardVersions?: LoadWhiteboardVersions,
): Promise<Blob> {
  if (convs.some((conversation) => isConversationStructurallyLocked(conversation.id))) {
    throw new Error(ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE);
  }
  if (convs.length === 0) {
    throw new Error('No conversations to export.');
  }

  const files: Record<string, Uint8Array> = {};
  let fileCount = 0;
  const addFile = (path: string, bytes: Uint8Array): void => {
    if (!Object.prototype.hasOwnProperty.call(files, path)) {
      fileCount += 1;
      if (fileCount > MAX_ARCHIVE_ENTRIES) {
        throw new Error(
          `This export needs more than ${MAX_ARCHIVE_ENTRIES} zip entries. Export conversations individually instead.`,
        );
      }
    }
    if (bytes.byteLength > MAX_ARCHIVE_ENTRY_BYTES) {
      throw new Error('This export contains an item larger than 500 MB. Remove the large item and try again.');
    }
    files[path] = bytes;
  };
  const archivedConvs: ArchivedConversation[] = [];
  const whiteboardConversations: ArchivedWhiteboardConversation[] = [];
  const skillManifest: SkillManifest = {
    format: 'llm-client:skill-manifest',
    version: SKILL_MANIFEST_VERSION,
    skills: [],
  };
  let attCount = 0;

  for (const conv of convs) {
    // Load messages on demand whenever the live snapshot is not proven
    // complete. Exporting a non-empty but partial array would silently create a
    // truncated archive. A successful Dexie read is authoritative regardless
    // of a stale cached messageCount; the archive writes the reconciled count.
    let msgs = conv.messages;
    if (!isConversationMessageHistoryComplete(conv)) {
      if (!loadMsgs) {
        throw new Error(
          `Conversation "${conv.title}" is not fully loaded; reload it before exporting.`,
        );
      }
      msgs = await loadMsgs(conv.id);
    }

    // `buildArchive` stays usable as a pure helper in Node tests. Production
    // export wrappers supply the retained-row loader. Without one, only a
    // conversation with no Whiteboard references can be represented safely;
    // a referenced archive must fail instead of silently dropping rows.
    if (!loadWhiteboardVersions && messagesHaveWhiteboardReferences(msgs)) {
      throw new Error(
        `Conversation "${conv.title}" has Whiteboard references but its retained versions were not loaded.`,
      );
    }
    const whiteboardVersions = loadWhiteboardVersions
      ? await loadWhiteboardVersions(conv.id)
      : [];
    if (whiteboardVersions.length > 0) {
      whiteboardConversations.push({
        conversationId: conv.id,
        versions: whiteboardVersions.map(portableWhiteboardVersion),
      });
    }

    // Extract custom skills into files and manifest.
    const customSkills = conv.custom_skills ?? [];
    for (const skill of customSkills) {
      const filename = skillMarkdownFilename(skill, skillManifest.skills);
      const filePath = `skills/${filename}`;
      addFile(filePath, strToU8(skillToMarkdown(skill)));
      skillManifest.skills.push({
        conversationId: conv.id,
        skillId: skill.id,
        source: 'custom',
        file: filePath,
        name: skill.name,
        description: skill.description,
        revision: skill.revision,
        createdAt: skill.createdAt,
        updatedAt: skill.updatedAt,
      });
    }

    const archivedMessages: ArchivedMessage[] = [];
    for (const sourceMessage of msgs) {
      // Archive the same field set that survives a Dexie round trip. This
      // excludes transient lifecycle state such as `streaming` and keeps export
      // aligned with clone/reload semantics without a bespoke transient list.
      const m = persistedMessageSnapshot(sourceMessage);
      if (!m.attachments || m.attachments.length === 0) {
        archivedMessages.push(m as ArchivedMessage);
        continue;
      }
      const archivedAtts: ArchivedAttachment[] = [];
      for (const a of m.attachments) {
        const blob = await loadAttachment(a.id);
        if (!blob) {
          // Stale IDB reference — record metadata only, no file. Re-import
          // will show this as a "preview unavailable" attachment.
          archivedAtts.push({
            id: a.id,
            name: a.name,
            mime: a.mime,
            isImage: a.isImage,
            size: a.size,
            file: '',
          });
          continue;
        }
        const safeName = `${a.id}-${sanitizeAttachmentName(a.name)}`;
        const path = `attachments/${safeName}`;
        if (blob.size > MAX_ARCHIVE_ENTRY_BYTES) {
          throw new Error('This export contains an item larger than 500 MB. Remove the large item and try again.');
        }
        addFile(path, new Uint8Array(await blob.arrayBuffer()));
        archivedAtts.push({
          id: a.id,
          name: a.name,
          mime: a.mime,
          isImage: a.isImage,
          size: a.size,
          file: path,
        });
        attCount++;
      }
      const { attachments: _drop, ...rest } = m;
      archivedMessages.push({ ...rest, attachments: archivedAtts });
    }
    // Strip custom_skills — the manifest carries them.
    const { custom_skills: _cs, ...convRest } = conv;
    archivedConvs.push({
      ...convRest,
      messageCount: archivedMessages.length,
      messages: archivedMessages,
    });
  }

  // Build the archive.
  const archive: ArchiveFile = {
    format: 'llm-client:archive',
    version: ARCHIVE_VERSION,
    exportedAt: Date.now(),
    conversations: archivedConvs,
  };
  const whiteboardArchive: WhiteboardArchiveFile = {
    format: 'llm-client:whiteboard',
    version: ARCHIVE_VERSION,
    conversations: whiteboardConversations,
  };

  // Never emit a carrier that the importer would reject. This catches stale
  // message references and malformed storage rows before any ZIP is produced.
  validateWhiteboardArchive(whiteboardArchive, archivedConvs);

  const readme = [
    'LC: conversation archive',
    '========================',
    '',
    `This zip contains ${convs.length} conversation${convs.length === 1 ? '' : 's'},`,
    `${skillManifest.skills.length} custom skill${skillManifest.skills.length === 1 ? '' : 's'},`,
    `and ${attCount} attachment${attCount === 1 ? '' : 's'}.`,
    '',
    'Structure:',
    '  - README.txt              what this is',
    '  - conversations.json      array of conversations (source of truth)',
    '  - whiteboard.json         retained board versions by conversation',
    '  - attachments/<id>-<name> file bytes, flat folder, one per attachment',
    '  - skills/manifest.json    custom skill mapping per conversation',
    '  - skills/lc_skill_<name>.md custom skill Markdown files',
    '',
    'To restore: open LC, go to Settings → Conversations → Import, and pick this zip.',
    'Imported conversations merge into your list by ID — existing entries',
    'are updated in place, new IDs are added. Attachments are restored',
    'to local storage so previews work again.',
    '',
    'Conversations included:',
    ...convs.map((c, i) => `  ${(i + 1).toString().padStart(3)}. ${c.title}`),
    '',
  ].join('\n');

  addFile('README.txt', strToU8(readme));
  addFile('conversations.json', strToU8(JSON.stringify(archive, null, 2)));
  addFile('whiteboard.json', strToU8(JSON.stringify(whiteboardArchive, null, 2)));

  // Write skills manifest if there are any custom skills.
  if (skillManifest.skills.length > 0) {
    addFile('skills/manifest.json', strToU8(JSON.stringify(skillManifest, null, 2)));
  }

  const zipped = zipSync(files, { level: 6 });
  if (zipped.byteLength > MAX_ARCHIVE_FILE_BYTES) {
    throw new Error('This export is larger than 1 GB. Export conversations individually instead.');
  }
  return new Blob([zipped as BlobPart], { type: 'application/zip' });
}

/** Save one conversation as a .zip archive. */
export async function exportConversationArchive(
  conv: Conversation,
  loadMsgs?: (id: string) => Promise<Message[]>,
  loadWhiteboardVersions?: LoadWhiteboardVersions,
): Promise<boolean> {
  const blob = await buildArchive([conv], loadMsgs, loadWhiteboardVersions);
  const filename = lcExportFileName(`chat-v${ARCHIVE_VERSION}-${conv.id.slice(0, 8)}`, 'zip');
  return saveBlobFile(filename, blob, [
    { name: 'Zip archive', extensions: ['zip'] },
  ]);
}

/** Save every conversation as a single .zip archive. */
export async function exportAllArchives(
  convs: Conversation[],
  loadMsgs?: (id: string) => Promise<Message[]>,
  loadWhiteboardVersions?: LoadWhiteboardVersions,
): Promise<boolean> {
  const blob = await buildArchive(convs, loadMsgs, loadWhiteboardVersions);
  return saveBlobFile(lcExportFileName(`chat-v${ARCHIVE_VERSION}-all`, 'zip'), blob, [
    { name: 'Zip archive', extensions: ['zip'] },
  ]);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface StagedArchiveAttachment {
  id: string;
  blob: Blob;
  mime: string;
  name: string;
  size: number;
}

export interface ImportedConversation {
  conversation: Conversation;
  /** Validated retained rows for the caller's later atomic conversation
   * replacement. Working rows are never present in an archive. */
  whiteboardVersions: ArchivedWhiteboardVersion[];
  /** Count of attachments that came back with bytes (re-stored in IDB). */
  attachmentsRestored: number;
  /** Count of attachments that were referenced but missing. */
  attachmentsMissing: number;
  /** Parsed bytes awaiting lifetime-fenced installation by the importer. */
  stagedAttachments?: StagedArchiveAttachment[];
}

/**
 * Read a .zip archive File and return its validated conversations. The public
 * wrappers choose whether attachment bytes are restored immediately for
 * inspection or staged for the transactional importer.
 *
 * Always returns an array, even for an archive that came from a
 * per-chat export (the array will have length 1).
 */
/** Import resource bounds. A conversation archive is a bounded document
 *  set; anything larger is refused before its bytes are decompressed. */
export interface ReadArchiveLimits {
  maxFileBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
}

const DEFAULT_ARCHIVE_LIMITS: ReadArchiveLimits = {
  maxFileBytes: MAX_ARCHIVE_FILE_BYTES,
  maxEntries: MAX_ARCHIVE_ENTRIES,
  maxEntryBytes: MAX_ARCHIVE_ENTRY_BYTES,
};

async function readArchiveInternal(
  file: File,
  limits: ReadArchiveLimits,
  persistAttachments: boolean,
): Promise<ImportedConversation[]> {
  if (file.size > limits.maxFileBytes) {
    throw new Error('This archive is too large to be a conversation archive.');
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  const integrity = readZipEntryIntegrity(buf);
  if (integrity.length > limits.maxEntries) {
    throw new Error(
      `This archive contains more than ${limits.maxEntries} entries, which exceeds the import limits.`,
    );
  }
  if (integrity.some((entry) => entry.originalSize > limits.maxEntryBytes)) {
    throw new Error('This archive contains an entry that exceeds the import limits.');
  }
  // Enforce the entry limits inside the unzip filter: an entry that fails
  // the check is never inflated, so the caps bound memory before extraction
  // rather than after it — a hostile archive cannot make us allocate its
  // contents first.
  let entryCount = 0;
  let overLimit: 'entries' | 'entry-size' | null = null;
  const entries: Unzipped = unzipSync(buf, {
    filter: (info) => {
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        overLimit = 'entries';
        return false;
      }
      if (info.originalSize > limits.maxEntryBytes) {
        overLimit = 'entry-size';
        return false;
      }
      return true;
    },
  });
  if (overLimit === 'entries') {
    throw new Error(
      `This archive contains more than ${limits.maxEntries} entries, which exceeds the import limits.`,
    );
  }
  if (overLimit === 'entry-size') {
    throw new Error('This archive contains an entry that exceeds the import limits.');
  }
  validateUnzippedEntries(integrity, entries);

  const jsonEntry = entries['conversations.json'];
  if (!jsonEntry) {
    throw new Error(
      'This zip is missing conversations.json. Not a valid LC archive.',
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(strFromU8(jsonEntry));
  } catch {
    throw new Error('conversations.json is not valid JSON.');
  }
  const parsed = requireArchiveFile(parsedJson);
  // The envelope check above only validates the container. Validate each
  // conversation entry too, so a crafted archive fails with the archive
  // error instead of a raw TypeError halfway through attachment restoration.
  for (const conversation of parsed.conversations) {
    if (!isConversationLike(conversation)) {
      throw new Error('This file is not a conversation archive from LLM Client.');
    }
    // Validate opaque native state before restoring any attachment or row.
    for (const message of conversation.messages) {
      if (message.gemini_interactions !== undefined) validateGeminiGroups(message.gemini_interactions);
    }
  }

  // Archive v1 always carries the root Whiteboard carrier. Its conversation
  // groups are sparse, so a chat with no retained rows needs no group. Validate
  // every present row and every message/source reference before the first
  // attachment blob can be persisted.
  const whiteboardEntry = entries['whiteboard.json'];
  if (!whiteboardEntry) {
    throw new Error(
      'This zip is missing whiteboard.json. Not a valid LC conversation archive v1.',
    );
  }
  let parsedWhiteboard: unknown;
  try {
    parsedWhiteboard = JSON.parse(strFromU8(whiteboardEntry));
  } catch {
    throw new Error('whiteboard.json is not valid JSON.');
  }
  const whiteboardVersionsByConversation = validateWhiteboardArchive(
    parsedWhiteboard,
    parsed.conversations,
  );

  // Read skills manifest if present. A present-but-invalid manifest is a
  // corrupt archive, not a reason to silently import conversations without
  // their custom skills.
  let skillManifest: SkillManifest | null = null;
  const manifestEntry = entries['skills/manifest.json'];
  if (manifestEntry) {
    try {
      const parsedManifest = JSON.parse(strFromU8(manifestEntry));
      if (!isSkillManifest(parsedManifest)) {
        throw new Error('skills/manifest.json has an unsupported format.');
      }
      skillManifest = parsedManifest;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(
          `Could not read custom skills from this archive: ${error.message}`,
          { cause: error },
        );
      }
      throw new Error('Could not read custom skills from this archive.', {
        cause: error,
      });
    }
  }

  // Build a lookup of custom skills per conversation from the manifest.
  const skillsByConvId = new Map<string, ConversationSkill[]>();
  const archiveConversationIds = new Set(parsed.conversations.map((conversation) => conversation.id));
  if (skillManifest) {
    for (const entry of skillManifest.skills) {
      if (!archiveConversationIds.has(entry.conversationId)) {
        throw new Error(
          `Skill manifest references unknown conversation: ${entry.conversationId}`,
        );
      }
      let list = skillsByConvId.get(entry.conversationId);
      if (!list) {
        list = [];
        skillsByConvId.set(entry.conversationId, list);
      }
      if (entry.source !== 'custom') {
        throw new Error(`Skill manifest entry for ${entry.file} is not a custom skill.`);
      }
      const skillFileName = entry.file.slice('skills/'.length);
      if (!entry.file.startsWith('skills/')
        || !skillFileName
        || skillFileName.includes('/')
        || skillFileName.includes('\\')
        || skillFileName === '.'
        || skillFileName === '..') {
        throw new Error(`Skill manifest entry has an unsafe file path: ${entry.file}`);
      }

      // Read and parse the skill Markdown from the archive. The file carries
      // the portable Markdown header but deliberately has no custom UUID;
      // the manifest restores the conversation-scoped identity and metadata.
      const fileData = entries[entry.file];
      if (!fileData) {
        throw new Error(`Skill manifest references a missing file: ${entry.file}`);
      }
      const parsedSkill = parseSkillMarkdown(strFromU8(fileData), entry.file);
      const now = Date.now();
      const customSkill: ConversationSkill = {
        id: entry.skillId,
        source: 'custom',
        name: entry.name || parsedSkill.name,
        description: entry.description ?? parsedSkill.description,
        content: parsedSkill.content,
        revision: entry.revision ?? parsedSkill.revision,
        createdAt: entry.createdAt ?? now,
        updatedAt: entry.updatedAt ?? now,
      };
      list.push(customSkill);
    }
  }

  // Prepare attachment bytes. Inspection callers restore immediately; the
  // transactional importer receives staged blobs. Missing entries are counted
  // per conversation so the caller can show a useful result.
  const results: ImportedConversation[] = [];
  for (const conv of parsed.conversations) {
    let restored = 0;
    let missing = 0;
    const stagedAttachments: StagedArchiveAttachment[] = [];
    for (const m of conv.messages) {
      if (!m.attachments) continue;
      for (const a of m.attachments) {
        if (!a.file) {
          missing++;
          continue;
        }
        const data = entries[a.file];
        if (!data) {
          missing++;
          continue;
        }
        if (data.byteLength !== a.size) {
          throw new Error(
            'This conversation archive contains an attachment whose size does not match its metadata.',
          );
        }
        const blob = new Blob([data as BlobPart], {
          type: a.mime || 'application/octet-stream',
        });
        const attachment = {
          id: a.id,
          blob,
          mime: a.mime,
          name: a.name,
          size: a.size,
        };
        if (persistAttachments) {
          await putAttachment(attachment.id, attachment.blob, attachment);
        } else {
          stagedAttachments.push(attachment);
        }
        restored++;
      }
    }
    // Convert back to the in-app Conversation shape: drop the
    // archive-only `file` field, mark attachments as stored in IDB.
    // Restore custom_skills from the manifest.
    const convSkills = skillsByConvId.get(conv.id) ?? [];
    // Normalize on archive read so restored UI state and runtime authorization
    // use exactly the same current grant representation.
    // `sortOrder` re-sequencing is a per-CONVERSATION decision, not a
    // per-message one: if any message carries a value outside the counter
    // domain (absent, or the ~1.75e12 timestamp fallback), every message of
    // the conversation is renumbered 1..n in archive order. Mixing kept
    // counters with freshly assigned indices would land both in the same
    // number space and duplicate [conversationId+sortOrder] keys
    // (docs/data-model.md).
    const renumber = conv.messages.some(
      (message) => !isCounterDomainSortOrder(message.sortOrder),
    );
    const out: Conversation = {
      ...conv,
      tools: conv.tools ? normalizeGrantState(conv.tools) : undefined,
      custom_skills: convSkills.length > 0 ? convSkills : undefined,
      messages: conv.messages.map((m, index) => {
        const { streaming: _streaming, ...message } = m;
        return {
          ...message,
          sortOrder: renumber ? index + 1 : m.sortOrder,
          attachments: m.attachments?.map((attachment) => {
            const transient = attachment as ArchivedAttachment & { dataUrl?: string };
            const { file: _file, dataUrl: _dataUrl, ...metadata } = transient;
            return { ...metadata, stored: 'idb' as const };
          }),
        };
      }),
    };
    results.push({
      conversation: out,
      whiteboardVersions: whiteboardVersionsByConversation.get(conv.id) ?? [],
      attachmentsRestored: restored,
      attachmentsMissing: missing,
      ...(stagedAttachments.length > 0 ? { stagedAttachments } : {}),
    });
  }
  return results;
}

/** Parse and immediately restore blobs. Kept for archive-inspection callers. */
export function readArchive(
  file: File,
  limits: ReadArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<ImportedConversation[]> {
  return readArchiveInternal(file, limits, true);
}

/** Parse without mutating attachment storage; the importer commits these bytes. */
export function readArchiveStaged(
  file: File,
  limits: ReadArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<ImportedConversation[]> {
  return readArchiveInternal(file, limits, false);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WHITEBOARD_VERSION_ID = /^[um]_\d{13}$/;
const WHITEBOARD_MAX_DOCUMENT_BYTES = 32 * 1024;

function portableWhiteboardVersion(
  version: ArchivedWhiteboardVersion,
): ArchivedWhiteboardVersion {
  return {
    conversationId: version.conversationId,
    id: version.id,
    owner: version.owner,
    content: version.content,
    createdAt: version.createdAt,
    sequence: version.sequence,
    sourceMessageId: version.sourceMessageId,
    sourceToolCallId: version.sourceToolCallId,
  };
}

function messagesHaveWhiteboardReferences(messages: Message[]): boolean {
  return messages.some(
    (message) => message.user_board !== undefined || message.whiteboard_refs !== undefined,
  );
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function whiteboardIntegrityError(message: string): never {
  throw new Error(`whiteboard.json integrity error: ${message}.`);
}

function isArchivedWhiteboardBaseline(
  version: ArchivedWhiteboardVersion | undefined,
  owner: WhiteboardOwner,
  sequence: number,
): boolean {
  return version !== undefined
    && version.owner === owner
    && version.sequence === sequence
    && version.content === ''
    && version.sourceMessageId === null
    && version.sourceToolCallId === null;
}

/**
 * Validate the complete carrier against the complete transcript before import
 * is allowed to persist attachment bytes. The returned rows are freshly
 * projected portable objects, so callers never retain unvalidated fields.
 */
function validateWhiteboardArchive(
  value: unknown,
  conversations: ArchivedConversation[],
): Map<string, ArchivedWhiteboardVersion[]> {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['format', 'version', 'conversations'])
    || value.format !== 'llm-client:whiteboard'
    || value.version !== ARCHIVE_VERSION
    || !Array.isArray(value.conversations)) {
    return whiteboardIntegrityError('the carrier has an unsupported shape or version');
  }

  const conversationsById = new Map<string, ArchivedConversation>();
  for (const conversation of conversations) {
    if (conversationsById.has(conversation.id)) {
      return whiteboardIntegrityError(
        `conversations.json repeats conversation ${JSON.stringify(conversation.id)}`,
      );
    }
    conversationsById.set(conversation.id, conversation);
  }

  const versionsByConversation = new Map<string, ArchivedWhiteboardVersion[]>();
  for (const rawGroup of value.conversations) {
    if (!isRecord(rawGroup)
      || !hasOnlyKeys(rawGroup, ['conversationId', 'versions'])
      || typeof rawGroup.conversationId !== 'string'
      || rawGroup.conversationId.length === 0
      || !Array.isArray(rawGroup.versions)) {
      return whiteboardIntegrityError('a conversation group has an invalid shape');
    }
    const conversationId = rawGroup.conversationId;
    if (!conversationsById.has(conversationId)) {
      return whiteboardIntegrityError(
        `the carrier references unknown conversation ${JSON.stringify(conversationId)}`,
      );
    }
    if (versionsByConversation.has(conversationId)) {
      return whiteboardIntegrityError(
        `the carrier repeats conversation group ${JSON.stringify(conversationId)}`,
      );
    }

    const versions: ArchivedWhiteboardVersion[] = [];
    const ids = new Set<string>();
    const sequences = new Set<number>();
    let priorSequence = 0;
    for (const rawVersion of rawGroup.versions) {
      if (!isRecord(rawVersion)
        || !hasOnlyKeys(rawVersion, [
          'conversationId',
          'id',
          'owner',
          'content',
          'createdAt',
          'sequence',
          'sourceMessageId',
          'sourceToolCallId',
        ])
        || typeof rawVersion.conversationId !== 'string'
        || typeof rawVersion.id !== 'string'
        || (rawVersion.owner !== 'user' && rawVersion.owner !== 'model')
        || typeof rawVersion.content !== 'string'
        || !Number.isSafeInteger(rawVersion.createdAt)
        || (rawVersion.createdAt as number) < 0
        || !Number.isSafeInteger(rawVersion.sequence)
        || (rawVersion.sequence as number) <= 0
        || !(rawVersion.sourceMessageId === null
          || (typeof rawVersion.sourceMessageId === 'string'
            && rawVersion.sourceMessageId.length > 0))
        || !(rawVersion.sourceToolCallId === null
          || (typeof rawVersion.sourceToolCallId === 'string'
            && rawVersion.sourceToolCallId.length > 0))) {
        return whiteboardIntegrityError(
          `conversation ${JSON.stringify(conversationId)} contains an invalid retained row`,
        );
      }
      const version = portableWhiteboardVersion(
        rawVersion as unknown as ArchivedWhiteboardVersion,
      );
      if (version.conversationId !== conversationId) {
        return whiteboardIntegrityError(
          `retained row ${JSON.stringify(version.id)} belongs to a different conversation group`,
        );
      }
      const expectedPrefix = version.owner === 'user' ? 'u_' : 'm_';
      if (!WHITEBOARD_VERSION_ID.test(version.id) || !version.id.startsWith(expectedPrefix)) {
        return whiteboardIntegrityError(
          `retained row ${JSON.stringify(version.id)} does not match its owner prefix`,
        );
      }
      if (ids.has(version.id)) {
        return whiteboardIntegrityError(
          `conversation ${JSON.stringify(conversationId)} repeats retained id ${JSON.stringify(version.id)}`,
        );
      }
      if (sequences.has(version.sequence) || version.sequence <= priorSequence) {
        return whiteboardIntegrityError(
          `conversation ${JSON.stringify(conversationId)} has duplicate or non-monotonic retained sequences`,
        );
      }
      if (new TextEncoder().encode(version.content).byteLength > WHITEBOARD_MAX_DOCUMENT_BYTES) {
        return whiteboardIntegrityError(
          `retained row ${JSON.stringify(version.id)} exceeds the 32 KiB document limit`,
        );
      }
      if (version.owner === 'user' && version.sourceToolCallId !== null) {
        return whiteboardIntegrityError(
          `user retained row ${JSON.stringify(version.id)} has a model tool-call source`,
        );
      }
      if (version.sourceMessageId === null && version.sourceToolCallId !== null) {
        return whiteboardIntegrityError(
          `retained row ${JSON.stringify(version.id)} has a tool-call source without a message source`,
        );
      }
      ids.add(version.id);
      sequences.add(version.sequence);
      priorSequence = version.sequence;
      versions.push(version);
    }
    if (
      !isArchivedWhiteboardBaseline(versions[0], 'user', 1)
      || !isArchivedWhiteboardBaseline(versions[1], 'model', 2)
    ) {
      return whiteboardIntegrityError(
        `conversation ${JSON.stringify(conversationId)} does not begin with the empty user and model initialization baselines`,
      );
    }
    versionsByConversation.set(conversationId, versions);
  }

  for (const [conversationId, conversation] of conversationsById) {
    const versions = versionsByConversation.get(conversationId) ?? [];
    if (conversation.tools?.whiteboard_enabled === true && versions.length === 0) {
      return whiteboardIntegrityError(
        `enabled conversation ${JSON.stringify(conversationId)} has no retained Whiteboard baselines`,
      );
    }
    const versionsById = new Map(versions.map((version) => [version.id, version]));
    const messagesById = new Map<string, ArchivedMessage>();
    for (const message of conversation.messages) {
      if (messagesById.has(message.id)) {
        return whiteboardIntegrityError(
          `conversation ${JSON.stringify(conversationId)} repeats message id ${JSON.stringify(message.id)}`,
        );
      }
      messagesById.set(message.id, message);
    }

    const requireVersion = (
      id: string,
      owner: WhiteboardOwner,
      field: string,
    ): ArchivedWhiteboardVersion => {
      const version = versionsById.get(id);
      if (!version || version.owner !== owner) {
        return whiteboardIntegrityError(
          `${field} references missing ${owner} retained row ${JSON.stringify(id)} in conversation ${JSON.stringify(conversationId)}`,
        );
      }
      return version;
    };

    for (const message of conversation.messages) {
      if (message.user_board !== undefined) {
        if (message.role !== 'user' || typeof message.user_board !== 'string') {
          return whiteboardIntegrityError(
            `message ${JSON.stringify(message.id)} has an invalid user_board reference`,
          );
        }
        requireVersion(message.user_board, 'user', `message ${JSON.stringify(message.id)} user_board`);
      }
      if (message.whiteboard_refs !== undefined) {
        const refs = message.whiteboard_refs as unknown;
        if (message.role !== 'assistant'
          || !isRecord(refs)
          || !hasOnlyKeys(refs, [
            'user_board',
            'model_initial_board',
            'model_latest_board',
          ])
          || typeof refs.user_board !== 'string'
          || typeof refs.model_initial_board !== 'string'
          || typeof refs.model_latest_board !== 'string') {
          return whiteboardIntegrityError(
            `message ${JSON.stringify(message.id)} has invalid whiteboard_refs`,
          );
        }
        requireVersion(
          refs.user_board,
          'user',
          `message ${JSON.stringify(message.id)} whiteboard_refs.user_board`,
        );
        const initial = requireVersion(
          refs.model_initial_board,
          'model',
          `message ${JSON.stringify(message.id)} whiteboard_refs.model_initial_board`,
        );
        const latest = requireVersion(
          refs.model_latest_board,
          'model',
          `message ${JSON.stringify(message.id)} whiteboard_refs.model_latest_board`,
        );
        if (latest.sequence < initial.sequence) {
          return whiteboardIntegrityError(
            `message ${JSON.stringify(message.id)} points its model latest reference before its initial reference`,
          );
        }
      }
    }

    for (const version of versions) {
      if (version.sourceMessageId === null) continue;
      const sourceMessage = messagesById.get(version.sourceMessageId);
      const expectedRole = version.owner === 'user' ? 'user' : 'assistant';
      if (!sourceMessage || sourceMessage.role !== expectedRole) {
        return whiteboardIntegrityError(
          `retained row ${JSON.stringify(version.id)} references a missing ${expectedRole} source message`,
        );
      }
      if (version.owner === 'user' && sourceMessage.user_board !== version.id) {
        return whiteboardIntegrityError(
          `user retained row ${JSON.stringify(version.id)} is not pinned by its source message`,
        );
      }
      if (version.owner === 'model'
        && sourceMessage.whiteboard_refs?.model_latest_board !== version.id) {
        return whiteboardIntegrityError(
          `model retained row ${JSON.stringify(version.id)} is not the latest row on its source message`,
        );
      }
      if (version.sourceToolCallId !== null) {
        const owningCall = sourceMessage.tool_calls?.find(
          (call) => call.id === version.sourceToolCallId,
        );
        if (!owningCall) {
          return whiteboardIntegrityError(
            `model retained row ${JSON.stringify(version.id)} references a missing source tool call`,
          );
        }
      }
    }
  }

  return versionsByConversation;
}

/** Strip path separators and characters that would break a zip
 *  entry. The attachment id prefix keeps names unique even if two
 *  conversations both have a file called `script.py`. */
function sanitizeAttachmentName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'file';
}

/** Convert a ConversationSkill to its user-facing Markdown format. */
function skillToMarkdown(skill: ConversationSkill): string {
  const metadata = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
  return [
    '---',
    `name: ${metadata(skill.name)}`,
    `description: ${metadata(skill.description)}`,
    `revision: ${skill.revision ?? 1}`,
    '---',
    '',
    skill.content,
    '',
  ].join('\n');
}

/** Generate a unique filename for a custom skill inside the archive. */
function skillMarkdownFilename(skill: ConversationSkill, existing: SkillManifestEntry[]): string {
  const base = skill.name
    .replace(/[<>:"/\\|?*]/g, '-')
    .split('').map((char) => char.charCodeAt(0) < 32 ? '-' : char).join('')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
    .toLowerCase()
    || 'custom-skill';
  let filename = `lc_skill_${base}.md`;
  const used = new Set(existing.map((entry) => entry.file.toLowerCase()));
  let suffix = 2;
  while (used.has(`skills/${filename}`.toLowerCase())) {
    filename = `lc_skill_${base}-${suffix++}.md`;
  }
  return filename;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Each archived attachment must be shaped well enough for the restoration
 *  loop (`m.attachments` iteration and the `id`/`name`/`mime`/`file`/`size`
 *  reads) not to throw on it. */
function isArchivedAttachmentArray(value: unknown): boolean {
  return Array.isArray(value)
    && value.every((attachment) => isRecord(attachment)
      && typeof attachment.id === 'string'
      && attachment.id.length > 0
      && typeof attachment.name === 'string'
      && typeof attachment.mime === 'string'
      && typeof attachment.isImage === 'boolean'
      && typeof attachment.file === 'string'
      && isFiniteNumber(attachment.size)
      && attachment.size >= 0);
}

function isMessageRole(value: unknown): boolean {
  return value === 'system'
    || value === 'developer'
    || value === 'user'
    || value === 'assistant'
    || value === 'tool';
}

/** Structural floor for a conversation entry: enough to guarantee the
 *  restoration loop above cannot throw on this shape — message attachments
 *  included. */
function isConversationLike(x: unknown): boolean {
  if (!isRecord(x)) return false;
  return typeof x.id === 'string'
    && x.id.length > 0
    && typeof x.title === 'string'
    && isFiniteNumber(x.createdAt)
    && isFiniteNumber(x.updatedAt)
    && isRecord(x.params)
    && Array.isArray(x.messages)
    && x.messages.every((message) => {
      if (!isRecord(message)) return false;
      if (typeof message.id !== 'string' || message.id.length === 0) return false;
      if (!isMessageRole(message.role)) return false;
      if (typeof message.content !== 'string' || !isFiniteNumber(message.createdAt)) return false;
      return message.attachments === undefined
        || isArchivedAttachmentArray(message.attachments);
    });
}

function requireArchiveFile(x: unknown): ArchiveFile {
  if (!isRecord(x) || x.format !== 'llm-client:archive') {
    throw new Error('This file is not a conversation archive from LLM Client.');
  }
  if (x.version !== ARCHIVE_VERSION) {
    throw new Error(
      `Unsupported conversation archive version ${String(x.version)}. This LC build imports version ${ARCHIVE_VERSION}.`,
    );
  }
  if (!Array.isArray(x.conversations)) {
    throw new Error('This file is not a conversation archive from LLM Client.');
  }
  return x as unknown as ArchiveFile;
}

function isSkillManifest(x: unknown): x is SkillManifest {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (o.format !== 'llm-client:skill-manifest'
    || o.version !== SKILL_MANIFEST_VERSION
    || !Array.isArray(o.skills)) return false;
  return o.skills.every((raw) => {
    if (typeof raw !== 'object' || raw === null) return false;
    const entry = raw as Record<string, unknown>;
    return entry.source === 'custom'
      && typeof entry.conversationId === 'string'
      && entry.conversationId.length > 0
      && typeof entry.skillId === 'string'
      && entry.skillId.length > 0
      && typeof entry.file === 'string'
      && entry.file.length > 0
      && typeof entry.name === 'string'
      && entry.name.length > 0
      && (entry.description === undefined || typeof entry.description === 'string')
      && (entry.revision === undefined || (typeof entry.revision === 'number' && Number.isFinite(entry.revision)))
      && (entry.createdAt === undefined || (typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)))
      && (entry.updatedAt === undefined || (typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)));
  });
}
