import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatExportTimestamp, lcExportFileName } from './exportNames.ts';

const settingsPageSource = readFileSync(
  new URL('../ui/settings/SettingsPage.tsx', import.meta.url),
  'utf8',
);
const indexCssSource = readFileSync(
  new URL('../index.css', import.meta.url),
  'utf8',
);

test('LC export filenames end with a local date and four-digit 24-hour time', () => {
  const localTime = new Date(2026, 7, 23, 9, 5, 59);
  assert.equal(formatExportTimestamp(localTime), '2026-08-23-0905');
  assert.equal(
    lcExportFileName('settings-v1', 'json', localTime),
    'lc-settings-v1-2026-08-23-0905.json',
  );
  assert.equal(
    lcExportFileName('theme-slate', 'theme.json', localTime),
    'lc-theme-slate-2026-08-23-0905.theme.json',
  );
});

test('LC export filename formatting has a stable invalid-date fallback', () => {
  assert.equal(
    lcExportFileName('support-v1', '.json', new Date(Number.NaN)),
    'lc-support-v1-1970-01-01-0000.json',
  );
});

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: new MemoryStorage(),
});

// Dynamic so the storage shim above is installed before the settings store
// resolves its persist backend.
const { readSettingsFile, buildSettingsExport } = await import('./export.ts');
const { hasUrlCredentials, removeUrlCredentials } = await import('./url-credentials.ts');
const { useAppModels } = await import('../modules/server-profiles/index.ts');
const { useProfileStore } = await import('../modules/server-profiles/index.ts');
const { getDefaultSettingsData, useSettings } = await import('../store/settings.ts');

const validSettings = {
  format: 'llm-client:settings',
  version: 1,
  exportedAt: 1700000000000,
  settings: {
    profiles: [],
    theme: 'system',
    assistantName: 'Assistant',
    zoom: 1,
    autoArchiveDays: 0,
    previewOverlayHeight: 175,
    materialMode: 'auto',
    pinComposer: false,
    tokenMeterStyle: 'donut',
    autoPreviewReasoning: true,
    customThemes: [],
    activeCustomThemeId: null,
    themeFilter: 'all',
    tools: {
      shell_allowlist: 'node',
      default_allowed_roots: [],
      web_fetch_rate_per_min: 50,
      brave_search_api_key: '',
      brave_search_api_key_ref: '',
      searxng_base_url: '',
      marginalia_api_key: '',
      marginalia_api_key_ref: '',
      web_search_provider: 'auto',
      vision_model: '',
      web_research_model: '',
    },
    hiddenModels: [],
  },
};

function settingsFile(value: unknown): File {
  return {
    text: async () => JSON.stringify(value),
  } as File;
}

test('settings import accepts a complete current settings export', async () => {
  const parsed = await readSettingsFile(settingsFile(validSettings));
  assert.equal(parsed.settings.theme, 'system');
  assert.deepEqual(parsed.settings.hiddenModels, []);
  assert.equal('max_tool_calls_per_batch' in parsed.settings.tools, false);
  assert.equal(parsed.settings.maxConcurrentGenerations, undefined);
});

test('new and reset settings default concurrent chats to two', () => {
  assert.equal(getDefaultSettingsData().maxConcurrentGenerations, 2);
});

test('new and reset settings show only the latest to-do list by default', () => {
  assert.equal(getDefaultSettingsData().showOnlyLatestTodoList, true);
});

