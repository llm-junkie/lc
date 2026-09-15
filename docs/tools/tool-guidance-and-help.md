# Tiered tool guidance and `lc_tool_help`

| Field | Value |
|---|---|
| Status | Active. Implemented through Phase 2. Phase 3 external evaluation remains open. |
| Maintained | 2026-08-31 |
| Scope | Architecture, contracts, rollout state, and evaluation gates |

LC uses tiered model guidance to reduce the fixed token cost of the system
prompt and tool definitions. The architecture preserves the guidance that
models need for correct and safe tool use.

The architecture includes a small, read-only `lc_tool_help` tool. This tool
returns bounded guidance for one exposed tool. LC also returns
condition-specific correction when an error or warning occurs.

This document is the maintained engineering contract for the feature. Its
bounds can change after evaluation without changing the architecture or API.

The implementation state on 2026-08-31 is:

- Phase 0, Phase 1, and Phase 2 are complete.
- Phase 3 has complete local contract, payload, limit, recovery, and STE fixtures.
- The required multi-model comparison has not run in this repository.
- Phase 4 and Phase 5 have not started.

The baseline fixed surface is 8,547 tokens. The pre-Whiteboard pilot fixture is
6,956 tokens. The current Whiteboard fixture is 7,499 tokens. Exact values live
in `tool-guidance-token.test.ts`. LC does not remove safety guidance to meet a
payload target.

---

## 1. Engineering context

Before tiering, the Windows reference fixture used 8,547 tokens. The
pre-Whiteboard pilot fixture used 6,956 tokens. The current Whiteboard fixture
uses 7,499 tokens. The reference fixture uses two workspace roots. Root count
changes the generated system prompt but does not change the tool payload.

Token counts are not additive. Token boundaries change when strings are joined
or removed. Therefore, a sum of per-tool counts does not predict the complete
payload count.

File I/O definitions were the largest cost center. The main contributors were
`lc_grep`, `lc_apply_patch`, `lc_read_file`, `lc_read_image`, `lc_glob_files`,
and `lc_read_pdf`. `lc_apply_patch` also repeated its complete syntax guidance
in the top-level description and the `patch` parameter description. The
implementation removed the second wire copy without removing information.

Large definitions have three costs:

- They consume context capacity on every request that exposes them.
- They can make important selection and safety rules harder to find.
- They make every uncached request prefix larger.

Provider prefix caching can reduce repeated prefix processing. It does not
restore context capacity. An on-demand help call instead adds a tool round and
suffix tokens. The evaluation must measure both costs.

The descriptions are comprehensive because the structural STE rewrite
preserved contract information. Tiering changes where that information lives.
It does not reverse the STE rewrite.

## 2. Design objectives

1. Reduce the fixed system and tool surface.
2. Keep ordinary tool calls self-sufficient, valid, and safe.
3. Preserve rare guidance in a source-owned and retrievable form.
4. Return an immediate correction when LC knows a safe correction.
5. Keep `lc:builtin:lc-tools` concise.
6. Keep help deterministic, bounded, local, and free of another model call.
7. Preserve strict operational schemas and authorization boundaries.
8. Measure selection, correction, and safety before the complete rollout.

## 3. Non-goals

- The architecture does not weaken validation, sandboxing, authorization, or
  destructive-operation protection.
- It does not execute an operational call under a corrected tool name.
- It does not replace the complete developer tool reference.
- It does not claim official ASD-STE100 vocabulary compliance.
- It does not add semantic search, embeddings, external search, or model-powered
  help retrieval.
- It does not put complete tool manuals into `lc:builtin:lc-tools`.
- It does not exempt help calls from existing batch or round limits.

## 4. Guidance tiers

LC uses three model-visible tiers. **Essential guidance** is always
visible. **Basic help** and **advanced help** are available on demand.

### 4.1 Essential guidance

Essential guidance belongs in the system prompt or structured tool definition.
The model must know this guidance before an ordinary call.

