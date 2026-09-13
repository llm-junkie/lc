/**
 * Store-free Safe Start collector for the shared support-report v1 builder.
 *
 * Safe Start and Settings emit the SAME current schema and use the same final
 * serializer. The difference is coverage, not format: store-dependent sections
 * are marked `unavailable` rather than opening a possibly malformed store to
 * recover their counts (docs/support-report.md, docs/troubleshooting.md).
 */

import { LC_VERSION } from '../app-metadata.ts';
import type { StartupDiagnosticSnapshot } from '../startup/startup-state';
import { isTauriRuntime } from '../startup/startup-platform.ts';
import { diagnosticBufferUnreadable, readDiagnosticEvents } from '../utils/diagnostic-events.ts';
import type { SupportReportOptions, SupportReportSnapshot } from '../utils/support-report-base';
import {
  createSupportReportSnapshotV1,
  type SupportReportV1Sources,
} from '../utils/support-report.ts';

function buildChannel(): 'development' | 'release' | 'test' | 'unknown' {
  const mode = import.meta.env?.MODE;
  if (mode === 'test') return 'test';
  if (import.meta.env?.DEV) return 'development';
  if (import.meta.env?.PROD) return 'release';
  return 'unknown';
}

function runtimeFacts(): Record<string, unknown> {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const userAgent = nav?.userAgent ?? '';
  const platform = nav?.platform ?? '';
  const combined = `${platform} ${userAgent}`.toLowerCase();
  const osFamily = combined.includes('windows') || combined.includes('win32')
    ? 'windows'
    : combined.includes('mac')
      ? 'macos'
      : combined.includes('linux')
        ? 'linux'
        : combined.includes('android')
          ? 'android'
          : /iphone|ipad|ipod|ios/.test(combined)
            ? 'ios'
            : 'unknown';
  const architecture = /arm64|aarch64/.test(combined)
    ? 'arm64'
    : /armv?7|\barm\b/.test(combined)
      ? 'arm'
      : /x86_64|x64|win64|amd64|wow64/.test(combined)
        ? 'x86_64'
        : /i[3-6]86|x86|win32/.test(combined)
          ? 'x86'
          : 'unknown';
  let resolved: Partial<Intl.ResolvedDateTimeFormatOptions> = {};
  try {
    resolved = Intl.DateTimeFormat().resolvedOptions();
  } catch {
    // The report builder supplies bounded unknown values.
  }
  const tauri = isTauriRuntime();
  const webviewFamily = tauri
    ? osFamily === 'windows'
      ? 'webview2'
      : osFamily === 'macos'
        ? 'webkit'
        : osFamily === 'linux'
          ? 'webkitgtk'
          : 'unknown'
    : /Chrome|Chromium/.test(userAgent)
      ? 'chromium'
      : /AppleWebKit/.test(userAgent)
        ? 'webkit'
        : 'unknown';
  return {
    kind: tauri ? 'tauri' : typeof window === 'undefined' ? 'unknown' : 'web',
    osFamily,
    architecture,
    webviewFamily,
    locale: typeof resolved.locale === 'string' ? resolved.locale : 'unknown',
    timeZone: typeof resolved.timeZone === 'string' ? resolved.timeZone : 'unknown',
    secureContext: typeof window === 'undefined' ? 'unknown' : window.isSecureContext,
  };
}

async function storageEstimate(): Promise<{ usage?: number; quota?: number; readable: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return { readable: false };
    const result = await Promise.race([
      navigator.storage.estimate(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('storage estimate timeout')), 1_500);
      }),
    ]);
    return { usage: result.usage, quota: result.quota, readable: true };
  } catch {
    return { readable: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Does not import or open settings, profiles, models, conversations, IndexedDB,
 * providers, tools, or skills. Unavailable store facts remain explicitly
 * unreadable instead of causing report generation to fail.
 */
export async function createSafeStartSupportReport(
  startup: StartupDiagnosticSnapshot,
  options: SupportReportOptions = {},
  now = new Date(),
): Promise<SupportReportSnapshot> {
  const estimate = await storageEstimate();
  const sources: SupportReportV1Sources = {
    reportSurface: 'safe-start',
    eventBufferReadable: !diagnosticBufferUnreadable(),
    // Store-dependent sections stay unavailable. Safe Start deliberately does
    // not import the settings, profile, model, or conversation stores, so it
    // reports "not collected" rather than guessing.
    collectorFailures: [],
    activeRequest: undefined,
    credentials: [],
    search: undefined,
    application: { version: LC_VERSION, buildChannel: buildChannel() },
    runtime: runtimeFacts(),
    startup,
    storage: {
      conversationSchemaVersion: 0,
      settingsSchemaVersion: 0,
      profileSchemaVersion: 0,
      ...(estimate.readable ? { approximateBytes: estimate.usage, quotaBytes: estimate.quota } : {}),
      conversationCountReadable: false,
      messageCountReadable: false,
      estimateReadable: estimate.readable,
      settingsReadable: false,
      profilesReadable: false,
    },
    providerCount: 0,
    activeProviderCount: 0,
    profiles: [],
    modelCount: 0,
    models: [],
    // Built-in recovery visuals only; persisted UI settings are not read.
    settings: {
      theme: 'system',
      zoom: 1,
      materialMode: 'glass',
      codeTheme: 'system',
      pinComposer: false,
      tokenMeterStyle: 'donut',
      autoPreviewReasoning: false,
      customThemes: [],
      ui: { sidebarOpen: false, sidePanelOpen: false },
      tools: {},
    },
    streamingActive: false,
    diagnosticEvents: readDiagnosticEvents(),
  };
  return createSupportReportSnapshotV1(sources, options, now);
}
