# A01 — Tool surface and contracts

**Template code:** `A01` · **Version:** 1.0 · **Status:** Active

> Codes are stable identifiers. Never reuse a code, and never reassign one.
> Record `A01 v1.0` in the audit that uses this template. A major version change
> means that the invariants or the matrix changed. Audits that ran against
> different majors are not comparable.

**Siblings:** [`a02-tool-loop-and-concurrency.md`](./a02-tool-loop-and-concurrency.md)
(how calls are scheduled), [`a11-security-and-sandbox.md`](./a11-security-and-sandbox.md)
(whether a call is permitted).

---

## Scope

**In.** All 21 built-in tools. This covers the Zod schemas, the JSON Schema sent
on the wire, the descriptions the model reads, the typed guidance and recovery
catalogs, `lc_tool_help` result modes, the result shapes, the error contracts,
the batch semantics, the caps, and the Rust handlers behind them. It also covers
the claims the system prompt makes about tools and the complete serialized tool
payload sent to each provider. It covers the **text** of every error, remedy,
warning, suggestion, help result, orchestration notice, and limit message that
a model can trigger. It also covers which result field owns each kind of text.

**Out.** Scheduling and concurrency (sibling). Sandbox enforcement (sibling).

## Scale and execution plan

A01 is LC's largest active audit template by declared surface and matrix size.
It covers all 21 tools and their shared TypeScript, Rust, provider, test, and
documentation contracts.

On 2026-08-26, the measured static working set was approximately 520,000 unique
`gpt-tokenizer` tokens before runtime evidence. The measurement included the
central audit files, direct A01 contracts, boundary templates, tool-engine code
and tests, Rust tools, adapters, and prompt-integrity code. Tokenizers can
produce different counts. Treat this figure as planning information. Do not use
it as coverage proof or a token cap. Re-measure it after material repository
changes.

Before source inspection, add an execution plan to audit §3 and §4. The plan
must do these things:

- Divide the audit into phases. Keep shared checks separate from per-tool
  checks, so one shared result is not repeated 21 times.
- Map every invariant and matrix axis to its required evidence. Identify source,
  test, runtime, live-provider, transcript, and packaged-build evidence.
- Keep a coverage ledger. Give each required cell one state: `Not started`,
  `Pass`, `Finding`, `Unexercised`, or `Not applicable`.
- Record evidence and ledger changes after each phase. Use the audit record as
  external memory before context compaction or a session restart.
- Use scripts and batched fixtures for mechanical checks. Validate each checker
  with independently known good and bad inputs.
- Reserve a final phase for cross-tool agreement, payload totals, model-visible
  language, documentation impact, non-findings, and residuals.

The phases are work units, not smaller verdicts. A01 is complete only when every
required matrix cell has a recorded disposition. If resources stop the run,
mark the remaining cells `Unexercised`. Do not lower the evidence standard or
claim a complete A01 verdict.

## Invariants

1. **The schema, the description, and the behavior agree.** The handler honors
   a parameter that the model can send. The cap the description states is the
   cap the handler enforces.
2. **The system prompt describes tools that exist**, with the semantics those
   tools have. Drift here is invisible to tests and expensive in tokens.
3. **Path and error travel together.** Every filesystem tool echoes the
   offending path in its result. The model can then correct itself without a
   guess.
4. **Every bound is explicit and enforced.** Realistic input must not be what
   keeps a bound inside its limit. Bounds include entry counts, byte caps,
   result truncation, and batch size.
5. **Truncation is always signalled.** A result that was cut off says so. A
   silent drop is a correctness bug. On `lc_read_image`, `analyze:true` can drop
   images after the first 10 without a signal. Treat that as a known regression
   candidate. An audit must verify the signal, or record the remaining behavior
   as an explicit finding.
6. **Mutating tools are atomic, or they are explicitly not atomic.**
   `lc_apply_patch` validates and prepares all deterministic actions before its
   first commit. Only a commit-time failure can produce a partial result, and
   `fully_applied` reports that result.
7. **Definitions travel once.** Tool definitions go through the structured
   provider field. Do not duplicate them into the system prompt.
