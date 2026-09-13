# Google Gemini native REST

**Implementation:** 2026-09-04. **Evidence:** documentation projections and
automated local tests, plus user-supplied archives of a failed request and a
successful Gemini 3.7 tool session. No sanitized raw SSE capture or successful
3.8/2.5 session has been verified. The embedded
`google.gemini-interactions` contract remains partially verified.
This is the maintained implementation and acceptance record. Configuration,
design decisions, and verification results below stand independently of the
temporary proposal, review, and command logs.

## Configuration

Select **Gemini REST** in the server add/edit panel, between
**Anthropic** and **LM Studio REST**. The four chips share one centered row:
**OpenAI**, **Anthropic**, **Gemini REST**, and **LM Studio REST**. Enter
`https://generativelanguage.googleapis.com/v1beta` in Base URL and use the API-key
field. Selecting an API chip changes only the variant; it never fills or
replaces the URL, including in a new or empty Gemini draft. Every variant keeps
the generic Base URL placeholder `http://127.0.0.1:1234/v1`. This placeholder is
a hint, not the Google API root.

LC appends `/interactions`; streaming adds a request-only `?alt=sse`. The
versioned root is retained separately from the reply endpoint. Native requests
and model discovery share `x-goog-api-key` authentication and LC's existing
profile-header, credential, and transport policy.

The API and protocol chips occupy their own bordered block between the
activation block and the server fields. A centered protocol row appears beneath
every API variant. OpenAI offers
**Responses · R** and **Chat Completions · CC**; Anthropic shows selected
**Messages · M**, Gemini REST shows selected **Interactions · I**, and
LM Studio REST shows selected **Chat · C**.
These protocol-chip letters use the endpoint colors: blue for R/CC, amber for M,
green for I, and purple for C.

Only OpenAI's two protocol chips change `apiStyle`; the other variants show
their one protocol as selected. A saved OpenAI style does not change a native
route. The LM Studio tools warning remains inside this block.

Both rows use an 8px chip gap. The primary row does not wrap. A horizontal
separator spans the block between rows, with a 1px `var(--border)` rule and
4px top and bottom margins. The second row has an additional 4px bottom margin.

Endpoint badges are selected from the configured route, and historical reply
badges use the saved endpoint:

| Endpoint | Badge |
|---|---|
| `/responses` | Blue `R` |
| `/chat/completions` | Blue `CC` |
| `/messages` | Amber `M` |
| `/interactions` | Green `I` |
| `/chat` | Purple `C` |
| Unknown or absent | `O` |

Gemini hover titles and the bubble's model-details popover include the literal
`/interactions`. The compact bubble footer shows only the model and its endpoint
badge, with retained spacing around the center dot. Footer badges share the picker
colors: blue `R`/`CC`, amber `M`, green `I`, purple `C`, and gray `O` when an old
reply did not persist its endpoint. All protocol abbreviations use uppercase in
settings, model pickers, and reply footers, including main, compact, and helper
model pickers. Labels and letters in the protocol chips use a center dot (`·`),
not parentheses. LM Studio native
replies with `/chat` acquire the purple `C` through rendering, without rewriting
stored history. Compatible routes retain their own badges. Changing a profile
updates its picker badge but does not rewrite the endpoint saved on a reply.

## Request and response ownership

The [adapter](../src/modules/llm-client/adapters/gemini-rest.ts) uses the
Interactions API, with `store: false` and complete local history. It does not
use a remote interaction chain. The embedded registry matches the exact Google
origin, exact `/v1beta` root, and `gemini-interactions` protocol. The adjacent
OpenAI compatibility path does not match.

The internal names have distinct owners: the profile saves
`apiVariant: 'gemini'`, the adapter exposes `protocol: 'gemini-rest'`, and provider contracts
and history projection use `gemini-interactions`. Contract matching supports
`match.path_match: 'exact' | 'prefix'`; omission retains prefix matching for
existing records. The Google native entry selects `exact`, so `/v1beta/openai`
cannot inherit it. Exact model records supplement surface facts; model-name
similarity never selects a provider or request dialect.

The contract sends a selected effort unchanged as
`generation_config.thinking_level`, and requests display summaries with
`thinking_summaries: auto`. Disabling LC's effort override leaves that field
unset; it does not disable the model's own thinking default. Sampling fields
absent from the native schema are omitted and their controls are inactive.
Explicit maximum-output and stop-sequence overrides retain their native shape.
`AdapterRequestParams.responseFormat` supplies native structured JSON output;
there is no schema editor in this change. Its native shape is
`{ type: 'text', mime_type: 'application/json', schema: ... }`.
System/developer messages become `system_instruction`; text and image inputs
use native content. LC does not inject a blanket `Api-Revision` header or retry
a rejected effort with a different value.