test('chat behavior is grouped between Appearance and Workspace', () => {
  const appearanceStart = settingsPageSource.indexOf('<Section title="Appearance"');
  const chatStart = settingsPageSource.indexOf('<Section title="Chat"', appearanceStart);
  const workspaceStart = settingsPageSource.indexOf('title="Workspace"', chatStart);
  const backupStart = settingsPageSource.indexOf('title="Backup & reset"', workspaceStart);
  const supportStart = settingsPageSource.indexOf('title="Support"', backupStart);
  assert.ok(appearanceStart >= 0 && chatStart > appearanceStart);
  assert.ok(workspaceStart > chatStart && backupStart > workspaceStart && supportStart > backupStart);

  const chatBlock = settingsPageSource.slice(chatStart, workspaceStart);
  assert.match(chatBlock, /Assistant name/);
  assert.match(chatBlock, /Concurrent chats/);
  assert.match(
    chatBlock,
    /className="appearance-grid"[\s\S]*?Concurrent chats[\s\S]*?Pin composer[\s\S]*?Auto reasoning preview[\s\S]*?To-do list preview[\s\S]*?Auto archive idle chats after[\s\S]*?Assistant name/,
    'Chat controls must keep the intended priority order in one grid',
  );
  assert.ok(
    chatBlock.indexOf('Concurrent chats')
      < chatBlock.indexOf("profileMutationsBlocked && 'generation-config-locked'"),
    'the live capacity control must remain outside the locked data-management region',
  );

  const backupBlock = settingsPageSource.slice(backupStart, supportStart);
  assert.doesNotMatch(backupBlock, /Concurrent chats|Auto archive idle chats after/);
  assert.match(backupBlock, /Chat history[\s\S]*?Export chats[\s\S]*?Import chats[\s\S]*?Delete all chats/);
  assert.match(backupBlock, /App settings[\s\S]*?Export settings[\s\S]*?Import settings[\s\S]*?Reset to defaults/);
});

