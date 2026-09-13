<!--
  Copyright 2026 LC Contributors

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at
      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->

# Scripts

Every executable script has a name that identifies its **repository role**.
The prefix defines the contract:

| Prefix | Means | Runs when |
|---|---|---|
| `build-` | Produces an artefact that the app imports. | `npm run build` or a deliberate manual refresh |
| `copy-` | Stages existing files for the packager. | `npm run build`, `npm run tauri:dev` |
| `check-` | Acts as a gate. Exits with a nonzero status after a contract violation. | Build, CI, release, or an operator-run check |
| `probe-` | Contacts a live service. Automation never runs it. | Manual |
| `bench-` | Measures behavior and reports results. Makes no assertions. | Manual |
| `fixture-` | Provides deterministic input to tests, probes, or benchmarks. | npm script or direct import |
| `fetch-` | Downloads external data. The build never runs it. | Manual |
| `generate-` | Validates or creates generated distributable inventories. | Build and release preparation |

Do not add a script that does not have one of these roles. Delete one-time
probes after an investigation. If the method remains useful, make it a `probe-`
or `bench-` script. Then, document it in this table.

One legacy exception exists. `gen_pdf_fixtures.py` predates the prefix contract.
It is a manual fixture generator that uses only the Python standard library. It
is deliberately independent of `pdf_oxide`. See
[architecture.md](../docs/architecture.md#pdf-reading-is-rust-side-and-capability-gated).

The file keeps its name to preserve references. A new script must not follow
this exception.

**If a script has an npm handle, cite the handle.** The handle remains valid
after a file rename, but a direct path does not. For example, use
`npm run check:solid-css` instead of `node scripts/check-solid-css.mjs`.

## Repository entry points

The root CMD/SH files are convenience compositions, not alternative build
pipelines. Their Windows and Linux/macOS variants must keep the same phases:

| Entry point | What it owns |
|---|---|
| `run_dev.cmd` / `bash run_dev.sh` | Reconcile npm dependencies with `npm install`, then call `npm run tauri:dev`. The npm handle stages common development resources. It does not build the production dependency inventory. |
| `build.cmd` / `bash build.sh` | Destructively clean, install the exact lockfile with `npm ci`, validate release license policy without writing artifacts, then call `npm run tauri:build`. That production handle generates and verifies the distributable notices before enabling Tauri bundling. |
| `clean.cmd` / `bash clean.sh` | Delete only disposable, gitignored dependencies, outputs, generated resources and license inventories, caches, logs, and extracted fixture directories. `LICENSE`, `NOTICE`, and committed fixture archives survive. |

All wrappers accept `--no-pause` for scripted use. They must return a nonzero
status when a child command fails. `clean.*` removes `node_modules` and the
native Cargo output. You do not need to run it before an incremental build.

## Build

| Script | Handle | What it does |
|---|---|---|
| [`build-skills-content.mjs`](./build-skills-content.mjs) | — | Embeds `skills/*.md` into `src/modules/builtin-skill-content.ts`. Re-run whenever a skill file changes. |
| [`copy-excalidraw-assets.mjs`](./copy-excalidraw-assets.mjs) | — | Copies Excalidraw fonts out of `node_modules` into `public/` so nothing loads from a CDN. The production frontend build generates their `LICENSES.md` beside them. |
| [`copy-tauri-resources.mjs`](./copy-tauri-resources.mjs) | — | Stages `spine-builder.html`, `models-cache.json`, `LICENSE`, and `NOTICE` into `src-tauri/resources/`. Tauri validates that common list in **both** build and dev. `npm run tauri:build` separately generates the production-only dependency inventory and selects `tauri.release.conf.json`. The development form takes the spine builder from `theme/` instead of `dist/`. |

## Gates

Each exits non-zero on failure. `check:provider-contracts` runs **first** in
`npm run build` and `check-release-licenses --frontend-artifacts` runs **last**.
The production release preparation adds the full `--artifacts` check after it
generates the distributable dependency inventory.

| Script | Handle | What it enforces |
|---|---|---|
| [`check-katex-font-assets.mjs`](./check-katex-font-assets.mjs) | `npm run check:katex-fonts` | Verifies that the production CSS references packaged WOFF2 files for all four KaTeX delimiter fonts. This keeps small fonts out of CSP-blocked `data:` URLs. Run it after `vite build`; the ordinary build does this automatically. |
| [`check-solid-css.mjs`](./check-solid-css.mjs) | `npm run check:solid-css` | Confirms that `src/themes/solid.css` covers every glass surface in `src/index.css`. The type system and test suite cannot detect this relationship. Read the header for the scope of the four checks. |
| [`check-release-licenses.mjs`](./check-release-licenses.mjs) | via `npm run licenses:check` | Checks source licence metadata and the split Tauri configuration. `--frontend-artifacts` checks ordinary build outputs. `--artifacts` also requires the production-only dependency inventory. The script runs in CI and `release.yml`. |
| [`check-release-version.mjs`](./check-release-version.mjs) | `npm run release:check` | That `package.json`, `tauri.conf.json`, `Cargo.toml`, and the release tag all state one version. |
| [`generate-third-party-licenses.mjs`](./generate-third-party-licenses.mjs) | `npm run licenses:generate` / `:check` | Validates the production npm/Cargo license closure. `:check` writes nothing. Release preparation uses `:generate` to write ignored artifacts to `src-tauri/resources/THIRD_PARTY_LICENSES.md` and `public/excalidraw-assets/LICENSES.md`. During `npm run build`, `--fonts-only` emits only the small frontend font notice. Requires installed dependencies. |
| [`check-provider-transport.ts`](./check-provider-transport.ts) | `npm run check:providers` | Transport and adapter behaviour against the local fixture server below. Start the fixture first. |
| [`check-docs-sync.mjs`](./check-docs-sync.mjs) | `npm run check:docs-sync` | Checks links, HTML targets, anchors, cited source paths, and orphans in living Markdown, excluding dated audit records as historical evidence.<br>The archive pass recognizes standard run codes and the fixed `a16a`–`a16m` subcodes. It rejects bare `a16` or unknown subcodes and scans non-binary files outside the archive for leakage.<br>It excludes Git metadata in directory and linked-worktree pointer-file form, standard generated or editor directories, and extracted fixture directories.<br>Fixture mode also excludes its root `expected.json` output and reproduces the linked-worktree pointer case.<br>`--fixture` verifies the known-answer set in `fixtures/docs-sync-check/`.<br>CI and the pre-release source-check job run the checker after dependency installation. |
| [`check-test-registry.mjs`](./check-test-registry.mjs) | `npm run check:tests` | Confirms that the explicit file list in the `test` script matches `src/` in both directions. Every test file must run, and every listed path must exist. The list is manual because transitive imports determine whether a file uses `node --test` or `tsx --test`. A glob cannot determine the runner. |
| [`check-import-extensions.mjs`](./check-import-extensions.mjs) | `npm run check:imports` | Confirms that relative value imports include their file extension and type-only imports do not. The Node test runner enforces this rule. Without this check, violations appear as `ERR_MODULE_NOT_FOUND` when a test reaches the module. |

The documentation checker expands comma-separated brace lists in inline source
paths. Every member must resolve. Its fixture includes both valid lists and a
list with a missing member.

## Fixtures

| Script | Handle | What it does |
|---|---|---|
| [`fixture-provider-server.mjs`](./fixture-provider-server.mjs) | `npm run fixture:providers` | Local HTTP server returning deterministic tool-call streams on OpenAI, Anthropic, and Responses envelopes. It also provides a CORS-safe pass-through to a running LM Studio. An OpenAI prompt containing `AUDIT_LONG_REASONING` emits a paced 256 KiB reasoning stream for preview-overlay checks. `AUDIT_FREEZE` retains the existing paced content stream. Reads `LC_AUDIT_FIXTURE_PORT`, `LC_AUDIT_LM_STUDIO_URL`, `LC_AUDIT_LM_STUDIO_MODEL`. |
| [`fixture-lc-archives.mjs`](./fixture-lc-archives.mjs) | imported by the archive fixture tests and benchmarks | Extracts the committed conversation and support-report 7z fixtures on first use. It puts each fixture in a separate subdirectory named after the archive. A `.extracted-ok` sentinel prevents later extractions. The `7z-wasm` development dependency decompresses files in-process. It uses 7-Zip 24.09 compiled to WASM and does not require system 7-Zip or a subprocess. The `.7z` files are tracked, and the extracted subdirectories are gitignored. |

The client reads `LC_AUDIT_FIXTURE_URL` to locate the server. It also reads
`LC_AUDIT_LM_STUDIO_MODEL`. Set these variables for `check:providers`, not for
the server.

### LC archive fixtures — `fixtures/lc-*.7z`

`fixtures/` contains two **committed** 7-Zip recompressions of real LC output.
The test suite, audit evidence, and benchmarks use production-shaped data
without a live app:

| Archive | What it is |
|---|---|
| `lc-chat-v1-all-2026-08-09.7z` (~1.1 MB) | One bulk `lc-chat-v1` export: two production conversations plus two empty archived templates, 425 messages, 6 attachments, 0 custom skills. It retains the ~549K/~895K reasoning fields, a 30K assistant response, an assistant error, seven legacy A13 reply-metadata shapes, and eight fully current reply-metadata shapes. |
| `lc-support-v1-2026-08-09.7z` (~3.5 KB) | Two real support-report v1 JSON files: default opt-outs and both privacy checkboxes opted in. The opted-in capture contains the bounded 64-model identifier sample. Its event window had no eligible error descriptions. |

The conversation archive is the same format LC's **Settings → Conversations →
Import** reads. Its `lc-chat-v1` envelope is:

```
README.txt                 what this is
conversations.json         array of conversations (source of truth)
attachments/<id>-<name>    file bytes, flat folder, one per attachment
skills/manifest.json       custom skill mapping per conversation (only when skills exist)
skills/lc_skill_<name>.md  custom skill Markdown files
```

The support archive unpacks to the exact immutable JSON payloads that LC's
support-report Preview, Copy, and Save surfaces use. They are compatibility and
privacy fixtures, not importable application state.

How the fixtures behave in the repo:

- **The `.7z` files are tracked, and the extracted subdirectories are gitignored.** The
  generic `*.7z` ignore rule is carved out for `scripts/fixtures/*.7z`, and
  `scripts/fixtures/*/` ignores the extract-on-demand dirs (see `.gitignore`).
- **Extraction is on demand and in-process.** `npm test` → the conversation and
  support fixture tests → `fixture-lc-archives.mjs`
  decompresses with the `7z-wasm` development dependency. This dependency uses
  7-Zip 24.09 compiled to WASM. It does not require system 7-Zip or a
  subprocess. Each archive goes into its **own** subdirectory named after the
  archive file. A `.extracted-ok` sentinel makes later runs a no-op. Status
  report: `node scripts/fixture-lc-archives.mjs`.
- **`clean.cmd`/`clean.sh` remove every extracted subdir** — the committed
  `.7z` archives and the tracked `docs-sync-check` corpus are kept, and the
  disposable copies are regenerated by the next `npm test`.
- **`docs-sync-check` is the one tracked fixture dir**: a known-answer corpus
  for `check-docs-sync --fixture`, deliberately exempt from the rules above.
- **Adding an archive:** commit the `.7z`, register it in `ARCHIVE_FIXTURES`
  in `fixture-lc-archives.mjs` with the entries it must contain once
  extracted, and note it in this table.

## Probes — operator-run, hit live services

None of these is called by `npm test`, `npm run build`, CI, or any hook.

| Script | What it does |
|---|---|
| [`probe-cache-live.mjs`](./probe-cache-live.mjs) | Sends one fixed synthetic prompt twice to a real provider and reports which documented cache fields came back, as bounded buckets. Prints no credential, no request or response body, no ids. Has **no defaults** — `--surface`, `--envelope`, `--base-url`, `--model`, and `--key-env` must all be passed, so it cannot contact a provider by accident. See [`docs/cache-observability.md`](../docs/cache-observability.md). |
| [`probe-thinking.mjs`](./probe-thinking.mjs) | Discovers which reasoning/thinking parameters an endpoint actually honours versus silently ignores. Works against LM Studio and the cloud APIs. Documented in [`probe-thinking.md`](./probe-thinking.md). |
| [`probe-smoke.mjs`](./probe-smoke.mjs) | Checks a live OpenAI-compatible server from end to end. It lists models, runs one non-streaming completion, and then runs one streamed completion. It exercises the real SSE path without a browser. Its default target is a hardcoded LAN address, so pass the base URL as the first argument. **It is not a platform or runtime gate.** It never launches LC, loads Tauri, or opens a window. A passing run gives evidence about a model server only. |

## Benchmarks and refresh tools

| Script | What it does |
|---|---|
| [`bench-hot-paths.mjs`](./bench-hot-paths.mjs) | Uses production modules to time UI-thread paths. It measures `countTokens`, the legacy per-frame recount, terminal compression, the maximum to-do snapshot index, and V8 parse cost of production chunks. Live checkpoints skip compression. The script reports numbers and makes no assertions. It measures CPU only. Frame time and heap measurements require a real browser. |
| [`bench-a06-markdown.mjs`](./bench-a06-markdown.mjs) | Times the synchronous Markdown pipeline behind a conversation open. It uses the exact `MessageBubble`/`ChunkedMarkdown` plugin chain: remarkGfm, remarkMath, sanitize/filename plugins, rehypeRaw, rehypeKatex, and rehype-prism-plus. It also uses `escapeNonMathDollars` and `countTokens`. It runs against the merged archive's `LC - Complete Tests` conversation with react-dom/server. It measures per-message cost for 14 real rendered messages, total work at n=50/100/200, and counting over 218 messages/~2.4 MiB. It reports numbers and makes no assertions. This is an SSR proxy for parsing and highlighting only. Browser commit, DOM, and layout require a real browser. Run `node --experimental-strip-types scripts/bench-a06-markdown.mjs`. The command extracts the fixture on demand. Evidence for audit A06. |
| [`bench-reasoning-stream.mjs`](./bench-reasoning-stream.mjs) | Selects `LC - A13 by Qwen 3.8 Max` from the merged archive. It replays the ~549K/~895K reasoning fields through append-only streaming paths. It covers the production TokenMeter computation with warm settled-message caches and a sequential growing-field simulation. It compares full-prefix splitting with the bounded live chunk window. It also measures unbounded single chunks, hostile growing Markdown chunks, and delayed Tool History ownership. It reports numbers and makes no assertions. It measures CPU only. Browser DOM and layout require an app run. Run `node --import tsx scripts/bench-reasoning-stream.mjs`. The command extracts the fixture on demand. |
| [`fetch-models-dev.mjs`](./fetch-models-dev.mjs) | Downloads the models.dev catalogue snapshot. Skips the download if the file exists. `--force` downloads it again. |
| [`build-models-cache.mjs`](./build-models-cache.mjs) | Reduces that snapshot to `public/models-cache.json`.<br>This script is a manual refresh and is not part of `npm run build`.<br>The cache is tracked. Therefore, ordinary builds read it directly and do not need the network. |

To refresh the model catalogue:

```bash
node scripts/fetch-models-dev.mjs && node scripts/build-models-cache.mjs
```

Then commit `public/models-cache.json`. The ~4.1 MB snapshot it derives from
(2026-08-25) is gitignored. Only the ~525 KB output
(2026-08-25) is tracked. Both grow with the models.dev
catalogue. That is what keeps two builds of
one commit producing identical bytes.

This pair refreshes the **tracked source of truth**, which is the artefact that
every build ships. The running app also has an in-app equivalent (Settings → Manage models
→ ⭳, via `src/modules/server-profiles/models-dev-sync.ts` and the Rust
`download_models_dev`/`rebuild_models_dev_cache` commands) that refreshes the
copy on the user's machine without a new build. It does not change the tracked
files. Developers must still run the scripts to add a catalogue refresh to the
repository.
