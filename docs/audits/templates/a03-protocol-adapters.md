# A03 — Protocol adapters

**Template code:** `A03` · **Version:** 2.0 · **Status:** Active

> Codes are stable identifiers. Never reuse a code, and never reassign one.
> Record `A03 v2.0` in the audit that uses this template. A major version change
> means that the invariants or the matrix changed. Audits that ran against
> different majors are not comparable.

**Siblings:** [`a04-streaming-and-turn-lifecycle.md`](./a04-streaming-and-turn-lifecycle.md)
owns live overlays, terminal settlement, and turn aggregation.
[`a05-state-and-persistence.md`](./a05-state-and-persistence.md) owns durable
round trips. [`a06-cpu-and-responsiveness.md`](./a06-cpu-and-responsiveness.md)
owns hot-path cost. [`a08-build-and-runtime-parity.md`](./a08-build-and-runtime-parity.md)
owns release-artifact embedding. [`a14-profile-model-and-credential-lifecycle.md`](./a14-profile-model-and-credential-lifecycle.md)
owns the profile inputs and immutable execution snapshot used for resolution.

---

## Scope

**In.** `llm-client/provider-contracts.ts`,
`llm-client/provider-contracts.v1.json`, `llm-client/provider-state.ts`,
`chat-pipeline/provider-history-projection.ts`,
`adapters/openai.ts`, `openai-responses.ts`, `anthropic.ts`, `gemini-rest.ts`,
`llm-client/gemini-state.ts`, and
`lmstudio-rest.ts`. This covers exact provider-contract resolution, request
construction, reasoning controls and carriers, history/replay selection, SSE
parsing and provenance, usage normalization, tool-call accumulation, and the
mapping between LC's domain messages and each wire format.

**Out.** Live/terminal orchestration and UI ledgers
(`a04-streaming-and-turn-lifecycle.md`). Tool semantics
(`a01-tool-surface-and-contracts.md`). Persistence
(`a05-state-and-persistence.md`). Profile/model discovery and generic
`models.dev` metadata (`a14-profile-model-and-credential-lifecycle.md`).

## Invariants

1. **One adapter serves a whole protocol family.** The Anthropic adapter also
   serves LM Studio, DeepSeek, MiniMax, Alibaba MaaS, and OpenRouter. The
   Responses adapter also serves LM Studio, QwenCloud, and OpenRouter. The Chat
   Completions adapter serves nearly everything else, including OpenRouter and
   Google's Gemini compatibility endpoint. A change that is correct only for the
   first-party API is a defect for the rest. Vendor behavior needs a predicate
   such as `isAnthropicOwnApi()`.

   **Derive this list from the repository, not from this template.** The server
   that LC exercises but nobody wrote down here is the one whose divergence gets
   missed. Reconcile configured protocol surfaces, the cache-observability
   matrix, and `provider-contracts.v1.json`. Existing adapter predicates are
   implementation under audit, not contract authority. An earlier inventory
   omitted OpenRouter from all three families, and the adapter turned out to
   drop its entire Responses text stream.