test('Chat starts collapsed whenever Settings opens normally', () => {
  assert.match(
    settingsPageSource,
    /const \[collapsed, setCollapsed\] = useState<Record<string, boolean>>\(\{[\s\S]*?chat: true,/,
  );
  assert.match(
    settingsPageSource,
    /else \{\s*setCollapsed\(\{ chat: true, model_tools: true, backup_reset: true, data_support: true \}\);/,
  );
});

test('server profile editor does not close when its overlay is clicked', () => {
  assert.match(settingsPageSource, /<div className="server-editor-overlay">/);
  assert.doesNotMatch(settingsPageSource, /className="server-editor-overlay"\s+onClick=/);
});

test('server profile editor is height-constrained so vertical overflow scrolls', () => {
  assert.match(
    indexCssSource,
    /\.server-editor-card\s*\{[\s\S]*?max-height:\s*calc\(100vh - 40px\);[\s\S]*?overflow-y:\s*auto;/,
  );
});

test('activation, server profile details, and request headers render as ordered sibling blocks', () => {
  const activationBlockStart = settingsPageSource.indexOf('<div className="server-profile-activation-controls">');
  const profileBlockStart = settingsPageSource.indexOf('<div className="server-profile-controls">');
  const requestHeaderBlockStart = settingsPageSource.indexOf('<div className="request-header-controls">');
  assert.ok(
    activationBlockStart >= 0
      && profileBlockStart > activationBlockStart
      && requestHeaderBlockStart > profileBlockStart,
  );

  const profileBlock = settingsPageSource.slice(profileBlockStart, requestHeaderBlockStart);
  assert.match(profileBlock, /Display name/);
  assert.match(profileBlock, /Base URL \(include API version\)/);
  assert.match(profileBlock, /Model fetching URL \(optional\)/);
  assert.match(profileBlock, /Note \(optional\)/);
  assert.doesNotMatch(settingsPageSource, /request-header-divider/);
  assert.match(
    settingsPageSource.slice(activationBlockStart),
    /Activate this profile[\s\S]*?role="switch"/,
  );
  assert.doesNotMatch(
    settingsPageSource.slice(
      settingsPageSource.indexOf('<div className="section-head">', profileBlockStart - 1000),
      profileBlockStart,
    ),
    /role="switch"/,
  );
});

test('Fetch models is available in the profile editor, not the profile list row', () => {
  const profileListStart = settingsPageSource.indexOf('{sortedProfiles.map((p) => {');
  const editorStart = settingsPageSource.indexOf('{editing && !profileMutationsBlocked && (');
  assert.ok(profileListStart >= 0 && editorStart > profileListStart);
  assert.doesNotMatch(settingsPageSource.slice(profileListStart, editorStart), /Fetch models/);
  assert.match(settingsPageSource.slice(editorStart), /Fetch models/);
});

test('profile list uses a compact icon-only Edit action', () => {
  assert.match(
    settingsPageSource,
    /className="bubble-icon-btn profile-edit-btn"[\s\S]*?aria-label=\{`Edit \$\{p\.name\}`\}[\s\S]*?<svg/,
  );
  assert.doesNotMatch(
    settingsPageSource,
    /className="ghost-btn small"[\s\S]{0,500}?aria-label=\{`Edit \$\{p\.name\}`\}/,
  );
  const rowActionsStart = settingsPageSource.indexOf('<div className="profile-actions">');
  const rowActions = settingsPageSource.slice(rowActionsStart, rowActionsStart + 3000);
  assert.ok(rowActions.indexOf('profile-edit-btn') < rowActions.indexOf("className={cn('toggle', p.active"));
});

test('settings export carries the rollback concurrency cap', () => {
  const previous = useSettings.getState().maxConcurrentGenerations;
  useSettings.setState({ maxConcurrentGenerations: 2 });
  try {
    assert.equal(buildSettingsExport().settings.maxConcurrentGenerations, 2);
  } finally {
    useSettings.setState({ maxConcurrentGenerations: previous });
  }
});

test('settings export carries the to-do list preview preference', () => {
  const previous = useSettings.getState().showOnlyLatestTodoList;
  useSettings.setState({ showOnlyLatestTodoList: true });
  try {
    assert.equal(buildSettingsExport().settings.showOnlyLatestTodoList, true);
  } finally {
    useSettings.setState({ showOnlyLatestTodoList: previous });
  }
});

test('settings export excludes user-defined profile request headers', () => {
  const previous = useProfileStore.getState().profiles;
  useProfileStore.setState({
    profiles: [{
      id: 'profile-private-headers',
      name: 'Private headers',
      baseUrl: 'https://example.test/v1',
      includeLcIdentifierHeader: true,
      lcIdentifierHeader: {
        name: 'Authorization',
        value: 'Bearer IDENTIFIER_SECRET_CANARY',
      },
      includeAdditionalRequestHeaders: true,
      requestHeaders: [{
        name: 'X-Api-Key',
        value: 'ADDITIONAL_SECRET_CANARY',
      }],
    }],
  });

  try {
    const profile = buildSettingsExport().settings.profiles[0];
    const serialized = JSON.stringify(profile);
    assert.equal(profile.includeLcIdentifierHeader, true);
    assert.equal(profile.includeAdditionalRequestHeaders, false);
    assert.equal('lcIdentifierHeader' in profile, false);
    assert.equal('requestHeaders' in profile, false);
    assert.doesNotMatch(serialized, /Authorization|X-Api-Key/);
    assert.doesNotMatch(serialized, /IDENTIFIER_SECRET_CANARY|ADDITIONAL_SECRET_CANARY/);
  } finally {
    useProfileStore.setState({ profiles: previous });
  }
});

test('settings export removes URL-embedded credentials and import rejects them', async () => {
  const previousProfiles = useProfileStore.getState().profiles;
  const previousTools = useSettings.getState().tools;
  useProfileStore.setState({
    profiles: [{
      id: 'profile-private-urls',
      name: 'Private URLs',
      baseUrl: 'https://profile-user:PROFILE_URL_SECRET_CANARY@example.test/v1',
      modelFetchUrl: 'https://model-user:MODEL_URL_SECRET_CANARY@models.example.test/models',
    }],
  });
  useSettings.setState({
    tools: {
      ...previousTools,
      searxng_base_url: 'https://search-user:SEARCH_URL_SECRET_CANARY@search.example.test',
    },
  });

  try {
    const payload = buildSettingsExport();
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /(?:PROFILE|MODEL|SEARCH)_URL_SECRET_CANARY/);
    assert.doesNotMatch(serialized, /profile-user|model-user|search-user/);
    assert.equal(payload.settings.profiles[0].baseUrl, 'https://example.test/v1');
    assert.equal(payload.settings.profiles[0].modelFetchUrl, 'https://models.example.test/models');
    assert.equal(payload.settings.tools.searxng_base_url, 'https://search.example.test/');
    await readSettingsFile(settingsFile(payload));

    const unsafeProfile = structuredClone(validSettings) as {
      settings: { profiles: Array<Record<string, unknown>> };
    };
    unsafeProfile.settings.profiles.push({
      id: 'profile-url-secret',
      name: 'Unsafe profile URL',
      baseUrl: 'https://user:secret@example.test/v1',
    });
    await assert.rejects(
      () => readSettingsFile(settingsFile(unsafeProfile)),
      /not a settings export from LLM Client/,
    );

    const unsafeSearch = structuredClone(validSettings) as {
      settings: { tools: Record<string, unknown> };
    };
    unsafeSearch.settings.tools.searxng_base_url = 'https://user:secret@search.example.test';
    await assert.rejects(
      () => readSettingsFile(settingsFile(unsafeSearch)),
      /not a settings export from LLM Client/,
    );
  } finally {
    useProfileStore.setState({ profiles: previousProfiles });
    useSettings.setState({ tools: previousTools });
  }
});

test('settings export removes credential query parameters and import rejects them', async () => {
  const previousProfiles = useProfileStore.getState().profiles;
  const previousTools = useSettings.getState().tools;
  useProfileStore.setState({
    profiles: [{
      id: 'profile-private-query',
      name: 'Private query credentials',
      baseUrl: 'https://example.test/v1?tenant=portable&api_key=PROFILE_QUERY_SECRET',
      modelFetchUrl: 'https://models.example.test/models?access_token=MODEL_QUERY_SECRET',
    }],
  });
  useSettings.setState({
    tools: {
      ...previousTools,
      searxng_base_url: 'https://search.example.test?token=SEARCH_QUERY_SECRET&language=en',
    },
  });

  try {
    const payload = buildSettingsExport();
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /(?:PROFILE|MODEL|SEARCH)_QUERY_SECRET/);
    assert.equal(payload.settings.profiles[0].baseUrl, 'https://example.test/v1?tenant=portable');
    assert.equal(payload.settings.profiles[0].modelFetchUrl, 'https://models.example.test/models');
    assert.equal(payload.settings.tools.searxng_base_url, 'https://search.example.test/?language=en');
    await readSettingsFile(settingsFile(payload));

    const unsafePayloads: unknown[] = [];
    const unsafeBaseUrl = structuredClone(validSettings) as {
      settings: { profiles: Array<Record<string, unknown>> };
    };
    unsafeBaseUrl.settings.profiles.push({
      id: 'profile-query-secret',
      name: 'Unsafe profile query',
      baseUrl: 'https://example.test/v1?api_key=secret',
    });
    unsafePayloads.push(unsafeBaseUrl);

    const unsafeModelUrl = structuredClone(validSettings) as {
      settings: { profiles: Array<Record<string, unknown>> };
    };
    unsafeModelUrl.settings.profiles.push({
      id: 'model-query-secret',
      name: 'Unsafe model query',
      baseUrl: 'https://example.test/v1',
      modelFetchUrl: 'https://models.example.test?access_token=secret',
    });
    unsafePayloads.push(unsafeModelUrl);

    const unsafeSearchUrl = structuredClone(validSettings) as {
      settings: { tools: Record<string, unknown> };
    };
    unsafeSearchUrl.settings.tools.searxng_base_url = 'https://search.example.test?token=secret';
    unsafePayloads.push(unsafeSearchUrl);

    for (const unsafe of unsafePayloads) {
      await assert.rejects(
        () => readSettingsFile(settingsFile(unsafe)),
        /not a settings export from LLM Client/,
      );
    }
  } finally {
    useProfileStore.setState({ profiles: previousProfiles });
    useSettings.setState({ tools: previousTools });
  }
});

test('settings export removes credentials from relative model-fetch URLs', async () => {
  const previousProfiles = useProfileStore.getState().profiles;
  useProfileStore.setState({
    profiles: [
      {
        id: 'relative-model-query',
        name: 'Relative model query',
        baseUrl: 'https://api.example.test/v1',
        modelFetchUrl: 'models?access_token=RELATIVE_MODEL_SECRET&tenant=portable',
      },
      {
        id: 'root-relative-model-query',
        name: 'Root-relative model query',
        baseUrl: 'https://api.example.test/v1',
        modelFetchUrl: '/models?token=ROOT_RELATIVE_MODEL_SECRET&language=en',
      },
      {
        id: 'ordinary-relative-model-query',
        name: 'Ordinary relative model query',
        baseUrl: 'https://api.example.test/v1',
        modelFetchUrl: 'nested/models?tenant=portable&page_token=cursor',
      },
    ],
  });

  try {
    const payload = buildSettingsExport();
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /(?:RELATIVE_MODEL|ROOT_RELATIVE_MODEL)_SECRET/);
    assert.equal(payload.settings.profiles[0].modelFetchUrl, 'models?tenant=portable');
    assert.equal(payload.settings.profiles[1].modelFetchUrl, '/models?language=en');
    assert.equal(
      payload.settings.profiles[2].modelFetchUrl,
      'nested/models?tenant=portable&page_token=cursor',
    );
    await readSettingsFile(settingsFile(payload));
  } finally {
    useProfileStore.setState({ profiles: previousProfiles });
  }
});

test('settings export removes fragment credentials and preserves ordinary anchors', async () => {
  const previousProfiles = useProfileStore.getState().profiles;
  const previousTools = useSettings.getState().tools;
  useProfileStore.setState({
    profiles: [
      {
        id: 'absolute-fragment-credentials',
        name: 'Absolute fragment credentials',
        baseUrl: 'https://api.example.test/v1#access_token=PROFILE_FRAGMENT_SECRET&section=portable',
        modelFetchUrl: 'https://models.example.test/models#token=ABSOLUTE_MODEL_FRAGMENT_SECRET&view=list',
      },
      {
        id: 'relative-fragment-credentials',
        name: 'Relative fragment credentials',
        baseUrl: 'https://api.example.test/v1',
        modelFetchUrl: 'models#client_secret=RELATIVE_MODEL_FRAGMENT_SECRET&view=grid',
      },
      {
        id: 'ordinary-anchors',
        name: 'Ordinary anchors',
        baseUrl: 'https://ordinary.example.test/v1#api-reference',
        modelFetchUrl: '/models#model-list',
      },
    ],
  });
  useSettings.setState({
    tools: {
      ...previousTools,
      searxng_base_url: 'https://search.example.test#access_token=SEARCH_FRAGMENT_SECRET&language=en',
    },
  });

  try {
    const payload = buildSettingsExport();
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /(?:PROFILE|ABSOLUTE_MODEL|RELATIVE_MODEL|SEARCH)_FRAGMENT_SECRET/);
    assert.equal(payload.settings.profiles[0].baseUrl, 'https://api.example.test/v1#section=portable');
    assert.equal(
      payload.settings.profiles[0].modelFetchUrl,
      'https://models.example.test/models#view=list',
    );
    assert.equal(payload.settings.profiles[1].modelFetchUrl, 'models#view=grid');
    assert.equal(payload.settings.profiles[2].baseUrl, 'https://ordinary.example.test/v1#api-reference');
    assert.equal(payload.settings.profiles[2].modelFetchUrl, '/models#model-list');
    assert.equal(payload.settings.tools.searxng_base_url, 'https://search.example.test/#language=en');
    await readSettingsFile(settingsFile(payload));

    const unsafePayloads: unknown[] = [];
    const unsafeBaseUrl = structuredClone(validSettings) as {
      settings: { profiles: Array<Record<string, unknown>> };
    };
    unsafeBaseUrl.settings.profiles.push({
      id: 'profile-fragment-secret',
      name: 'Unsafe profile fragment',
      baseUrl: 'https://example.test/v1#access_token=secret',
    });
    unsafePayloads.push(unsafeBaseUrl);

    const unsafeModelUrl = structuredClone(validSettings) as {
      settings: { profiles: Array<Record<string, unknown>> };
    };
    unsafeModelUrl.settings.profiles.push({
      id: 'model-fragment-secret',
      name: 'Unsafe model fragment',
      baseUrl: 'https://example.test/v1',
      modelFetchUrl: 'models#token=secret',
    });
    unsafePayloads.push(unsafeModelUrl);

    const unsafeSearchUrl = structuredClone(validSettings) as {
      settings: { tools: Record<string, unknown> };
    };
    unsafeSearchUrl.settings.tools.searxng_base_url = 'https://search.example.test#token=secret';
    unsafePayloads.push(unsafeSearchUrl);

    for (const unsafe of unsafePayloads) {
      await assert.rejects(
        () => readSettingsFile(settingsFile(unsafe)),
        /not a settings export from LLM Client/,
      );
    }
  } finally {
    useProfileStore.setState({ profiles: previousProfiles });
    useSettings.setState({ tools: previousTools });
  }
});

