# Reasoning, Replay, Effort, and Token Accounting

**Status:** Normative engineering contract
**Primary-source verification:** 2026-09-02
**Repository verification:** 2026-09-02

This document is the canonical contract for reasoning controls, reasoning
history, provider continuation state, the assistant-turn usage footer, and the
next-request TokenMeter. Provider-specific notes and historical audit records
must link here instead of restating these rules from memory.

The contract separates three things that must never be conflated:

1. **Provider fact** — a field, event, carrier, mapping, or retention rule in a
   current primary provider document.
2. **LC policy** — what LC archives, sends, counts, and shows.
3. **Current implementation** — code that may still deviate from either of the
   first two. Known deviations are listed in §10; their existence does not turn
   them into policy.

## 1. Evidence and change rules

Use this evidence order when changing reasoning behavior:

1. the current first-party API reference or model guide;
2. a sanitized wire fixture captured from that exact provider, endpoint, and
   model;
3. an adapter regression fixture that states whether it is a literal capture or
   only a schema projection;
4. an explicitly documented LC fallback.

A model name, endpoint family, relay hostname, empty visible reasoning field,
or event name by itself is not evidence of encryption, replay eligibility, or
token occupancy. When primary documentation does not define a carrier, preserve
the returned structure and classify it structurally. Do not guess.

Every provider row below has a dated source. Reverify the affected row before a
behavior change. A documentation search snippet is not verification; open the
source page. A successful request to one first-party endpoint does not verify a
compatible endpoint or relay.

The `log/` directory is diagnostic scratch space and is not durable evidence.
If a capture establishes a new contract, reduce it to a sanitized committed
fixture and cite that fixture from a test before deleting the capture.

### 1.1 Machine-readable provider contracts

[`src/modules/llm-client/provider-contracts.v1.json`](../src/modules/llm-client/provider-contracts.v1.json)
is the versioned source-of-truth database for LC-verified wire behavior. The
production build statically embeds it in LC's application bundle; it is not a
public runtime asset, app-data override, or remote update surface. Its records are scoped by
an exact Base URL origin, a declared exact path or path prefix, a configured
protocol, and—where one provider surface changes shape by model—an exact model
ID. The resolver in
`src/modules/llm-client/provider-contracts.ts` never chooses a provider from a
model name and never uses a model regex, substring, or case-folded near match.
An unregistered relay therefore stays unknown instead of inheriting a
first-party contract by resemblance. On an `exact-registration` surface, an
unregistered model receives only surface-wide facts; model controls and model
history overrides remain unknown. On a `surface-default` contract, the surface
facts apply to every model ID by definition.

A separate commercial product that exposes the exact same protocol, origin,
and path is recorded in `additional_products`, not as an ambiguous duplicate
contract. This shares only verified wire behavior. Accounts, API keys, billing,
and other product identity remain separate. A later distinct origin or path
requires its own contract.

The registry records request-control paths, retention and replay behavior,
carrier classes, stream behavior, usage paths, accounting relationships, dated
primary sources, and explicit partial/unknown states. Its schema makes the
following invariants non-overridable: archive all returned reasoning, keep
reasoning independent of Tool History, pass effort values through, and treat a
missing reasoning measurement as unknown. `documented_values` is evidence for
capability presentation; it is not permission for an adapter to remap, clamp,
or reject a selected value locally. `npm run check:provider-contracts` validates
the bundled file and every production build runs that check.

models.dev remains useful but has a different job. Its `api.json`,
`models.json`, and `catalog.json` provide provider roots, context/output limits,
reasoning availability and options, modalities, tool support, a coarse
Responses/Completions shape, static body/header hints, and the two interleaved
field hints `reasoning_content` and `reasoning_details`. Its current schema does
not represent carrier semantics, replay rules, Tool History independence, SSE
subtypes, cumulative versus append deltas, usage paths, inclusive-versus-
additive accounting, opaque-state binding, or LC policy. Those omissions are
why `models-cache.json` remains untouched generic enrichment and cannot become
wire-contract authority. The reviewed models.dev commit and this accepted/
rejected field boundary are pinned inside the LC registry.

LC validates and retains the embedded registry once at module load. Generation
admission resolves the main route and every helper route by exact
origin/path/protocol/model and freezes the result, match status, and registry
version into the execution snapshot. `LLMClient` also resolves for direct
callers. Chat and Responses request controls, provider-history projection,
reasoning-carrier selection, replay accounting, and TokenMeter context
projection consume that resolved object. TokenMeter memoizes resolution by
configuration, so streaming deltas do not rescan the registry.

An unmatched provider uses only the configured protocol's generic request
shape. LC sends no guessed reasoning control, retention switch, vendor-only
sampling extension, or first-party opt-in. This keeps the ordinary chat path
usable even when the reasoning dialect has not been registered. The exact
fallback bodies are:

| Configured protocol | Generic request | Same-route continuation state |
|---|---|---|
| OpenAI Chat Completions | `model`, `messages`, `stream`, standard sampling/limit/stop fields, tools, and standard stream options | Provider-returned plaintext `reasoning_content` can accompany its assistant message only on the exact source Base URL and model. LC never invents a request-level reasoning field. |
| OpenAI Responses | `model`, `input`, `stream`, `store: false`, instructions, standard sampling/limit fields, and tools | Returned Responses output items are replayed unchanged only on the exact source Base URL and model, preserving reasoning/function-call pairing. |
| Anthropic Messages | `model`, normalized `messages`, required `max_tokens`, `stream`, system/sampling/stop fields, and tools | Returned signed, redacted, or plaintext thinking blocks are replayed unchanged only on the exact source Base URL and model. No `thinking` or `output_config` control is invented. |
| Gemini native Interactions | `model`, ordered native `input`, `stream`, `store: false`, optional system/output-limit/stop fields, tools, and structured output; no unregistered thinking controls | Complete returned response groups precede their matching results. An unregistered relay requires the exact source Base URL and model; native signatures and response-local accounting stay with their group. |
| LM Studio native chat | Native chat/input stream shape | The server-owned `previous_response_id` remains provider-managed and unmeasured locally. |

The provider word in a relay URL or model name grants no special behavior.
Same-route replay above is structural preservation of data that exact endpoint
returned, not provider identification. Switching the Base URL or model blocks
unverified continuation state. Retained reasoning whose next-request occupancy
cannot be verified is shown as an unknown contribution, never as a measured
zero. Registering newly verified behavior requires a source change, evidence,
tests, and a release; the embedded database is intentionally not a production
user override.

## 2. Non-negotiable LC invariants

### 2.1 LC retains reasoning

Reasoning returned by a provider is conversation data. LC archives the readable
reasoning and every provider continuation carrier needed to reproduce the
conversation. LC does not compact, summarize, prune, or delete old reasoning as
part of normal history construction.

`lc_tool_history` changes how completed tool calls and results are projected. It
has no authority to remove reasoning, signatures, encrypted items, plaintext
reasoning items, or their accounting. Turning Tool History on or off cannot make
reasoning disappear from the canonical conversation.

A provider may document that it ignores or server-filters a carrier. That is a
provider fact, not an LC deletion policy. LC still retains the original carrier.
The presence of provider-side context-management, clearing, truncation, or
compaction fields in an API schema does not enable those features in LC. They
require a separately approved LC behavior and tests; automatic server filtering
of an unchanged request is a different provider fact.

### 2.2 Preserve provider state exactly

Signed, encrypted, redacted, and structured reasoning must be replayed complete,
unmodified, and in provider order whenever it is eligible for the next request.
Do not splice visible summary text into an opaque carrier. Do not rebuild a
provider block from the display string when the original block exists.

Provider state is scoped to the provider surface that produced it unless the
provider explicitly documents wider portability. A model change does not
authorize reinterpreting an opaque carrier as text or dropping it by default:
when the provider documents model-switch replay, keep passing the original
carrier and let the server accept or filter it. A switch to another provider or
unverified relay must not leak opaque state merely because it uses the same
protocol envelope.

### 2.3 Protocol translation is allowed; model correction is not

LC must translate the same user control into the field shape required by the
selected protocol. Examples are flat `reasoning_effort` in Chat Completions,
`reasoning.effort` in Responses, and `output_config.effort` in Messages. This is
wire-shape translation.

LC must not:

- rewrite one selected effort value to another;
- omit `none` merely to avoid a provider validation error;
- maintain a model-name allowlist or regex gate for effort values;
- infer an effort ceiling from a model name;
- silently promote, demote, or collapse UI rungs;
- invent support because an endpoint is “OpenAI compatible.”

The server is responsible for documented mapping, normalization, defaults, and
validation. If the selected value is invalid, surface the provider error. If a
provider exposes model capability metadata, use that metadata to present valid
choices; do not copy it into a permanent name table. If a protocol does not
define an effort field at all, omit the field because the protocol lacks it—not
because LC guessed what a model accepts.

Legacy budget-only thinking is a different control. A conversion from an LC
effort label to `budget_tokens` is an LC approximation, not pass-through. It
must be model-independent, documented to the user, and used only when current
provider capability metadata says the selected endpoint supports manual budget
thinking but no semantic effort field. A model-name fallback is prohibited.

### 2.4 Unknown is not zero

Zero means that the relevant source explicitly reported or deterministically
contained zero. Missing reasoning usage, an opaque carrier without accounting,
or a stream whose carrier type is not yet known is **unknown**, never zero.

The UI may show a lower bound or a pending/unknown state. It must not present an
exact remaining-context percentage while a known opaque contribution is
unmeasured.

## 3. Four different ledgers

### 3.1 Canonical conversation archive

The archive owns full visible replies, readable reasoning, tool calls and
results, Responses output items, Messages thinking blocks and signatures,
structured `reasoning_details`, and any local replay accounting. It is not a
token ledger and is not filtered by Tool History.

### 3.2 Assistant-turn footer

The bubble footer describes work already consumed while producing that LC
assistant turn. A tool loop can contain multiple provider responses, so the
footer aggregates all of them exactly once.

The compact label is `Turn usage · N reported` when `N` provider responses
reported usage. Provider counts remain provider counts; LC estimates remain
identified as estimates. Reasoning supplied by any provider is labeled
`Reasoning (reported)` in user-facing usage details. Internal metadata may
retain a more precise provider-counter/provider-estimate distinction for
diagnostics, but providers do not receive different UI terminology.

Turn usage is historical cost. It is not the next request’s context occupancy.

### 3.3 Next-request TokenMeter