8. **An error message is control input, not a log line.** The model writes its
   next call from the message. Every message names the field it rejected, says
   what was wrong with that field, and gives a remedy that is true *for that
   field*. A message borrowed from a sibling parameter is a defect, even when
   the rejection itself is correct.

   One validator can serve two parameters. If it describes both in the
   vocabulary of the first, it states advice that is false for the second.
9. **Absence and empty content follow the field contract.** For an optional
   parameter where empty content has no operation-specific meaning, omission,
   `null`, and an empty or whitespace-only string all mean "not supplied". The
   handler accepts each form as such. A field whose contract makes empty or
   whitespace-only text meaningful must preserve it exactly. `lc_whiteboard`
   applies that exception according to the selected action: empty `content`
   clears the model board during replace, empty `new_string` deletes the exact
   match during edit, and whitespace can be board content or an exact match.
   Blank fields that belong to another action normalize to omission.

   Models fill every declared optional field instead of leaving it out. If the
   handler rejects the filler, it teaches a rule the schema does not contain.
   The model then satisfies that invented rule with a real value, so the retry
   *succeeds* while it does work nobody requested. Fail closed only for input a
   reader could misread as an instruction, such as an unparseable range. An
   empty value carries no instruction to misread.
10. **A rejection states the rule it enforced.** When a constraint is
    positional, ordered, or conditional, the message names that constraint. A
    real but misplaced header reported as "unknown" denies that the header
    exists. The caller then cannot correct the placement, and repeats the
    layout.
11. **Absence has one meaning on the way out, too.** Invariant 9 governs input.
    This invariant is its mirror on the result. Every required field is present
    on every entry that declares it. Optional fields are omitted when absent;
    they are never emitted as `null`. A counter whose absence would be
    ambiguous is required and carries zero where nothing happened.

    This includes success entries, error entries, and cancellation entries.
    The schema, serializer, fixtures, and prose must agree about which fields
    are required and which fields are omitted.
12. **Sibling tools agree about the same bytes.** Two tools can accept the same
    path. They must not disagree about whether that file is text, binary,
    hidden, or too large.

    Some differences are deliberate. A search that skips one file must not fail
    a whole batch, and a read of that file has nothing to return. When the
    difference is deliberate, both descriptions state it. A model that gets
    `binary_detected` from one tool and a clean empty result from another
    cannot tell which answer describes the file.
13. **A signal that asserts a fact can prove it.** Invariant 5 forbids the
    silent drop. The opposite failure is also a defect. A truncation flag raised
    when nothing was cut sends the model to redo completed work.

    Proving a positive is usually cheap. Proving a negative usually is not.
    Where the proof is unbounded, the result carries a third value that means
    *not determined*. Never dress a guess as a fact in either direction.
14. **The payload is bounded, not only the item count.** A result cap counts
    items. It does not bound their size. One field of one item can exceed every
    other budget in the tool. A per-item cap still leaves the sum unbounded.
    State both bounds, and name the bound that stopped the call.

    A cap also counts the unit the caller receives. When a mode returns one row
    per file, a cap that spends itself per match gives that mode the same
    ceiling as the verbose one, and the number it returns is a floor wearing the
    name of a total. Check the cap against each output shape, not only the
    default one.

15. **A reported property comes from the evidence the tool acted on.** A tool
    that sniffs a file's bytes to decode it, and then reports the format from
    the filename, is describing a different file from the one it opened. The
    weaker source usually agrees, which is what makes the disagreement rare and
    late.

    This is invariant 12 turned inward: not two tools contradicting each other,
    but one tool contradicting itself. Ask of every reported property which
    input produced it, and whether the tool already held a better answer at that
    moment.

16. **Typed catalogs own model-facing per-tool guidance and recovery.** A tool
    description, detailed help section, error recovery mapping, or suggested
    help query is derived from the authoritative catalog when that catalog owns
    it. A duplicate prose table or switch in the runner is drift, even when its
    current text happens to agree.
17. **Detailed help stays bounded and inside one exposed tool.**
    `lc_tool_help` resolves one requested tool, never lists the registry, and
    searches only that tool's catalog with deterministic ranking and bounds.
    It reports its result through `data.mode`, keeps the ordinary
    `ToolResultEnvelope`, and never exposes detailed guidance for an unexposed
    tool. A corrected name is reported; it is never executed as an operational
    call.