A statement is essential if its omission can cause one of these outcomes:

- The model selects the wrong tool.
- The model cannot construct a common valid call from the schema.
- The model can cause unenforced data loss or another unsafe effect.
- The model misreads ordinary success, partial success, or truncation.
- The model misses a prerequisite that LC cannot recover after the call.

Essential tool guidance normally includes:

- State the purpose in one sentence.
- Distinguish the tool from its closest sibling.
- Explain non-obvious required input structure.
- State destructive behavior and concurrency protection.
- State a hard limit that changes ordinary planning.
- State the primary partial-success or truncation signal.
- Give one minimal example when the input language is otherwise unclear.

Current safety examples include `expected_sha256`, no-clobber behavior for Add
and Move, and the exactly-once rule for `lc_edit_file.old_string`. Batch
preflight behavior remains essential when it changes how the model must divide
calls.

The schema and provider payload already carry canonical tool and parameter
names. A description must not retain extra prose only to repeat those names.

Frequency is not the deciding factor. A rare destructive condition can remain
essential. An enforced rejection can usually explain itself when it occurs.

A data-loss guard can move out of a definition only when both conditions hold:

1. A runtime signal reliably occurs with the risk.
2. The related result carries the guard automatically.

A safety guard must never become query-only guidance.

### 4.2 Basic help

`lc_tool_help({"tool":"lc_read_file"})` returns a compact practical guide.
Basic help can contain:

- It can contain common examples.
- It can explain useful defaults.
- It can explain normal result interpretation.
- It can give ordinary correction advice.
- It can list available advanced keywords.

Basic help does not repeat the complete schema or essential description. It
adds information that is useful sometimes but is not required before every
ordinary call.

### 4.3 Advanced help

`lc_tool_help({"tool":"lc_read_file","query":"encoding"})` searches
maintained help sections for one tool. Advanced help can contain:

- It can explain rare encoding behavior.
- It can explain unusual provider or platform limits.
- It can define diagnostic counters.
- It can explain budget and cancellation priority.
- It can explain uncommon patch matching behavior.
- It can distinguish detailed error conditions.
- It can give edge-case examples.
- It can give recovery detail beyond the immediate remedy.

Advanced guidance remains important. LC can provide it when a detected
condition or an explicit query makes it relevant.

## 5. Placement procedure

Classify each existing sentence in this order:

1. Keep information that selects the correct tool in the tool definition.
2. Keep information that constructs an ordinary call in the tool definition.
3. Keep an unenforced safety prerequisite in the tool definition.
4. Keep ordinary result interpretation in the tool definition.
5. Put a global rule for several tools in the system prompt.
6. Return condition-specific information with the related result.
7. Put unusual pre-call information in advanced help.
8. Put concise cross-tool strategy in `lc:builtin:lc-tools`.
9. Keep implementation detail only in engineering documentation.

Timing and recoverability determine placement. Frequency alone does not
determine placement.

No sentence is removed until the inventory records its new owner or deliberate
retirement.

## 6. System prompt and skill boundary

The system prompt owns global rules. These rules include exposure,
authorization, batching, paths, archived results, and help discovery.

The two retrieval surfaces have separate roles:

- `lc:builtin:lc-tools` owns cross-tool selection and workflows.
- `lc_tool_help` owns practical and advanced guidance for one tool.

The generated system prompt needs one combined retrieval rule:

> Use `lc_skill` with `lc:builtin:lc-tools` for cross-tool choices and
> workflows. Use `lc_tool_help` for detailed guidance about one tool.

The generated prompt must not name an unavailable tool or skill. LC exposes
`lc_tool_help` only when at least one operational tool category is exposed.
Foundation interactions such as `lc_ask_user` can have a canonical
non-operational name entry without a detailed help catalog. This does not make
them help-search targets or expose guidance for an unavailable tool.

The current two-root system prompt is 552 tokens. Its checked limit is 560
tokens. Most savings must come from tool definitions.

