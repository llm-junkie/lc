/**
 * LC-authored Whiteboard interface text.
 *
 * Keeping the visible copy in one dependency-free module lets the structural
 * plain-language gate exercise the same strings rendered by every entry point.
 */

export const WHITEBOARD_UI_TEXT = Object.freeze({
  title: 'Whiteboard',
  description: 'Conversation notes shared across model turns.',
  open: 'Open whiteboard',
  enable: 'Enable Whiteboard for this conversation',
  modelBoard: 'Model board',
  userBoard: 'User board',
  modelTab: 'Model',
  userTab: 'User',
  ownerTabs: 'Whiteboard boards',
  modelMarkdown: 'Model Whiteboard Markdown',
  editUserMarkdown: 'Edit user Whiteboard Markdown',
  versionUnavailable: 'Whiteboard version unavailable',
  shortVersionUnavailable: 'Version unavailable',
  visibleVersionUnavailable: 'A visible Whiteboard version is unavailable.',
  current: 'Current',
  currentLive: 'Current · Live',
  currentUnsaved: 'Current · Unsaved',
  currentSavedForNextSend: 'Current · Saved for next send',
  unavailable: 'Unavailable',
  newerVersionAvailable: 'Newer version available',
  nothingHereYet: 'Nothing here yet.',
  previousVersion: 'Previous version',
  nextVersion: 'Next version',
  import: 'Import',
  importing: 'Importing…',
  export: 'Export',
  exporting: 'Exporting…',
  close: 'Close',
  closeWhiteboard: 'Close Whiteboard',
  retry: 'Retry',
  loading: 'Loading Whiteboard…',
  edit: 'Edit',
  cancel: 'Cancel',
  save: 'Save',
  saving: 'Saving…',
  unsavedDraft: 'Unsaved draft',
  discardTitle: 'Discard unsaved Whiteboard changes?',
  discardDescription:
    'Your saved board is unchanged. The text currently in the editor will be lost.',
  keepEditing: 'Keep editing',
  discardChanges: 'Discard changes',
  userTooLarge: 'The user Whiteboard exceeds 32 KiB in UTF-8.',
  overLimit: 'Whiteboard exceeds the 32 KiB limit.',
  nearLimit: 'Whiteboard is within 4 KiB of the size limit.',
  bytes: 'bytes',
  savedForNextSend: 'Whiteboard saved for the next send.',
  packageExported: 'Whiteboard package exported.',
  packageImported: 'Whiteboard package imported.',
  packageFilter: 'LC Whiteboard package',
  couldNotLoad: 'Could not load Whiteboard:',
  couldNotSave: 'Could not save Whiteboard:',
  couldNotExport: 'Could not export Whiteboard:',
  couldNotImport: 'Could not import Whiteboard:',
  couldNotOpen: 'Could not open Whiteboard:',
  couldNotInitialize: 'Could not initialize Whiteboard:',
  couldNotEnable: 'Could not enable Whiteboard:',
  nativePackageReadFailed: 'Could not read the selected Whiteboard package.',
});

export type WhiteboardUiOwner = 'model' | 'user';

export function whiteboardHistoryControlsLabel(owner: WhiteboardUiOwner): string {
  return `${owner} Whiteboard history controls`;
}

export function whiteboardPreviousVersionLabel(owner: WhiteboardUiOwner): string {
  return `Previous ${owner} Whiteboard version`;
}

export function whiteboardNextVersionLabel(owner: WhiteboardUiOwner): string {
  return `Next ${owner} Whiteboard version`;
}

export function whiteboardExportNotice(modelVersion: string, userVersion: string): string {
  return `Export model's board (${modelVersion}) and user's board (${userVersion}).`;
}

/** Complete finite sample set for dynamic Whiteboard UI labels. */
export const WHITEBOARD_DYNAMIC_UI_TEXT = Object.freeze([
  ...(['model', 'user'] as const).flatMap((owner) => [
    whiteboardHistoryControlsLabel(owner),
    whiteboardPreviousVersionLabel(owner),
    whiteboardNextVersionLabel(owner),
  ]),
  whiteboardExportNotice('Jan 1, 2026, 12:00:00 AM', 'Jan 1, 2026, 12:00:00 AM'),
]);
