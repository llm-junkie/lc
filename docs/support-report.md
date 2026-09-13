# Support reports

LC can create a local, redacted JSON report for troubleshooting. Open
**Settings → Support → Create support report**. Review the preview, then
use **Copy** or **Save** to attach the report to a GitHub issue. LC does not
upload the report, send telemetry, or make a network request while creating it.

The saved filename is `lc-support-v1-YYYY-MM-DD-HHmm.json`, using the local
24-hour time. The preview is the final
serialized JSON, including its trailing newline. Copy and Save receive that
same immutable string. LC does not rebuild or serialize the report again after
the preview appears.

## Format

The current schema is identified by:

```json
{
  "format": "llm-client:support-report",
  "version": 1
}
```

The report is an independent support format, not a settings export or
conversation archive. New fields require a deliberate schema change. Unknown
application-state keys are not copied into the report.

The repository contains a 7-Zip recompression of two real version-1 reports in
`scripts/fixtures/lc-support-v1-2026-08-09.7z`. One report has both optional
privacy checkboxes off. The other report has both checkboxes on. Fixture tests
verify that saved production reports remain valid and within documented
bounds. The tests also verify that reports do not contain private-content
shapes.

They assert stable invariants instead of timestamps or diagnostic-ring
contents. Those values naturally differ between captures.

**Version 1 is the complete pre-release schema.** LC has not shipped an older
support-report contract, so the current allowlisted sections and diagnostic
vocabulary define the initial format. A later incompatible format must use a
new version and must not silently validate as version 1.

## Included by default

- LC version and development/release channel
- runtime kind, OS family/version when parseable, architecture, Tauri/WebView
  versions, locale, time-zone name, and secure-context state
- coarse startup phase, consecutive incomplete-start count, Safe Start state,
  and a bounded structured startup failure code when available
- IndexedDB/settings/profile schema versions, index-based conversation/message
  counts, a rounded browser-storage estimate, and read-integrity flags
- provider protocol/style/routing/active state and endpoint classes only:
  `loopback`, `private-network`, `public-https`, `public-http`, or `invalid`
- model counts and supported/unsupported/unknown capability counts
- active tool-policy mode, category flags, grant counts, limits, and global
  default counts
  (`foundation` means that Workspace is on without an active prompting category)
- enabled/selected/custom skill counts, without skill identity or content
- active-generation count, bounded phase counts, a maximum 12-entry
  identity-free recent-request projection, aggregate image-cache
  batches/bytes/generation count, backward-compatible active state, plus
  structured outcome and usage counters
- theme mode, zoom bucket, feature switches, custom-theme counts, and the
  runtime material resolution (requested `materialMode`, resolved platform,
  active material, whether a native material is confirmed, and a bounded
  fallback reason when the active material is matte)
- at most 64 structured diagnostic events with a fixed subsystem, operation,
  outcome, code, optional HTTP status, and numeric usage fields. A version-1
  report identifies them with the current vocabulary. Storage, model, search,
  credential, and permission events do not appear as `unknown`. LC reduces
  repeated identical storage outcomes to the most recent outcome. Therefore,
  five-second checkpoints cannot fill the ring with copies of one fact.

### Current version-1 sections