18. **Model-visible text follows LC's structural STE rules.** Every LC-authored
    description, help result, issue, remedy, warning, suggestion, orchestration
    notice, and limit message passes the repository checker. Documentation and
    tests describe these as LC's structural rules. They do not claim official
    ASD-STE100 compliance.
19. **Content fields contain only the content they declare.** Tool-native
    recovery guidance belongs in `warning` or `warnings`. A per-item failure
    belongs in `error`, and a terminal failure belongs in `issues`. An image
    `description`, PDF `summary`, fetched `body`, or process `stdout` and
    `stderr` must not carry LC control prose. Cancellation returns an aborted
    result instead of successful-looking content.
20. **A successful transport response is not proof of semantic content.** A
    vision response counts as a description only when the selected provider
    response shape contains non-whitespace text. Missing or blank text becomes
    a per-image error. If no image has real model text, `analyzed` is false and
    `description` is null. `analyzed_count` counts images successfully encoded
    and admitted to a vision request; it does not assert network delivery.
    `described_count` counts usable descriptions returned.
21. **To-do status and evidence are independent.** A list accepts zero, one, or
    several `in-progress` tasks. `completion_evidence` is optional, trimmed,
    bounded, and must contain visible text when present. A completed task
    without it succeeds with one bounded warning; it is not rejected or
    silently supplied with fabricated evidence.
22. **Whiteboard operations preserve ownership and visibility.** One explicit
    read returns the turn-pinned user board and latest model board. Replace and
    exact edit can change only the model board. The schema has no owner or
    historical-version selector. Mutation results report compact references,
    `changed`, and resulting UTF-8 bytes; they do not echo the document.

## Check matrix

| Axis | Required variations |
|---|---|
| Per tool | Happy path, bad path, missing file, permission-denied path, oversized input, malformed params, empty batch |
| Batch | Single, multiple, at the cap, over the cap, mixed valid and invalid entries |
| Mutation | Create, overwrite, partial multi-file patch, a patch whose second file fails at commit |
| Encoding | UTF-8, CRLF and LF, BOM, very long lines, binary content |
| Truncation | Output just under and just over each cap, verifying the signal |
| Wire shape | The JSON Schema each adapter sends, per envelope |
| Description drift | Every description read against the handler it describes |
| Guidance ownership | Every typed catalog entry against the descriptions, detailed help, stable recovery codes, and model-visible messages derived from it. Include a tool with pilot help and a tool without detailed help |
| Help resolution | Exact name, safe correction, ambiguous name, unknown name, unexposed name, and no catalog. A correction is returned as data and never becomes an operational execution |
| Help query | Omitted query, exact section label, aliases, multiple terms, no match, tie by declaration order, normalization, maximum terms, maximum matches, and maximum serialized bytes. Search stays inside one resolved tool |
| Help result shape | Every `data.mode`: `basic`, `matched`, `no_match`, `ambiguous`, `not_exposed`, `already_returned`, and `limit_reached`. Optional fields are omitted rather than set to `null`; there is no list or revision mode |
| Absence encoding | Per optional parameter: omitted, `null`, `""`, whitespace-only, and the value that means "no effect" for that field |
| Error message text | The named field is the field that failed. The remedy is true for that field. Sibling parameters do not share one message. A positional or conditional rule is stated, not implied |
| Remedy replay | Follow each stated remedy literally. The corrected call must succeed, and must do what the remedy promised |
| Result-field presence | Every declared result field, on every entry the tool can emit: success, per-entry error, cancellation during work, and the zero case for each counter |
| Content and control ownership | `lc_read_image` capability, cache-miss, encoding, request-failure, missing-text, and partial-success paths; `lc_read_pdf` summaries and exact-text recovery; pre-spawn `lc_run_shell` and `lc_web_fetch` cancellation. Assert that content fields contain no LC guidance |
| Vision response shape | Anthropic Messages, OpenAI Responses, LM Studio REST, and Chat Completions, each with real text, blank text, missing text, malformed JSON, and a non-success status. Distinguish images admitted to requests from usable descriptions returned |
| To-do status and evidence | Zero, one, and several in-progress tasks; completed tasks with evidence, without evidence, with empty or invisible-only evidence, and with evidence at and over the cap; one update with several missing-evidence IDs. Pin the successful warning and validation-error text |
| Whiteboard operations | Read both turn-visible documents; replace with ASCII, Unicode, empty, and whitespace-only content; exact edit with one, zero, and several matches; deletion; unchanged replacement and edit; reread after each mutation; and an attempted owner or historical-version field |
| Whiteboard bounds and recovery | Exactly 32 KiB and one byte over, measured as UTF-8; deterministic bounded not-found suggestions; bounded non-unique excerpts; read and write failures; missing retained reference; failed initialization; and an aborted generation. Assert compact mutation output and no user-board text in edit diagnostics |
| Cross-tool agreement | One file, put to every tool that can open it. Do the tools agree it is text, binary, hidden, or oversized? Where they differ, does each description say so? |
| Payload bound | One result item at its maximum size, a full result set at its maximum count, and the two together |
| Signal provability | A run that stops exactly at a cap with nothing beyond it, and a run with one item beyond it. The flag must tell those apart, or say it did not determine which |
| Cap unit per mode | Each output shape at its cap. The unit spent must be the unit returned, so a mode that emits one row per file does not spend itself per match |
| Property provenance | Per reported property: which input produced it, and whether the tool already held a stronger answer. Format, encoding, size, and type are the usual offenders |
| Refusal paths | Every rejection the tool can emit, exercised end to end. A guard that stops working fails by accepting, which no passing test notices |
| Payload budget | Exact token counts for the complete serialized tool payload, the complete schema-description payload, and the system prompt. Measure each fixture directly; do not add per-tool token counts |
| Model-visible language | Every LC-authored description, help result, issue, remedy, warning, suggestion, orchestration notice, and limit message against the structural STE checker |

