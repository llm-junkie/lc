# A16 — Documentation and code sync

**Template code:** `A16` · **Version:** 1.0 · **Status:** Active

> Codes are stable identifiers. Never reuse a code, and never reassign one.
> Record `A16 v1.0` in the audit that uses this template. A major version change
> means that the subcode catalog, invariants, or matrix changed. Audits that ran
> against different majors are not comparable.

---

## Scope

**Mechanical in.** Every living Markdown document in the checker corpus. This
includes the root `README.md` and tracked documents under `docs/`, `scripts/`,
`theme/`, and `skills/`. It also includes any legal or public Markdown admitted
by the checker, documentation paths in source comments, and the
cross-references between these surfaces.

**Semantic in.** Exactly one fixed A16 subcode per run. This includes every
living document and docstring that makes a claim in that subcode's semantic
scope. "All documentation" is not a completable semantic audit.

**Out.** The *contents* of the records in `docs/audits/logs/`. Those records are
dated, and nobody rewrites them. The mechanical checker also excludes dated
records from the link, path, and orphan checks.

Their **boundary** is in scope. Invariant 8 checks the rest of the tree for
references that point into them.

### Runnable subcodes

`A16` is a family template. It is not a runnable code. Do not create an
`a16__yyyymmddhhmm` run. Select one stable subcode from this table and use it in
the run id, such as `a16c__202608252355`.

| Subcode | Semantic documentation scope |
|---|---|
| `A16a` | Built-in tool surface, policy, errors, typed guidance, help, and generated reference claims. `A16b` owns Tool History details. `A16c` owns Whiteboard details |
| `A16b` | Tool History storage, retrieval, search, ranking, projection, bounds, compatibility, and diagrams |
| `A16c` | Whiteboard tool, policy, lifecycle, storage, archive, package, UI, recovery, security, privacy, and accessibility claims |
| `A16d` | Conversation state, persistence, multi-conversation ownership, capacity, coordination, recovery, diagnostics, and release-evidence claims |
| `A16e` | Provider protocols, request and response envelopes, streaming, usage normalization, reasoning, cancellation, and transport claims |
| `A16f` | Profile, model, model-discovery, override, credential, routing, model-cache lifecycle, and execution-snapshot claims |
| `A16g` | Search-provider selection, request behavior, private-host rules, measured provider evidence, and cache-observability claims |
| `A16h` | Startup, Safe Start, recovery shell, development build, packaged runtime, generated resources, CI and release workflows, release gate, and artifact claims |
| `A16i` | Sandbox, permissions, SSRF, secret handling, privacy, redaction, conversation-export boundaries, and support-diagnostic claims |
| `A16j` | Overlay stack, input ownership, shortcuts, focus, announcements, zoom, motion, and assistive-technology claims |
| `A16k` | Theme, viewer, preview, export, responsive layout, rendering, and visual-parity claims |
| `A16l` | CPU, responsiveness, memory, lifetime, cache-retention, hostile-input, benchmark, and platform-performance claims |
| `A16m` | Documentation corpus, index, source-path map, audit process, audit-archive boundary, and migration-policy claims |

The subcode set and meanings are stable. After first use, adding, removing, or
reassigning one is a major template change. Update
`scripts/check-docs-sync.mjs` and its known-answer fixture in the same change.

These subcodes partition claims, not files. A cross-cutting file such as
`architecture.md`, `modules.md`, or `getting-started.md` can contain claims for
several subcodes. Assign each claim to its subject. Do not assign the whole file
to one subcode for convenience.

An A16 subrun is not a substitute for another audit template. It follows each
in-scope documentation claim to enough implementation, test, generated, or
runtime evidence to decide whether that claim is true. It does not repeat the
owning audit's complete matrix or search unrelated implementation behavior for
new defects. If claim verification exposes an out-of-scope product defect,
record the documentation mismatch and hand the product question to its owning
audit domain.

In particular, `A16a` does not produce an A01 verdict. It checks whether
existing tool documentation is true. It does not run A01's complete per-tool
matrix or investigate undocumented tool behavior.