| Section | What it contains |
|---|---|
| `collection` | Report surface (`settings` or `safe-start`), per-section `available`/`unavailable`, bounded collector failure codes (`collector-timeout`, `collector-failed`), event-buffer readability, and dropped/truncated counts |
| `storage` | Database-open, metadata-hydrate, indexed-read, and durable-write outcomes, plus the age bucket of the last successful durable write |
| `activeRequest` | Identifies request facts or current-configuration facts. Includes protocol, API style, routing, endpoint class, and cache surface. Includes reasoning enabled/effort, stream-timeout bucket, and tool-definition count. Includes resolved vision, reasoning, and tool capabilities. Reports whether a context window was known. |
| `modelDiscovery` | Last list/sync outcome, bounded code/status, returned-count bucket, endpoint class, and metadata source (`discovered`, `cached`, `override`, `unknown`) |
| `authConfiguration` | Per chat, non-chat profile, and search surface: `keychain-ref`, `plaintext-fallback`, `not-configured`, or `unknown`, plus that surface's own resolution or bootstrap outcome |
| `search` | Selected provider, including `auto`. Includes the provider that actually resolved and the configured providers. Includes SearXNG endpoint class, last outcome and status, result-count bucket, and allowlisted ignored names `freshness`, `extra_snippets`, `cross_check`. |
| `providerStream` | Correlates the most recent request with its own terminal stream result. Includes outcome, status, finish code, and cancellation/timeout/retry state. Includes duration bucket, token usage, and whether the provider reported usage. |
| `cacheAndPrefix` | Provider cache read/write/miss/report status (`reported`, `partially-reported`, `not-reported`, or `unknown`) and reporter, plus the bounded LC prefix conclusion, its qualifiers, and conclusion counts. No replay item or accounting locator is collected. |
| `tools.recent` | Canonical built-in tool name or `unknown`, outcome/result code, permission disposition, and duration bucket |
| `ui` | Existing theme/zoom/feature facts plus the material resolution (`materialMode`, platform, active material, native-activation state, bounded fallback reason), the report entry surface, and bounded Safe Start action outcomes |

Every count, age, duration, and result size that is not already a safe exact
aggregate uses a documented bucket:

- **duration** — `under-100ms`, `100ms-1s`, `1-5s`, `5-30s`, `30s-2m`, `over-2m`, `unknown`
- **count** — `none`, `1-9`, `10-49`, `50-199`, `200+`, `unknown`
- **age** — `under-1m`, `1-10m`, `10-60m`, `1-24h`, `over-24h`, `never`, `unknown`
- **quota** — `empty`, `under-25%`, `25-49%`, `50-79%`, `80%+`, `unknown`

Every category is a closed enum. A value LC does not recognize serializes as
`unknown`, never as arbitrary provider text.

### The active request

`activeRequest` describes the last chat request that LC sent. LC captures the
request at the provider boundary. Later conversation, profile, or configuration
changes do not rewrite it. The section describes failed and successful requests
in the same way.

Internally, concurrent generations record into a bounded 12-entry recent
session ring keyed only by an ephemeral runtime session identity. The portable
report never serializes that key or any conversation identity. `activeRequest`
projects the most recent snapshot. `streaming.recentRequests` carries bounded,
identity-free request facts in arrival order. This order lets users compare
concurrent failures without one chat erasing the others.

`activeRequest.source` says which kind of fact this is:

- `request` — a request ran, and these are its facts
- `current-configuration` — no request has run this session, so the section
  describes what is configured right now. `toolDefinitionCount` is absent,
  because nothing has been assembled to count
- `unavailable` — neither was readable.

`toolDefinitionCount` counts the tool definitions in the payload sent to the
provider, not entries in the stored tool policy.

### Request/stream correlation

`providerStream.correlated` reports whether the most recent provider request
was matched to its own terminal stream result. The pairing uses an ephemeral
counter that exists only inside the 64-event ring. The counter wraps at a small
bound. It is **not** a provider, request, message, conversation, or profile
identifier. It is also **not** a content hash.

LC never serializes the counter
into the report. It serializes only the Boolean value and resulting facts.

The counter applies to one session and is never persisted. Therefore,
correlation cannot survive a reload. A request from an earlier session does not
pair with a result. `correlated` reads `false` instead of matching a stale
stream result. LC reports a stream result only when it belongs to the adjacent
request. Otherwise, that field reads `unknown`.

Every terminal path carries the pairing. These paths include network, HTTP,
missing-body, parsing, timeout, and cancellation failures. They include reasoning
rejection and its retry. Native LM Studio completion and ordinary success also
carry the pairing.

### Search selection versus search resolution

`search.selectedProvider` is the provider that the user selected, including
`auto`. `search.configuredProviders` identifies providers with a recorded
credential or base URL. `search.resolvedProvider` is the provider that the
resolver selected. It comes only from an actual resolution or call. LC never
infers it from configuration.