## Domain-specific evidence rules

- **Read the description against the handler, not against the schema.** The
  schema and the handler usually agree. The prose is what rots.
- **Measure the serialized payload that the provider receives.** Adding
  independent per-tool token counts does not account for array, object, field,
  and escaping overhead. Use the exact full-payload fixtures, and record the
  tokenizer and exposure profile with the result.
- **Test help as a result contract, not as prose search.** Assert the resolved
  tool, `data.mode`, correction, omitted optionals, declaration-order tie break,
  exposure boundary, and serialized byte cap. A matching sentence alone does
  not prove deterministic resolution.
- **A cap claim needs an input that crosses it.** Reading `max_entries` proves
  that the constant exists. It does not prove that the handler enforces it.
- **A 2xx response is only transport evidence.** For every supported vision
  response shape, return an empty object and a whitespace-only text field. The
  public tool result must report an image error, not fabricate a description.
- **Test semantic field ownership, not only field presence.** A non-null
  `description` or `summary` can satisfy the type while carrying a warning,
  placeholder, or error. Assert both where control text appears and where it
  does not appear.
- **Assert on the message, not on the rejection.** `assert.rejects(fn, /Invalid
  "force_render" value/)` passes on *any* message that carries that prefix. This
  includes a message whose remedy is false for `force_render`. A test that pins
  only the prefix certifies the half of the message that was never wrong. Pin
  the remedy sentence.
- **A remedy is a testable claim about behavior.** If the message says "omit it
  to read every page", omit it and confirm that the tool reads every page. An
  unexercised remedy sentence is where a sibling field's advice survives.
- **One validator serving two parameters needs a message test per caller.** A
  test of the helper alone cannot see that the wording is wrong for the second
  caller, because the helper does not know which caller it serves.
- **Session transcripts are primary evidence for this domain.** A repeated
  identical call marks a message the model could not act on. A
  duplicate-suppression marker marks the same thing. Sample archived
  conversations across several model families. A message that reads clearly to a
  human is not thereby actionable, and the models that fill optional fields are
  not always the weakest ones.

  **Boundary:** the suppression mechanism belongs to the loop, not to this
  template. A01 reads the marker as a symptom of a bad message. A01 does not
  verify that suppression fires correctly.
