# LC — Engineering Documentation

**Version:** 1.0.0 | **Release status:** Pre-release | **Updated:** 2026-09-02 | **Stack:** React 19 + TypeScript + Vite 8 + Zustand + Tauri 2 (Rust)

This document is the engineering reference for the LC (LLM Client) codebase. It covers architecture, modules, tools, the security sandbox, streaming, and the data model.

The [project README](../README.md) provides the product overview. Use
[`getting-started.md`](./getting-started.md) to install and configure LC, and
use this document for implementation details, behavioral contracts, audits,
and historical engineering records.

---

## Standing product constraints

These bind every feature, not one of them. A change that breaks one of these is
a defect regardless of what else it improves.

1. User data stays local unless the user deliberately sends it to a model,
   search provider, or export destination.
2. Support reports are explicit local actions. LC never uploads one.
3. Recovery never silently deletes or rewrites conversations, messages,
   attachments, settings, profiles, keys, grants, skills, or workspace files.
4. Provider-reported values stay distinguishable from LC estimates and LC
   inferences, everywhere they are shown.
5. Cache support uses provider-native behavior. LC builds no prompt, KV,
   response, or content cache of its own.
6. Diagnostic instrumentation does not reorder prompt content, inject cache
   breakpoints, or otherwise change the provider request. Enabling a provider's
   cache is a separate product decision. Diagnostics then observe the final
   post-policy request. See
   [cache-observability.md §1](./cache-observability.md#1-what-this-is-and-what-it-is-not).
7. Existing compatible servers that omit new optional fields keep working
   exactly as before.
8. Every scan, collection, string, event set, and serialized artifact has an
   explicit bound.
9. Reasoning controls use protocol-shape translation, not model-name correction.
   LC does not silently remap, gate, promote, demote, or omit a selected effort
   value. Provider capability metadata and provider validation are authoritative.
10. Reasoning returned by a provider is canonical conversation data. Normal
    history construction and Tool History do not compact, summarize, prune,
    clear, or delete it. A provider's automatic server-side filtering is not an
    LC deletion policy.

**Do not change these numbers.** Source comments cite them by number.
Constraint 4 uses these numbers in `chat-pipeline/orchestrator.ts` and
`llm-client/cache-usage.ts`. Constraint 6 uses them in
`llm-client/prefix-diagnostics.ts`. Constraint 7 uses them in
`llm-client/adapters/anthropic.ts` and `llm-client/anthropic-version.ts`.
Constraint 8 uses them in `tool-engine/builtin/tool-history-search.ts`.
Constraints 9 and 10 are owned by
[`reasoning-and-token-accounting.md`](./reasoning-and-token-accounting.md).

The `a03` (7, 6), `a05` (3, 8), and `a12` (1, 2, 4, 8) audit templates also cite
these numbers. Several of those
citations are a bare number that names no file, so they are findable only by
searching for the number itself. Renumbering this list silently breaks every one
of them. Add new constraints at the end. Do not reorder the list.

---

## Start Here

| Goal | Recommended document |
|---|---|
| Set up LC or connect a provider | [`getting-started.md`](./getting-started.md) |
| Develop, test, or build LC | [Development](#development) |
| Understand the system | [`architecture.md`](./architecture.md), then [`modules.md`](./modules.md) |
| Change concurrent-chat ownership or lifecycle | [`concurrent-conversations.md`](./concurrent-conversations.md), then [`streaming.md`](./streaming.md) and [`data-model.md`](./data-model.md) |
| Work on agentic tools | [`tools/tools.md`](./tools/tools.md), then [`tools/TOOL-POLICY-MODEL.md`](./tools/TOOL-POLICY-MODEL.md) |
| Change reasoning, replay, effort, token accounting, streaming, or provider adapters | [`reasoning-and-token-accounting.md`](./reasoning-and-token-accounting.md), then [`streaming.md`](./streaming.md) and [`note-openai-responses.md`](./note-openai-responses.md) |
| Review storage and persisted state | [`data-model.md`](./data-model.md) |
| Review trust boundaries | [`security.md`](./security.md) |
| Investigate a regression | [`audits/`](./audits/), and the constraint sections in [`streaming.md`](./streaming.md#adapter-constraints-proven-against-live-endpoints) and [`architecture.md`](./architecture.md#token-counting-is-hostile-input-hardened) |

The policy and reference documents contain more detail than the root README. When behavior changes, update the relevant contract in this document set.

### Where each contract lives

| Area | Document |
|---|---|
| Native Gemini Interactions, final profile UI, replay, implementation owners, and recorded/open verification | [note-gemini-rest.md](./note-gemini-rest.md) |
| Support report v1 — schema, inclusions, exclusions, opt-ins | [support-report.md](./support-report.md) |
| Safe Start — trigger rule, recovery actions, non-goals | [troubleshooting.md](./troubleshooting.md), [architecture.md](./architecture.md) |
| Search providers — selection, resolution, ignored parameters | [search-providers.md](./search-providers.md) |
| Generation parameters — panel organization, built-in recipes and System prompt text, temperature reference, override toggles, per-endpoint support, `max_tokens` vs. thinking budget | [data-model.md](./data-model.md#built-in-parameter-presets), [data-model.md](./data-model.md#the-override-contract), [modules.md](./modules.md#max_tokens-and-the-thinking-budget) |
| Cache usage and prompt-prefix diagnostics | [cache-observability.md](./cache-observability.md) |
| Reasoning retention, provider replay carriers, effort dispatch, live reasoning accounting, assistant-turn footer usage, TokenMeter semantics, and the verified wire-contract database | [`reasoning-and-token-accounting.md`](./reasoning-and-token-accounting.md), [`provider-contracts.v1.json`](../src/modules/llm-client/provider-contracts.v1.json), with storage details in [`data-model.md`](./data-model.md) and performance bounds in [`architecture.md`](./architecture.md#next-request-context-uses-one-provider-history-projection) |
| Concurrent chats — capacity, ownership, UI state, interactions, persistence, and release evidence | [concurrent-conversations.md](./concurrent-conversations.md) |
| Streaming render performance and long-output windowing | [architecture.md](./architecture.md#long-reasoning-streaming-is-bounded) |
| `lc_tool_history` retrieval and bounded search | [tools/tool-history.md](./tools/tool-history.md), [tools/tool-reference.md](./tools/tool-reference.md) |
| Tool policy and permissions | [tools/TOOL-POLICY-MODEL.md](./tools/TOOL-POLICY-MODEL.md) |

---

## Release gate

A public binary may be published only when all of the following conditions
hold. This standing checklist applies to each release.

- the support report meets its coverage, correlation, privacy, delivery, and
  bound criteria, and every documented diagnostic fact has a **production
  emitter**. See
  [support-report.md § Diagnostic facts have production emitters](./support-report.md#diagnostic-facts-have-production-emitters)
  for this requirement. A schema and a test are not sufficient.
- Safe Start and the search providers still pass their regression and privacy
  contracts.
- cache observability passes its adapter, persistence, UI, report-versioning,
  prefix-diagnostics, and privacy criteria. This includes **dated live probes
  for each service where credentials are available**.
  Use `scripts/probe-cache-live.mjs` as the harness. See
  [cache-observability.md § Running a live probe](./cache-observability.md#running-a-live-probe).
- Tool History search passes its compatibility, ranking, bound, responsiveness,
  and UTF-8 criteria.
- TypeScript tests, `tsc -b`, `eslint .`, Rust tests, the frontend production
  build, and the packaged desktop smoke path all pass.
- the documentation describes actual behavior, including every provider surface
  that is fixture-only rather than live-verified.

No additional feature is implied by that list. A release is not blocked on
pinned context, MCP, a Tool History browser, provider cache tuning, or other
breadth.

### Manual desktop-platform validation

| Platform | Status |
|---|---|
| Windows 11 | **Certified working.** Manual runtime test completed on 2026-08-28. |
| Linux Mint 22.3 Cinnamon (X11) | **Certified working.** Manual runtime test completed on 2026-08-28. |
| Fedora 44 Workstation (GNOME, Wayland, NVIDIA proprietary driver) | **Certified working.** Manual runtime test completed on 2026-08-28. |
| macOS (Apple Silicon and Intel) | **Build verified; runtime unverified.** GitHub Actions builds both targets and provides source-level frontend and Rust test coverage on `macos-latest`. No job launches the packaged app or executes the Intel artifact, and no manual Mac test has been performed. |

### Accepted platform and performance residuals

These dated risk acceptances are not passes. Re-examine each acceptance during
the release gate.

| Residual | Disposition |
|---|---|
| Linux WebKitGTK performance | Manual runtime certification is current for Linux Mint 22.3 Cinnamon and Fedora 44 Workstation as of 2026-08-28, but no formal Linux performance measurement is recorded. |
| macOS (Apple Silicon and Intel) | `ci.yml` and `pre-release.yml` provide source-level test coverage on `macos-latest`; `pre-release.yml` then builds Apple Silicon and Intel artifacts after its test matrix passes. `release.yml` builds both targets but runs no tests. No workflow launches the packaged app or executes the Intel artifact, and no manual Mac test has been performed. Runtime compatibility remains unverified. |
| Automated packaged-app launch | Manual runtime certification is current for Windows 11, Linux Mint 22.3 Cinnamon, and Fedora 44 Workstation as of 2026-08-28. Automated packaged-app launch coverage is still absent on every platform. |
| Excalidraw fonts (12.50 MiB) | On 2026-08-19, the copy script staged 234 files with a total size of 13,107,068 bytes. The repository accepts this size for complete offline CJK fidelity. The fonts load only when needed and are absent from the cold path. The copy script stages only the package's production font directory. It does not stage locale JSON files. |
| Large-history message-list virtualization | On 2026-08-19, source inspection confirmed that `ChatView` still maps every non-tool message to a `MessageBubble`. The list is not virtualized. This audit did not repeat the earlier browser measurement. Therefore, the living index does not retain its numeric results as current performance evidence. |
| Completed very-long reasoning DOM | On 2026-08-24, source and tests confirmed that live reasoning is bounded and every completed field over 6,400 characters reopens through the same 6,400-character progressive budget. Markdown-safe tails stay within the budget when a boundary is available; an oversized final atomic block uses a bounded plain-text tail. Each user click doubles the budget, and repeated clicks can reach the full settled render. Source inspection confirms that this explicit full render is not virtualized. See [architecture.md](./architecture.md#long-reasoning-streaming-is-bounded). |
| Repeated viewer open/close heap retention | The repository has no current heap trace. Release-platform validation still owns a formal repeated-open and close retention check. This status was checked again on 2026-08-19. |
| Three-conversation tool/image soak | No current 30-minute forced-GC renderer soak is recorded. Release validation must capture heap start/end, resident transcript/UI counts, image-cache bytes, and Dexie write-latency percentiles. This status was checked on 2026-08-24. See [concurrent-conversations.md](./concurrent-conversations.md#release-evidence-still-required). |
| Same-profile concurrent provider behavior | No current observation records whether one real LM Studio or other local profile executes, queues, or rejects three simultaneous generations. This is provider behavior, but release validation must characterize it. This status was checked on 2026-08-24. See [concurrent-conversations.md](./concurrent-conversations.md#release-evidence-still-required). |
| Packaged concurrent-chat interaction | The packaged startup path is covered separately. Repository evidence does not yet include a final packaged-UI pass with simultaneous generation, targeted cancellation, capacity refusal/draft retention, and Sidebar ownership. This status was checked on 2026-08-24. See [concurrent-conversations.md](./concurrent-conversations.md#release-evidence-still-required). |

These manual platform checks cover runtime functionality, not formal
performance measurement or automated packaged-app launch. macOS remains at
build and source-test coverage until a packaged app is run there.

---

## Document Map

### Core

| Document | Content |
|---|---|
| [`architecture.md`](./architecture.md) | Runtime overview, technology stack, system context, component tree, module dependency graph, and data flow |
| [`concurrent-conversations.md`](./concurrent-conversations.md) | Concurrent-chat product behavior, ownership, admission, UI state, interactions, resource coordination, persistence, recovery, privacy, and remaining release evidence |
| [`modules.md`](./modules.md) | Deep dive into the 4 modules, including the Base URL contract, model-list endpoint probing, and the `max_tokens`/thinking-budget precedence |
| [`security.md`](./security.md) | Sandbox (`resolve_under_roots`), binary allowlist, env scrubbing, SSRF, permissions, cancellation |
| [`data-model.md`](./data-model.md) | `Conversation`, `Message`, `GenerationParams` and the parameter override contract, `ServerProfile`, tool config, storage layout |
| [`getting-started.md`](./getting-started.md) | Installation, first launch, provider setup, custom skills, conversation Whiteboard, security boundaries, and troubleshooting |
| [`support-report.md`](./support-report.md) | Support-report v1 schema, privacy boundary, included/excluded data, bounds, and GitHub issue workflow |
| [`troubleshooting.md`](./troubleshooting.md) | Startup recovery, Safe Start activation, retry flow, first-launch Gatekeeper/SmartScreen approval, and non-destructive guarantees |
| [`linux-platform.md`](./linux-platform.md) | Linux platform behaviors and workarounds: matte material resolution, WebKitGTK Shift-keyup quirk, NVIDIA + Wayland DMABUF startup-crash guard, tao 0.35 Wayland titlebar-button repair, and the tauri 2.12 removal checklist |
| [`github-workflows.md`](./github-workflows.md) | CI gates, dependency security, public-repository scanning, and draft desktop releases |
| [`streaming.md`](./streaming.md) | SSE pipeline, protocol adapters, `readWithTimeout`, tool loop orchestrator, timeout architecture |
| [`reasoning-and-token-accounting.md`](./reasoning-and-token-accounting.md) | Normative provider reasoning contract: replay carriers, retention, effort pass-through, footer and TokenMeter ledgers, live accounting, verified provider matrix, and known implementation deviations |
| [`reasoning-loop-detection.md`](./reasoning-loop-detection.md) | Reasoning-only loop guard, matching algorithm, abort semantics, finish metadata, and tests |
| [`file-line-changes-preview.md`](./file-line-changes-preview.md) | File-change badge and highlighted preview: persistence, lazy reconstruction, file-level merging, stacked-hunk semantics, and final-state limitations |
| [`search-providers.md`](./search-providers.md) | Brave, SearXNG, and Marginalia as user-selected search providers: measured provider evidence, selection and priority rules, parameter parity, private-host reasoning, and licence constraints |
| [`cache-observability.md`](./cache-observability.md) | Provider cache counters and prompt-prefix diagnostics. Covers normalized usage, per-surface coverage, and live evidence. Explains what LC observes versus what LC changes. Includes the live-probe harness. |

### Tools

| Document | Content |
|---|---|
| [`tools/tools.md`](./tools/tools.md) | All 21 built-in tools with schemas, error handling, batch semantics, Rust backends |
| [`tools/TOOL-POLICY-MODEL.md`](./tools/TOOL-POLICY-MODEL.md) | Normative exposure, authorization, persistence, and Workspace UI contract |
| [`tools/tool-reference.md`](./tools/tool-reference.md) | Complete per-tool input/output schemas, edge cases, and batch semantics |
| [`tools/tool-error-handling.md`](./tools/tool-error-handling.md) | Per-tool behavior on bad paths, content, and params — and whether the model can self-correct |
| [`tools/tool-history.md`](./tools/tool-history.md) | `lc_tool_history` design: tool result archive, API, context flow, TokenMeter integration |
| [`tools/tool-history-diagrams.md`](./tools/tool-history-diagrams.md) | Tool History architecture diagrams (detailed and simplified) |
| [`tools/tool-guidance-and-help.md`](./tools/tool-guidance-and-help.md) | Engineering contract for tiered model guidance, bounded `lc_tool_help`, and condition-specific recovery |
| [`tools/lc-todo-write.md`](./tools/lc-todo-write.md) | Closed engineering reference for foundation exposure, model-maintained task state and expected staleness, continuity, and the Preview Overlay tab |
| [`tools/lc-ask-user.md`](./tools/lc-ask-user.md) | Closed implementation contract for foundation user questions, same-turn continuation, FIFO interaction ownership, and modal presentation |
| [`tools/lc-whiteboard.md`](./tools/lc-whiteboard.md) | Closed implementation contract for two-owner Markdown boards, turn-scoped versions, model tool access, package handoff, and responsive history UI |

### Viewers & provider notes

| Document | Content |
|---|---|
| [`diagram-viewers.md`](./diagram-viewers.md) | SVG, Mermaid, and Excalidraw viewer behavior, theme-aware exports, 4x output, and transparent-background shortcuts |
| [`excalidraw-viewer.md`](./excalidraw-viewer.md) | Why the embedded viewer is pinned to `@excalidraw/excalidraw@0.18.1`, and the compatibility constraints |
| [`note-openai-responses.md`](./note-openai-responses.md) | Design decisions behind the OpenAI Responses (`/v1/responses`) integration: reasoning, storage, state |
| [`keyboard-and-overlays.md`](./keyboard-and-overlays.md) | Which surface owns a key press: the modal gate, the overlay stack, and the propagation rules that are not optional. Read before adding an overlay or a shortcut |
| [`../theme/theme-system.md`](../theme/theme-system.md) | Spine theme format, token resolution, and the standalone theme builder |
| [`upgrade_visibility.md`](./upgrade_visibility.md) | Design rationale for the model-visibility registry and per-model overrides. **Implemented** — kept for the reasoning, not as open work |

### Audits and post-mortems

**Every durable conclusion belongs in the document that owns that contract**, not
in the audit that found it. The table below points directly to the document that
owns each listed conclusion.

Audit records are **kept** in [`audits/logs/`](./audits/logs/). Each audit needs
an independent review before the maintainer can close it. The archive provides
provenance, not the durable contract.

[`audits/`](./audits/) holds the reusable machinery: an index, the audit and
review skeletons, and sixteen domain templates. See
[Roles and the cycle](./audits/README.md#roles-and-the-cycle) for who may close
an audit.

**Current contract owners:**

| Conclusion | Owned by |
|---|---|
| One adapter serves a whole protocol family — vendor behavior needs a predicate | [`streaming.md`](./streaming.md#adapter-constraints-proven-against-live-endpoints) |
| Images ride as their own user turn, exactly once, labelled as tool output | same |
| Images inside tool results: rejected by 2 of 3 live endpoints, do not retry blind | same |
| Adapter unit tests cannot validate protocol support | same |
| Anthropic requires strict user/assistant alternation | same |
| `countTokens` bounds unbroken runs and neutralizes tokenizer sentinels | [`architecture.md`](./architecture.md#token-counting-is-hostile-input-hardened) |
| `sortOrder` must hold a single value domain | [`data-model.md`](./data-model.md) |
| Settings import preserves local credential fallbacks it cannot reproduce | [`search-providers.md`](./search-providers.md#62-key-handling), [`data-model.md`](./data-model.md) |
| Keychain writes reject where no backend exists | [`search-providers.md`](./search-providers.md#62-key-handling) |
| Attachment blob mutations feed the durable-write vocabulary | [`support-report.md`](./support-report.md) |
| Archive and settings import enforce size caps before decompression. Import re-sequences `sortOrder` outside the counter domain. | [`data-model.md`](./data-model.md) |
| `ToolCallRecord` deliberately has no status field, with the measurement behind it | [`data-model.md`](./data-model.md) |
| Escape ownership is decided by listener order, not stacking order | [`keyboard-and-overlays.md`](./keyboard-and-overlays.md) §3.1 |
| A modal can vanish mid-dispatch, so the gate reads a capture-phase snapshot | [`keyboard-and-overlays.md`](./keyboard-and-overlays.md) §3.2 |
| The SSRF predicate deliberately uses bit arithmetic. A CIDR table was declined. | [`security.md`](./security.md#why-this-is-bit-arithmetic-and-not-a-cidr-table) |
| Custom themes must not inherit `[data-theme='light']`-gated overrides | [`theme/theme-system.md`](../theme/theme-system.md) |
| `repairWindowsJson` is destructive and may only run after a parse failure | [`tools/tool-error-handling.md`](./tools/tool-error-handling.md#repairwindowsjson-is-only-ever-a-fallback) |
| `lc_apply_patch` validate-then-commit design and `fully_applied` semantics | [`tools/tools.md`](./tools/tools.md) |
| Platform validation evidence and remaining automation gaps | [Manual desktop-platform validation](#manual-desktop-platform-validation) and [Accepted platform and performance residuals](#accepted-platform-and-performance-residuals), above |

The test suite is the durable reference. It includes `image-injection.test.ts`,
`tokens.test.ts`, `orchestrator-closure.test.ts`, `scroll-lock.test.ts`,
`mermaid-render-boundary.test.ts`, and the adapter suites. These tests encode
findings from this list. The build also runs `scripts/check-solid-css.mjs`.
---

## Quick Reference

### Key Files

| Concern | File | Role |
|---|---|---|
| App shell | `src/App.tsx` | Layout + cross-cutting hooks |
| Startup boundary | `src/startup/` + `src/safe-start/` | Pre-App phase/counter state machine, packaged-Tauri selection, and minimal recovery/report shell |
| Orchestrator | `src/modules/chat-pipeline/orchestrator.ts` | `runStreamWithTools()`: stream → tools → re-stream loop |
| System prompt | `src/modules/chat-pipeline/system-prompt.ts` | Dynamic prompt builder with tool definitions |
| Protocol adapters | `src/modules/llm-client/adapters/{openai,openai-responses,anthropic,gemini-rest,lmstudio-rest}.ts` | One file per API protocol |
| Model discovery | `src/modules/llm-client/models/{url,list,gemini}.ts` | URL resolution, bounded local fallback, native/OpenAI response parsing, Gemini pagination, full-ID preservation, and metadata-enrichment handoff |
| Tool registry | `src/modules/tool-engine/registry.ts` + `registry-names.ts` | `BUILTIN_TOOLS`, `HANDLERS_BY_NAME`, and canonical category membership |
| Tool runner | `src/modules/tool-engine/runner.ts` | Validation, resolution, execution, permission checks, concurrency pool |
| Sandbox bridge | `src/modules/tool-engine/sandbox-bridge.ts` | Typed interface for all Tauri tool commands |
| Conversation store | `src/store/conversations.ts` | Zustand + Dexie (IndexedDB). Metadata loads at startup. The selected chat and every transcript lifecycle owner remain resident. Only complete, clean, nonresident histories are evicted. Generation-addressed mutations and completeness checks prevent partial snapshots from replacing durable history. The current Dexie v3 schema includes the generation journal. Incompatible versions are rejected. |
| Settings store | `src/store/settings.ts` | Zustand-persisted settings defaults and actions (schema version 1) |
| Tauri entry | `src-tauri/src/lib.rs` | Command registration, proxy, window state |
| Theme builder | `theme/spine-builder.html` (source) → `src-tauri/resources/spine-builder.html` (build artifact) | Vite emits the standalone page to `dist/`. `scripts/copy-tauri-resources.mjs` copies it to `resources/`. The packaged app uses the system browser. Raw EXEs use the embedded app-cache fallback. |
| FS sandbox | `src-tauri/src/tools/fs_ops.rs` | `resolve_under_roots`, all file I/O |
| Shell sandbox | `src-tauri/src/tools/shell.rs` | Binary allowlist, env scrub, UTF-16 decode |

### Module Map

```
src/modules/
├── llm-client/          ← Protocol adapters (OpenAI, OpenAI Responses, Anthropic, Gemini REST, LM Studio REST)
├── server-profiles/     ← Profile lifecycle, model cache, global model store
├── chat-pipeline/       ← Streaming + tool loop orchestrator, system prompt, phase tracking
└── tool-engine/         ← Tool registry, typed SandboxBridge, 21 built-in handlers
```

Module barrels are the preferred public APIs. UI code also imports focused
helpers directly. Examples include path and file-change helpers, generation
and interaction coordinators, provider-history projection, and token-count
request adapters. These examples describe current imports, not an exhaustive
exception list or a requirement to move helpers into barrels.

## Development

Node.js 26 is required by both `.node-version` and `package.json`. Browser-only
development needs Node and npm. Native development and packaging additionally
need Rust plus the platform packages listed by
[Tauri's prerequisite guide](https://v2.tauri.app/start/prerequisites/).

Use `npm ci` for a fresh, lockfile-exact install. The development convenience
wrappers use `npm install` so an existing `node_modules` can be reconciled
without deleting it on every launch.

```bash
npm ci                # Exact package-lock.json install; CI and clean builds use this
npm run dev           # Browser-only Vite server (http://127.0.0.1:5173)
npm run tauri:dev     # Stage common native resources, then start Tauri + Vite
npm run build         # Gates/generators → tsc/Vite → common resources/checks
npm run tauri:build   # Generate production notices, then build host desktop bundles
npm run check:rust    # Stage development resources, then type-check Rust
```

The root wrappers compose those lower-level commands:

| Entry point | Contract |
|---|---|
| `run_dev.cmd` / `bash run_dev.sh` | Runs `npm install` and then `npm run tauri:dev`. It does not generate a dependency-license inventory. Pass `--no-pause` when another script calls it. |
| `build.cmd` / `bash build.sh` | Removes disposable files and runs `npm ci`. It validates release license policy without writing artifacts. Then it runs `npm run tauri:build`. Pass `--no-pause` for non-interactive use. |
| `clean.cmd` / `bash clean.sh` | Removes `node_modules`, `dist`, native Cargo output, generated resources, license inventories, caches, transient logs, and extracted fixtures. Tracked fixture archives, `LICENSE`, and `NOTICE` remain. |

You can invoke `npm run tauri:dev` directly. Its package script stages the
common resource list that Tauri validates before `tauri dev`. Do not invoke
bare `npx tauri dev` because it bypasses that staging contract. The default Tauri
configuration has bundling disabled. `npm run tauri:build` explicitly prepares
the frontend and production legal artifacts, then applies
`src-tauri/tauri.release.conf.json` to enable installers and include the
generated dependency inventory. Neither generated license artifact is tracked.

### Tests

```bash
npm test                                            # JS/TypeScript test suites
npm run build                                       # Gates, generators, tsc, Vite, common resources/checks
npm run lint                                        # ESLint
npm run check:docs-sync                             # Living-document integrity
npm run licenses:check                              # Release dependency policy; writes no artifacts
npm run release:prepare                             # Frontend + generated production legal artifacts
npm run check:rust                                  # Staged native type-check
npm run test:rust                                   # Staged native tests
node scripts/probe-smoke.mjs                        # End-to-end smoke test (live server)
```