A provider can remain configured after its keychain entry disappears. In this
case, its `authConfiguration` surface shows a failed bootstrap. The report does
not claim that the provider served a call.

### Where model metadata came from

`modelDiscovery.metadataSource` reports one value. It uses this precedence:
`override`, `cached`, `discovered`, and then `unknown`. `override` means that
the list came from a custom model endpoint. `cached` means that LC's bundled
models.dev cache enriched at least one entry. `discovered` means that the server
described its own models. LC records the value after enrichment finishes.

Therefore, a metadata failure cannot leave a successful claim.

### Why `authConfiguration` is not called `credentials`

The final redaction pass blanks any key whose name looks credential-bearing.
That pass would erase this whole section even though it contains only closed
enum values that describe *which storage slot is populated*. The section name
avoids the redaction pattern. Its contents make the section safe. Report
creation does not read the keychain. It also does not read a reference name,
account id, or credential value.

Exact model identifiers and sanitized error descriptions are separate opt-ins
and are off each time the report window opens. Error descriptions retain only
recognized generic failure classes. Unknown exception text and provider bodies
are replaced with a closed fallback.

## Always excluded

- API keys and keychain reads performed only for reporting
- authorization headers, bearer tokens, cookies, URL credentials, query
  parameters, and fragments
- exact configured hosts and endpoints
- conversations, titles, messages, prompts, generated text, reasoning, and
  refusals
- Responses output items, Anthropic thinking blocks, opaque replay accounting,
  item/block locators, summaries, signatures, redacted payloads, ciphertext,
  and remote response handles
- attachments and attachment metadata
- tool arguments, commands, stdout/stderr, tool output, and granted path text
- skill names, descriptions, source paths, and content
- Windows, UNC, Unix, and `file://` paths
- email addresses and long encoded/base64 values
- arbitrary provider response bodies, exception stacks, raw logs, and unknown
  object keys
- search queries, search results, fetched pages, and research contents
- request bodies, prompts, system text, tool schemas, and raw SSE events
- cache keys, session keys, `prompt_cache_key`, `session_id`, `x-session-id`,
  OpenRouter routing identifiers, prefix digests, and the per-session HMAC key
- stable provider, request, message, conversation, or profile identifiers
- automatic upload, telemetry, crash reporting, or remote support access.

The generator constructs a new object from an allowlist. Then it applies a
final recursive redaction pass. Strings, arrays, nesting, provider and model
samples, event count, and serialized size have limits. The current serialized
size limit is 64 KiB. If an addition approaches that limit, LC reduces optional
identifiers, descriptions, and event samples. It preserves valid JSON.

`collection.sizeReduced` and `collection.omitted` identify the shortened
sections. Therefore, a smaller report never appears complete.

Malformed, unavailable, or oversized sources cannot make report creation fail.
The builder does not trust its input. It removes unrecognized enum values. It
also filters a null or hostile entry before it reads a field.

## Diagnostic facts have production emitters

An earlier review found documented diagnostic facts that had a schema and
tests. However, no shipped code path recorded them, so they could not appear in
a real report. Each row below identifies a shipped emitter and a test. The test
runs the production path and reads the diagnostic ring. It does **not** inject
an event into the builder. A schema and builder test do not prove that a fact
reaches a user's report.