## 7. `lc_tool_help` contract

`lc_tool_help` is a read-only local tool. It performs no filesystem, shell,
network, or model operation. It requires no grant or permission prompt.

The tool has no list mode. The model already receives every exposed tool name
and description in the structured payload. The result has no revision field.
The catalog is compiled into the same application run as the tools.

### 7.1 Input

```ts
interface ToolHelpInput {
  tool: string;
  query?: string;
}
```

The input bounds are:

| Input | Bound |
|---|---:|
| `tool` | 1 to 80 characters |
| `query` | 1 to 160 trimmed characters |
| Distinct query terms | At most 8 |
| Unknown properties | Rejected |

An omitted query requests basic help. An empty or whitespace query is treated
as omitted. The query searches only the resolved tool.

`tool` remains a bounded string instead of a JSON Schema enum. A strict provider
can reject an unknown enum before LC can correct it.

### 7.2 Result envelope

The existing `ToolResultEnvelope` remains the only result envelope. The help
result uses `mode` inside `data`. It does not nest another `status` field.

```ts
type ToolHelpMode =
  | 'basic'
  | 'matched'
  | 'no_match'
  | 'ambiguous'
  | 'not_exposed'
  | 'already_returned'
  | 'limit_reached';

interface ToolHelpData {
  mode: ToolHelpMode;
  requested_tool: string;
  resolved_tool?: string;
  correction?: 'normalized' | 'alias' | 'unique_typo_match';
  guidance?: string;
  matches?: Array<{ section: string; guidance: string }>;
  available_keywords?: string[];
  suggestions?: Array<{ tool: string; purpose: string }>;
  message?: string;
}
```

Optional fields are omitted when they do not apply. LC does not serialize them
as `null`.

### 7.3 Basic result

An omitted query returns `mode: "basic"`.

```json
{
  "status": "ok",
  "data": {
    "mode": "basic",
    "requested_tool": "lc_read_file",
    "resolved_tool": "lc_read_file",
    "guidance": "...",
    "available_keywords": [
      "encoding",
      "line ranges",
      "size limits",
      "binary files"
    ]
  },
  "issues": [],
  "warnings": []
}
```

The keyword list contains at most 12 entries.

### 7.4 Query result

The query is forgiving search text. It is not an exact topic identifier. The
search normalizes case and whitespace. Curated aliases can normalize hyphens,
underscores, and established equivalent terms.

The search checks section titles and aliases before section content. It returns
at most three sections. It enforces the complete serialized output bound.

```json
{
  "status": "ok",
  "data": {
    "mode": "matched",
    "requested_tool": "lc_read_file",
    "resolved_tool": "lc_read_file",
    "matches": [
      {
        "section": "Encoding",
        "guidance": "..."
      }
    ]
  },
  "issues": [],
  "warnings": []
}
```

An unknown query is not an execution error. It returns `mode: "no_match"`, no
guidance, and bounded available keywords.

The search is deterministic. It does not use embeddings, external search, or
an LLM.

## 8. Tool-name correction

### 8.1 Help calls

`lc_tool_help` can correct a confident tool-name mistake because the tool is
read-only. The correction is always disclosed.

The resolution order is:

1. Match the exact canonical name.
2. Normalize case, spaces, hyphens, underscores, and a missing `lc_` prefix.
3. Match a curated alias.
4. Calculate Damerau-Levenshtein distance across exposed canonical names.
5. Accept a typographical correction only when one candidate is unique.

The typographical threshold is distance 2 or less. The runner-up must
be at least 2 edits farther away. Evaluation must test this rule against the
complete registry and future near-collisions.

A prefix that identifies several tools is ambiguous. LC returns at most three
purpose-labelled suggestions and no guidance.

A confident correction answers the help request in the same call. The result
uses the normal `basic`, `matched`, or `no_match` mode and includes
`correction`.

