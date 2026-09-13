# Upgrade: Model visibility metadata + per-model overrides

Status: **Implemented.** Retained as the design rationale, not as open work.  
Primary targets: reliable **VISION filtering** and reactive **context-window token meter**  
Secondary targets: metadata badges, override editor, Guess, persistence, and settings portability

> **This document was a plan and now records the design rationale.** The plan
> has shipped. It includes the canonical registry, detected/effective layers,
> per-profile/model overrides, and synchronous override recomputation. These
> modules implement the design:
> `src/modules/server-profiles/model-overrides.ts`, `model-cache.ts`,
> `model-enricher.ts`, and the `useAppModels` registry, with
> `model-registry.test.ts`, `model-overrides.test.ts`,
> `model-enricher-guess.test.ts`, `runtime-vision-precedence.test.ts`, and
> `settings-export.test.ts` cover the design. `ModelVisibilityPanel.tsx`
> renders the capability badges and override editor.
>
> Sections below that read as future work ("this upgrade will…", "update X
> to…") describe decisions already made. Where this document and the code
> disagree, the code is authoritative.

## Why

models.dev cannot cover every model from every provider. Local LM Studio
models and new or obscure cloud models can have incomplete metadata. Models
missing from `models-cache.json` can also have incomplete metadata.

LC carries metadata through `AppModelEntry.maxContextLength`, `capabilities`,
and `CachedModel.c/v/r/t`. However, `ModelVisibilityPanel.tsx` removes it from
the panel's grouped rows.

This upgrade:

1. Shows model metadata in the visibility panel: reasoning, vision, tools, and context window.
2. Lets the user override context window and capability metadata per profile + model.
3. Makes override changes reactive without a server refresh.
4. Uses effective `vision` metadata to filter **Settings > Workspace > Model for image analyze**.
5. Uses effective context metadata to update the active chat's token meter immediately.
6. Persists overrides and includes them in settings export/import.
7. Changes the unknown-context token-meter fallback from 32k to 256k.

## Required user-visible invariants

These are the release-critical behaviors for this upgrade:

- If the profile is active and the model is visible, `vision = Yes` adds the
  model to **Settings > Workspace > Model for image analyze** immediately.
- Setting `vision = No` immediately removes the model from that picker. If the
  model is selected, LC resets `tools.vision_model` to `''` (`Same as chat model`).
- An explicit user `vision = No` also controls the chat/tool execution path.
  Server detail or models.dev metadata must not enable vision again.
- Saving a context-window override immediately updates the active chat token
  meter. The override must match the exact `profileId + modelId`. The update
  does not change models or refresh servers.
- Removing/resetting an override immediately restores detected base metadata.
- Models with the same model ID on different profiles never share overrides.

## Non-goals / explicit scope

- No general ModelPicker visual redesign. Its existing text tags remain.
- No editor for display name, pricing, modalities other than vision, or other models.dev fields.
- No network request to models.dev from Guess. Guess reads the downloaded/bundled compact cache.
- No Rust tool-command, image-analysis request, web-search/fetch, or sub-agent transport redesign.
- No pruning of orphaned override keys.
- Old settings exports without `modelOverrides` remain importable. Importing
  one clears current overrides because settings import has replace semantics.

## Metadata layers and priority

Priority, lowest to highest:

```text
server/native metadata + models.dev fallback enrichment < user override
```
models.dev fills missing server fields. It does not replace authoritative
native/server metadata. The user override is the final layer. LC applies it
separately to each field.

An explicit `false` is meaningful and must win over detected `true`. Missing/`undefined` means no opinion at that layer.

## Canonical model registry: the metadata source of truth

LC currently intends `useAppModels` to be the shared model source, but consumers bypass it in several ways:

- Chat `ModelPicker` subscribes directly to `useAppModels.models`.
- Settings snapshots `crossServerModels()` into local `subAgentModels` state.
- Model visibility reads active profiles from `useAppModels` but inactive profiles directly from `modelCache` and manually invalidates that read with `cacheVersion`.
- `ChatView` copies context into local state.
- The orchestrator independently combines its model-detail cache with an ID-only app-store lookup.

These sources are separate projections and snapshots, not independent
databases. The projections can disagree. This upgrade makes `useAppModels` the
canonical registry. Server discovery, models.dev, the persistent base cache,
and override persistence are registry **inputs**. UI and runtime consumers read
effective metadata only from the registry.

### Registry record

```ts
export interface ModelMetaOverride {
  c?: number;   // positive safe integer; max context tokens
  v?: boolean;  // vision
  r?: boolean;  // reasoning
  t?: boolean;  // tools
}

export interface ModelRegistryRecord {
  key: string;                  // hiddenModelKey(profileId, modelId)
  profileId: string;
  modelId: string;
  profileActive: boolean;
  origin: 'live' | 'cache';
  detected: AppModelEntry;      // server/native + models.dev fallback
  override?: ModelMetaOverride;
  effective: AppModelEntry;     // detected + override
}
```

The registry contains cached records for inactive profiles. It contains live
and cached records for active profiles. Therefore, the visibility panel can
use the registry without direct localStorage or cache reads.

For compatibility, `useAppModels.models` remains a derived array of **active
effective entries** for existing chat/tool consumers. The record map is the
canonical state:

```ts
interface State {
  records: Record<string, ModelRegistryRecord>;
  overrides: Record<string, ModelMetaOverride>;
  models: AppModelEntry[]; // active effective projection

  setMetadataOverride: (profileId: string, modelId: string, value: ModelMetaOverride) => void;
  removeMetadataOverride: (profileId: string, modelId: string) => void;
  replaceMetadataOverrides: (value: Record<string, ModelMetaOverride>) => void;
  resetMetadataOverrides: () => void;
  replaceProfileModels: (profileId: string, entries: AppModelEntry[]) => void;
  // existing bootstrap/refresh/health actions...
}
```

Central selectors/helpers:

```ts
selectEffectiveModel(state, profileId, modelId): AppModelEntry | undefined;
selectActiveEffectiveModels(state): AppModelEntry[];
selectVisibilityRecords(state): ModelRegistryRecord[]; // active + inactive
```

Consumers must not query `modelCache`, models.dev, or the override persistence module directly.

### Override persistence adapter

`src/modules/server-profiles/model-overrides.ts` is a pure validation and
persistence adapter. It is not a second Zustand source of truth. It exports
`ModelMetaOverride`, sanitizer/load/save functions, and immutable merge helpers.
`useAppModels` owns the live override state and calls the adapter.

Rules:

- Reuse `hiddenModelKey(profileId, modelId)` for the composite key. Consumers
  never split the key, so model IDs containing `:` remain safe.
- Registry actions validate and normalize entries. Empty entries are deleted rather than persisted.
- Bulk replacement validates every imported/persisted entry and drops invalid or empty entries.
- `c` must satisfy `Number.isSafeInteger(c) && c > 0`.
- Persist under `lc_model_meta_overrides` and `lc_model_meta_overrides_bak`.
- A valid empty primary object is authoritative. Fall back to backup only when the primary is missing or malformed, not merely empty.
- Persist a fresh object to both keys after every override-state change.
- Orphaned profile/model keys remain in `overrides` and are applied if the record returns later.

Pure immutable helper:

```ts
export function applyOverride(
  detected: AppModelEntry,
  override: ModelMetaOverride | undefined,
): AppModelEntry;
```

`applyOverride()` must not mutate `detected`, `detected.capabilities`, or the stored override.

### Registry ingestion and derivation

1. Bootstrap reads `modelCache` for **all known profiles** and loads persisted overrides, then creates registry records.
2. `buildFromCache()`, `buildLiveEntries()`, and `buildCacheEntries()` create detected entries only.
3. One central commit function updates detected records, applies exact-key overrides, and regenerates the active `models` projection atomically.
4. `setMetadataOverride`, remove, replace, and reset synchronously regenerate
   affected `effective` records and `models`. They do not require a server refresh.
5. `bootstrap()`, `refresh()`, and `refreshServer()` commit through the same
   function. Network discovery remains limited to active profiles. Inactive
   records come from the persistent base cache.
6. Profile activation changes update `profileActive` and the active projection without discarding the cached record. Profile deletion removes its records but does not need to prune orphaned overrides.
7. Replace the direct `useAppModels.setState({ models: ... })` in `SettingsPage.tsx::testServer()` with `replaceProfileModels()`.
8. Cache refreshes remain pure: user overrides are never written into `lc:server-model-cache`.

To preserve the detected layer across cold starts and inactive profiles,
update `model-cache.ts::set()`. Store detected booleans as booleans. Do not
convert `false` to `undefined` with `|| undefined`.

## Critical consumer 1: Workspace vision-model filter

The Workspace `SubAgentModelPicker` filters with
`capabilities.vision === true`. However, `SettingsPage` stores a
`crossServerModels()` snapshot in local state. It recomputes only during open,
profile, and explicit reload flows.

Required changes:

- `SettingsPage` subscribes to the registry's active effective `useAppModels((s) => s.models)` projection while open.
- Recompute `subAgentModels` whenever effective models, active profiles, or hidden-model visibility changes.
- `crossServerModels()` continues to read effective `useAppModels.models`, not detected records or raw cache metadata.
- When the configured packed `tools.vision_model` no longer resolves to an active, visible entry with `vision === true`, reset it to `''` (`Same as chat model`). This covers an override changed to `No`, a hidden model, or an inactive profile.
- When a vision override becomes `Yes`, the entry appears immediately without any model refresh.
- Preserve packed `profileId::modelId` matching throughout. Do not use the
  model ID alone as a fallback.

The web-research/tools filter benefits from the same reactive list, although vision is the release-critical capability.

## Critical consumer 2: chat context-window token meter

`ChatView` copies context into local state with an imperative
`useAppModels.getState()` effect. The effect depends only on conversation and
model identity. It misses override-only changes and can select the wrong
profile when duplicate model IDs exist.

Replace it with a reactive composite-key selector:

```ts
const modelMaxContext = useAppModels((s) =>
  s.models.find((m) =>
    m.profileId === conv?.serverId && m.id === conv?.model
  )?.maxContextLength ?? 0
);
```

Pass that value directly to `TokenMeter`. `ModelPicker` no longer needs to push
context through `onModelContext`. Remove that callback if it has no remaining
callers.

Unknown models continue to pass `0`, and `TokenMeter.tsx` changes its display fallback:

```ts
const max = maxContext > 0 ? maxContext : 256000;
```

The fallback affects only visual and accounting behavior. LC does not persist
it as detected model metadata.

## Runtime vision precedence

The generation pipeline currently ORs `modelDetail.vision` with an ID-only app-store lookup. That allows server `true` to defeat an explicit user `false` and can cross profile boundaries.

In `orchestrator.ts`:

1. Resolve the base capability from the exact current profile + model. Retain the existing server-detail/store fallback behavior when no override exists.
2. Read the exact user override for `prof.id + effectiveModelId`.
3. Resolve vision as:

```ts
const detectedVision =
  modelDetail?.capabilities?.vision === true || baseEntry?.capabilities.vision === true;
const modelIsVision = override?.v ?? detectedVision;
```

4. Carry this resolved boolean through `PipelineOptions` / tool-loop state. Do not later re-derive it using `find(m => m.id === model)`.

This ensures `vision = No` controls both UI filtering and actual image injection/tool behavior.

## Rust/native sub-agent execution boundary

The metadata-registry work does **not** redesign the Rust tool protocol or sub-agent transports.

### Image analyze

`lc_read_image` with `analyze:true` still:

1. Reads the configured packed vision-model reference (or uses Same as chat model).
2. Resolves the exact owning profile and keychain credential in TypeScript.
3. Sends the existing `AnalyzeImagesArgs` shape to Rust `tool_analyze_images`: paths, encoding/downscale limits, `server_url`, concrete model ID, API key, API variant/style, and prompts.
4. Lets Rust prepare images and execute the provider-specific image-analysis request exactly as today.

The registry affects only which model is offered/retained in Settings and makes profile/model resolution unambiguous. No new metadata, context value, or override object is sent across the Tauri bridge.

`lc_read_image` with `analyze:false` is intentionally affected by effective vision metadata: an explicit `vision = No` makes the existing `modelIsVision` guard reject raw image injection and advise `analyze:true`. That is a correctness fix, not a Rust protocol change.

### Web research

- Rust `tool_web_search` / `tool_web_fetch`, provider selection, rate limits, fetched content, and cancellation/operation identity remain unchanged.
- The synthesis sub-agent still uses the existing TypeScript `ctx.llmCall` -> `LLMClient.chatOnce` path.
- The registry only supplies/validates the configured packed model reference and its exact profile. The research prompt, `max_tokens`, transport, and Rust search/fetch commands are unchanged.

### Context metadata

Context-window overrides update model presentation and the main chat token meter only. This upgrade does not use them to alter Rust request limits, sub-agent `max_tokens`, truncation, provider parameters, or execution policy. Any future context-aware scheduling for sub-agents is a separate change.

## Visibility-panel row redesign

Compact row:

```text
[checkbox] Model name          [brain][eye][tools] 128k [edit]
```

- Keep visibility behavior unchanged.
- Build active and inactive groups from registry records. Remove the panel's direct `modelCache.getAll()` read and its manual `cacheVersion` invalidation token.
- Do not put the edit button inside the existing row `<label>`. Use a row `<div>`, associate the checkbox with a dedicated `<label htmlFor=...>`, and keep Edit as a separate button.
- Model name uses `min-width: 0` and ellipsis so badges/context/edit remain visible.
- Capability badges are 16x16 square chips using existing `--tag-*-bg/fg` variables: purple reasoning, green vision, blue tools.
- Give each badge an accessible label and title. Color alone must not identify
  the capability.
- Context uses shared `formatCtx()` and displays a dim `?` when effective context is unknown.
- Edit button uses `type="button"`, `aria-label="Edit metadata for …"`, and a currentColor pencil glyph.

Extract `formatCtx()` from `ModelPicker.tsx` into `src/utils/formatCtx.ts` and import it in both components.

Add `src/ui/shared/ModelCapabilityIcons.tsx`:

| Capability | Glyph source | Style |
|---|---|---|
| Reasoning | brain icon from `MessageBubble.tsx` | stroke/currentColor |
| Vision | new lucide-style eye | stroke/currentColor |
| Tools | wrench+screwdriver from `MessageBubble.tsx` / `SidePanel.tsx` | fill/currentColor |

## Override editor

Render the editor as a child component so `useOverlayEscape(..., true)` is registered only while the editor is mounted. Reuse `.server-editor-overlay` / `.server-editor-card`, with `role="dialog"`, `aria-modal="true"`, an accessible heading, initial focus, and focus restoration to the Edit button.

The form edits the **override layer**, while showing detected base/effective values for clarity:

```text
+------------------------------------+
| Model name                     [x] |
| Detected context: 128k             |
| Context override: [             ]  | empty = Inherit
|                                    |
| Vision:    [Inherit] [Yes] [No]    |
| Reasoning: [Inherit] [Yes] [No]    |
| Tools:     [Inherit] [Yes] [No]    |
|                                    |
|              [Reset] [Guess] [Save]|
+------------------------------------+
```

Rules:

- Capability form state is `boolean | undefined`: `undefined = Inherit`, `true = Yes`, `false = No`.
- This three-state UI is required so unknown/inherited metadata is not silently saved as explicit `false`.
- Context input holds only the override. Empty means Inherit. The placeholder
  shows the detected context or `256000` when unknown.
- Validate context with `Number.isSafeInteger(value) && value > 0`. Use
  `type="number"`, `min="1"`, and `step="1"`. If the value is invalid, block
  Save and show an accessible inline error.
- On open, load the stored override and display detected/effective metadata separately.
- Save removes fields equal to the base value, removes an all-empty override entry, writes the normalized remainder, toasts `Metadata saved.`, and closes.
- Reset changes every field to Inherit. A subsequent Save removes the override and restores detected metadata.
- Guess fills explicit form values but does not save.

## Guess implementation

Add:

```ts
export async function guessModelMeta(
  baseUrl: string,
  modelId: string,
): Promise<{
  context_window?: number;
  display_name?: string;
  capabilities?: {
    vision: boolean;
    reasoning: boolean;
    tools: boolean;
  } | null;
} | null>;
```

Correct dual-path behavior:

- Tauri calls `lookup_models_dev` with `{ baseUrl, ids: [...] }`. The command
  returns an array, not the full compact cache.
- Try the exact model ID and publisher-prefix-stripped ID.
- If provider-scoped Tauri lookup misses, retry with an all-provider lookup (`baseUrl: ''`).
- Browser loads `/models-cache.json`, searches the provider-matched subset first, then all providers, using `findProvidersInCache()` and `lookupInProviders()`.
- Fix or bypass the current `model-enricher.ts::loadCache()` Tauri branch. Do
  not invoke `lookup_models_dev` without its required arguments. Do not cast
  its array result to `CompactCache`.
- No remote request to models.dev occurs.
- On match, Guess fills context and all returned capability states silently.
- On miss, show `toast.info("Sorry, couldn't guess.")`.

## Settings export/import/reset

Add an optional wire field because old version-1 exports remain accepted:

```ts
modelOverrides?: Record<string, {
  c?: number;
  v?: boolean;
  r?: boolean;
  t?: boolean;
}>;
```

Writer:

- Always emits `modelOverrides`.
- Deep-clones each entry, not only the outer record.

Validator:

- Accepts the field when missing.
- Requires a plain record when present.
- Requires `c` to be a positive safe integer and `v/r/t` to be booleans when present.
- Rejects arrays, null entries, malformed fields, and non-finite/fractional/non-positive context values.

Import:

1. Restore profiles/settings.
2. Call `useAppModels.getState().replaceMetadataOverrides(s.modelOverrides ?? {})`.
3. Clear `modelCache` because imported profile IDs may otherwise reuse stale metadata from the previous installation.
4. Trigger cache-first app-model bootstrap/refresh after installing profiles
   and overrides. The existing `importSettings()` path does not clear this
   cache. The old reference to lines 333-334 was incorrect because those lines
   belong to `resetSettings()`.
5. Registry records/effective models recompute immediately, then again from fresh detected models as discovery completes.

Reset paths:

- `resetSettings()` calls `useAppModels.getState().resetMetadataOverrides()` next to visibility reset.
- `clearAndResetAll()` calls both `resetMetadataOverrides()` and visibility
  `resetAll()`. These calls consistently clear memory and primary/backup
  storage. Do not rely only on deleting localStorage keys before reload.

## Files touched

| File | Change |
|---|---|
| `src/modules/server-profiles/model-overrides.ts` | new pure validation/persistence adapter + immutable merge helper |
| `src/modules/server-profiles/model-overrides.test.ts` | merge, persistence normalization, explicit false, profile isolation |
| `src/modules/server-profiles/model-store.ts` | Canonical active/inactive registry. Own overrides, detected/effective records, and the active compatibility projection. |
| `src/modules/server-profiles/model-cache.ts` | preserve detected false booleans in base cache |
| `src/modules/server-profiles/model-enricher.ts` and/or `src/modules/llm-client/models/*` | Correct dual-path Guess lookup. Remove the invalid Tauri cache cast. |
| `src/modules/server-profiles/cross-server.ts` | consume the registry's active effective projection with exact-profile identity |
| `src/modules/server-profiles/index.ts` | export new store/actions/types if using the barrel |
| `src/modules/chat-pipeline/orchestrator.ts` | Explicit user vision false wins. Use composite profile/model lookup. |
| `src/ui/settings/ModelVisibilityPanel.tsx` | metadata rows + accessible override editor + reactive base/effective join |
| `src/ui/settings/SettingsPage.tsx` | Reactive Workspace model list. Invalidate a selected non-vision model. Use the model-store replace action. |
| `src/ui/settings/SubAgentModelPicker.tsx` | Change only if needed for invalid-selection display or accessibility. The filtering rule stays `vision === true`. |
| `src/ui/chat/ChatView.tsx` | reactive composite-key context selector |
| `src/ui/chat/ModelPicker.tsx` | Use shared `formatCtx`. Remove the context callback if unused. |
| `src/ui/chat/TokenMeter.tsx` | unknown fallback 32768 -> 256000 |
| `src/ui/shared/ModelCapabilityIcons.tsx` | new shared icons |
| `src/utils/formatCtx.ts` | new shared formatter |
| `src/index.css` / `src/themes/solid.css` | Badge, editor, and tri-state styles. Solid-theme audit compliance. |
| `src/utils/export.ts` | optional wire type + deep-copy writer + strict validator |
| `src/utils/import.ts` | replace overrides, clear stale model cache, trigger rebuild, reset paths |
| `src/utils/settings-export.test.ts` | missing/valid/malformed override validator cases |
| `src/utils/import.test.ts` | replace semantics and reset behavior |
| `package.json` | add any new test file to the explicit `tsx --test` list |
| `docs/data-model.md` | document base cache, effective models, and override shape after implementation |

No `src-tauri` product-code change is planned. Guess reuses the existing `lookup_models_dev` command with its correct request/response contract, and image analysis continues to use the existing `tool_analyze_images` command.

## Automated verification

This repository uses `node:test` / `tsx --test`, not Vitest.

- `npm test` after adding new tests to the explicit package script.
- `tsc -b`.
- ESLint on touched files.
- `node scripts/check-solid-css.mjs`.

Required tests:

- `applyOverride()` is immutable and merges each field independently.
- Explicit `false` wins over detected `true`.
- Removing/resetting an override restores base metadata without network refresh.
- Two profiles with the same model ID remain isolated.
- Store override changes synchronously produce a new effective `models` array.
- Visibility records include inactive cached profiles without a component-level `modelCache` read.
- Cached `false` capabilities survive write/read.
- Workspace vision candidates use effective metadata.
- A configured vision-model reference is invalidated when effective vision becomes false.
- Runtime vision resolution honors explicit false even when `modelDetail` is true.
- Context lookup matches both `serverId` and model ID.
- Settings validator accepts a missing field and valid overrides. It rejects
  arrays, invalid booleans, defined empty/malformed records, and invalid
  context numbers.
- Import replaces rather than merges overrides and clears stale base cache.
- Existing sub-agent cancellation/lifecycle tests remain green. Registry
  changes do not alter `runSubAgentChatOnce`, `AnalyzeImagesArgs`, or Rust
  search/fetch command inputs.
- Existing model list, cache ordering, import, and token-meter tests remain green.

## Manual acceptance checklist

1. Open model visibility: rows show effective badges/context and `?` for unknown context.
2. Set an unknown model's Vision override to Yes and Save.
3. Without refreshing models, confirm it appears under **Settings > Workspace > Model for image analyze**.
4. Select it there, then change its Vision override to No. Confirm it disappears and the configured image-analysis model resets to `Same as chat model`.
5. Use a chat with the same model. Confirm that the explicit No override blocks
   or avoids vision injection even if server detail reports vision.
6. Set a context override for the active chat model. Confirm the token meter ceiling/percentage updates immediately.
7. Reset the context override. Confirm the detected base context returns immediately.
8. Verify the same model ID on a second profile is unchanged.
9. Confirm that a Guess hit fills the form without saving or showing a success
   toast. Confirm that a miss shows `Sorry, couldn't guess.`.
10. Close/reopen/restart and confirm overrides persist.
11. Export settings and confirm that `modelOverrides` is present. Import the
    settings and confirm that overrides, Workspace filtering, and the token
    meter are restored.
12. Import an older settings file without `modelOverrides` and confirm overrides clear cleanly.
13. Reset settings and Clear-and-reset both remove primary/backup override data.
14. Run `lc_read_image` with `analyze:true` and a configured image-analysis
    model. Confirm that the same packed profile/model resolves and the Rust
    analysis request succeeds.
15. Run `lc_web_research` with a configured research model. Confirm that Rust
    search/fetch and TypeScript synthesis behavior are unchanged.

## Resolved decisions

1. Vision filtering and reactive context metering are the highest-priority outcomes.
2. Override identity is always `profileId + modelId`.
3. Capability editing is three-state: Inherit / Yes / No.
4. Context input edits only the override. Empty means Inherit.
5. Unknown context displays `?`. The token meter uses a 256000 fallback.
6. Reset returns every form field to Inherit. Save then removes the override.
7. Guess fills only and stays silent on success. Miss text is
   `Sorry, couldn't guess.`.
8. Groups remain collapsed by default (`collapsedGroups[profileId] ?? true`).
9. Overrides remain separate from the model cache and are never written into detected metadata.
10. The registry is the only live metadata source for UI/runtime consumers.
    Persistent caches are input adapters only.
11. Rust image-analysis, web-search/fetch, and sub-agent transport contracts remain unchanged.