test('settings export omits invalid SearXNG values', async () => {
  const previousTools = useSettings.getState().tools;
  const invalidValues = [
    'search.example.test?token=MISSING_SCHEME_SECRET#access_token=FRAGMENT_SECRET',
    'https://[invalid?token=MALFORMED_HOST_SECRET',
    'data:text/plain,api_key=PASTED_SCHEME_SECRET',
    'file:///C:/Users/PRIVATE_SCHEME_USER/search',
    'ftp://search.example.test',
  ];

  try {
    for (const searxngBaseUrl of invalidValues) {
      useSettings.setState({
        tools: { ...previousTools, searxng_base_url: searxngBaseUrl },
      });
      const payload = buildSettingsExport();
      assert.equal(payload.settings.tools.searxng_base_url, '');
      assert.doesNotMatch(
        JSON.stringify(payload),
        /MISSING_SCHEME_SECRET|FRAGMENT_SECRET|MALFORMED_HOST_SECRET|PASTED_SCHEME_SECRET|PRIVATE_SCHEME_USER/,
      );
      await readSettingsFile(settingsFile(payload));
    }
  } finally {
    useSettings.setState({ tools: previousTools });
  }
});

test('settings import rejects invalid SearXNG values', async () => {
  for (const searxngBaseUrl of [
    'search.example.test?token=MISSING_SCHEME_SECRET#access_token=FRAGMENT_SECRET',
    'https://[invalid?token=MALFORMED_HOST_SECRET',
    'data:text/plain,api_key=PASTED_SCHEME_SECRET',
    'file:///C:/Users/PRIVATE_SCHEME_USER/search',
    'ftp://search.example.test',
  ]) {
    const unsafe = structuredClone(validSettings) as {
      settings: { tools: Record<string, unknown> };
    };
    unsafe.settings.tools.searxng_base_url = searxngBaseUrl;
    await assert.rejects(
      () => readSettingsFile(settingsFile(unsafe)),
      /not a settings export from LLM Client/,
    );
  }
});