If an exact name identifies an unexposed tool, LC returns `not_exposed`. It does
not return detailed help or substitute another tool. Documentation must not
look like evidence that an unavailable tool can be called.

### 8.2 Operational calls

LC never executes an operational call under a corrected name. An unknown
operational name receives at most three ranked suggestions.

Runner validation and both orchestrator rejection paths must use one shared
resolver. They must not return the complete tool list. A unique suggestion can
save one discovery trip, but the model must submit a new operational call.

An ambiguous result returns several bounded suggestions. A mutating retry
remains a new model call. That call still uses validation, authorization,
contention checks, and current-state protection.

## 9. Help limits and duplicate suppression

The general tool-round limit defaults to 128. Help needs smaller turn limits
because a help call resets the reasoning-only loop guard like any other tool
call.

The turn limits are:

| Limit | Value |
|---|---:|
| Total help attempts per turn | 6 |
| Help results that return guidance | 3 |
| Help results that return no guidance after lookup | 2 |

LC checks the total limit first. Every recognized `lc_tool_help` call counts
toward the total. This rule includes duplicate, schema-invalid, no-match,
corrected, and batched calls.

A confidently corrected call that returns guidance counts against the guidance
limit. `no_match`, `ambiguous`, and `not_exposed` count against the lookup limit.
A duplicate counts only against the total limit.

After a limit is reached, the call returns `mode: "limit_reached"`. The result
contains no guidance and no complete tool list. A total-limit result performs
no lookup and contains no suggestions.

A lookup-limit result can retain suggestions that the current lookup already
calculated. The result contains at most three suggestions.

All counters saturate. Further calls return the same bounded terminal result.
All counters reset at the turn boundary. Help has no exemption from batch or
round limits.

### 9.1 Duplicate identity

LC suppresses a repeated help request before it returns the guidance body. The
repeat returns `mode: "already_returned"` and no guidance.

The duplicate key uses validated and normalized input. It contains the resolved
canonical name when resolution succeeds. Otherwise, it contains the normalized
requested name. The key also contains the normalized query.

The duplicate governor and help handler must use the same resolver.

LC decides duplicate admission in batch-index order before concurrent tool
execution. A completion-time ledger is not sufficient because completion order
is nondeterministic.

The implementation can use a handler hook or a help-call governor. The chosen
mechanism must provide both the duplicate key and the compact duplicate result.
A key alone is insufficient.

Operational tools keep their current annotate-only duplicate behavior. A
repeat can be intentional after state changes.

### 9.2 Tool History

Help results follow normal Tool History behavior. The active turn retains the
full result. A completed turn receives the existing generic stub.

The stub contains the archived result count, message identifier, and called
tool names. It does not retain help summaries or keywords. The model can use
`lc_tool_history` or make a new help call when it needs the full result.

## 10. Recovery contract

`lc_tool_help` supplements recovery. A common correction must not require a
help call when LC already knows the correction.

Each issue uses the shortest safe path:

1. Return `suggested_call` when LC knows exact corrected input.
2. Return bounded suggestions when several tool names are plausible.
3. Return `remedy` when one short action is sufficient.
4. Return `help` when more explanation can improve the corrected call.
5. Name a user or external action when LC has no executable correction.

### 10.1 Existing envelope

LC extends `ToolResultIssue`. It does not create a parallel error envelope.

```ts
interface ToolHelpArguments {
  tool: string;
  query: string;
}

interface ToolNameSuggestion {
  tool: string;
  purpose: string;
}

interface ToolResultIssue {
  // Existing fields remain unchanged.
  code: string;
  message: string;
  retryable?: boolean;
  suggested_call?: Record<string, unknown>;

  // New optional fields.
  remedy?: string;
  help?: ToolHelpArguments;
  suggestions?: ToolNameSuggestion[];
}
```

`help` contains exact arguments for `lc_tool_help`. Its `tool` value is the
target operational tool. It is not the name `lc_tool_help`.