- **Check the escape, not only the error.** Read the calls that *follow* a
  rejection. A model that escapes by inventing a value has learned a rule the
  schema does not contain. The escaping call then returns green, so the defect
  is invisible in every signal except the arguments themselves. Ask what
  fraction of *successful* calls carry a value the caller never wanted.

  > **The shape this takes.** A range validator shared by `pages` and
  > `force_render` rejected an empty string with the `pages` remedy: *omit it to
  > read every page*. That advice is false for `force_render`, where omission
  > renders nothing extra. Two archived sessions, on different models, show the
  > same escape. Each retried the identical call, then set `force_render` to
  > `"1"` to satisfy the invented "must be non-empty" rule. Every successful read
  > in both sessions then rasterized page 1 unasked. The rejection was correct
  > and the tests passed, and the result was wrong work on a green path.
  >
  > That instance is fixed, and it is here as the pattern, not as an open defect.
  > An audit sweeps for the class: any optional parameter that rejects its own
  > absence, and any message whose remedy was written for a different field.

- **A test that rebuilds the logic tests nothing.** A unit test can construct
  its own copy of a check and assert on that copy. Such a test passes forever,
  including after the production check breaks. Read each test back to the
  function it claims to cover. If the code under assertion is defined inside the
  test module, the coverage is imaginary. This is worst where it is most
  reassuring, because the untested check now looks guarded.
- **Point every tool at one file.** Cross-tool disagreement is invisible from
  inside one tool's tests, because each tool is self-consistent. Take one
  awkward file and call every tool that accepts a path. Use UTF-16 content, a
  dotfile, a file just over a size ceiling, and a file that holds a NUL.
  Disagreement is a finding in whichever description does not mention it.
- **A refusal needs its own test.** A guard is a few lines that never run on
  the happy path, so nothing fails when it stops working — the tool simply
  begins accepting what it used to refuse. Drive each refusal end to end, and
  assert that the state it protects is unchanged afterwards, not merely that an
  error came back.
- **Exercise meaningful empty Whiteboard strings.** Generic optional-absence
  fixtures are not evidence for `lc_whiteboard`. Send empty and whitespace-only
  values through the production argument normalizer, schema, and handler. Prove
  that an empty replacement clears the model board, an empty replacement text
  deletes exactly one match, whitespace stays byte-for-byte stable, and the
  user board never changes.
- **Check a documented format list against what the build links.** A constant
  table of supported types drifts from the decoder's feature flags without a
  single test failing, because nothing reads the table except the reader. Take
  each entry and feed the tool a real file of that type.
- **Search results are claims about absence.** Zero matches asserts that the
  text is not there. Verify that claim against a file the search cannot decode,
  not against one it simply does not match. A decoder that silently mangles
  content returns the same empty result as a genuine miss, and nothing in the
  output separates the two.

  > **The shape this takes.** A content search decoded every candidate
  > leniently. It replaced undecodable bytes instead of refusing them. UTF-16
  > text survives that decode as valid UTF-8, because a NUL is a legal code
  > point. The pattern therefore ran against alternating letters and NULs,
  > matched nothing, and returned an empty result with no diagnostic set.
  >
  > A sibling read tool already called the same bytes binary and refused them.
  > The toolchain's own shell wrapper emitted UTF-16 on Windows, so the search
  > could not see files the toolchain produced. Every test passed. Four of those
  > tests exercised a boundary walk written inside the test module, which the
  > production path never used.
  >
  > Invariants 11 and 12 fail there, and so does the evidence rule above. Each
  > failure was invisible from inside that one tool. The class is any tool that
  > answers a question about content it decoded permissively, and any pair of
  > tools that read the same bytes to different conclusions.

## Known-load-bearing context

- [`tools/tools.md`](../../tools/tools.md), [`tools/tool-reference.md`](../../tools/tool-reference.md),
  [`tools/tool-guidance-and-help.md`](../../tools/tool-guidance-and-help.md), and
  [`tools/tool-error-handling.md`](../../tools/tool-error-handling.md) are the
  contracts. A disagreement is a finding in one or the other.
- [`tools/tool-error-handling.md`](../../tools/tool-error-handling.md) grades
  each tool's self-correction quality, and currently records no failing tier.
  That grading asks whether the *information* reaches the model, such as the
  path, the code, and the field name. Presence is necessary and not sufficient.
  A message can carry all three and still point the caller at the wrong
  correction.

  An audit that confirms the grade has not yet checked invariants 8 to 10. A
  tool graded ✅ is where a wrong-remedy defect hides longest.
- [`tools/TOOL-POLICY-MODEL.md`](../../tools/TOOL-POLICY-MODEL.md) is normative
  for exposure and category membership.