test('the shared URL credential rule is case-insensitive and preserves ordinary URL components', () => {
  for (const name of [
    'api_key',
    'X-API-Key',
    'access.token',
    'refresh-token',
    'client_secret',
    'credential',
    'password',
    'sig',
    'signature',
    'subscription_key',
    'X-Amz-Signature',
    'authorization',
    'key',
    'token',
  ]) {
    assert.equal(hasUrlCredentials(`https://example.test/v1?${name}=secret`), true, name);
    assert.equal(hasUrlCredentials(`https://example.test/v1#${name}=secret`), true, name);
  }

  const ordinary = 'https://example.test/v1?tenant=portable&language=en&page_token=cursor';
  assert.equal(hasUrlCredentials(ordinary), false);
  assert.equal(removeUrlCredentials(ordinary), ordinary);

  const base = 'https://api.example.test/v1';
  assert.equal(
    removeUrlCredentials('models?access_token=secret&tenant=portable', base),
    'models?tenant=portable',
  );
  assert.equal(
    removeUrlCredentials('/models?token=secret&language=en', base),
    '/models?language=en',
  );
  const ordinaryRelative = 'nested/models?tenant=portable&page_token=cursor';
  assert.equal(removeUrlCredentials(ordinaryRelative, base), ordinaryRelative);

  assert.equal(
    removeUrlCredentials('models#%61ccess_token=secret&view=list', base),
    'models#view=list',
  );
  assert.equal(
    removeUrlCredentials('/models#route?token=secret&view=grid', base),
    '/models#route?view=grid',
  );
  for (const ordinaryAnchor of ['#api-reference', '#chapter=2', '#token']) {
    const value = `https://example.test/v1${ordinaryAnchor}`;
    assert.equal(hasUrlCredentials(value), false);
    assert.equal(removeUrlCredentials(value), value);
  }
});