2. **A compatible server that omits an optional field keeps working exactly as
   before.** See [standing constraint 7](../../README.md#standing-product-constraints).
3. **Round-trip fidelity.** The path from domain message to wire, to response,
   and back to domain message preserves role order, tool pairing, reasoning, and
   provider replay items.
4. **Anthropic alternation is LC's normalization, not Anthropic's rule.**
   Array-content messages merge into the preceding same-role message.
   Anthropic's own API *combines* consecutive same-role turns instead of
   rejecting them: "Consecutive `user` or `assistant` turns in your request will
   be combined into a single turn".

   Verifying this invariant against `api.anthropic.com` alone will therefore
   make the merge look removable. It is not removable. The merge exists for the
   stricter Anthropic-compatible servers on the same adapter, and for
   `tool_result`-first ordering.
5. **Usage normalization keeps provider reports distinct from LC estimates.** It
   also keeps an explicit zero distinct from an absent value. See
   [`cache-observability.md`](../../cache-observability.md) §2.
6. **Terminal usage is read from the event that carries it.** An unusable
   restatement never erases a good earlier value.
7. **No adapter injects a cache, routing, or session directive** as a side
   effect of diagnostics. See constraint 6.
8. **Provider identity is exact and wire-scoped.** A built-in contract resolves
   from configured protocol plus exact URL origin and a declared exact path or
   path prefix. An exact model record can refine that contract but cannot select
   the provider.
   Model-name substrings, regexes, case folding, and familiar envelope shapes
   cannot make an unregistered relay inherit a first-party contract. Separately
   sold products on an identical wire boundary use `additional_products`, not
   ambiguous duplicate matches.
9. **The verified registry is immutable application code.** The strict v1 JSON
   is the development source of truth, is statically embedded into the LC
   bundle, and is validated and deep-frozen once in memory. Production does not
   fetch it, load an app-data override, or ship it as a standalone public JSON
   asset. `models-cache.json` remains generic enrichment and cannot acquire
   request, carrier, replay, stream, or usage authority.
10. **Reasoning retention and replay are structural.** LC archives every
    provider-returned reasoning carrier independently of Tool History.
    Plaintext, summaries, encrypted/signed/redacted state, provider output
    items, and remote handles retain their distinct meanings. Eligible opaque
    state is replayed complete, unchanged, ordered, and only within its verified
    provider boundary. A provider-side filter is not an LC deletion rule, and
    an unknown structure is preserved and marked unknown rather than guessed.
11. **LC translates field shape, not provider policy.** A selected semantic
    effort is forwarded unchanged in the field defined by the resolved
    protocol. LC does not clamp, fold, promote, demote, silently omit, or gate
    it by model name. Capability metadata may present supported choices; the
    server still maps or rejects them. Provider-documented retention controls
    are selected only from exact contract/capability data.
12. **Accounting describes the wire without inventing occupancy.** Each
    contract identifies usage paths and whether reasoning is a subset of output,
    separate from output, inclusive but undifferentiated, or unreported.
    Response-bound reported reasoning can account only for its surviving opaque
    carrier group. Plaintext selected for the next request is counted locally;
    summaries are not treated as full chain of thought; remote state stays
    unknown without an authoritative current-input count. Missing is unknown,
    never zero, while an explicit reported zero remains zero.
13. **Reasoning stream provenance survives normalization.** Similar SSE names
    across compatible providers do not prove plaintext, summary, or encryption.
    The adapter retains event subtype, item/block identity, delta semantics, and
    terminal structure so A04 can replace—not add—the transient live overlay.
    A generic parser may accept a family union, but it cannot assign one
    provider's semantics to every event in that union.

## Check matrix

| Axis | Required variations |
|---|---|
| Envelope | Chat Completions, Responses, Anthropic Messages, Gemini Interactions REST, LM Studio REST |
| Server per envelope | At least two per adapter: one first-party and one compatible. This axis is what finds family bugs. Where an envelope has only one implementation, record it as a template limitation instead of counting the cell closed. LM Studio REST is its own protocol |
| Contract resolution | Exact origin/path/protocol matches, exact-path versus prefix records, longest declared path, exact model override, unknown model, unregistered relay, lookalike domain, provider name in a path, and two commercial products sharing one wire contract. A model ID never selects a provider |
| Registry integrity | Strict schema failure, duplicate source/contract/product, ambiguous match, missing evidence, non-exact model selector, embedded singleton identity, frozen nested values, absence from `public/`, and no standalone production JSON |
| Boundary predicates | First-party-only credentials or headers classify a parsed hostname. Exercise a lookalike registrable domain and the name inside a path segment. These security boundaries do not authorize effort/model capability guesses |
| Shape-selection predicates | Configured protocol selects the envelope. Provider-specific dialects require an exact registered boundary or explicit capability; an unregistered proxy remains unknown rather than inheriting semantics from its model name |
| Reasoning carrier | Plaintext, readable summary, encrypted, signed plaintext, redacted, remote handle, and structurally unknown; empty and non-empty companion signatures; several carriers in one response |
| History and replay | Ordinary continuation and tool rounds; Tool History on and off; provider/model switch; complete ordered opaque groups; all-prior, same-turn, provider-filtered, output-item, and remote-handle contracts; missing carrier accounting |
| Controls | Chat `reasoning_effort`, Responses `reasoning.effort`, Messages `output_config.effort`, manual budget mode, enable/disable shape, provider retention fields, unsupported value, and live capability metadata. Assert unchanged semantic effort values |
| Stream events | Text, plaintext reasoning, summary/display reasoning, unresolved compatible reasoning, tool calls split across deltas, empty deltas, append and cumulative values, usage before and after finish, error during the stream, and terminal structured items |
| Usage shapes | Absent, explicit zero, malformed, `null`, conflicting aliases, TTL breakdown, router-reported |
| Reasoning accounting | Subset-of-output, separate-from-output, inclusive-undifferentiated, not-reported, unknown; plaintext local count, response-bound opaque report, display-only summary, remote occupancy, and terminal carrier replacement without double counting |
| Message shapes | System handling per envelope, ordinary tool results, tool results with one and several recognized `[LC]` notice prefixes, images, multi-part content, and an assistant message with both text and tool calls |
| Spec divergence | Every place a server deviates from its published spec, and whether that deviation affects LC |

## Domain-specific evidence rules

- **Adapter unit tests cannot validate protocol support.** They assert that LC
  *emits* a shape. They never assert that a server *accepts* it. Putting images
  inside tool results passed 14 tests, and two of three live endpoints rejected
  it.
- **A wire-shape change needs a live endpoint per family**, not one vendor.
- **A usage-normalization claim needs the raw envelope.** An archive stores LC's
  normalized result, so it cannot tell you which provider alias produced a
  counter. Use `scripts/probe-cache-live.mjs`, which records the raw field
  names.
- **A provider-contract claim needs dated first-party evidence or a sanitized
  exact-surface fixture.** A model name, search snippet, compatible envelope,
  or another provider's documentation cannot establish carrier, replay,
  stream, or accounting semantics.
- **Compare the request and meter projection.** For every replay claim, capture
  the exact carrier sequence serialized by the adapter and the carrier sequence
  selected for context accounting. Tool History variations must not change
  reasoning eligibility.
- **Partial contracts stay partial.** Unknown replay, stream, or usage fields
  cannot be treated as verified merely because another field on the same
  endpoint is documented.

## Known-load-bearing context

- [`streaming.md`](../../streaming.md#adapter-constraints-proven-against-live-endpoints)
  holds the constraints proven against live endpoints. This includes the
  images-in-tool-results attempt. Do not retry that attempt without per-profile
  capability detection.
- [`cache-observability.md`](../../cache-observability.md) holds the normalized
  usage model and the per-surface verification status.
- [`reasoning-and-token-accounting.md`](../../reasoning-and-token-accounting.md)
  is the normative retention, carrier, effort, replay, and accounting contract.
  Its machine-readable source is
  [`provider-contracts.v1.json`](../../../src/modules/llm-client/provider-contracts.v1.json).