This table is a release-gate criterion. See
[README.md § Release gate](./README.md#release-gate). A newly documented
diagnostic fact is not done until it has a row here.

| Fact | Emitter | Production-path test |
|---|---|---|
| Storage open | `store/db.ts` `openConversationStorage` | `store/storage-diagnostics.test.ts` |
| Metadata hydrate | `store/db.ts` `loadAllMeta` | `store/storage-diagnostics.test.ts` |
| Indexed read | `store/db.ts` `loadMessages` | `store/storage-diagnostics.test.ts` |
| Durable write (all conversation mutations) | `store/db.ts` `durableWrite` wrapper | `store/storage-diagnostics.test.ts` |
| Credential bootstrap — chat | `platform/chat-credential.ts` | `platform/credential-diagnostics.test.ts` |
| Credential resolution — non-chat profile paths | `platform/chat-credential.ts` | `platform/credential-diagnostics.test.ts` |
| Credential bootstrap — search | `platform/search-key-bootstrap.ts` | `platform/credential-diagnostics.test.ts` |
| Model discovery | `llm-client/models/list.ts` | `llm-client/models/model-discovery-diagnostics.test.ts` |
| Search resolution | `tool-engine/search-provider.ts` | `tool-engine/search-call-diagnostics.test.ts` |
| Search call, no-results, provider error, missing config | `tool-engine/search-diagnostics.ts`, used by `tool-engine/builtin/web_search.ts` and `tool-engine/builtin/web_research.ts` | `tool-engine/search-call-diagnostics.test.ts` |
| Provider request, all terminal paths | `llm-client/client.ts` | `llm-client/request-diagnostics.test.ts` |
| Active-request shape | `llm-client/request-snapshot.ts`, captured in `client.ts` | `llm-client/request-diagnostics.test.ts`, `utils/support-report-active-request.test.ts` |
| Stream completion, all terminal paths | `chat-pipeline/orchestrator.ts` | `llm-client/request-diagnostics.test.ts` |
| Tool execution with its permission disposition | `tool-engine/runner.ts` `executeToolCall` | `tool-engine/tool-permission-diagnostics.test.ts` |
| Denied / unavailable / abandoned permission | `tool-engine/runner.ts` `recordBlockedPermission`, wired in `chat-pipeline/orchestrator.ts` | `tool-engine/tool-permission-diagnostics.test.ts` |
| Safe Start recovery actions | `safe-start/SafeStartShell.tsx` | `safe-start/safe-start-shell.test.ts` |

## GitHub issue workflow

1. Reproduce the problem if practical so recent structured event codes are
   available.
2. Open **Settings → Support → Create support report**.
3. Leave both optional switches off unless the maintainer specifically needs
   model identity or generic error context.
4. Read the final preview. The generator redacts private data, but you control
   what you share.
5. At the lower left, use **Report issue**. LC opens its GitHub issue tracker in
   the default browser.
6. Save the JSON file and attach it to the issue, or copy the JSON into a fenced
   code block.

The report is diagnostic only. It is not a backup and cannot be imported to
restore settings or conversations.

## Report creation in Safe Start

Safe Start and Settings emit the **same current schema** and use the **same
final serializer**. The difference is coverage, not format.

The Safe Start recovery shell offers the same final v1 report, preview, Copy,
and Save guarantees. It does not import or open the normal settings, profile,
model, or conversation stores. `collection.sections` marks store-dependent
sections as `unavailable`. Safe Start does not open a possibly malformed store
to recover counts. It marks dependent store counts and integrity facts as
unreadable.

Report creation still succeeds when settings are malformed or the
conversation database cannot open. Model identifiers are absent because Safe
Start skips model discovery. Sanitized diagnostic descriptions remain optional
and off by default.

## Collection is side-effect-free

Creating a report does not cause these actions:

- network request or model refresh
- keychain read or conversation load
- complete database scan or repair

The collector summarizes facts captured during normal operation at normalized
boundaries. These include storage access, model discovery, credential
resolution and bootstrap, search calls, provider requests, and stream completion.
They also include tool execution, permission results, and Safe Start recovery
actions.

Recording a diagnostic never changes the outcome of the operation being
observed. Every recording path swallows its own failures.

The collector uses only the conversation database `count()` helpers. These
helpers record nothing. Storage events come from hydration, lazy message reads,
and durable mutations. LC records one `storage-write-*` outcome for each
logical mutation. The boundary covers conversation rows, attachment blobs,
localStorage stores, and desktop key-store writes and deletions.

LC records one outcome for each mutation
that changes a row. A delete that finds nothing records no outcome. An empty
delete list also records no outcome. A function that changes two tables in one
transaction still records one outcome.

A failed write also raises the store-level `persistence-error` or
`persistence-warning` signal included in the same schema. This separate
vocabulary describes the same failure at a higher layer. It does not feed
`storage.durableWrite`.