test('settings import rejects incomplete settings payloads', async () => {
  const incomplete = structuredClone(validSettings) as { settings: Record<string, unknown> };
  delete incomplete.settings.tools;
  await assert.rejects(
    () => readSettingsFile(settingsFile(incomplete)),
    /not a settings export from LLM Client/,
  );
});

test('settings import rejects non-current versions', async () => {
  const incompatible = structuredClone(validSettings) as { version: number };
  incompatible.version = 0;
  await assert.rejects(
    () => readSettingsFile(settingsFile(incompatible)),
    /not a settings export from LLM Client/,
  );
});

test('settings import rejects plaintext API keys', async () => {
  const withSecret = structuredClone(validSettings) as {
    settings: { profiles: Array<Record<string, unknown>> };
  };
  withSecret.settings.profiles.push({
    id: 'profile-1',
    name: 'Cloud',
    baseUrl: 'https://example.test/v1',
    apiKey: 'secret-must-not-be-portable',
  });
  await assert.rejects(
    () => readSettingsFile(settingsFile(withSecret)),
    /not a settings export from LLM Client/,
  );
});

test('settings import binds credential references to their owning setting', async () => {
  const valid = structuredClone(validSettings) as {
    settings: {
      profiles: Array<Record<string, unknown>>;
      tools: Record<string, unknown>;
    };
  };
  valid.settings.profiles.push({
    id: 'profile-1',
    name: 'Cloud',
    baseUrl: 'https://example.test/v1',
    apiKeyRef: 'profile.profile-1',
  });
  valid.settings.tools.brave_search_api_key_ref = 'brave-search-key';
  valid.settings.tools.marginalia_api_key_ref = 'marginalia-search-key';
  await readSettingsFile(settingsFile(valid));

  const profileRebind = structuredClone(valid);
  profileRebind.settings.profiles[0].apiKeyRef = 'brave-search-key';
  await assert.rejects(
    () => readSettingsFile(settingsFile(profileRebind)),
    /not a settings export from LLM Client/,
  );

  const crossProfile = structuredClone(valid);
  crossProfile.settings.profiles.push({
    id: 'profile-2',
    name: 'Other cloud',
    baseUrl: 'https://other.example.test/v1',
    apiKeyRef: 'profile.profile-1',
  });
  await assert.rejects(
    () => readSettingsFile(settingsFile(crossProfile)),
    /not a settings export from LLM Client/,
  );

  const searchRebind = structuredClone(valid);
  searchRebind.settings.tools.brave_search_api_key_ref = 'profile.profile-1';
  await assert.rejects(
    () => readSettingsFile(settingsFile(searchRebind)),
    /not a settings export from LLM Client/,
  );

  const collidingRef = structuredClone(valid);
  collidingRef.settings.profiles[0] = {
    ...collidingRef.settings.profiles[0],
    id: 'profile/a',
    apiKeyRef: 'profile.profile/a',
  };
  await assert.rejects(
    () => readSettingsFile(settingsFile(collidingRef)),
    /not a settings export from LLM Client/,
  );

  const duplicate = structuredClone(valid);
  duplicate.settings.profiles.push({ ...duplicate.settings.profiles[0] });
  await assert.rejects(
    () => readSettingsFile(settingsFile(duplicate)),
    /not a settings export from LLM Client/,
  );
});

