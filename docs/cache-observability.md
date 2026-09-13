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

# Provider cache usage and prompt-prefix diagnostics

**Status:** Implemented
**Modules:** `src/modules/llm-client/cache-usage.ts`,
`src/modules/llm-client/prefix-diagnostics.ts`,
`src/ui/chat/usage-detail.ts`

---

## 1. What this is, and what it is not

LC **observes** what a provider reported about cache reads, writes, and misses.
It separately explains **what LC changed** in the cache-relevant part of its
request.

LC does **not**:

- build a prompt, KV, response, semantic, or content cache of its own
- retain provider cache entries, pre-warm, or send keep-alive requests
- promise savings, compute a hit rate, or estimate billing
- infer a cache hit from latency
- add `cache_control`, `prompt_cache_breakpoint`, `prompt_cache_key`,
  `session_id`, `x-session-id`, retention controls, or any other cache or
  routing directive as a side effect of diagnostics
- reorder, mutate, or otherwise change the request it observes.

`not-reported` means only that LC received no recognized cache counter. It does
**not** mean the provider performed no caching. An explicit numeric `0` is a
provider report and stays distinguishable from an absent field.

### Activation is a separate decision from observation

Diagnostics never change the request. Provider-native cache **activation** is a
separate product decision, which [standing constraint 6](./README.md#standing-product-constraints)
permits. Diagnostics then observe the final post-policy request.

LC makes one such choice: **Anthropic's own API**, where caching is opt-in and
nothing is cached without it ([§3.1](#31-anthropic-caching-is-opt-in)). It uses
the top-level automatic form, so the server places and advances the breakpoint.
Every bullet above still holds — no breakpoint of LC's own, no reordering, no
LC cache, and no directive on any other provider.

---

## 2. Normalized usage model

```ts
interface CacheUsage {
  status: 'reported' | 'not-reported';
  readTokens?: number;
  writeTokens?: number;
  missTokens?: number;
  writeTokensByTtl?: { ephemeral5m?: number; ephemeral1h?: number };
  reportedBy?: 'provider' | 'router';
  anomalies?: Array<'malformed-value' | 'negative-value' | 'fractional-value'
    | 'conflicting-aliases' | 'ttl-breakdown-mismatch'>;
}

interface NormalizedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  tokenCoverage?: Record<'input' | 'output' | 'total', 'reported' | 'partial' | 'unreported'>;
  cache?: CacheUsage;
  source?: 'provider' | 'lc-estimate';
}
```

Gemini Interactions uses separate output and thought counters: normalized output
is `total_output_tokens + total_thought_tokens`. A reported `total_tokens` is
authoritative. `total_cached_tokens` stays a subset of input; raw
`total_tool_use_tokens` is retained without assuming additive semantics. Missing
components carry field-level coverage through persistence and turn aggregation;
the UI distinguishes a lower bound from an unreported field. A malformed later
snapshot does not erase a usable earlier count. No cache-control option is added.

Gemini prefix diagnostics observe native `system_instruction`, ordered `input`
steps, `tools`, `generation_config`, and `response_format`, without changing the
request or inferring a cache hit. See [Gemini REST](./note-gemini-rest.md) for
the documentation-only provider evidence and replay/accounting contract.

Normalization rules:

1. Only finite, non-negative integers are accepted. A malformed value is
   ignored and produces a bounded code — never a raw provider payload. JSON
   `null` is the one exception. A compatible server can use it for "no value"
   in a numeric field. LC reads it as **absent**, not malformed. It raises no
   anomaly. See [§3.4](#34-unusable-cache-counter-values).
   Every other unusable type still codes.
2. Zero is preserved. A recognized field present with `0` means `reported`.
3. OpenAI-compatible `prompt_tokens` and Responses `input_tokens` already
   include cached input. Reads, writes, and misses are never added to them.
4. For Anthropic-shaped usage, normalized `prompt_tokens` is
   `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
   Missing optional terms contribute zero to that documented sum only. Absence
   still reads as absence inside `cache`.
5. `cache_creation_input_tokens` is the authoritative write total when the
   optional TTL breakdown is also present. The breakdown is a detail and is
   never added a second time. A disagreement records
   `ttl-breakdown-mismatch` and keeps the authoritative total.
6. DeepSeek's provider `prompt_tokens` stays authoritative. Hit and miss
   counters are details and are not added to it.
7. When more than one compatible alias appears, the adapter's API envelope owns
   precedence. LC never sums aliases that may describe the same tokens. It
   records `conflicting-aliases` only when the aliases carry **different**
   values. Duplicates that agree are ordinary, not an anomaly. DeepSeek sends
   `prompt_cache_hit_tokens` alongside the OpenAI-compatible
   `prompt_tokens_details.cached_tokens` on every Chat Completions response.
   Flagging co-presence alone caused a permanent code on DeepSeek. That code
   hid a real divergence in noise.
8. Ordinary usage with no recognized cache field carries
   `{ status: 'not-reported' }`. A response with no usable provider usage
   leaves `usage` absent, exactly as before.
9. **Any one usable counter is a provider report.** An envelope split across
   several events counts as reported if *any* event carried a usable field. The
   Anthropic adapter merges `message_start` and `message_delta`. A terminal
   `output_tokens` value alone is sufficient. A requirement for opening-event
   usage discarded reports from servers that report only at termination. LC
   then used `lc-estimate` for a figure that the provider had sent.

`source` keeps a **provider report** distinct from an **LC estimate**. When a
server reports no usage, LC counts tokens locally and marks the result
`lc-estimate`. No surface presents that as a provider figure.

### Why write counters are mostly an Anthropic thing

`readTokens` arrives from nearly every caching provider. `writeTokens` arrives
from almost none. That is a billing artefact, not a gap in LC.

A provider reports writes when a write is **billed differently**. Anthropic
charges 1.25× base input for cache creation at the 5-minute TTL. It charges 2×
at the hour. Therefore, it itemizes writes as `cache_creation_input_tokens` and
the `ephemeral_5m` / `ephemeral_1h` breakdown. Providers with automatic caching
generally make the write free, so there is nothing separate to report and only
the read matters. The OpenAI Chat Completions envelope follows the same logic:
`prompt_tokens_details.cached_tokens` is standard, a write counter is not.

Observed 2026-08-05, one turn per surface:

| Provider | Envelope | `writeTokens` |
|---|---|---|
| Anthropic | Anthropic | 14,573 |
| MiniMax | Anthropic | absent |
| QwenCloud (`glm-5.2`) | Chat Completions | absent |
| LM Studio (Responses, Messages) | both | absent |
| OpenCode gateway (`hy3`) | Chat Completions | explicit `0` |

MiniMax shows that this behavior is a pricing choice, not an envelope limit. It
uses the Anthropic protocol, whose schema contains the field. MiniMax still
omits the field.

LC recognizes the write aliases on every envelope that defines one, so a
provider that starts sending one needs no code change. The last two rows are
not equivalent. An absent field shows no write line. The gateway's explicit
`0` reports zero and stays visible under rule 2.

---

## 3. Provider coverage and how it was verified

Coverage follows the protocol instead of the hostname. A compatible gateway
retains the facts in a documented usage envelope. An unknown server that omits
them behaves as before.

| Provider / API surface | Envelope | Verification | Live evidence |
|---|---|---|---|
| OpenAI — Chat Completions | Chat Completions | **live-verified** | 2026-08-05 — read counter growing across three turns (0 → 5,248 → 5,504) on `gpt-4.1-mini`. No write counter, as the envelope predicts. |
| OpenAI — Responses | Responses | **live-verified** | 2026-08-04 — read **and** write counters, three repeated requests |
| OpenRouter — Chat Completions | Chat Completions (router) | **live-verified** | 2026-08-05 — router-reported read and explicit-zero write, three turns (read 0 → 7,936 → 0). See [§3.3](#33-a-router-read-can-drop-back-to-zero). |
| OpenRouter — Responses | Responses (router) | **live-verified** | 2026-08-05 — router-reported read, three turns (0 → 7,808 → 0). See [§3.3](#33-a-router-read-can-drop-back-to-zero). |
| Anthropic — Messages | Anthropic | **live-verified** | 2026-08-05 — read **and** write counters plus the TTL breakdown, three growing-prefix turns on `claude-sonnet-5`. See [§3.1](#31-anthropic-caching-is-opt-in). |
| DeepSeek — Context Caching | Chat Completions | **live-verified** | Maintainer-confirmed on the packaged desktop build, 2026-08-04/05. Per-turn figures not retained. |
| QwenCloud — OpenAI-compatible | Chat Completions | **live-verified** | Maintainer-confirmed on the packaged desktop build, 2026-08-04/05. Per-turn figures not retained. |
| QwenCloud — Responses | Responses | **live-verified** | 2026-08-04 — read counter, three repeated requests |
| QwenCloud — Anthropic-compatible | Anthropic | **live-verified** | Maintainer-confirmed on the packaged desktop build, 2026-08-04/05. Per-turn figures not retained. |
| MiniMax — OpenAI-compatible | Chat Completions | **live-verified** | Maintainer-confirmed on the packaged desktop build, 2026-08-04/05. Per-turn figures not retained. |
| MiniMax — Anthropic-compatible automatic | Anthropic | **live-verified** | 2026-08-04 — read counter growing across three repeated requests. No cache-creation counter, and `input_tokens` reported as zero. |
| MiniMax — Anthropic-compatible explicit | Anthropic | **fixture-only** | Not reachable through LC — see below |
| Z.AI — Context Caching | Chat Completions | **live-verified** | 2026-08-04 — read counter growing across three repeated requests |

**Twelve of the thirteen surfaces have live evidence. The thirteenth cannot
have live evidence.** A fixture-only surface follows the provider's published
usage envelope. Tests exercise it through the real adapter SSE path. This does
not prove that a live account and model report those fields today.

Nothing is outstanding. The sole permanent exception is MiniMax explicit,
below.

Two grades of live evidence are recorded, and the table says which applies.
Seven rows carry retained per-turn counter figures from sessions whose archives
were read directly. Five carry maintainer confirmation of an end-to-end test on
the packaged desktop build. Those tests reported the counters as documented,
but did not retain the per-turn numbers. Both are live evidence. Repository
artifacts cannot reproduce the second type.

The three rows closed on 2026-08-05 came from a thirteen-conversation archive,
`lc-chat-v1-all-2026-08-05`. The packaged build created one conversation for
each provider and envelope pair. Each conversation had three growing-prefix
turns.

The two
OpenRouter rows are self-attributing: `reportedBy: 'router'` is derived from the
`openrouter.ai` hostname by `usageReporterForBaseUrl` and cannot be produced by
any other host. The OpenAI Chat Completions row is attributed from its envelope,
which has no `responses_output_items`. Its non-router origin and the
maintainer's session label also support the attribution. The archive proves the
envelope and rules out OpenRouter.

However, a redacted support report has no
hostname. Therefore, account identity depends on maintainer confirmation.

The **MiniMax Anthropic-compatible explicit cache** row is a permanent
exception, not an outstanding task. Explicit caching requires provider
breakpoints. [Standing constraint 6](./README.md#standing-product-constraints)
forbids LC from adding a breakpoint. LC cannot reach
that surface by using LC, so its fixture is the only evidence that will ever
exist for it.

### What the 2026-08-04 evidence is, and what it is not

The evidence is two real multi-turn sessions against real accounts, run through
LC's own adapter path, with the conversation archives and support reports
retained. Each conversation issued three requests that shared a growing prefix.
Each provider's cache read counter behaved as documented. It was zero or low
on the first request and substantial on the second and third.

**The envelope identifies a row, not the provider name.** A model identifier
does not identify the API surface. For example, gpt-5.6 has no Chat Completions
surface. A DeepSeek or Qwen account can use the Responses envelope. The archive
provides the attribution signals. Only the Responses adapter produces
`responses_output_items`.

The support report's `activeRequest.protocol` names
the adapter for the last request. Use these signals to label rows.

For the four labelled surfaces, the evidence **does** establish these facts:

- A live account reports the counters that LC normalizes.
- Reads increase when a prefix is reused.
- `prompt_tokens` remains authoritative and is not counted twice.
- The UI and support-report aggregates carry the result end to end.

It **does not** name the raw provider alias that produced each counter, because
a conversation archive records LC's normalized result rather than the provider
envelope. Where that distinction matters — for example to confirm whether a
provider returned `prompt_cache_hit_tokens` or the OpenAI-compatible
`prompt_tokens_details.cached_tokens` — run the probe harness below. The harness
records the raw field names.

Observations from the same sessions that sit outside the coverage table above
but are worth recording:

- **The Anthropic envelope was exercised three times, but never against
  Anthropic.** All three Anthropic-protocol conversations used
  Anthropic-*compatible* endpoints (MiniMax, DeepSeek, and a gateway). The
  first-party Anthropic Messages row therefore stayed fixture-only on that
  date, even though the adapter that serves it already had live evidence behind
  it. Superseded on 2026-08-05 by the opt-in session in
  [§3.1](#31-anthropic-caching-is-opt-in). The row is now live-verified.
- **Explicit zeroes survive a live round trip.** Two of those conversations
  reported `cache_creation_input_tokens: 0` alongside a non-zero read. The
  archive retains `writeTokens: 0` rather than dropping the field. This behavior
  confirms rule 2 and [standing constraint 4](./README.md#standing-product-constraints).
- **Anthropic token composition held.** Where `input_tokens` was non-zero,
  normalized `prompt_tokens` equalled input + read + creation exactly once.
- **MiniMax-M3's normalized `prompt_tokens` equalled its cache read exactly**
  on all three turns of the 2026-08-04 session, implying no uncached input at
  all. This result exposed an LC gap, which is now confirmed. LC read
  `input_tokens` only from `message_start`. Current Anthropic API versions
  restate cumulative usage on `message_delta`. Some compatible servers report
  uncached input *only* there. LC now takes a positive terminal `input_tokens` as
  authoritative.

  A repeat session on 2026-08-05 used the same model. Every turn reported
  non-zero uncached input (`prompt_tokens` 7,649 against a 6,656 read). The
  pre-fix session had reported equal values. The fixture note was
  corrected accordingly.

- **Anthropic's own API reported zero cache on every turn.** It reported an
  explicit `0` for reads, writes, and both TTL buckets. This result was reproduced
  on 2026-08-05 across three growing-prefix turns on `claude-sonnet-5`. It was a truthful
  provider report of nothing cached, not a parsing defect: LC sent no cache
  directive, and Anthropic caches nothing without one. It has since been
  resolved by opting in — [§3.1](#31-anthropic-caching-is-opt-in).
- A local LM Studio server reported `not-reported` with ordinary token counts,
  confirming live that a compatible server omitting cache fields behaves
  exactly as before. On 2026-08-05 that turned out to be true of **one of its
  three envelopes only** — see [§3.2](#32-lm-studio-reports-cache-on-two-of-its-three-envelopes).
- An OpenAI-compatible gateway returned more than one compatible alias at once.
  LC kept envelope precedence instead of summing them — normalization rule 7,
  observed live. It also recorded `conflicting-aliases`. Rule 7 now limits that
  anomaly to aliases with different values. The archive does not retain the
  values needed to apply the current rule to this observation. The precedence
  result remains valid.

Fixtures live in `src/modules/llm-client/cache-usage-fixtures.ts` and carry an
explicit `verification` field, plus a dated `liveEvidence` note once a surface
is verified. When a live probe is run, update both those fields and this table
in the same change.

### 3.1 Anthropic caching is opt-in

Anthropic caches nothing unless the request asks. With no `cache_control` in
the body it returns `cache_read_input_tokens: 0` and
`cache_creation_input_tokens: 0` — a real report of zero, which is what LC
displayed. Every other Anthropic-protocol service LC talks to (MiniMax,
DeepSeek, LM Studio, Qwen) caches automatically, so only first-party Anthropic
looked broken.

LC opts in with the top-level automatic form:

```jsonc
{
  "model": "claude-sonnet-5",
  "cache_control": { "type": "ephemeral" },   // request root, not a content block
  "messages": [ /* ... */ ]
}
```

The server attaches the breakpoint to the last cacheable block and advances
it. Therefore, LC never inserts or moves a breakpoint or reorders content.
These actions comply with [standing constraint 6](./README.md#standing-product-constraints).
The form uses one root field, so prefix diagnostics see unchanged segments.
`isAnthropicOwnApi()` also gates the version header and this field.

Therefore,
compatible servers never receive the field (constraint 7). MiniMax's
explicit-cache surface stays unreachable (§3).

Costs: a write is billed at 1.25× base input. A read is billed at approximately
0.1×. Therefore, the first request costs slightly more, and reuse repays it.

The minimum cacheable
prefix is model-dependent. It is 512 tokens on Opus 5 and Fable 5. It is 1,024
on Sonnet 5 and Opus 4.8. It is 4,096 on Opus 4.6 and Haiku 4.5.

Below the
minimum, nothing caches and the counters stay `0` without an error. LC sets no
TTL override, so the 5-minute default applies. The 1-hour TTL doubles the write
price and is a separate decision.

**Verified live, 2026-08-05** — three-turn `claude-sonnet-5` session through
the shipped adapter:

| Turn | Uncached input | Cache read | Cache write |
|---|---:|---:|---:|
| 1 | 2 | 0 | 11,431 |
| 2 | 2 | 10,818 | 2,448 |
| 3 | 2 | 12,020 | 14,573 |

Turn 1 writes without reading because nothing was stored. The write *is* the
miss. Turn 2 reads most of it and writes only the appended turn. This result
proves reuse. A read that stays at zero indicates prefix invalidation. Uncached
input stays at 2 tokens because the server advances the breakpoint.

A read need not equal the previous write: matching is at block boundaries, so a
tail past the last matching boundary is rewritten. Over these three turns
caching cost ~26% less than sending the same input uncached, and the margin
widens with conversation length.

### 3.2 LM Studio reports cache on two of its three envelopes

One LM Studio instance, one model (`qwen/qwen3.6-35b-a3b`), 2026-08-05:

| LM Studio envelope | LC result | Read tokens across three turns |
|---|---|---|
| Responses | `reported` | 6,037 → 7,256 → 8,014 |
| Anthropic Messages | `reported` | 6,037 → 7,078 → 7,545 |
| Chat Completions | **`not-reported`** | — |

This is not an LC parsing defect. In the same batch, the Chat Completions path
reported reads from QwenCloud (`glm-5.2`) and an OpenCode gateway (`hy3`).
Therefore, LC recognizes `prompt_tokens_details.cached_tokens`. LM Studio does
not send it. Nor does it mean nothing was cached.

The engine and KV cache
are shared across all three endpoints, and the other two show reads climbing on
the same prefixes. It is the §1 rule in practice: `not-reported` describes the
report, not the caching.

**LM Studio documentation does not confirm whether this behavior is by
design.** Its Responses documentation shows the field and says token caching
“will always be present in API responses.” However, this statement appears only
in the `/v1/responses` section. It applies to the Responses-shaped
`input_tokens_details.cached_tokens`. Neither the
[Chat Completions page](https://lmstudio.ai/docs/developer/openai-compat/chat-completions)
nor the [API changelog](https://lmstudio.ai/docs/developer/api-changelog)
documents that endpoint's `usage` object at all. The likeliest reading is that
LM Studio populates whichever field the emulated envelope defines — but that is
inference, so it is recorded as unverified.

No LC change is warranted: if LM Studio adds the field, LC picks it up with no
code change.

### 3.3 A router read can drop back to zero

Both OpenRouter rows read substantially on turn 2 and then reported **zero** on
turn 3 of the same growing-prefix conversation:

| Surface | Turn 1 | Turn 2 | Turn 3 |
|---|---:|---:|---:|
| OpenRouter — Chat Completions | 0 | 7,936 | 0 |
| OpenRouter — Responses | 0 | 7,808 | 0 |

This is the `router-upstream-unknown` case the design anticipated, not a
regression and not a prefix break. LC's own prefix conclusion on those turns was
`stable-prefix-active-suffix-changed`. The request prefix was intact. Therefore,
the zero describes where the request was routed, not what LC sent. A sticky route
can fail over to a different upstream instance between turns, and a cold
instance has nothing cached. LC does not reinterpret it (§5), and it does not
weaken the row: turn 2 is what proves the counter arrives and is normalized.

### 3.4 Unusable cache-counter values

The same 2026-08-05 batch also exercised OpenRouter's **Anthropic-compatible**
surface, which is outside the thirteen-row table. Each of its three turns had a
`malformed-value` anomaly and no write counter. No other surface in the batch
had this result. Cache read stayed `0` across all three turns. However, the same
provider and model read 7,936 on turn 2 through Chat Completions.

Investigating that found a genuine LC defect, since fixed. `message_delta`
merged a restated cache counter over the `message_start` value based only on key
presence. The adjacent `input_tokens` merge required a usable value. A server
that restates a counter as JSON `null` therefore
erased a good opening value. Reproduced through the shipped adapter:

| `message_start` | `message_delta` | Before | After |
|---|---|---|---|
| read 5,000, write 2,048 | write `null` | write dropped, `prompt_tokens` 5,100 | write 2,048, `prompt_tokens` 7,148 |
| read 5,000, write 2,048 | read `null` | read dropped, `prompt_tokens` 2,148 | read 5,000, `prompt_tokens` 7,148 |

Both counters and the documented `input + read + creation` prompt sum (rule 4)
were understated. The fix merges a restatement only when it is usable. Thus,
an explicit `0` still wins under rule 2. LC retains an unusable value only if
it saw no usable value for that key. This preserves rule 1's bounded code.

It is
not OpenRouter-specific: any Anthropic-protocol server that nulls a counter on
the terminal event hit it. Covered by
`adapters/cache-usage-streaming.test.ts`, "Anthropic cache counters restated
unusably on the terminal event".

The same retain-until-usable rule applies at the whole-envelope level on Chat
Completions and Responses streams. A later `usage` object replaces the retained
provider envelope only when that adapter's normalizer finds at least one usable
counter in it. An empty object or an object containing only unusable values
therefore cannot erase an earlier valid report. An explicit numeric zero is
usable and still replaces the earlier value. The Chat and Responses cases live
beside the Anthropic counter-level cases in
`adapters/cache-usage-streaming.test.ts`.

**That fix did not change the OpenRouter symptom. A second session showed the
cause.** A conversation archive stores LC's normalized result, not the provider
envelope (§3). Thus, multiple raw shapes can produce the same archived output. A
repeat session on the evening of 2026-08-05 — run on a development build that
*included* the fix — settled it:

| Turn | Read | Write | Anomaly |
|---|---:|---|---|
| 1 | 0 | absent | `malformed-value` |
| 2 | 0 | absent | `malformed-value` |
| 3 | **8,512** | absent | `malformed-value` |

Two conclusions follow.

**Reads are intact.** Turn 3 carries a real 8,512-token read through to the
archive, so nothing is zeroing the read counter. The zeroes on turns 1 and 2 are
genuine router-cold-route reports — the same `0 → non-zero → 0` shape both other
OpenRouter envelopes showed in the morning batch (§3.3). An earlier hypothesis,
that a terminal `cache_read_input_tokens: 0` was overwriting a real opening
read, is ruled out by this turn.

**The write field is always non-numeric and unusable.** All six turns across two
independent sessions carried `malformed-value` and no write counter. This result
did not depend on whether the read was 0 or 8,512. The second session included
the fix.

Therefore, the value cannot arrive on `message_delta` over a good
`message_start` value. That shape now yields `writeTokens: 0` and no anomaly.
OpenRouter therefore sends `cache_creation_input_tokens` as JSON `null`
in a position where LC never sees a usable value for that key.

**The counters LC showed were already correct.** No usable write counter ever
arrived, so none was displayed. In the same batch, the OpenCode gateway used the
same Anthropic envelope. It reported `writeTokens: 0` with no anomaly.
Therefore, this result is OpenRouter's serialization of "not applicable". It is
not a defect in the Anthropic write path.

What remained was a classification question, since resolved: `null` now reads as
**absent** rather than `malformed-value` (rule 1). A field a server sets to
`null` is one it is declining to report, which is what `not-reported` already
means (§1). Coding it as a malformed payload put a permanent anomaly on every
healthy response from that surface and made the anomaly channel useless there.
The change is deliberately narrow — only JSON `null`. Strings, booleans,
objects, `NaN`, and `Infinity` still code, so a genuinely broken payload is
still visible.

It also stops LC attributing a `0`/`0` token count to a provider
that reported `null` for both totals. That now falls through to an
`lc-estimate`, which constraint 4 requires be distinguishable from a provider
report.

### Running a live probe

`scripts/probe-cache-live.mjs` is the operator-run harness for the two-request
live-evidence criterion in the [release gate](./README.md#release-gate). Tests,
builds, and hooks do not run it. It has no defaults. You must pass the surface,
envelope, endpoint, model, and credential environment variable. Therefore, it
cannot contact a provider by accident.

```bash
node scripts/probe-cache-live.mjs --surface "OpenAI — Chat Completions" --envelope chat-completions --base-url https://api.openai.com/v1 --model <model-id> --key-env OPENAI_API_KEY
```

It sends one fixed synthetic prompt twice, unchanged, and reads only `usage`.
It adds no `cache_control`, `prompt_cache_breakpoint`, `prompt_cache_key`,
`session_id`, `x-session-id`, or OpenRouter routing control. The probe observes
native behavior. It does not create cache behavior. It prints only these items:

- provider/API surface and endpoint class
- date and recognized cache-field names
- bounded token buckets
- HTTP status and pass/fail result

It never prints credentials, request or response bodies, or headers. It also
omits request IDs, cache or session keys, and provider output.

A failing probe is evidence. Record it without changes. Do not label the
surface as live-verified. Do not rerun the probe until it passes.

Mapping tests deliberately assert **field shapes**, not that a model will cache
because its identifier resembles a current provider model. Provider
documentation and model thresholds change.

### OpenRouter

OpenRouter is one router/compatibility surface, not a new direct adapter per
upstream provider. Counters returned through it are labeled **OpenRouter
reported** (`reportedBy: 'router'`) unless the standard response identifies the
upstream authoritatively. LC never infers the upstream from the model name,
pricing, latency, or cache counters, and records it as unknown.

OpenRouter's `cache_discount` is monetary provider metadata rather than token
usage. It is not normalized into `CacheUsage`.

OpenRouter can use `session_id`, the `x-session-id` header, or
`prompt_cache_key` for sticky routing. LC adds none of them. They affect
routing, router-model selection, and request grouping in OpenRouter's logs, so
any future LC control requires a separate explicit product and privacy
decision.

---

## 4. End-to-end path

```text
stream terminal usage -> protocol adapter -> StreamResult
-> orchestrator -> assistant message -> IndexedDB
-> response detail UI -> conversation archive export/import
-> redacted support-report v1 aggregate
```

**The chip.** A completed reply carries one clickable chip of bare figures —
aggregate output, aggregate cache, whole-turn duration:

```text
588 · 11,431 · 14.6s      588 · unreported · 14.6s
```

Each provider response is normalized before aggregation. One assistant bubble
can contain several initial/tool-loop responses; their already-normalized
reads, writes, misses, and TTL buckets are summed exactly once. Coverage is
retained: some reported rounds plus some unreported rounds is
`partially-reported`, never a complete report and never an inferred zero.

Clicking the chip opens the breakdown, which names each figure. The hover title
carries the attributed detail lines. The cache figure reads `unreported` when no
counter was reported, never `0`, which would imply the provider cached
nothing.

**Three claim classes stay separated** ([standing constraint 4](./README.md#standing-product-constraints)):

| Surface | Claim |
|---|---|
| Popover titled **Turn usage · N reported** | assistant-turn sum of response-local provider figures |
| Popover titled **Turn usage · mixed provider report and LC estimate** | some rounds were provider reports and some were locally counted |
| Popover titled **LC estimate** | legacy/single response for which the server returned no usage |
| Popover titled **Legacy final-response report** | old tool-loop row without an assistant-turn aggregate marker |
| Detail line `Provider: …` | provider, including the router qualifier |
| Detail line `LC: …` | LC inference about LC's own request |

The title never names a vendor. Router attribution remains on cache detail;
which upstream served a routed response is not inferred. A `cache read 0` can
indicate route failover instead of a broken prefix. This detail appears in
`(OpenRouter reported)` and the `router-upstream-unknown` prefix qualifier.

`LC:` lines sit alongside provider counters on ordinary responses: a
provider-reported reply still carries LC's prefix conclusion, because the two
answer different questions (§5).

**Reported vs derived.** Under "Provider report," each value comes from
provider numbers. However, `Input` is derived. On the Anthropic envelope, it is
`input_tokens + cache_read + cache_creation` under rule 4. Anthropic's
`input_tokens` is the uncached remainder, not the prompt total. With caching,
it is often a single-digit number.

On OpenAI and Responses envelopes, the
provider total includes cached input. Therefore, LC adds nothing under rule 3.
`Output`, `Cache read`, and `Cache write` are verbatim.

Under "LC estimate," `Input` and both cache rows read `unreported`. LC never
estimates a cache counter. A locally counted prompt total is not comparable.

Other rules:

- Explicit zeroes stay visible. An absent counter reads `unreported`.
- Writes, misses, and the TTL breakdown live in the detail lines. No ratio or
  percentage is ever shown.
- The TokenMeter's **Provider cache** row is always present, `unreported`
  included.
  Hiding it made "nothing reported a counter" indistinguishable from "this
  meter has no such row" — the question the row exists to answer.
- The TokenMeter describes the active adapter's next-request projection. It
  never substitutes the footer's assistant-turn total. Locally countable
  fields stay local; only a provider-reported or explicitly provider-estimated
  reasoning count can supply an otherwise unmeasurable opaque contribution,
  and only while its exact carrier is replayed and known retained.
- Conversation archives retain cache usage losslessly. Archives written before
  these fields existed import unchanged.
- Support reports carry only bounded aggregate counters and conclusion counts.

---

## 5. Prompt-prefix diagnostics

At the final provider-shaped request boundary — after Tool History projection
and request assembly, immediately before send — LC splits the request into
cache-relevant segments:

1. Protocol/API style, model, and cache-relevant reasoning/effort controls
2. Ordered tool definitions and tool-choice controls
3. System instructions and resolved skills
4. projected historical blocks, including Tool History stubs, tool results,
   images and their detail settings, reasoning replay items, and provider
   output items
5. the active-turn suffix.

Each segment is reduced to a **keyed digest** using a fresh random per-session
HMAC key. The imported key is **non-extractable**, so LC cannot serialize it.
LC never persists or exports the key or any digest. LC never uses an unkeyed stable
content hash, because
that would be a durable fingerprint of user content.

### Chain scope and what a change reports

A comparison chain is identified by **conversation + server profile**. That is
the boundary at which LC has nothing to compare:

- Changing conversation or profile produces `no-comparable-request`. There is
  no earlier request in that chain, so no claim is made about one.
- Changing protocol, API style, or model stays **inside** the chain and
  produces the bounded `provider-protocol-or-model-changed` conclusion. That
  request also becomes the new baseline, so the next identical request compares
  against it and reports `stable-prefix` rather than repeating the change.

The second case is deliberate. Discarding the chain would report
`no-comparable-request` and lose the reason the prefix could not be reused,
which is the fact that a maintainer needs. LC reports the change once and then
moves the baseline forward. This behavior keeps the information without
overstating it. The conclusion describes only what LC changed. It never
describes what the provider did.

Earlier wording described protocol/API-style/model changes as starting a new
chain. The shipped behavior and tests follow the description above. Only the
wording changed because inspection found no privacy or correctness reason to
discard the chain.

History comparison is prefix-aware. Appending new history is **not** a break in
the earlier common prefix. The following actions cause a historical-prefix
change:

- replacing full results with Tool History stubs
- editing or retrying a turn
- reordering blocks
- changing image detail
- mutating an earlier provider replay item.

Only a bounded conclusion is stored:

`no-comparable-request`, `provider-protocol-or-model-changed`,
`cache-relevant-options-changed`, `tool-definitions-or-choice-changed`,
`system-or-skills-changed`, `history-prefix-changed`,
`stable-prefix-active-suffix-changed`, or `stable-prefix`.

Provider breakpoint behavior is a **separate qualifier**, never folded into the
conclusion:

- `provider-breakpoint-may-exclude-suffix` renders as *"provider may not reuse
  the stable prefix under the current breakpoint"* — never as *"LC caused a
  cache miss"*.
- `router-upstream-unknown` records that a routed request's sticky route may
  have failed over for reasons outside LC's request. A zero cache read through
  a router is never reinterpreted as a prefix change.

The completed-response detail keeps the two evidence classes visibly apart:

```text
Provider: cache read 0 tokens (reported)
LC: stable core prefix; active suffix changed
```

---

## 6. Tests

| File | Covers |
|---|---|
| `src/modules/llm-client/cache-usage.test.ts` | All 13 §3 rows plus cache and reasoning missing/zero/malformed/negative/fractional/conflicting-alias cases across Chat, Responses, and Anthropic envelopes |
| `src/modules/chat-pipeline/turn-usage-accumulator.test.ts` | One- and three-response turn sums, large early reasoning, cache/reasoning partial coverage, mixed attribution, and response-ID deduplication |
| `src/modules/llm-client/adapters/cache-usage-streaming.test.ts` | The same facts through each adapter's real SSE path, including terminal usage, explicit zeroes, and the [§3.4](#34-unusable-cache-counter-values) restatement guard |
| `src/utils/cache-usage-persistence.test.ts` | Tests the real row mapping, IndexedDB, and archive paths. Covers cache fields, turn aggregates, replay accounting, strict malformed-input clearing, legacy rows, and forbidden cache/session/digest keys. |
| `src/modules/llm-client/prefix-diagnostics.test.ts` | Segment changes, prefix-aware history, qualifiers, privacy, bounds |
| `src/ui/chat/usage-detail.test.ts` | Wording that keeps provider report, LC estimate, and LC inference distinct |
| `src/ui/chat/token-meter.test.ts` | TokenMeter ignores cache counters, uses the next-request provider projection, and exposes unknown opaque/remote state as a lower bound |