The audit requester or maintainer selects the subcode before the branch opens.
The auditor confirms that the selected boundary is completable. The auditor
must not replace it with a different or easier scope. For an untargeted
maintenance sweep, the maintainer selects in this order:

1. A subcode named by an open residual or a recent high-risk change.
2. A subcode with no closed A16 coverage.
3. The subcode with the oldest closed A16 coverage.
4. Catalog order when the previous rules tie.

If the claim inventory proves that a fixed subcode is still too large, stop
before semantic inspection. Record the sizing evidence and ask the maintainer
to revise this catalog. Do not narrow the run silently or invent a new subcode.

Record the exact subcode and table name, the selection basis, and the previous
closing commit or `none` in audit §1. The run timestamp is the minute that the
individual subrun opens. Do not reuse another subrun's timestamp as a suite id.
The maintainer adds `A16 subcode: <code> — <exact table scope>.` after the
closing commit's opening paragraph. This structured line lets later selection
use `git log` without depending on a deleted record.

## Scale and execution plan

A16 has two different boundaries. Every subrun checks the whole living
documentation corpus for mechanical failures. It deeply verifies the claims of
one fixed subcode. If the proposed semantic scope is "all documentation", stop
and select a subcode before source inspection.

On 2026-08-26, the Markdown under `docs/` measured approximately 248,000
`gpt-tokenizer` tokens. A whole-repository semantic attempt would require more
than 1.5 million candidate tokens across documentation, implementation, tests,
and scripts before runtime evidence. Tokenizers can produce different counts.
Treat these figures as planning information. Do not use them as coverage proof
or a token cap. Re-measure them after material repository changes.

A16 can therefore exceed A01 if it is scoped incorrectly. A large context
window does not solve the evidence, attribution, and recall problems of one
monolithic pass.

Before source inspection, add an execution plan to audit §1, §3, and §4. The
plan must do these things:

- Copy the selected subcode's exact scope into §1. Name its owning contract
  documents and explicit claim boundaries. Do not rename or broaden the scope.
- Separate the corpus-wide mechanical cells from the subcode semantic cells.
- Inventory every living document and docstring that makes a claim about the
  selected claim family. Do not start with an assumed short file list.
- Map each claim to its authority in production code, tests, generated sources,
  or measured runtime evidence.
- Keep a claim ledger. Record the claim location, claim type, authority,
  evidence, and state. Use `Not started`, `Pass`, `Finding`, `Unexercised`, or
  `Not applicable`.
- Validate each mechanical checker with independently known good and bad
  fixtures before trusting its clean result.
- Re-derive semantic claims from the required source on demand. Do not load the
  whole repository and rely on context recall.
- Check every replacement sentence as a new claim. Search the corpus for the old
  promise in the words a reader would use.
- Record evidence and ledger changes after each phase. Use the audit record as
  external memory before context compaction or a session restart.

Use these phases unless the audit records a better equivalent:

1. Confirm the subcode, claim inventory, authority map, and evidence plan.
2. Run and validate the corpus-wide mechanical checks.
3. Map the selected claims to code, tests, generated sources, and runtime
   evidence.
4. Re-derive each claim and record findings, non-findings, and uncertainty.
5. Apply remediation, verify every replacement claim, and reverse-search for
   the old behavior.
6. Re-run verification and close every required ledger cell.

The final verdict covers the selected subcode and the mechanical corpus sweep
at the recorded commit and time. It never means that all documentation was
semantically correct. If resources stop the run, mark the remaining cells
`Unexercised`. Do not broaden the verdict or lower the evidence standard.

## Invariants

1. **Every in-scope documented behavior exists.** A described flag, field,
   function, or command is present in the code with those semantics.
2. **Every reference resolves.** Cross-document links, section anchors, and
   cited source paths all point at something real.
3. **Numbers are checkable.** A stated test count, tool count, or coverage
   figure names what produced it. A reader can then measure it again instead of
   trusting it.
4. **Claims are dated where they age.** "Verified live" without a date is not a
   claim. It is a mood.
5. **In-scope status labels are current.** A plan marked "no code changed yet"
   whose plan shipped is worse than no status at all.