test('settings import accepts a payload with no modelOverrides field', async () => {
  // Version-1 exports predate the field; they must stay importable.
  const legacy = structuredClone(validSettings) as { settings: Record<string, unknown> };
  assert.equal('modelOverrides' in legacy.settings, false);
  const parsed = await readSettingsFile(settingsFile(legacy));
  assert.equal(parsed.settings.modelOverrides, undefined);
});

test('settings import accepts valid model overrides', async () => {
  const withOverrides = structuredClone(validSettings) as {
    settings: Record<string, unknown>;
  };
  withOverrides.settings.modelOverrides = {
    'profile-1:model-a': { c: 131072, v: true, r: false, t: true },
    'profile-2:model-a': { v: false },
    'profile-3:model-b': {},
  };
  const parsed = await readSettingsFile(settingsFile(withOverrides));
  assert.deepEqual(parsed.settings.modelOverrides?.['profile-2:model-a'], { v: false });
});

test('settings import accepts valid model customizations and rejects malformed entries', async () => {
  const valid = structuredClone(validSettings) as { settings: Record<string, unknown> };
  valid.settings.modelCustomizations = {
    'profile-1': {
      added: { 'glm-5.3': { n: 'GLM 5.3', c: 262144, r: true, t: true } },
      deleted: ['server-old'],
    },
  };
  const parsed = await readSettingsFile(settingsFile(valid));
  assert.equal(parsed.settings.modelCustomizations?.['profile-1'].added['glm-5.3'].n, 'GLM 5.3');

  const invalid = structuredClone(validSettings) as { settings: Record<string, unknown> };
  invalid.settings.modelCustomizations = {
    'profile-1': { added: { broken: { n: '', c: 0 } }, deleted: 'not-an-array' },
  };
  await assert.rejects(() => readSettingsFile(settingsFile(invalid)), /not a settings export/);
});