The TokenMeter predicts the request LC would send next using the currently
selected model, endpoint, tools, system prompt, Tool History setting, and
completed conversation state. It does not include a future user message that
has not been sent.

It counts:

- locally tokenizable text selected for the next request;
- locally tokenizable plaintext reasoning selected for the next request;
- provider-reported reasoning tokens bound to an opaque carrier that survives
  the next-request projection;
- tool definitions, retained tool calls/results, and LC’s documented request
  projections.

It does not substitute a previous response’s `completion_tokens` for the text
that will actually be replayed. It does not count a readable summary a second
time when that summary is only the display form of an opaque reasoning carrier.

When a provider explicitly documents that a field is ignored for the exact
request shape, the meter may exclude it from effective context while LC still
archives it. DeepSeek Chat without `tools` is the current documented example.
Server-side filtering that cannot be predicted from request structure must be
shown as uncertain, not guessed from a model name.

### 3.4 Active-stream overlay

During streaming, terminal provider items and final usage may not exist yet.
The meter must still live-count append-only plaintext output and reasoning with
bounded work, then reconcile to the terminal carrier and provider accounting.

The stream parser must preserve provenance for each reasoning delta:

- plaintext replay text;
- readable summary/display text;
- opaque or encrypted state;
- unknown until a structured item resolves it.

A generic `response.reasoning.delta` event is not enough to classify the text.
The transient live count must be replaced—not added again—when the final item
arrives. Existing bounded overlap/sample accounting remains mandatory so live
counting cannot retokenize an ever-growing field on every delta.

## 4. Carrier classification

| Carrier | Archive and replay | TokenMeter treatment |
|---|---|---|
| Plaintext reasoning (`reasoning_content`, `reasoning.text`, or `content[].reasoning_text`) | Preserve exact text and original structured item when present | Count selected plaintext locally |
| Readable reasoning summary | Preserve for display and replay only when it is part of the provider item | Do not treat it as full reasoning; do not double-count beside opaque state |
| Encrypted/signature-backed reasoning | Preserve opaque bytes and ordered item/block unchanged | Use only response-bound provider-reported reasoning tokens; unknown if unavailable |
| Redacted reasoning | Preserve unchanged; never decode or tokenize the payload | Use bound provider reporting or mark unknown |
| Remote response handle | Preserve only for the provider flow that owns it | Unknown unless the provider supplies an authoritative current-input count |
| Unknown compatible-server structure | Preserve losslessly within bounded schemas | Do not infer plaintext or encryption; mark unknown until structurally resolved |

Classification is structural first and provider-scoped where two providers use
the same shape with different meaning. In particular:

- a non-empty OpenAI Responses `encrypted_content` is opaque;
- a non-empty Responses `content[].reasoning_text` is plaintext only when the
  provider defines it as chain-of-thought rather than a summary;
- OpenRouter `reasoning_details[].type` distinguishes text, summary, and
  encrypted entries;
- a 64-hex MiniMax Messages signature accompanies readable plaintext and is not
  evidence that the readable text itself is encrypted;
- an Anthropic signature is encrypted full reasoning while the visible
  `thinking` field is a summary or empty display form.

## 5. Verified provider and protocol matrix

### 5.1 OpenAI

| Surface | Verified contract | LC consequence |
|---|---|---|
| Chat Completions | Uses flat `reasoning_effort`. OpenAI documents cross-turn CoT passing as a Responses capability, not a Chat Completions capability. | Send the selected effort unchanged. Do not invent a replay carrier from visible text. |
| Responses | Reasoning is an output item. `reasoning.encrypted_content` enables stateless/manual multi-turn replay. Summary events and summary parts are readable display output, separate from the opaque carrier. | With `store: false`, preserve and replay eligible output items. Bind `output_tokens_details.reasoning_tokens` to the exact opaque item group. |

