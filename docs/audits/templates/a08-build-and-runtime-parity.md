# A08 — Build and runtime parity

**Template code:** `A08` · **Version:** 2.0 · **Status:** Active

> Codes are stable identifiers. Never reuse a code, and never reassign one.
> Record `A08 v2.0` in the audit that uses this template. A major version change
> means that the invariants or the matrix changed. Audits that ran against
> different majors are not comparable.

---

## Scope

**In.** The production build, the packaged desktop bundles, generated resources,
bundled assets, embedded provider contracts, and license artifacts. It also
covers every behavior that differs between `npm run dev` and the installed
binary.

**Out.** Runtime performance in either mode
([`a06-cpu-and-responsiveness.md`](./a06-cpu-and-responsiveness.md),
[`a07-memory-and-lifetimes.md`](./a07-memory-and-lifetimes.md)).

## Invariants

1. **Behavior verified in dev holds in the packaged build**, or the difference
   is documented. Startup failure counting, key storage, and the native relay
   all behave differently outside packaged Tauri.
2. **Every generated resource is generated.** Git ignores the files the build
   writes, and the pipeline produces them. Never commit them, and never let them
   go missing silently.
3. **Nothing disposable is committed.** Git ignores everything that `clean.cmd`
   and `clean.sh` delete. `.gitignore` states this invariant, and it must stay
   true. The Windows cleaner and the Linux and macOS cleaner remove the same
   classes of artifact.
4. **The bundle ships what it claims.** No development-only module, fixture, or
   source map reaches the release artifact unintentionally.
5. **License obligations are met in the artifact**, not only in the repository.
6. **A cold install works.** Use a fresh machine, no prior config, and no dev
   server.
7. **Concurrent lifecycle parity is packaged parity.** Capacity admission,
   independent native relays, targeted cancellation, background completion,
   conversation UI restoration, and application-owned page exit behave the
   same in dev and the installed binary. Browser-only fallback may differ only
   where a native capability is explicitly unavailable.
8. **Provider contracts are embedded, not deployed as mutable data.** The
   validated registry source is compiled into application code. No standalone
   `provider-contracts.v1.json` appears in `public/`, `dist/`, app data, or the
   packaged resource list, and runtime startup performs no contract fetch. A03
   owns contract semantics; A08 proves artifact placement and packaged parity.

## Check matrix

| Axis | Required variations |
|---|---|
| Build path | Incremental `npm run build`, direct `npm run tauri:build`, `build.cmd --no-pause`, `bash build.sh --no-pause` |
| Artifact | Linux `deb`, AppImage, and RPM. Windows NSIS and MSI. macOS `.app` and DMG. Every target configured in `src-tauri/tauri.conf.json` |
| Install state | Fresh install with no prior config, and an upgrade over a previous version |
| Resource generation | Direct `npm run tauri:dev` after the generated common resources are absent. Cover `models-cache.json` in both copies, Excalidraw assets, the spine builder, `LICENSE`, and `NOTICE`. Confirm that dev does **not** generate the production dependency inventory, and that `npm run tauri:build` does |
| Embedded provider contracts | Source-schema check, dev startup, production Vite output, and packaged desktop artifact. Confirm the registry marker is compiled into application code, no standalone contract JSON is emitted or copied, and the synchronous and compatibility async accessors return the same frozen object without network activity |
| Native Gemini addition | Confirm `google.gemini-interactions` is embedded and the [final profile UI and badge mapping](../../note-gemini-rest.md#configuration) survive packaged rendering: four primary chips, separated protocol row, uppercase colored letters, and generic URL hint without automatic replacement. Verify `/interactions` is appended once, native relay cancellation, and conversation reload; local fixture tests do not close live/provider or packaged parity cells |
| Built-in skill generation | Generate `src/modules/builtin-skill-content.ts` from the skill sources when missing or changed. Repeat with identical bytes and prove the generator performs no rewrite. On Windows, exercise a transient sharing violation and the bounded retry path without hiding a persistent failure |
| Environment | Packaged Tauri, dev server, browser-only with no Tauri APIs |
| Parity probes | Key storage, startup markers, one and three native stream relays, middle-stream cancellation, page exit with several sessions, background Sidebar status, conversation draft restoration, the default-two and opt-in-three capacity setting, and file dialogs. Verify each one in the packaged build |
| Concurrent provider run | Two sessions at the default, three after opt-in, refusal of the next chat without losing its draft, three maximum transport queues, cancellation of the middle owner, and same-profile server behavior. Record whether the external server executes, queues, or rejects parallel requests |
| Release workflow | The version and tag check, generated resources, legal artifacts, draft-release behavior, and the exact bundle matrix in `.github/workflows/release.yml` |

## Domain-specific evidence rules

- **A parity claim requires the packaged binary.** A dev-server result is
  evidence about the dev server. This is the same rule that governs live
  provider evidence in
  [`cache-observability.md`](../../cache-observability.md).
- **Do not substitute a packaged startup smoke for concurrent parity.** A
  responsive five-second launch proves packaging and startup only. Exercise
  simultaneous generation and targeted Stop inside the packaged WebView, or
  record that acceptance as outstanding.
- **Build from a clean tree at least once.** A build that works only
  incrementally is a build that will fail in CI.
- **Exercise both wrapper families.** Static parity is necessary and not
  sufficient. Record their phases, their failure exit codes, and their
  `--no-pause` behavior on Windows and on Linux and macOS. A local host build is
  not evidence for another platform.
- **Record the artifact.** Give the bundle names, the sizes, and the commit they
  came from.

## Known-load-bearing context

- `.gitignore` states the clean-script invariant. Adding a clean target without
  an ignore entry breaks it.
- `npm run tauri:dev` stages the development resource list before it launches
  Tauri. `run_dev.*` installs dependencies and delegates to that npm handle. A
  bare `npx tauri dev` bypasses the contract.
- `npm run tauri:build` owns `release:prepare`. It then invokes Tauri with the
  release overlay, whose merged configuration removes `beforeBuildCommand`. The
  root `build.*` wrappers must not pre-build the frontend, because that runs the
  full pipeline twice.
- `public/models-cache.json` is tracked, and it is what the build stages. The
  build never fetches. `scripts/data/models-dev.json` is an untracked 3 MB
  snapshot, used only by the manual refresh path. That path is
  `scripts/fetch-models-dev.mjs` followed by `scripts/build-models-cache.mjs`.
  `src-tauri/resources/models-cache.json` is a generated copy of the tracked
  file.
- `scripts/build-skills-content.mjs` owns the generated built-in skill-content
  module. An identical source must not replace the output file, because an
  unnecessary rewrite can collide with the Windows compiler or file watcher.
  Transient write retries are bounded; a persistent write failure still fails
  the build.