`suggestions` is only for bounded tool-name correction. These optional fields
do not create another result shape. Complete failures and partial batch
failures continue to use `ToolResultEnvelope`.

For a partial batch result, each issue owns its path, remedy, suggested call,
help arguments, and suggestions. LC must not attach one failed entry's recovery
to another entry.

### 10.2 Exact correction

This example uses the existing `invalid_arguments` code. It does not invent a
new code for a schema maximum.

```json
{
  "status": "error",
  "issues": [
    {
      "code": "invalid_arguments",
      "message": "max_results must be at most 50.",
      "retryable": false,
      "remedy": "Set max_results to 50 or less.",
      "suggested_call": {
        "max_results": 50
      }
    }
  ],
  "warnings": []
}
```

The corrected input must be complete enough for a new validated call. LC never
executes `suggested_call` implicitly.

### 10.3 Help escalation

Use `help` only when more explanation can improve the corrected call.

```json
{
  "status": "error",
  "issues": [
    {
      "code": "invalid_arguments",
      "message": "The patch text does not contain a valid patch section.",
      "retryable": false,
      "remedy": "Correct the patch syntax and submit a new call.",
      "help": {
        "tool": "lc_apply_patch",
        "query": "syntax"
      }
    }
  ],
  "warnings": []
}
```

The catalog supplies each help query. The model does not have to guess a
maintained keyword.

### 10.4 Terminal recovery

`retryable` has one narrow meaning. It is true only when the same arguments can
succeed later without correction. A corrected call uses `suggested_call`,
`remedy`, or `help` even when `retryable` is false.

All `invalid_arguments` paths must use `retryable: false`. Repeating malformed
input without correction cannot succeed.

A terminal outcome needs no new field. It has all these properties:

- `retryable` is false.
- `suggested_call` is absent.
- `help` is absent.
- `remedy` names a user or external action.

`encoding_not_utf8` is one terminal example. LC returns no content and has no
conversion tool.

```json
{
  "status": "error",
  "issues": [
    {
      "code": "encoding_not_utf8",
      "message": "The content is not valid UTF-8. LC returns no content for this file.",
      "path": "D:\\work\\legacy.txt",
      "retryable": false,
      "remedy": "LC has no conversion tool. Ask the user to convert the file to UTF-8."
    }
  ],
  "warnings": []
}
```

Triggered guidance can say that `lc_grep` still searches mostly valid UTF-8
with isolated invalid bytes. A returned U+FFFD character must trigger the
write-back warning automatically. That warning must not require a help query.

LC must not recommend `iconv` as an LC action. The executable is not an exposed
LC capability and might not exist on the current platform.

### 10.5 Stable error ownership

Recovery uses stable error codes. LC must not parse human-readable messages to
select a remedy or help query.

Shared runner, policy, and native-normalization codes need shared declarations.
Each catalogued tool composes those declarations with its tool-specific codes.
The catalog recovery map can reference only declared codes.

This declaration is a contract. It does not prove that every runtime path emits
the declared code. Tests must exercise representative emitted codes and compare
them with the catalog mappings.

During the pilot, only catalogued tools receive mapped recovery. Other tools
keep current behavior. After the complete rollout, every exposed operational
tool must have a catalog.

## 11. Scope of `lc:builtin:lc-tools`

The LC Tool Cheat Sheet owns cross-tool decisions and workflows. Examples
include:

- It distinguishes `lc_read_file` from `lc_grep`, `lc_glob_files`,
  `lc_list_dir`, and `lc_stat`.
- It distinguishes `lc_edit_file` from `lc_write_file` and `lc_apply_patch`.
- It distinguishes `lc_web_search` from `lc_web_fetch` and `lc_web_research`.
- It explains safe multi-tool workflows.
- It tells the model to inspect a repeated-call result before another retry.
- It explains when detailed single-tool help is useful.

The cheat sheet does not repeat schemas, full limits, error catalogs, advanced
help, or complete per-tool descriptions.

