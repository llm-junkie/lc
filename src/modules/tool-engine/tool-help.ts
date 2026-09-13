import type { ToolResultEnvelope } from './types';
import { guidanceCatalog } from './tool-guidance.ts';
import {
  normalizeRequestedToolName,
  resolveToolName,
  type ToolNameCorrection,
} from './tool-name-resolution.ts';

export const TOOL_HELP_MAX_OUTPUT_BYTES = 16 * 1024;
export const TOOL_HELP_MAX_MATCHES = 3;
export const TOOL_HELP_MAX_KEYWORDS = 12;
export const TOOL_HELP_MAX_QUERY_TERMS = 8;

export type ToolHelpMode =
  | 'basic'
  | 'matched'
  | 'no_match'
  | 'ambiguous'
  | 'not_exposed'
  | 'already_returned'
  | 'limit_reached';

export interface ToolHelpData {
  mode: ToolHelpMode;
  requested_tool: string;
  resolved_tool?: string;
  correction?: ToolNameCorrection;
  guidance?: string;
  matches?: Array<{ section: string; guidance: string }>;
  available_keywords?: string[];
  suggestions?: Array<{ tool: string; purpose: string }>;
  message?: string;
}

export interface ToolHelpInput {
  tool: string;
  query?: string;
}

export const TOOL_HELP_MESSAGES = Object.freeze({
  noCatalog: 'Detailed guidance is not available for this tool during the pilot.',
  noMatch: 'No help section matched this query.',
  ambiguous: 'The tool name did not identify one exposed tool.',
  notExposed: 'This tool is not exposed in the current Workspace.',
  duplicate: 'LC already returned this help result during the current turn.',
  totalLimit: 'The total help-attempt limit is reached for this turn.',
  guidanceLimit: 'The help-guidance limit is reached for this turn.',
  lookupLimit: 'The unresolved help-lookup limit is reached for this turn.',
});

export const TOOL_HELP_INPUT_MESSAGES = Object.freeze({
  tool: 'tool must contain from 1 through 80 characters after trimming. Use one exposed tool name within that limit.',
  queryCharacters: 'query must contain at most 160 characters after trimming. Shorten query or omit it for basic help.',
  queryTerms: `query must contain at most ${TOOL_HELP_MAX_QUERY_TERMS} distinct terms. Remove extra terms or omit query for basic help.`,
});

