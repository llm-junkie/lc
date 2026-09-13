export const FIXTURES_DIR: string;

export const CHAT_ARCHIVE: 'lc-chat-v1-all-2026-08-09.7z';
export const SUPPORT_ARCHIVE: 'lc-support-v1-2026-08-09.7z';
export const SUPPORT_DEFAULT_JSON: 'lc-support-v1-2026-08-09-1701.json';
export const SUPPORT_INCLUDED_JSON: 'lc-support-v1-include-2026-08-09-1701.json';

export type ArchiveFixtureName = typeof CHAT_ARCHIVE | typeof SUPPORT_ARCHIVE;

export const ARCHIVE_FIXTURES: readonly [
  {
    readonly archive: typeof CHAT_ARCHIVE;
    readonly expect: readonly ['conversations.json', 'whiteboard.json', 'README.txt', 'attachments'];
  },
  {
    readonly archive: typeof SUPPORT_ARCHIVE;
    readonly expect: readonly [typeof SUPPORT_DEFAULT_JSON, typeof SUPPORT_INCLUDED_JSON];
  },
];

export function extractedDir(archive: string): string;

export function ensureExtracted(): Promise<Record<ArchiveFixtureName, string>>;