The materialized guide stays concise and normally uses hundreds rather than
thousands of tokens. Its expected range is about 600 to 900 tokens, subject to
workflow-quality tests. Exact fixture values live in tests.

The cheat sheet is retrieved content. It is not part of the fixed request until
the model calls `lc_skill`. Its result still consumes suffix context and must
remain bounded.

## 12. Ownership model

Typed TypeScript catalogs are the authoritative source for model-facing tool
guidance and recovery metadata. A catalog lives with its tool module or in one
colocated help module.

A catalog contains:

- It contains the canonical tool name.
- It contains one-line purpose text.
- It contains the essential model description.
- It contains compact basic guidance.
- It contains bounded advanced sections.
- It contains section titles and curated query aliases.
- It contains bounded keywords.
- It contains declared error codes.
- It contains error-code-to-remedy and help-query mappings.

`lc_tool_help` reads the catalog at call time and filters it through the current
exposure snapshot. Runtime recovery reads the same error mapping.

The registry validates canonical names, aliases, bounds, and recovery-map keys.
Tests verify catalog coverage and emitted error codes. A missing catalog is
allowed only during the pilot and staged rollout.

Long developer documentation remains prose. The catalog can carry a stable
developer-reference anchor, but runtime code does not parse Markdown. Build
checks validate shared facts and anchors.

The cheat sheet has a separate cross-tool owner. It must not be generated by
concatenating every tool's basic help.

Descriptions, help results, remedies, the cheat sheet, and developer references
must not become independent copies of the same model-facing text.

## 13. Bounds and token budgets

These values are operational bounds and evaluation targets:

| Surface | Target |
|---|---:|
| Generated system prompt | At most 560 tokens |
| Ordinary tool description | Prefer at most 120 tokens |
| Exceptional tool description | At most 250 tokens with justification |
| Complete `lc_tool_help` definition | At most 220 tokens |
| Complete system and tool payload | 7,499 tokens for the current Whiteboard fixture |
| Basic help result | At most 400 tokens |
| One advanced help section | At most 300 tokens |
| Complete serialized help result | At most 16 KiB and preferably 1,000 tokens |
| Sections per query | At most 3 |
| Keywords per tool | At most 12 |
| Name suggestions | At most 3 |

The pilot reduced the fixed surface from 8,547 tokens to 6,956 tokens. The
current Whiteboard fixture is 7,499 tokens. The glob traversal-error guidance
adds 28 tokens to the earlier 7,471-token fixture. This correction does not
expand the pilot's guidance tier rollout.

The complete payload assertion is authoritative. Per-tool ceilings are separate
assertions. The two measurements cannot be reconciled arithmetically.

CI must measure the exact materialized payload for fixed fixtures. The
measurement covers these items:

- It includes every top-level description.
- It includes every schema description.
- It includes every schema key and structural token.
- It includes the complete `lc_tool_help` definition.
- It includes the generated system prompt.

Fixed fixtures use the direct `o200k_base` encoder from `gpt-tokenizer`.
They do not use the runtime estimator, which samples long whitespace-free runs.
The current schema array is 2,660 tokens, or 2,220 after description removal.
Historical measurements remain recorded values and are not remeasured by current fixtures.

CI also records the schema-only payload before and after description removal.
The stripped value is a diagnostic baseline, not a permanent structural floor.
Schemas and token boundaries can change.

Token reduction is not a pass when selection, correction, interpretation, or
safety regresses.

## 14. Pilot content classification

### 14.1 `lc_apply_patch` no-loss reduction

The implementation removes the second complete syntax block from the `patch`
parameter description. It keeps one short parameter sentence and retains the
minimal syntax plus one short example in the top-level essential description.

The schema does not carry a shadowed Zod description that can restore the
duplicate. This change preserves the guidance while reducing the fixed payload.

### 14.2 `lc_grep`

The essential description owns these facts:

- The tool searches file contents with regular expressions.
- Path-pattern entries search directories recursively.
- One unresolved path rejects the batch.
- `truncated=true` proves that the result is incomplete.
- `truncated=null` means that completeness was not determined.
- `lc_glob_files` searches names.
- The common include and exclude rule changes ordinary searches.

Advanced help or triggered recovery owns these facts:

- Diagnostic-counter definitions.
- Truncation-reason priority.
- Detailed UTF-16 and isolated invalid UTF-8 behavior.
- Uncommon output modes.
- Cancellation priority.
- Full hidden-file and excluded-file analysis.

When grep returns replacement characters or a truncation reason, the result
must carry the related warning and remedy automatically.

### 14.3 `lc_read_file`

The essential description owns these facts:

- The tool reads text files and focused line ranges.
- Ordinary path-count and size limits affect call planning.
- Successful results provide fields needed for later safe writes.
- An oversized read fails instead of returning a partial body.
- Images and PDFs require their dedicated readers.
- A detected encoding risk returns a direct diagnostic pointer.

Detailed encoding distinctions live in help or triggered recovery. The U+FFFD
write-back guard remains on every result that can carry replacement characters.

### 14.4 Pilot readers

`lc_read_pdf` is the third help-architecture pilot. It tests summary
provenance, exact-text recovery, vision requirements, and model-dependent
behavior.

`lc_apply_patch` received its no-loss duplicate reduction before the pilot. Its
remaining advanced migration follows the same evaluation gates.

## 15. Rollout

### Phase 0 — baseline and no-loss reductions: complete

1. Full-payload and schema-description token fixtures measure the complete wire
   surface.
2. Dynamic system-prompt fixtures cover the supported workspace variants.
3. The duplicated `lc_apply_patch` parameter guidance is removed.
4. Each model-visible sentence has a declared owner.

### Phase 1 — help catalog and tool: complete

1. Typed catalogs define the guidance contract.
2. `lc_grep`, `lc_read_file`, `lc_read_pdf`, and `lc_whiteboard` have catalogs.
3. `lc_tool_help` implements the documented input and output contract.
4. Name correction and query lookup are deterministic and bounded.
5. Help-call limits and duplicate suppression use batch-index order.
6. Tool History keeps its normal stubbing behavior and tests.

### Phase 2 — recovery integration: complete

1. `ToolResultIssue` carries `remedy`, `help`, and bounded name suggestions.
2. `suggested_call` carries exact corrected input.
3. Every `invalid_arguments` result is `retryable: false`.
4. Runner and orchestrator paths share unknown-tool handling.
5. Bounded ranked suggestions replace complete tool lists.
6. Pilot tools use stable error mappings.
7. Tests verify that every emitted help query returns a catalog match.

### Phase 3 — pilot evaluation: external matrix open

Local automated contract, payload, limit, recovery, and writing fixtures are
complete. The external matrix must compare the untiered and tiered surfaces for
`lc_grep`, `lc_read_file`, and `lc_read_pdf`. It uses the same tasks and provider
adapters for both variants.

Measure:

- Measure correct tool selection.
- Measure valid first-call construction.
- Measure unsafe or destructive-call prevention.
- Measure ordinary partial and truncated result interpretation.
- Measure successful correction after validation and runtime errors.
- Measure cases where the model needs guidance but does not call help.
- Measure unnecessary help calls.
- Measure help loops and limit behavior.
- Measure tool rounds that recovery uses.
- Measure complete fixed request tokens.
- Measure triggered help-result tokens.
- Measure provider cache observations when they are available.

The matrix must include:

- Include one current frontier model.
- Include one smaller hosted model.
- Include one local model with a constrained context.
- Include strict structured-tool validation.
- Include an OpenAI-compatible local adapter.
- Test with Tool History enabled and disabled.

The pilot does not pass only because token count decreases.

### Phase 4 — complete rollout: not started

Apply the reviewed classification to the remaining operational tools. Add a
catalog for each tool before moving its advanced guidance.