export function normalizeHelpQuery(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

export function distinctHelpQueryTerms(value: string | undefined): string[] {
  return [...new Set(normalizeHelpQuery(value).split(' ').filter(Boolean))];
}

function helpEnvelope(data: ToolHelpData): ToolResultEnvelope<ToolHelpData> {
  return { status: 'ok', data, issues: [], warnings: [] };
}

function serializedBytes(data: ToolHelpData): number {
  return new TextEncoder().encode(JSON.stringify(helpEnvelope(data))).byteLength;
}

function keywordsFor(tool: string): string[] | undefined {
  const values = guidanceCatalog(tool)?.keywords.slice(0, TOOL_HELP_MAX_KEYWORDS);
  return values && values.length > 0 ? [...values] : undefined;
}

function sectionScore(
  query: string,
  terms: readonly string[],
  section: { title: string; aliases: readonly string[]; guidance: string },
): number {
  const labels = [section.title, ...section.aliases].map(normalizeHelpQuery);
  const labelText = labels.join(' ');
  const content = normalizeHelpQuery(section.guidance);
  if (labels.includes(query)) return 500;
  if (labels.some((label) => label.includes(query))) return 450;
  if (terms.every((term) => labelText.includes(term))) return 400;
  if (content.includes(query)) return 300;
  if (terms.every((term) => content.includes(term))) return 250;
  const labelTerms = terms.filter((term) => labelText.includes(term)).length;
  if (labelTerms > 0) return 200 + labelTerms;
  const contentTerms = terms.filter((term) => content.includes(term)).length;
  return contentTerms > 0 ? 100 + contentTerms : 0;
}

function matchedData(
  base: Pick<ToolHelpData, 'requested_tool' | 'resolved_tool' | 'correction'>,
  query: string,
): ToolHelpData {
  const catalog = guidanceCatalog(base.resolved_tool!);
  if (!catalog) {
    return { ...base, mode: 'no_match', message: TOOL_HELP_MESSAGES.noCatalog };
  }
  const terms = distinctHelpQueryTerms(query);
  const ranked = catalog.sections
    .map((section, index) => ({ section, index, score: sectionScore(query, terms, section) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, TOOL_HELP_MAX_MATCHES);

  if (ranked.length === 0) {
    const available = keywordsFor(catalog.tool);
    return {
      ...base,
      mode: 'no_match',
      ...(available ? { available_keywords: available } : {}),
      message: TOOL_HELP_MESSAGES.noMatch,
    };
  }

  const matches: Array<{ section: string; guidance: string }> = [];
  for (const entry of ranked) {
    const candidate = [...matches, {
      section: entry.section.title,
      guidance: entry.section.guidance,
    }];
    const data: ToolHelpData = { ...base, mode: 'matched', matches: candidate };
    if (serializedBytes(data) > TOOL_HELP_MAX_OUTPUT_BYTES) break;
    matches.push(candidate[candidate.length - 1]);
  }
  if (matches.length === 0) {
    const available = keywordsFor(catalog.tool);
    return {
      ...base,
      mode: 'no_match',
      ...(available ? { available_keywords: available } : {}),
      message: TOOL_HELP_MESSAGES.noMatch,
    };
  }
  return { ...base, mode: 'matched', matches };
}

export function buildToolHelpData(
  input: ToolHelpInput,
  exposedNames: ReadonlySet<string>,
): ToolHelpData {
  const resolution = resolveToolName(input.tool, exposedNames);
  if (resolution.kind === 'ambiguous' || resolution.kind === 'unknown') {
    return {
      mode: 'ambiguous',
      requested_tool: input.tool,
      ...(resolution.suggestions.length > 0 ? { suggestions: resolution.suggestions.slice(0, 3) } : {}),
      message: TOOL_HELP_MESSAGES.ambiguous,
    };
  }
  const base = {
    requested_tool: input.tool,
    resolved_tool: resolution.resolved,
    ...(resolution.correction ? { correction: resolution.correction } : {}),
  };
  if (resolution.kind === 'not_exposed') {
    return { ...base, mode: 'not_exposed', message: TOOL_HELP_MESSAGES.notExposed };
  }

  const query = normalizeHelpQuery(input.query);
  if (query) return matchedData(base, query);

  const catalog = guidanceCatalog(resolution.resolved);
  if (!catalog) {
    return { ...base, mode: 'no_match', message: TOOL_HELP_MESSAGES.noCatalog };
  }
  const available = keywordsFor(catalog.tool);
  const data: ToolHelpData = {
    ...base,
    mode: 'basic',
    guidance: catalog.basic,
    ...(available ? { available_keywords: available } : {}),
  };
  if (serializedBytes(data) > TOOL_HELP_MAX_OUTPUT_BYTES) {
    throw new Error(`${catalog.tool} basic help exceeds the serialized output bound.`);
  }
  return data;
}

export function buildToolHelpEnvelope(
  input: ToolHelpInput,
  exposedNames: ReadonlySet<string>,
): ToolResultEnvelope<ToolHelpData> {
  return helpEnvelope(buildToolHelpData(input, exposedNames));
}

export function toolHelpDuplicateKey(
  input: ToolHelpInput,
  exposedNames: ReadonlySet<string>,
): string {
  const resolution = resolveToolName(input.tool, exposedNames);
  const tool = resolution.kind === 'resolved' || resolution.kind === 'not_exposed'
    ? resolution.resolved
    : normalizeRequestedToolName(input.tool);
  return `${tool}\n${normalizeHelpQuery(input.query)}`;
}