test('settings import rejects malformed model overrides', async () => {
  const cases: unknown[] = [
    [],                                              // array, not a record
    { 'p:m': null },                                 // null entry
    { 'p:m': [] },                                   // array entry
    { 'p:m': { c: 0 } },                             // non-positive context
    { 'p:m': { c: -8192 } },                         // negative context
    { 'p:m': { c: 8192.5 } },                        // fractional context
    { 'p:m': { c: Number.MAX_SAFE_INTEGER + 2 } },   // beyond safe integer
    { 'p:m': { c: '8192' } },                        // context as string
    { 'p:m': { v: 'yes' } },                         // capability as string
    { 'p:m': { t: 1 } },                             // capability as number
  ];
  for (const modelOverrides of cases) {
    const invalid = structuredClone(validSettings) as { settings: Record<string, unknown> };
    invalid.settings.modelOverrides = modelOverrides;
    await assert.rejects(
      () => readSettingsFile(settingsFile(invalid)),
      /not a settings export from LLM Client/,
      `expected rejection for ${JSON.stringify(modelOverrides)}`,
    );
  }
});

test('settings import rejects a non-current LM Studio native base URL', async () => {
  const invalid = structuredClone(validSettings) as {
    settings: { profiles: Array<Record<string, unknown>> };
  };
  invalid.settings.profiles.push({
    id: 'profile-1',
    name: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    apiVariant: 'lm-studio',
  });
  await assert.rejects(
    () => readSettingsFile(settingsFile(invalid)),
    /not a settings export from LLM Client/,
  );
});

test('settings export always emits modelOverrides, deep-copied per entry', () => {
  useAppModels.getState().replaceMetadataOverrides({
    'profile-1:model-a': { c: 131072, v: false },
  });
  try {
    const payload = buildSettingsExport();
    const exported = payload.settings.modelOverrides;

    assert.deepEqual(exported, { 'profile-1:model-a': { c: 131072, v: false } });
    // Not the live store objects: mutating the export must not reach state,
    // and a later state change must not rewrite an already-built export.
    assert.notEqual(exported, useAppModels.getState().overrides);
    assert.notEqual(
      exported?.['profile-1:model-a'],
      useAppModels.getState().overrides['profile-1:model-a'],
    );

    useAppModels.getState().setMetadataOverride('profile-1', 'model-a', { c: 4096 });
    assert.deepEqual(exported, { 'profile-1:model-a': { c: 131072, v: false } });
  } finally {
    useAppModels.getState().resetMetadataOverrides();
  }
});

test('settings export emits an empty modelOverrides record when none are set', () => {
  useAppModels.getState().resetMetadataOverrides();
  const payload = buildSettingsExport();
  assert.deepEqual(payload.settings.modelOverrides, {});
});

test('settings export deep-copies model customizations', () => {
  useAppModels.getState().replaceModelCustomizations({
    'profile-1': {
      added: { manual: { n: 'Manual', c: 32768, t: true } },
      deleted: ['fetched'],
    },
  });
  try {
    const exported = buildSettingsExport().settings.modelCustomizations;
    assert.deepEqual(exported, {
      'profile-1': {
        added: { manual: { n: 'Manual', c: 32768, t: true } },
        deleted: ['fetched'],
      },
    });
    assert.notEqual(exported?.['profile-1'], useAppModels.getState().customizations['profile-1']);
    assert.notEqual(exported?.['profile-1'].added.manual, useAppModels.getState().customizations['profile-1'].added.manual);
  } finally {
    useAppModels.getState().resetModelCustomizations();
  }
});

test('an exported settings payload passes its own validator', async () => {
  useAppModels.getState().replaceMetadataOverrides({ 'profile-1:model-a': { c: 8192, t: true } });
  try {
    const payload = buildSettingsExport();
    const parsed = await readSettingsFile(settingsFile(payload));
    assert.deepEqual(parsed.settings.modelOverrides, { 'profile-1:model-a': { c: 8192, t: true } });
  } finally {
    useAppModels.getState().resetMetadataOverrides();
  }
});

test('settings import rejects oversized files before parsing', async () => {
  await assert.rejects(
    () => readSettingsFile({
      size: 6 * 1024 * 1024,
      text: async () => JSON.stringify(validSettings),
    } as unknown as File),
    /too large to be a settings export/,
  );
});
