# A13 — Startup, Safe Start, and recovery

**Template code:** `A13` · **Version:** 1.0 · **Status:** Active

> Codes are stable identifiers. Never reuse a code, and never reassign one.
> Record `A13 v1.0` in the audit that uses this template. A major version change
> means that the invariants or the matrix changed. Audits that ran against
> different majors are not comparable.

**Siblings:** [`a05-state-and-persistence.md`](./a05-state-and-persistence.md)
for durable data. [`a08-build-and-runtime-parity.md`](./a08-build-and-runtime-parity.md)
for packaged behavior against development behavior.

---

## Scope

**In.** `src/startup/` and `src/safe-start/`. This covers startup launch
options, marker persistence, the pre-application bootstrap graph, the Safe Start
shell, failure classification, retry behavior, and reset-window behavior. It
also covers every recovery action available before the normal application loads.

**Out.** General conversation and archive persistence
([`a05-state-and-persistence.md`](./a05-state-and-persistence.md)). Bundle
production ([`a08-build-and-runtime-parity.md`](./a08-build-and-runtime-parity.md)).
Artifact redaction ([`a12-privacy-and-redaction.md`](./a12-privacy-and-redaction.md)).
Normal lazy conversation-load repair of an orphaned Whiteboard provisional row
belongs to A04 and A05, not Safe Start.

## Invariants

1. **The marker is bounded and versioned.** Marker data that is malformed,
   oversized, stale, or unavailable cannot create an unbounded retry loop. It
   also cannot select an unsafe graph.
2. **Startup phases are monotonic and idempotent.** LC records a phase only
   after the boundary is crossed. Duplicate writes and renderer or native races
   cannot move a session backward, and cannot manufacture readiness.
3. **Safe Start is graph-isolated.** The recovery path renders its own shell
   first. Before that, it does not import the normal `App`, the stores, the
   provider adapters, the tools, the skills, model discovery, or the generation
   graph.
4. **Mode selection is explicit.** Automatic Safe Start is packaged-only.
   `--safe-start` is a diagnostic override. Browser and dev behavior stays
   deliberate. A marker failure fails safe, and never invents a crash count.
5. **Retry is bounded.** A normal retry is one-shot. A failed retry returns to
   Safe Start on the next launch. A successful normal launch resets the
   consecutive-failure window.
6. **Recovery is non-destructive.** Safe Start does not silently delete,
   rewrite, archive, repair, or migrate user data, including retained or working
   Whiteboard rows. A destructive operation must be explicit, separately
   confirmed, and outside automatic recovery.
7. **Diagnostics work without the normal store.** The Safe Start report and the
   recovery controls stay usable when LC cannot import the normal application
   graph. They still observe the A12 privacy bounds.
8. **Process boundaries are honest.** A native marker, a renderer failure, a
   clean shutdown, and a window-state reset have distinct meanings. A stale
   session or a second process cannot conflate them.
9. **Safe Start never settles Whiteboard state.** It does not import the
   Whiteboard store, inspect mutation receipts, repair assistant tool results,
   promote pending user content, import a package, or retry `lc_whiteboard`.
   Those normal-graph actions remain unavailable until ordinary conversation
   loading owns them.

## Check matrix

| Axis | Required variations |
|---|---|
| Launch mode | Packaged normal, packaged automatic Safe Start, explicit `--safe-start`, dev, browser-only |
| Marker state | Missing, valid, malformed, oversized, unreadable, stale, a phase at each boundary, and a concurrent read and write |
| Failure count | First early failure, second consecutive failure, Safe Start launch, successful normal retry, failed retry, reset after success |
| Import graph | Safe Start with the normal graph, conversation database, and Whiteboard modules unavailable; the normal graph with Safe Start modules unavailable; and a dynamic import failure at each boundary |
| Recovery actions | Support report, retry normal, reset window state, open data directory, manual inspection, and explicit repair if one exists |
| Side effects | No model discovery, provider request, tool call, generation, auto-archive, Whiteboard read/import/settlement, or background repair before normal readiness |
| Privacy | A Safe Start report with hostile marker and error content, and redaction with the store unavailable |
| Platform | Packaged Windows and at least one POSIX target. A new process, a renderer reload, and a native launch after an interrupted session |

## Domain-specific evidence rules

- **Inspect the module graph, not only the recovery screen.** A Safe Start
  screenshot does not prove that LC skipped importing the normal stores or
  providers first.
- **Exercise the actual marker on disk.** State-machine unit tests are
  necessary. They do not prove native persistence, process boundaries, or
  packaged launch selection.
- **Record the exact launch sequence.** State which process launched, which
  phase completed last, whether the marker was available, and whether the launch
  was packaged.
- **Every automatic action must be reversible, or explicitly non-destructive.**
  A repair that only looks helpful is a recovery finding when it changes data.
- **Seed hostile Whiteboard working state before Safe Start.** An orphaned
  provisional row and mutation receipt must remain byte-for-byte unchanged
  through Safe Start report, retry selection, data-directory opening, and
  window reset. Then start the normal graph and prove that only its lazy
  conversation-load recovery settles the row once.

## Known-load-bearing context

- [`architecture.md`](../../architecture.md#pre-application-startup-boundary)
  holds the pre-application import boundary and the Safe Start graph.
- [`troubleshooting.md`](../../troubleshooting.md) holds the user-visible
  failure counting, the retry behavior, and the recovery behavior.
- [`security.md`](../../security.md) holds the native launch and local-data
  trust boundaries.