Sources: [Responses create](https://developers.openai.com/api/reference/cli/resources/responses/methods/create),
[model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2).
Verified 2026-09-02.

### 5.2 Anthropic

| Surface | Verified contract | LC consequence |
|---|---|---|
| Messages | A `thinking` block contains readable summarized thinking or an empty display field plus a `signature` containing encrypted full reasoning. `thinking_delta` streams display text; `signature_delta` closes the block. | Preserve every block and signature unchanged. Count visible text only as display text; use provider reasoning usage for opaque occupancy. |
| Tool continuation and model switches | Thinking blocks within a tool-use turn are required. Across completed turns Anthropic recommends passing everything. It also says to keep passing blocks unchanged when switching Claude models; the API decides which blocks the target can read and filters the rest. | LC sends all preserved blocks on the same verified Anthropic provider surface. Tool History cannot remove them. The meter must not subtract them from a model-name guess about server filtering. |
| Capability discovery | `GET /v1/models` returns thinking-type and effort-level capability data. | Prefer live capability metadata. Do not maintain parallel model-name capability tables. |

Sources: [thinking](https://platform.claude.com/docs/en/build-with-claude/thinking),
[streaming](https://platform.claude.com/docs/en/build-with-claude/streaming),
[Models API](https://platform.claude.com/docs/en/api/models). Verified 2026-09-02.

### 5.3 DeepSeek

| Surface | Verified contract | LC consequence |
|---|---|---|
| Chat Completions | `reasoning_content` is plaintext CoT. If the request carries `tools`, reasoning from **all previous turns** must be passed, including turns without a tool call. Without `tools`, historical reasoning is ignored even if sent. | Tools-present projection replays all prior reasoning. No-tools projection may exclude it from effective-context accounting while retaining it in the archive. |
| Responses | `response.reasoning_text.delta` is incremental chain-of-thought. A replayed reasoning input item uses plaintext content; `summary` and `encrypted_content` are unsupported **inside that input item**. The top-level `reasoning.summary` request option is accepted but generates no summary. The public page does not state Chat's tools-dependent history filtering rule for Responses. | Preserve/count plaintext reasoning items across history unless a Responses-specific contract proves they are ignored. Strip incompatible fields from a replayed item; do not confuse that with the accepted top-level display option. |
| Anthropic-compatible Messages | `thinking` and `output_config.effort` are supported; `budget_tokens` is ignored and `redacted_thinking` is unsupported. The public compatibility table does not define an encrypted carrier. | Preserve returned thinking structurally and count readable plaintext. Do not infer Anthropic encryption from the Messages envelope. |

Sources: [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/),
[Responses](https://api-docs.deepseek.com/guides/responses_api/),
[Anthropic compatibility](https://api-docs.deepseek.com/guides/anthropic_api/).
Verified 2026-09-02.

### 5.4 MiniMax

| Surface | Verified contract | LC consequence |
|---|---|---|
| Chat Completions | `reasoning_split: true` exposes plaintext in `reasoning_content` and structured `reasoning_details`; the documented stream uses cumulative snapshots. Complete reasoning must be preserved for multi-turn tool use. | Compute append suffixes for live display, but preserve the complete final structure for replay. |
| Anthropic-compatible Messages | Returns readable `thinking` beside a fixed-size 64-hex signature. | Treat thinking as plaintext plus replay-integrity state, not Anthropic encrypted reasoning. Preserve both unchanged. |
| Responses | Native `/v1/responses` support is now documented. Non-`none` compatibility efforts enable M3 reasoning but do not tune its depth. The public page does not currently specify the reasoning item’s text/encryption fields or reasoning SSE event subtype. | Send the selected effort unchanged. Preserve final reasoning items structurally. Keep live carrier classification unknown until the returned item resolves it; do not infer from the endpoint name. |

Sources: [OpenAI SDK and Chat behavior](https://platform.minimax.io/docs/api-reference/text-openai-api),
[Messages API](https://platform.minimax.io/docs/api-reference/text-chat-anthropic),
[Responses](https://platform.minimax.io/docs/api-reference/responses-create),
[documentation index](https://platform.minimax.io/docs/llms.txt). Verified
2026-09-02. The Responses page appeared in the current index and supersedes the
earlier assumption that MiniMax Responses existed only through relays.

### 5.5 Kimi / Moonshot AI

Moonshot exposes two separate first-party products. Their credentials, Base
URLs, model IDs, defaults, and protocol surfaces are not interchangeable.

| Surface | Verified contract | LC consequence |
|---|---|---|
| Kimi Open Platform Chat Completions (`api.moonshot.ai/v1`) | The platform primarily exposes Chat Completions. Thinking is returned and streamed as plaintext `reasoning_content`, before answer `content`. The field counts toward both the output limit and token consumption. The public usage examples report inclusive `completion_tokens`, not a separate documented reasoning-token counter. | Archive and locally count the selected plaintext. Do not infer encryption or substitute the inclusive completion total for next-request occupancy. No official Responses or Messages endpoint is currently documented for this product. |
| Open Platform controls | `kimi-k3` always reasons, always preserves thinking, and accepts flat `reasoning_effort: low | high | max` (default `max`); it does not accept the K2 `thinking` object. `kimi-k2.7-code` always reasons and preserves all historical reasoning but does not support `reasoning_effort`. `kimi-k2.6` uses `thinking.type` and `thinking.keep`, where `keep: "all"` enables full historical preservation. | Select the documented wire shape from explicit provider/model capability data, not a regex. Forward a selected effort unchanged. LC's retain-reasoning policy uses `keep: "all"` when that field exists and sends every historical `reasoning_content` selected by the provider contract. |
| Tool loops and history | Within one multi-step tool task, all reasoning content must be returned with the complete assistant message. K3 and K2.7 require complete historical reasoning across turns. K2.6 ignores older-turn reasoning by default but preserves it when `thinking.keep` is `"all"`; preserved reasoning continues to occupy and be billed in the context window. | Tool History cannot remove the field. The request projection and TokenMeter must include the same complete plaintext history whenever preservation is active. Provider-documented ignore behavior may change effective accounting, but never the archive. |
| Kimi Code OpenAI-compatible Chat (`api.kimi.com/coding/v1`) | This is a separate membership API with different model IDs. K3 accepts `low`, `high`, and `max` and the server documents its own aliases/mapping for other effort labels; the default is `high`. Disabling thinking routes K3/K2.7 requests to K2.6. | Send the user's selected effort unchanged and let the server map or reject it. Do not copy the published mapping into LC. Preserve returned plaintext `reasoning_content` exactly. |
| Kimi Code Anthropic-compatible Messages (`api.kimi.com/coding/`) | The product documents `/v1/messages`, K3 effort translation, and preserved Anthropic thinking blocks. It does not publish a complete raw response schema proving whether a returned signature is encrypted, integrity-only, absent, or separately token-accounted. | Treat it as a distinct verified provider surface. Preserve blocks structurally, but do not import first-party Anthropic encryption/accounting semantics from the shared envelope. A sanitized live fixture is required before assigning a more specific carrier class. |

Sources: [Open Platform thinking models](https://platform.kimi.ai/docs/guide/use-thinking-models),
[reasoning effort](https://platform.kimi.ai/docs/guide/use-reasoning-effort),
[Chat reference](https://platform.kimi.ai/docs/api/chat),
[Kimi Code models](https://www.kimi.com/code/docs/en/kimi-code/models.html),
and [Kimi Code overview](https://www.kimi.com/code/docs/en/). Verified
2026-09-02.

### 5.6 OpenRouter

| Surface | Verified contract | LC consequence |
|---|---|---|
| Chat Completions | `reasoning_details` has explicit `reasoning.text`, `reasoning.summary`, and `reasoning.encrypted` variants. The complete consecutive sequence must be passed back unchanged. | Classify each detail by type. Live-count text only; never tokenize encrypted data or treat a summary as raw reasoning. |
| Responses | Streams `response.reasoning.delta`; complete item snapshots are the structured authority. The generic event does not identify text versus summary/encrypted upstream state. | Display the delta, but delay exact replay classification until the item structure is known. Replace snapshots by ID and reconcile the live overlay. |
| Messages and routed models | OpenRouter translates across upstream providers. A routed model’s name does not prove which reasoning carrier the relay returned. | Use returned structure, not upstream-model assumptions. Preserve relay blocks/details unchanged. |

Sources: [reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens),
[Responses streaming](https://openrouter.ai/docs/agent-sdk/call-model/streaming).
Verified 2026-09-02.

### 5.7 Z.AI / GLM

| Surface | Verified contract | LC consequence |
|---|---|---|
| Chat Completions | Returns plaintext `reasoning_content`. `thinking.clear_thinking` defaults to `true`; `false` preserves complete, unmodified, ordered historical reasoning. The server documents its own effort mapping and validation. | LC’s retain-reasoning policy requires `clear_thinking: false` and full historical reasoning. Forward effort unchanged and let Z.AI map or reject it. |
| GLM 5.3 protocols | The model page lists Chat Completions, Responses, and Anthropic Messages endpoints. GLM 5.3 accepts `low`, `high`, and `max`, always reasons, and rejects disabling reasoning. | Support all three configured protocols. Do not gate effort by model name or silently replace/omit `none`; surface the provider error. |
| GLM Responses/Messages carrier | The model page verifies protocol support but does not specify the exact reasoning SSE/item/block carrier for these compatibility endpoints. | Preserve and classify the returned structure. A sanitized live fixture is required before provider-specific parsing or accounting rules are added. |

Sources: [GLM 5.3](https://docs.z.ai/guides/llm/glm-5.3#model-api),
[Chat Completions](https://docs.z.ai/api-reference/llm/chat-completion).
Verified 2026-09-02.

### 5.8 Alibaba Cloud Model Studio / QwenCloud

QwenCloud is a separate Qwen product, website, account, and API-key surface.
Its current first-party quickstart and API references nevertheless use the same
international DashScope wire roots as Alibaba Cloud Model Studio:
`https://dashscope-intl.aliyuncs.com/compatible-mode/v1` for OpenAI-compatible
Chat and Responses, and `https://dashscope-intl.aliyuncs.com/apps/anthropic`
for the Anthropic SDK. The registry therefore names QwenCloud as an additional
product on the shared wire contracts; it does not add duplicate `qwencloud.*`
matches. Credentials are never shared or inferred from that wire equivalence.

| Surface | Verified contract | LC consequence |
|---|---|---|
| Chat Completions | The server documents model-dependent mappings for `reasoning_effort`, plaintext `reasoning_content`, `completion_tokens_details.reasoning_tokens`, and model-specific `preserve_thinking` or `clear_thinking` controls. Reasoning tokens are part of completion tokens. | Forward effort unchanged. Use the advertised retention field only to implement LC’s retain-reasoning policy; do not reproduce server effort mappings or select retention fields by model regex. Live-count plaintext and replace it with terminal provider usage when reported. |
| Responses | `response.reasoning_text.delta` and completed `output[].summary` are reasoning summaries, not plaintext CoT. `output_tokens_details.reasoning_tokens` is part of output tokens. Stored responses can be continued by `previous_response_id` for seven days; the reference does not establish manual replay of summary/output items. | Treat the summary as display-only, not locally tokenizable full reasoning or a manual replay carrier. Treat the response ID as provider-managed remote state; its pre-send occupancy is unknown until authoritative usage arrives. |
| Anthropic-compatible Messages | Thinking is plaintext `content[].thinking`; `content[].signature` is currently documented as always empty. `output_config.effort` is preferred over the deprecated budget. Usage has no separate reasoning count, and the public reference does not fully specify thinking stream deltas or cross-turn replay. | Do not import first-party Claude encryption semantics. Count returned thinking text locally for the live meter, but keep replay and stream behavior unknown until first-party documentation or a sanitized fixture proves them. Forward effort unchanged. |

Sources: [Chat Completions](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions),
[Responses](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-responses),
[QwenCloud introduction](https://docs.qwencloud.com/developer-guides/getting-started/introduction),
[QwenCloud Chat reference](https://docs.qwencloud.com/api-reference/chat/openai-chat),
[QwenCloud Responses reference](https://docs.qwencloud.com/api-reference/chat/openai-responses),
[QwenCloud Messages reference](https://docs.qwencloud.com/api-reference/chat/anthropic),
and [QwenCloud thinking guide](https://docs.qwencloud.com/developer-guides/text-generation/thinking).
Verified 2026-09-02.

### 5.9 Gemini OpenAI compatibility

The compatibility endpoint accepts flat `reasoning_effort` and maps it to each
Gemini model’s native thinking level or budget. It documents model-dependent
disable behavior. LC must pass the selected value unchanged and let the server
map or reject it; LC must not fold `xhigh` or `max` to `high`.

Source: [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai).
Verified 2026-09-02.

### 5.10 LM Studio native and compatible endpoints

LM Studio native chat accepts `reasoning` as `off`, `low`, `medium`, `high`, or
`on`, exposes plaintext reasoning output, and reports
`reasoning_output_tokens`. It can retain remote state through
`previous_response_id`. The native models endpoint may expose allowed reasoning
options; those options outrank model-name inference.

LM Studio also supports OpenAI-compatible Responses with reasoning and prior
response state. A remote response ID is a continuation handle, not locally
tokenizable context. Without an authoritative current-input count, its hidden
occupancy remains unknown.

Sources: [native chat](https://lmstudio.ai/docs/developer/rest/chat),
[Responses](https://lmstudio.ai/docs/developer/openai-compat/responses).
Verified 2026-09-02.

### 5.11 Meta Model API (partially verified)

Three exact first-party contracts cover `https://api.meta.ai`: `meta.chat`
(OpenAI-style Chat Completions, base path `/v1`), `meta.responses`
(OpenAI-style Responses, `/v1`), and `meta.messages` (Anthropic-style
Messages, `/` and `/v1`). Selection is by exact origin, configured base-path
prefix, and protocol only. A Muse model name is not provider evidence: the
OpenCode Zen relay (`https://opencode.ai/zen/v1`) must never inherit a Meta
contract, and neither must lookalike origins such as `foo.meta.ai`.

Every LC effort is sent unchanged, including `none` and `max`. Meta owns
validation: selecting `none` sends the documented disable shape and surfaces
Meta's real result, which for Muse Spark is currently HTTP 400. LC must not
omit the field, remap the effort, or retry the rejection. A first-party
Responses session on 2026-09-03 pins the protocol enum: `max` is rejected as
an unknown variant with the expected list `none`, `minimal`, `low`, `medium`,
`high`, `xhigh`, while `muse-spark-1.3-contributor` rejects `none` at the
model capability level. `minimal` stays a documented wire value only; it is
not an LC effort. Messages authenticates with `Authorization: Bearer` and
sends neither `x-api-key` nor `anthropic-version`; it must not emit `top_k`
or `stop_sequences`.

Responses replays encrypted provider output items with an optional
display-only summary; an empty summary array is valid and keeps the encrypted
item, and the summary member shape `{ type: "summary_text", text }` is pinned
by first-party fixtures. A second first-party Responses session (six turns,
30 encrypted reasoning items in 19 replay groups, 3,888 reasoning tokens)
corroborates subset arithmetic, cached input below input totals, and exact
provider-order replay. Messages replays `thinking` summaries as display-only
text and `redacted_thinking` blocks as the encrypted continuation carrier;
the redacted block shape `{ type: "redacted_thinking", data }` is pinned by a
first-party fixture (28 blocks in 19 groups, 3,654 thinking tokens), while
`thinking.type: "disabled"` and `output_config.effort: "max"` rejections are
pinned as single-attempt surfaces. No `thinking` summary block appears in the
Messages archive, so summary display shape there stays documentation-only, as
does the `thinking.display` request path. Terminal `thinking_tokens` binds to
the opaque block, never to the summary's character count. A recorded provider
block order lets Messages serialize thinking, text, and tool_use in the
returned sequence, with each response owning its own blocks. New rows record
the response ordinal and exact text segments. LC discards stale or malformed
ordering metadata when its text does not equal canonical message content.
Messages cache
composition (whether `input_tokens` already includes
`cache_read_input_tokens`) is unconfirmed pending a repeated-prefix
measurement; reported reads are recorded beside input totals without claiming
additive math. The server count-token endpoints have an exact-contract
transport (`token-count.ts`) wired to TokenMeter preflight for exact Meta
contracts only: a debounced, abortable tracker (`server-token-count.ts`)
measures the adapter-built request, the server total becomes the authoritative
occupancy, and local categories stay clearly labeled as local, with silent
fallback to the local estimate on any failure. The count-endpoint responses
themselves have no live capture yet. The preflight hydrates durable attachments
and applies the same provider-history, Tool History, and Workspace prompt
projection as generation. A future composer message and transient tool image
batches are absent because they are not part of the settled conversation.

Chat Completions has a first-party normalized archive session (seven xhigh
turns, 15,505 historical reasoning tokens staying a subset of completion
usage, cached input below input totals). Archived Chat assistant messages
carry no `reasoning_content` field at all: there is no replayable
private-reasoning carrier, and the historical total contributes zero reasoning
to the next request's context. Raw request/SSE captures are still absent on
all three surfaces, as are with/without-`include` comparisons,
display-omitted behavior, and disabled-reasoning captures for Chat.

All three conversations ran on one server/profile ID while the profile moved
between protocols. ChatView reads the next-request target from the current
mutable profile, so viewing an old conversation after a protocol switch
legitimately shows zero carried reasoning — its carrier cannot replay into a
different protocol's request. Prefer distinct profiles for side-by-side
protocol tests.

All three contracts stay `partially-verified`. `meta.responses` has two
first-party sessions behind it but still lacks raw request/SSE captures, a
with/without-`include` comparison, and a count-endpoint capture. `meta.chat`
and `meta.messages` have normalized archive evidence each but no raw captures.
Zen conversations are relay observations only and must not establish Meta
caching, usage, carrier, error, or availability behavior.

Sources: [reasoning](https://dev.meta.ai/docs/reasoning),
[Responses protocol](https://dev.meta.ai/docs/protocols/responses),
[Messages protocol](https://ai.developer.meta.com/docs/protocols/messages),
[prompt caching](https://dev.meta.ai/docs/prompt-caching),
[token counting](https://dev.meta.ai/docs/token-counting).
Recorded 2026-09-03.

### 5.12 Google native Gemini Interactions

`google.gemini-interactions` resolves only on the exact Google `/v1beta` API
root and `gemini-interactions` protocol. The native adapter appends
`/interactions`; the adjacent OpenAI compatibility path is a different surface.
The contract targets `gemini-3.8-flash` first and includes exact documented
2.5 model records. Its status remains **partially verified**: local tests are
documentation projections, not live provider captures.

LC sends `store: false` and complete ordered response steps. Each native response
group precedes its matching function results, including inside a merged bubble
with several tool rounds. Tool History does not compact these exchanges.
Thought signatures are opaque replay state; visible summaries are display-only.
A partial response or a thought without its signature cannot be replayed
automatically. Google owns filtering on a same-surface model switch; an
unregistered relay requires the exact source root and model. Retained native
steps can replay after a Google model switch, but their effective thought
occupancy remains unknown because the provider may filter them.

`gemini_interactions` colocates raw response-local usage and its thought-step
index locator with the complete replay group. The shared projection counts
reported thought usage once only when that signed group and locator survive.
Missing or stale accounting makes the meter a lower bound. Summary length and
the assistant footer's aggregate never substitute for hidden reasoning.

Native `total_output_tokens` excludes `total_thought_tokens`; normalized output
adds them. Preserve a reported `total_tokens`, and do not add cache or tool-use
counters. Missing components retain field-level `tokenCoverage`, including
through persistence and turn aggregation. The selected effort goes unchanged
to `generation_config.thinking_level`; `thinking_summaries: auto` controls display.
Turning off LC's effort override omits the effort field and leaves the model's
default thinking policy in effect. Native sampling controls are unavailable.

Sources: [REST schema](https://ai.google.dev/api/interactions-api),
[thinking](https://ai.google.dev/gemini-api/docs/thinking),
[streaming](https://ai.google.dev/gemini-api/docs/streaming), and
[function calling](https://ai.google.dev/api/interactions-api#CreateInteraction-function_calling).
Recorded 2026-09-04. See [implementation](./note-gemini-rest.md) and its
[recorded validation and remaining acceptance work](./note-gemini-rest.md#verification-boundary).

## 6. Effort dispatch table

This table defines wire shape, not supported model values.

| Configured protocol/dialect | Field shape | Value rule |
|---|---|---|
| OpenAI-style Chat Completions | `reasoning_effort` | Forward selected value unchanged |
| Provider Chat dialect with a separate enable switch | Provider-documented enable switch plus `reasoning_effort` when the endpoint schema defines it | Translate on/off shape; forward effort unchanged |
| OpenAI Responses | `reasoning.effort` | Forward selected value unchanged |
| Anthropic Messages adaptive thinking | `thinking.type` plus `output_config.effort` | Translate mode shape; forward effort unchanged |
| Anthropic Messages manual budget-only thinking | `thinking.type: enabled` plus `budget_tokens` | Use live capability metadata; any fallback budget is an explicit LC approximation, never a model-name map |
| MiniMax Chat/Messages | Provider-documented `thinking.type` | This is enable/disable, not an effort remap |
| LM Studio native | Native `reasoning` scalar selected from advertised options | Use server capability metadata; do not infer from model name |
| Gemini native Interactions | `generation_config.thinking_level` | Forward selected value unchanged; disabling LC's override omits the field |
| Meta Messages disable | `thinking.type: disabled`, no effort value | Send the documented disable shape; surface the provider result unchanged |

Endpoint detection may choose a documented wire dialect. It must not choose an
effort value. Prefer explicit server-profile capability/dialect data over host
substrings. Host predicates used for credentials or first-party-only headers
are a separate security boundary and do not justify model capability guesses.

## 7. Request-history rules

1. Build the canonical conversation history without deleting reasoning.
2. Apply Tool History only to completed call/result representation.
3. Select provider-native replay state within its verified provider boundary,
   using recorded endpoint/model provenance for identity and diagnostics—not as
   an automatic same-model retention gate.
4. Apply only provider-documented request-structure rules, such as DeepSeek’s
   tools-present behavior or Z.AI’s explicit preserved-thinking flag.
5. Count the same projection the adapter will serialize.
6. If the provider performs an unobservable server-side transformation, retain
   the carrier and mark the meter uncertain instead of guessing.

The adapter and TokenMeter must consume one shared pure projection. A live meter
overlay may add transient active-stream text, but it cannot change settled
replay selection.

## 8. Streaming and performance requirements

- Preserve the original event subtype and item ID at the adapter boundary.
- Do not merge plaintext, summary, and unknown reasoning deltas into an
  untyped accumulator.
- Count append-only live text with the existing bounded overlap/sample method.
- Never tokenize encrypted, redacted, signature, or unknown opaque payloads.
- Reconcile once at item completion or stream termination.
- A completed item replaces transient accounting for the same item; it does not
  add a second copy.
- Tool-loop subresponses remain response-local until the turn accumulator adds
  them exactly once.
- Large live fields must retain the documented tokenizer and render bounds in
  `architecture.md`.

## 9. Required regression coverage

Any reasoning-accounting change must cover, as applicable:

- every supported protocol surface, not only the first-party endpoint;
- plaintext, summary, encrypted, redacted, signed, remote-handle, and unknown
  carrier classes;
- reasoning-only, answer-only, and interleaved tool streams;
- cumulative versus append-only streaming deltas;
- tool-present and no-tools history projection;
- Tool History on and off with identical reasoning retention;
- multiple provider responses in one assistant turn;
- live count, terminal reconciliation, abort, disconnect, and missing usage;
- no double counting when terminal structure replaces the live overlay;
- bounded tokenizer input for a very large reasoning stream;
- archive/Dexie round trip of every provider continuation carrier;
- exact effort pass-through, including an unsupported value that must reach the
  provider/error boundary rather than being rewritten locally.

Unit fixtures prove parser and projection behavior. They do not prove that a
live endpoint currently accepts a field. Record live verification separately
and sanitize it into a durable fixture when it establishes a new wire shape.

## 10. Current implementation deviations

These are known defects or unresolved implementation gaps as of 2026-09-02.
They are not approved exceptions.

| Area | Current deviation | Required direction |
|---|---|---|
| Alibaba Chat retention controls | The contract records capability-driven `preserve_thinking` / `clear_thinking`, but current model metadata does not expose which field a selected model supports, so LC sends neither. | Consume an explicit server capability or exact model contract; never guess from a model regex. |
| Anthropic Messages | Model-name parsing chooses thinking mode, effort support, display behavior, disable behavior, and rewrites `xhigh` to `max`. | Consume Models API capability metadata; remove model-name effort gates/remaps. Keep only a documented capability-driven legacy budget fallback. |
| Kimi Code Messages | Kimi model IDs fall through Claude-oriented Anthropic model-name heuristics, while no durable live fixture establishes the exact request, returned block carrier, or usage shape. | Add sanitized OpenAI-compatible and Messages fixtures from the distinct Kimi Code endpoint. Use explicit capability/profile data and structural carrier classification; never infer Anthropic encryption from the envelope. |
| Responses streaming | `reasoning_text`, `reasoning_summary_text`, and generic OpenRouter reasoning deltas share one untyped accumulator. | Preserve subtype/provenance and reconcile against final structured items. |
| Responses request options | `summary: auto` is sent generically even though compatible providers assign different semantics or do not document the field. | Send provider/protocol-supported display options only; do not use one option to infer carrier type. |
| Responses remote handles | Contracts can identify a `remote-handle` continuation surface, but LC does not yet persist a generic Responses response ID or send `previous_response_id`; TokenMeter therefore reports remote-state occupancy as unknown. | Add typed response-ID provenance and exact-origin replay before enabling the handle. |
| Provider-contract adoption | Request controls and provider-history/TokenMeter projection consume the immutable resolved contract. Anthropic request capability selection and some terminal stream normalization still use legacy adapter predicates listed above. | Move only behavior the contract can express; add capability data before removing an indispensable fallback. |
| Meta legacy hostname branches | `isMetaAIEndpoint` and the legacy Meta request branches in the Chat and Messages adapters still exist for direct-call use; the production path resolves `meta.chat` / `meta.responses` / `meta.messages` by exact contract ID. The helper is now exact-origin only. | Remove the branches once direct-call coverage migrates to resolved contracts. |
| Meta Messages cache composition | The contract records `cache_read_input_tokens` beside `input_tokens` without claiming additive math; the repeated-prefix experiment has not run. | Run the count-token/first-request/repeat-request comparison, then pin the composition. |

Remove a row only in the same change that adds focused regression coverage and
updates this document’s verification date. Do not “fix” the documentation to
match a deviation.

## 11. Maintainer checklist

Before merging a reasoning change, answer all of these in the change record:

1. Which exact provider, endpoint, and protocol are affected?
2. Is the claim from a current primary source, a sanitized live capture, or a
   local fallback?
3. Is the returned value plaintext, display summary, encrypted, signed,
   redacted, remote, or unknown?
4. What is archived?
5. What is sent on the next request with Tool History both on and off?
6. What does the TokenMeter count while streaming and after completion?
7. What does the assistant-turn footer report?
8. Is any selected effort value changed, gated, or omitted by LC? If yes, stop:
   that conflicts with §2.3 unless it is a protocol-shape conversion.
9. Does any missing measurement appear as zero? If yes, stop.
10. Are focused tests, the full suite, build, lint, docs sync, and import/test
    registry checks green?