Update the generated cheat sheet, developer references, STE tests, and token
fixtures in the same change.

### Phase 5 — final budgets: not started

Set final budgets from measured quality and cost. Record justified exceptions
for complex descriptions. Do not weaken a safety rule to satisfy a token target.

## 16. Evaluation gates

The rollout passes only when all applicable gates pass.

### 16.1 Contract gates

- Every result uses the existing envelope.
- Help results use `mode`, not an inner `status`.
- Optional fields are omitted when absent.
- Search stays inside one resolved tool.
- No list mode or revision field exists.
- Unknown operational names are never executed automatically.
- Unexposed tools return no detailed help.

### 16.2 Bound gates

- Every input, list, catalog section, result, and counter has an explicit bound.
- Batch-index order determines duplicate admission.
- Duplicate help returns no repeated guidance body.
- Total, guidance, and lookup counters saturate.
- The complete serialized payload passes its fixture budget.

### 16.3 Safety gates

- Essential safety guidance remains visible before an unenforced risk.
- A triggered safety guard appears whenever its runtime signal occurs.
- The U+FFFD write-back guard never becomes query-only.
- Recovery never executes a suggested operational call.
- A terminal recovery message does not claim that LC can perform an unavailable
  action.

### 16.4 Writing gates

Every LC-authored model-visible string follows the repository's structural STE
rules. This scope includes:

- It includes system-prompt text.
- It includes tool and parameter descriptions.
- It includes catalog guidance.
- It includes recovery messages and remedies.
- It includes warnings.
- It includes name suggestions.
- It includes limit and duplicate results.
- It includes LC-authored schema validation messages.
- It includes image, PDF, and research sub-agent instructions.
- It includes the Windows built-in error remap and interrupted-call notices.

`model-visible-ste.test.ts` covers the TypeScript-owned surfaces. Boundary
probes exercise each custom schema message. Direct fixtures cover each tool
sub-agent prompt, batch limit, patch preflight notice, Windows built-in error
remap, and interrupted-call notice. Repository audits apply the same rules to
LC-authored Rust warnings and errors. The fixtures protect technical literals
and stable error codes from prose rewriting.

### 16.5 Ownership gates

- Each advanced statement has one authoritative catalog entry.
- Shared error codes have shared declarations.
- Catalog recovery keys reference declared codes.
- Tests compare representative emitted codes with catalog mappings.
- The cheat sheet does not concatenate per-tool manuals.
- Developer documents are generated or checked from the owning facts.

## 17. Architecture decisions

- The system exposes one dedicated `lc_tool_help` tool.
- Operational schemas stay strict.
- `tool` is required and `query` is optional.
- Queries use bounded search text instead of an exact topic enum.
- A query searches only one resolved tool.
- Help has no list mode.
- Catalogs have no model-visible revision field.
- An omitted query returns basic help.
- An unknown query returns `no_match`, not an execution error.
- Only the read-only help tool corrects confident names in the same call.
- Operational name correction suggests a retry but never executes it.
- `lc:builtin:lc-tools` stays focused on cross-tool workflows.
- Recovery extends the existing issue envelope instead of adding an envelope.
- Exact corrected input uses `suggested_call`.
- Typed TypeScript catalogs are the model-facing source of truth.
- Tool History keeps normal stubbing.
- Turn limits and duplicate suppression are deterministic.
- Structural STE rules apply to all LC-authored model-visible text.
- Payload measurement uses the complete serialization, not additive estimates.

## 18. Implementation choices that remain bounded

The architecture deliberately leaves two internal choices to implementation:

1. The ordered help governor can use a handler hook or a dedicated governor
   module. It must satisfy the duplicate and limit gates.
2. Developer references can be generated from catalog facts or checked against
   them. Runtime code must not parse long Markdown documents.

These choices do not reopen the tool contract, recovery envelope, guidance
tiers, ownership direction, or evaluation gates.
