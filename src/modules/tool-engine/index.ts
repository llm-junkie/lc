/**
 * Tool engine — the project's tool-calling runtime.
 *
 * Re-exports everything consumers need:
 *   - Policy (resolveExposure, authorizeCall, TOOL_POLICY, etc.)
 *   - Registry (BUILTIN_TOOLS, HANDLERS_BY_NAME, materialize, enabledTools)
 *   - Runner (validateToolCalls, resolveHandler, executeToolCall, etc.)
 *   - Path safety (cleanPath, isAbsolutePath, sanitizePathSepWhitespace, etc.)
 *   - Sandbox bridge (SandboxBridge, createTauriBridge, createMockBridge)
 *   - Types (ToolHandler, ToolHandlerContext, ToolCallRecord, ToolResultRecord)
 */

// Policy (Phase 1.1–1.2 — must be imported before anything that depends on exposure)
export {
  resolveExposure,
  isExposed,
  authorizeCall,
  authorizeNonFileCall,
  authorizeFileCall,
  resolveFileAuthorization,
  buildGrantSnapshot,
  categoryOf,
  promptDedupeKey,
  normalizePathForMatch,
  findMostSpecificRoot,
  parentDir,
  TOOL_POLICY,
  FILE_IO_READ_ONLY_NAMES,
  FILE_IO_MUTATING_NAMES,
  ALL_TOOL_NAMES,
} from './policy.ts';
export type {
  ToolCategory,
  GrantScope,
  PromptPolicy,
  Mutability,
  ToolPolicyMetadata,
  PersistedToolsConfig,
  ExposureSnapshot,
  AuthorizationState,
  PolicyErrorCode,
  StructuredIssue,
  AuthorizationDecision,
  GrantSnapshot,
  FileAuthorizationResult,
} from './policy';

// Registry
export {
  BUILTIN_TOOLS,
  HANDLERS_BY_NAME,
  materialize,
  enabledTools,
  FILE_IO_NAMES,
  FOUNDATION_NAMES,
  WEB_ACCESS_NAMES,
  OPERATIONAL_TOOL_NAMES,
  SKILLS_NAMES,
  TOOL_HELP_NAMES,
  WHITEBOARD_NAMES,
} from './registry.ts';
export {
  addFileChangePreviews,
  materializeFileChangePreview,
  mergeFileLineChanges,
  summarizeFileLineChanges,
  type FileChangeHunk,
  type FileChangePreviewSource,
  type FileChangeType,
  type FileDiffLine,
  type FileLineChange,
  type FileLineChanges,
} from './file-line-changes.ts';

// Workspace UI state transitions
export { setWorkspaceEnabled, setWebAccessEnabled, setSkillsEnabled } from './workspace-state.ts';
export type { WorkspaceStateConfig } from './workspace-state';
export { normalizeGrantState } from './grant-state.ts';

// Runner
export {
  validateToolCalls,
  admitToolCallsById,
  resolveHandler,
  executeToolCall,
  checkDirPermission,
  wireToRecord,
  sanitizeToolArgs,
  normalizeOptionalAbsence,
  runWithPool,
} from './runner.ts';
export type { ValidatedCall, ResolveResult, DirPermResult } from './runner';

export {
  appendTodoProjectionToContent,
  buildTodoSnapshotIndex,
  formatTodoRequestProjection,
  parseTodoWriteInput,
  requestContainsTodoSnapshotCall,
  resolveTodoRequestProjection,
  todoCounts,
  todoOmittedNotesNotice,
  todoSnapshotToPlainText,
  TODO_ITEM_SCHEMA,
  TODO_TOOL_NAME,
  TODO_WRITE_OUTPUT_SCHEMA,
  TODO_WRITE_SCHEMA,
} from './todo-state.ts';
export type {
  TodoItem,
  TodoSnapshot,
  TodoSnapshotIndex,
  TodoWriteInput,
  TodoWriteOutput,
} from './todo-state';
export { decodeStoredToolResultEnvelope } from './tool-result-content.ts';
export {
  ASK_USER_ANSWER_SCHEMA,
  ASK_USER_BATCH_ISSUE,
  ASK_USER_CHOICE_SCHEMA,
  ASK_USER_INPUT_SCHEMA,
  ASK_USER_OUTPUT_SCHEMA,
  ASK_USER_QUESTION_SCHEMA,
  ASK_USER_TOOL_NAME,
} from './ask-user.ts';
export type {
  AskUserAnswer,
  AskUserChoice,
  AskUserInput,
  AskUserInteraction,
  AskUserInteractionResult,
  AskUserOutput,
  AskUserQuestion,
} from './ask-user';

// Lenient JSON parser (extracted so it's testable without the full import chain)
export { tryParseLenient } from './try-parse-lenient.ts';
export type { LenientParseResult } from './try-parse-lenient';

// Path safety
export {
  cleanPath,
  formatPathForDisplay,
  isAbsolutePath,
  parentDirectory,
  scopeDirForResolved,
  sanitizePathSepWhitespace,
} from './clean-path.ts';
export { checkPath, resolveDirForApprovedScope } from './path-safety.ts';
export type { CheckPathResult } from './path-safety';

// Sandbox bridge
export { createTauriBridge, createMockBridge } from './sandbox-bridge.ts';

// File lock manager (Phase 1.7)
export {
  applyPatchLockTargets,
  canonicalizeLockTargets,
  FileLockManager,
  applicationFileLocks,
  reserveApplyPatchLock,
  type ApplyPatchLockReservation,
} from './file-lock.ts';
export type {
  SandboxBridge,
  ReadFileArgs, ReadFileResult,
  ReadImageArgs, ReadImageResult,
  AnalyzeImagesArgs, AnalyzeImagesResult,
  WriteFileArgs, WriteFileResult,
  ListDirArgs, ListDirResult,
  RunShellArgs, RunShellResult,
  GrepArgs, GrepResult,
  EditArgs, EditResult,
  WebFetchArgs, WebFetchResult,
  WebSearchArgs, WebSearchResult,
} from './sandbox-bridge';

// Types
export type {
  ToolHandler,
  ToolHandlerContext,
  ToolConfig,
  ToolCallRecord,
  ToolResultRecord,
  WhiteboardToolMutationState,
  WhiteboardToolService,
  WhiteboardToolServiceErrorCode,
  WhiteboardToolServiceResult,
  WhiteboardToolSnapshot,
} from './types';