6. **Docstrings do not cite documents that no longer exist.** Deleting a record
   requires repointing what referenced it.
7. **Where a document and the code disagree, the document says which one wins.**
8. **Nothing outside `docs/audits/logs/` references a record inside it.** This
   covers references by path, by link, by run id, and by finding id. A record is
   an audit file or a review file. The directory and its `README.md` are
   ordinary documentation, and anyone may link to them.

   The archive is a leaf. A conclusion worth citing belongs in the document that
   owns that contract. The live audit branch named for the run id and the
   standalone closing commit message are the only operational exceptions;
   neither is a contract citation, and the branch is deleted after integration.
   See [`../README.md`](../README.md#the-archive-is-a-leaf).
9. **Dated risk acceptances are re-verified at each release gate.** An
   acceptance is a claim with an expiry, not a permanent record. At the gate,
   re-verify it against code or a test and re-date it, or delete it. Delete a
   claim that you cannot re-derive from either source.

   Carrying an acceptance because it is *correctly dated* is the exact failure
   this invariant catches. A date proves when someone wrote a line. It never
   proves that the line is still true.
10. **`A16c` gives the Whiteboard contract one implemented vocabulary.** Tool,
    policy, error, Tool History, data-model, architecture, module, security,
    privacy, theme, overlay, recovery, and accessibility documents use the same
    owner, pending/provisional/retained, turn-reference, package, size, and
    lifecycle semantics as code. The built-in count and category count come
    from the canonical registry and policy types. The implementation plan is
    renamed to the living `lc-whiteboard.md` document only after completed-diff
    review.
11. **`A16d` gives multi-conversation concurrency one ownership vocabulary.**
    Architecture, streaming, data model, modules, security, support-report,
    troubleshooting, settings, source comments, and audit templates agree on
    the capacity-two default and hard maximum of three; provisional and
    committed chat admission with exact-owner handoff; conversation/generation
    identity; immutable snapshots; per-conversation persistence/UI state;
    application interaction
    and mutation coordination; journal recovery; diagnostics; and the current
    environment-dependent release observations and evidence status.

## Check matrix

Run **Link integrity**, **Orphans**, and **Archive leakage** against the whole
living documentation corpus. Apply every other semantic axis only when it is
relevant to the selected subcode and its living claims. Keep an unrelated
semantic row in the audit matrix, mark it `Not applicable`, and state the scope
reason. Do not silently remove rows.

| Axis | Required variations |
|---|---|
| Link integrity | Cross-file links, intra-file anchors, and source paths cited in prose and in docstrings |
| Behavioral claims | Each documented flag, field, default, cap, and command, against its implementation |
| Numeric claims | Test counts, tool counts, surface counts, and coverage figures, all re-measured |
| Tool documentation inventory (`A16a`) | Registry order and count, category and foundation membership, grant behavior, system-prompt claims, typed guidance catalogs, help modes and limits, stable recovery codes, content-versus-control field ownership, declared orchestration notices and framing bounds, and generated LC Tool Cheat Sheet revision and token fixture. `A16b` and `A16c` own their detailed contracts |
| Generated documentation sources | Skill source Markdown against `src/modules/builtin-skill-content.ts`, generator inputs against outputs, and generated-content tests. Re-run the generator and distinguish a required update from an identical no-op |
| Status headers | Every "Status:" line, every "Updated:" line, and every verdict line |
| Orphans | Documents the index does not reference, and index entries with no document |
| Docstring drift | Module headers that describe a structure that has since changed |
| Archive leakage | Inbound references to a **record** in `docs/audits/logs/`, from docs, docstrings, comments, and test names. Include bare run ids and finding ids such as `F-a16c-…` and `R-a16c-…`, which no path grep will catch. Links to the directory or its `README.md` are not leakage. The live audit branch and standalone closing commit are the only operational exceptions |
| Semantic drift | Claims that require reading the implementation: stale prose, wrong docstrings, changed defaults, and numbers that stay syntactically valid while no longer being true |
| Whiteboard contract (`A16c`) | Input/output schema, 32 KiB UTF-8 bound, owner permissions, exposure default, batch rule, pinned/latest visibility, version IDs and sequence ordering, pending/provisional lifecycle, branch truncation, archive carrier, Tool History projection, package filename and ZIP bounds, overlay layouts and exit guards, support-report exclusion, recovery, and plan-to-living-document rename |
| Multi-conversation contract (`A16d`) | Capacity default and maximum, Settings location/export/import fallback, provisional lease and handoff ordering, session and phase ownership, navigation and resident UI state, persistence lanes/revisions/tombstones/journal schema and repair, FIFO prompts, filesystem/shell coordination, snapshot fields and secret boundary, image-cache ownership, Sidebar behavior, support-report allowlists, packaged acceptance, soak, and same-profile provider characterization |

## Domain-specific evidence rules

- **Script the mechanical half.** Link, anchor, and path resolution are exactly
  the checks a human skims past. A short Node script over every `.md` file finds
  them reliably. A careful read does not.
- **The script is not the whole audit.** It deliberately cannot prove semantic
  behavior, numeric freshness, status accuracy, or docstring meaning. A clean
  script run is necessary evidence. It is not an A16 subrun verdict.
- **Test the deletion. Do not reason about it.** Before you remove a document,
  move it aside and run the reference checks again. Retiring the bug
  post-mortems turned up two live references this way, which a read had missed.
- **Do not write the intended end state as fact.** A document that says a file
  "was removed" before anyone removed it is false. It is false in the direction
  a reader cannot detect, because the prose looks settled. Describe the policy
  and the migration, and let the tree speak for the deletion.
- **Re-derive every claim you keep, not only every number.** A figure must be
  measurable again. Any other claim must be checkable again against code or a
  test. "Linux has never been exercised" is not a figure, so a numbers-only rule
  waves it through while it goes stale. If you cannot re-derive a claim, name
  the thing that would prove it, or delete the claim.
- **The line you write to replace a bad claim is itself a new claim. Check it
  before you write it.** Rewriting a vague, unverifiable sentence into a
  specific, checkable-sounding one is the most tempting fix available, and the
  easiest to get wrong, because precision reads as evidence.

  Open the file you are about to cite. Naming a workflow, a job, or a constant
  that does not do what you credit it with is *worse* than the woolly sentence
  it replaced. A reader can now act on it, and it will survive every mechanical
  check. Verify a replacement against its source as rigorously as you verify the
  claim you remove.
- **For `A16c`, reconcile Whiteboard from source, not from the accepted plan
  alone.** The plan is the implementation contract during rollout, but the
  audit must compare every living claim with the registry, policy, schemas,
  storage transactions, UI state engine, ZIP parser, native bounded reader, and
  tests. Rename the plan only after this comparison, then prove no living
  reference still points at the retired plan filename.
- **For `A16d`, reconcile concurrency from source, not from the implementation
  report.**
  Follow admission, handoff, session registration, snapshot capture, tool
  identity, persistence, terminal cleanup, recovery, Settings, and UI selectors
  through production code and tests. The report is evidence history; living
  documents must be re-derived from the tree.
- **A grep is not a check.** `git check-ignore` on a path that does not exist
  produces a confident wrong answer. So does a regex that matches a substring of
  a URL. Verify the checker before you trust the result.

## Known-load-bearing context

- [`docs/README.md`](../../README.md) lists the living documents. The contract
  map is in that same file, under
  [Where each contract lives](../../README.md#where-each-contract-lives).
- The tool contract spans [`tools/tools.md`](../../tools/tools.md),
  [`tools/tool-reference.md`](../../tools/tool-reference.md),
  [`tools/tool-guidance-and-help.md`](../../tools/tool-guidance-and-help.md),
  [`tools/tool-error-handling.md`](../../tools/tool-error-handling.md),
  [`tools/tool-history.md`](../../tools/tool-history.md), and
  [`tools/TOOL-POLICY-MODEL.md`](../../tools/TOOL-POLICY-MODEL.md). A tool count
  or exposure claim is not checked until it is reconciled across that set and
  the registry source.
- Audit records and post-mortem records are working documents. Migrate their
  durable conclusions into the contract documents before removal. That migration
  is part of this audit's job when it runs alongside a cleanup.