The SSE parser handles indexed step starts, typed deltas, step stops, and
interaction completion. Text and thought summaries have separate callbacks;
`arguments_delta` fragments form function arguments only when the step closes.
Terminal steps, when present, supply the authoritative replay representation.
An incomplete stream retains partial state and does not authorize tool execution
or automatic replay. Unknown step members survive; unsupported delta forms stop
continuation explicitly. Non-streaming helpers accept JSON or SSE without
repeating a generation request.

Provider facts: [REST schema](https://ai.google.dev/api/interactions-api),
[streaming](https://ai.google.dev/gemini-api/docs/streaming),
[thinking](https://ai.google.dev/gemini-api/docs/thinking),
[function calling](https://ai.google.dev/api/interactions-api#CreateInteraction-function_calling), and
[structured output](https://ai.google.dev/gemini-api/docs/structured-output).

## Replay and persistence

`Message.gemini_interactions` retains one group per response: schema version,
response identity, exact source Base URL/model, complete ordered steps,
completion state, raw response-local usage, thought-step index locator, and
unresolved fragments when interrupted. Storage compresses it into
`MessageRow.geminiInteractionsJson`.
The existing storage projection also owns checkpoints, clone, archive export,
and import. Archive import validates native groups before restoring any
attachments or rows. Invalid or excessive native state is rejected explicitly.
The optional, unindexed column needs no Dexie schema-version migration; older
messages without native state remain valid.

The group's `responseId` is an LC accounting/replay identity, not a remote
continuation handle. A nonempty provider ID is retained as opaque metadata.
When Google omits it or returns the schema's empty default, the parser retains
its per-response `local-<UUID>` key; empty later metadata cannot erase a known
ID. This keeps stateless tool rounds distinct without enabling remote storage.

The bounds are 256 groups per assistant message, 2,048 steps per response, and
`16 * 1024 * 1024` serialized characters across a message's native groups.
The decoded stream budget uses the same character count minus 8,192 reserved
for LC's group envelope. The shared SSE decoder additionally bounds each event
at `4 * 1024 * 1024` decoded characters. These character limits are not UTF-8
byte limits. Base URLs are bounded at 4,096 characters and model IDs at 1,024.
Opaque response IDs share the stream and whole-group budgets; they have no
separate 1,024-character cap and are never truncated.
These are integrity limits, not truncation or history-compaction policies.

The [native history builder](../src/modules/llm-client/gemini-state.ts) expands
a merged assistant bubble into each whole returned response followed by its
matching client results. It preserves text around parallel function calls and
places transient tool-image inputs after the associated result batch. Calls use
`id`; results use `call_id`. Missing or duplicate pairings stop continuation.
Tool History leaves native Gemini exchanges complete. A source/target mismatch
withholds native state only from the outbound projection; the archive survives.
Same-surface model changes use Google's filtering contract. An unregistered
relay requires the exact source Base URL and model.
After a model change, the retained steps still replay but their effective
thought occupancy is unknown because Google may filter them.

## Accounting and discovery

Native output and thought counters are separate: normalized completion is their
sum. A reported total remains authoritative, cached input is a subset, and the
tool-use counter is retained without assuming it is additive. Usage snapshots
reconcile inside one response before the turn accumulator adds it once.
`tokenCoverage` distinguishes reported, partial, and unreported numeric fields;
the UI shows a lower bound or an unreported label instead of invented zeroes.

Gemini accounting is colocated with its complete response group rather than
duplicated into the Responses/Messages locator sidecar. The shared history
projection uses that same group and its thought-step index locator for replay
and TokenMeter: a complete signed group with matching indexes is counted once
from its reported thought usage; its visible summary is
display-only. Missing accounting or unresolved native reasoning remains unknown.
No Interactions server preflight count has been enabled.

Native model discovery calls the versioned root's `/models` without probing LM
Studio. A configured Model fetching URL replaces that initial URL; pagination
still follows `nextPageToken` by adding `pageToken` to the configured URL.
Discovery strips only the initial `models/` resource prefix, preserving exact
model IDs, display names, and input/output limits. Pagination is limited to
128 pages and 16,384 distinct entries; repeated tokens fail explicitly. Exact
registered capabilities supplement discovery;
generic enrichment is not authority for wire behavior. `gemini-3.8-flash` is the
primary target. The embedded record marks it as always thinking, records
`low`, `medium`, and `high` as documented effort values, and enables vision and
tools. Those values are evidence, not a client-side effort allowlist. The same
adapter targets the documented 2.5 surface without translating effort labels to
legacy thinking budgets. Exact 2.5 records distinguish always-thinking Pro from
optional-thinking Flash and Flash-Lite; live acceptance remains unverified.

## Implementation owners

| Concern | Maintained source |
|---|---|
| Native request, SSE assembly, and response settlement | [gemini-rest.ts](../src/modules/llm-client/adapters/gemini-rest.ts) and [client.ts](../src/modules/llm-client/client.ts) |
| Group validation, ordered replay, provenance, and usage normalization | [gemini-state.ts](../src/modules/llm-client/gemini-state.ts) |
| Request/meter projection and once-per-response usage | [provider-history-projection.ts](../src/modules/chat-pipeline/provider-history-projection.ts), [orchestrator.ts](../src/modules/chat-pipeline/orchestrator.ts), and [turn-usage-accumulator.ts](../src/modules/chat-pipeline/turn-usage-accumulator.ts) |
| Exact contracts and native model discovery | [provider-contracts.ts](../src/modules/llm-client/provider-contracts.ts), [provider-contracts.v1.json](../src/modules/llm-client/provider-contracts.v1.json), and [models/gemini.ts](../src/modules/llm-client/models/gemini.ts) |
| Persistence and archive validation | [db.ts](../src/store/db.ts) and [exportArchive.ts](../src/utils/exportArchive.ts) |
| Profile chips, shared badge mapping, and spacing | [SettingsPage.tsx](../src/ui/settings/SettingsPage.tsx), [reply-meta.ts](../src/utils/reply-meta.ts), and [index.css](../src/index.css) |
| Context occupancy and partial usage presentation | [TokenMeter.tsx](../src/ui/chat/TokenMeter.tsx) and [usage-detail.ts](../src/ui/chat/usage-detail.ts) |

## Verification boundary

The [adapter tests](../src/modules/llm-client/adapters/gemini-rest.test.ts) use
synthetic IDs, signatures, and counters. They cover native controls, SSE
fragments, complete and interrupted replay, usage, discovery, JSON/SSE helpers,
and real IndexedDB/archive round trips. The tool-loop test in
[orchestrator-closure.test.ts](../src/modules/chat-pipeline/orchestrator-closure.test.ts)
exercises the real adapter and orchestrator with parallel results and a second
tool round. These tests verify LC behavior, not Google's acceptance of a
synthetic signature.

### Recorded local validation — 2026-09-04

| Check | Result and scope |
|---|---|
| Full `npm test` | 2,426 passed: 589 Node and 1,837 tsx tests, with no failures or skips, at the native integration checkpoint |
| Native adapter scenarios | 12 tests plus the orchestrator's parallel/two-round scenario; the 12 adapter tests also passed after the uppercase badge change |
| Production and test TypeScript | `tsc -b` and `npm run typecheck:tests` passed |
| Static checks | Full ESLint, import registry (431 files), test registry (140 files: 30 Node, 110 tsx), and docs sync passed at the integration checkpoint |
| Production frontend build | Passed embedded-contract, CSS/configuration, font, resource, and frontend-license checks; existing chunk-size/dynamic-import warnings remained |
| Production artifact inspection | Native contract compiled into application JavaScript; no standalone provider-contract JSON emitted |
| Browser UI | Chip ordering, per-variant protocol rows, endpoint hints, native route selection, colors, and separate API block checked in local browser previews |
| Subsequent UI refinements | Uppercase badges and JSX layout changes received focused lint checks. Final separator/4px margins and the generic URL hint were checked against source/diffs; packaged rendering was not tested |

The full-suite/build results precede the final cosmetic refinements. They are a
dated implementation record, not live-provider or packaged-runtime evidence.
No live Google generation requests or real Google API credentials were used for
these checks. The final documentation consolidation passed
`npm run check:docs-sync` and `git diff --check -- docs`.

### Interaction ID regression — 2026-09-04

A user-supplied conversation archive recorded an empty assistant response,
no native steps, and LC's `Invalid Gemini response ID.` error. The old parser
raised that error for either an empty ID or one longer than 1,024 characters.
The archive did not retain the rejected ID, so it cannot distinguish those
branches or serve as a raw SSE fixture.

The [Interaction schema](https://ai.google.dev/api/interactions-api) exposes
the ID as an optional string with an empty default and declares no such length
limit. LC now accepts empty/omitted metadata using its local group key and
retains longer nonempty IDs under the existing size budgets. Regression
fixtures cover empty/omitted/null IDs, metadata restatements, long IDs,
persistence, and rejection above the whole-state budget. The real orchestrator
fixture covers three responses with blank IDs across two tool rounds, preserving
all three groups and their usage. These are synthetic reproductions of the
failure paths.

### Successful Gemini 3.7 archive — 2026-09-04

A later user-supplied archive records a successful native
`gemini-3.7-flash` session after the ID correction. It contains 21 messages,
seven assistant tool turns, and 14 native response groups. Each turn has one
complete signed thought/function-call response, its exactly matched client
result, and one complete signed thought/model-output response. The groups retain
14 distinct local IDs and 14 provider usage reports. Every assistant aggregate
equals the sum of its two provider totals, including output plus thought tokens.

The seven live calls cover directory listing, text files, images, a PDF, two
built-in skills, and Whiteboard mutation. All calls have one result with the
same `call_id`; the final outputs show that Google accepted each locally replayed
native response and result. Some thought responses include a display summary and
others carry only a signature, and both forms remain complete.

This archive is normalized LC conversation state. It does not retain the raw
request body, SSE frames, or the provider's empty-versus-omitted interaction-ID
metadata. It therefore confirms the live tool-loop outcome and durable
invariants, but does not replace sanitized raw-wire fixtures or close 3.8/2.5
acceptance.

### Remaining acceptance work

Keep the contract **partially verified** until the relevant evidence gaps close.
The local tests above cover portions of this matrix; they do not close the live
or packaged cells. Capture sanitized evidence with date, exact endpoint/model,
and a label distinguishing literal wire capture, normalized archive, and
synthetic projection.

| Area | Evidence still required before claiming full acceptance |
|---|---|
| Model matrix | Direct `gemini-3.8-flash` chat/thinking/tools and available 2.5 models; a normalized 3.7 tool session is recorded, but unavailable models and uncaptured raw wire behavior remain explicitly unverified |
| Controls and errors | Override off, unchanged supported and unsupported efforts, single-attempt rejection, output/stop limits, and model-specific defaults; verify omitted sampling fields on actual requests |
| Native streaming | Raw SSE framing, initial content, delayed or signature-only thoughts, absent/empty summaries, terminal usage/steps, HTTP/SSE failure, EOF, cancellation, and deadlines |
| Tools and replay | Provider-accepted signatures through parallel and multiple tool rounds, text around calls, error/denied tools, result pairing, tool images exactly once, and reload then continuation; missing or incomplete state must stop continuation |
| Usage and meter | Real output/thought totals, missing versus zero counters, nonzero tool-use counters, cached subsets, interim/terminal restatements, and exactly one accumulator addition per response; never infer hidden reasoning from a summary or bubble aggregate |
| History and route changes | Tool History on/off preserves the same native exchange; request and meter project the same groups; provider/model switches preserve archived state while withholding foreign state or marking filtered thought occupancy unknown |
| Structured output and images | Object/array/nullable schemas, invalid schemas, streamed partial JSON, cutoff/refusal, image input, and function-calling combinations; do not assume 2.5 supports every combination |
| Durability and discovery | Packaged reload, clone, edit/retry, interruption checkpoints, old rows, bounds failures, malformed import before writes, discovery cancellation, explicit URL pagination, and failed-refresh ownership |
| Profile and badges | Save/reopen, unchanged URL/key on chip selection, generic placeholder, all picker/footnote variants, historical endpoint stability, and readable light/dark/custom-theme colors with the final two-row layout |
| Boundary and compatibility | Exact origin/version/path/protocol/model matching, trailing slash, adjacent `/openai`, terminal operation, wrong version, lookalike host, unknown model, and unregistered relay; existing adapters must not acquire Google headers, state, or controls |
| Packaged runtime | Repository release gates, Rust tests, Tauri credential handling, native relay cancellation, concurrent streams, and conversation reload; a frontend build does not establish desktop parity |

Use the protocol audit [A03](./audits/templates/a03-protocol-adapters.md) and
build/runtime audit [A08](./audits/templates/a08-build-and-runtime-parity.md)
for the cross-provider and release gates. Preserve accepted sanitized fixtures
in the test sources before discarding temporary captures.

## Deferred scope

This integration does not add a `generateContent` adapter, Vertex AI, hosted
tools/agents, Live API, background jobs, remote interaction chains, explicit
cache management, audio/video/image generation, Files API uploads, or a schema
editor. Interactions server preflight counting remains deferred until a counter
is evidenced to cover the complete outgoing projection, including retained
thoughts and tools. A documented lossless equivalent could qualify; an unrelated
`countTokens` request shape alone does not establish that equivalence.
