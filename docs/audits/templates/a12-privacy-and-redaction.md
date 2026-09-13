# A12 — Privacy and redaction

**Template code:** `A12` · **Version:** 1.0 · **Status:** Active

> Codes are stable identifiers. Never reuse a code, and never reassign one.
> Record `A12 v1.0` in the audit that uses this template. A major version change
> means that the invariants or the matrix changed. Audits that ran against
> different majors are not comparable.

---

## Scope

**In.** Everything that can leave the machine, or be handed to another person.
This covers provider requests and vision payloads, search and research queries
and results, support reports, conversation archives, settings export, diagnostic
events, the prefix-digest chain, error messages, and logs. It also covers what
LC *stores*, such as keys, grants, caches, ask-user answers, and model-maintained
to-do snapshots and projections.
It includes Whiteboard retained and working content, explicit provider replay,
Tool History projection, support-report exclusion, conversation archives, and
the two-document Whiteboard handoff package. It includes conversation-keyed
runtime diagnostics, the bounded recent-request projection ring, active session
and phase aggregates, and image-cache batch/byte/generation metrics.

**Out.** Whether a tool may act (`a11-security-and-sandbox.md`).

## Invariants

1. **User data stays local**, unless the user deliberately sends it to a model,
   to a search provider, or to an export destination. See constraint 1.
2. **Support reports are explicit local actions. LC never uploads one.** See
   constraint 2.
3. **Bounded vocabulary only.** Diagnostics carry enumerated codes and bucketed
   numbers. They never carry raw provider payloads, message content, paths,
   hostnames, or credentials.
4. **No durable fingerprint of user content.** The prefix-digest key is
   per-session and randomly generated. LC imports it as non-extractable, and
   never persists or exports it. An unkeyed stable content hash is forbidden,
   precisely because it would be durable.
5. **Provider-reported values stay distinguishable from LC estimates and LC
   inferences, everywhere LC shows them.** See constraint 4.
6. **Every artifact is bounded.** This covers strings, arrays, event sets, and
   the final serialized size. See constraint 8.
7. **Opt-ins are opt-in.** Anything beyond the default report requires an
   explicit user choice, and the report records that the user made it.
8. **Outbound payloads are intentional and minimal.** The provider, vision,
   search, research, export, and tool-result boundaries carry only the data the
   user-selected action requires. Credentials and local diagnostics never
   hitchhike. Cancellation prevents late payload publication.
9. **Whiteboard content is local until an explicit boundary uses it.** LC does
   not inject either board into system prompts or ordinary messages. An
   explicit `lc_whiteboard` read or mutation and its result follow normal
   provider request history. With Tool History off, completed calls retain full
   arguments and board results in replay. With Tool History on, completed turns
   use generic stubs; active-turn calls stay complete.
10. **Whiteboard history retrieval is reference-only.** `lc_tool_history`
    returns the owning turn references for an archived Whiteboard call, not its
    Markdown or mutation arguments, and excludes board text from broad search.
    An unresolved owning call fails closed with empty arguments and redacted
    output. Canonical local history and conversation archives remain complete.
11. **Whiteboard exports disclose only their declared data.** A Whiteboard
    package contains exactly the two documents visible at capture and no
    history, IDs, roots, grants, files, settings, or tool history. A conversation
    archive intentionally includes retained versions and references but omits
    working rows. Support reports and diagnostic events contain neither board
    text nor version IDs.
12. **Concurrency diagnostics remain identity-free outside runtime.** Portable
    reports may include bounded recent request projections, active counts,
    phase counts, and aggregate image-cache counts/bytes. They never include
    conversation IDs, generation IDs, tool-call IDs, titles, prompts, paths,
    pixels, raw endpoints, credentials, or per-owner cache contents. Reading
    metrics has no eviction or cleanup side effect.

## Check matrix

| Axis | Required variations |
|---|---|
| Artifact | Support report, in default form and with each opt-in, with zero/one/three active generations, recent-request projections, and image-cache aggregates. Conversation archive. Whiteboard package. Settings export. Diagnostic ring |
| Content classes | Conversations that contain paths, URLs, credentials pasted as text, tool output, ask-user choices and custom answers, to-do titles, blocker notes, completion evidence, both Whiteboard documents and version IDs, images, and custom skills |
| Forbidden keys | Cache keys, session keys, `prompt_cache_key`, `session_id`, `x-session-id`, digests, and HMAC key material. Assert each one absent from every serialized artifact |
| Bounds | An input large enough to force truncation at every cap. Verify that LC records the truncation |
| Failure modes | Collector failure, an unreadable event buffer, an oversized report. Each must degrade, not leak |
| Surfaces | Settings and Safe Start. Safe Start runs without the store, and must still redact |
| Outbound boundary | Chat completion, explicit Whiteboard read/mutation results, Tool History on and off, Whiteboard and conversation exports, the saved to-do projection added to a later request, ask-user results returned to the model, vision, Brave and SearXNG and Marginalia search, research fetch and synthesis, tool results, open-browser actions, and the cancellation and late-result paths |
| Concurrent identity canaries | Distinct conversation, generation, message, profile, and tool-call IDs; titles, prompts, local paths, endpoint hosts, image bytes, and credentials seeded across three sessions. Assert none appears in serialized default or opted-in support-report bytes while the bounded aggregate counts remain correct |

## Domain-specific evidence rules

- **Assert absence over the serialized bytes**, not over the object. A field
  stripped in the model but present in the JSON is still a leak.
- **Use a hostile fixture.** Use a conversation that contains realistic secrets,
  paths, and hostnames. A clean conversation proves nothing.
- **A redaction claim needs the production collector**, not a hand-built report.
  A test that injects an event into the builder proves nothing about what the
  shipped path emits.
- **Collect while several generations are live and again after cleanup.** This
  proves the recent-request and image-cache seams expose only their allowlisted
  projections and that reading metrics does not mutate either registry.
- **Check the negative too.** Over-redaction that removes a fact the report is
  supposed to carry is also a finding.
- **Inspect all three Whiteboard projections separately.** Assert serialized
  provider bytes with Tool History on and off, `lc_tool_history` retrieval and
  search output, and both export formats. The correct stubbed request does not
  prove reference-only retrieval, and a minimal Whiteboard package does not
  prove that the conversation archive retained canonical history.
- **Use different visible and hidden board values for export.** Select history
  in one pane, keep a live or pending head in the other, and leave unsaved user
  editor text. The two package entries must match the click-time visible sources
  exactly and no hidden value may occur in the ZIP bytes.

## Known-load-bearing context

- [`support-report.md`](../../support-report.md) holds the schema, the privacy
  boundary, the inclusions and exclusions, and the bounds.
- [`cache-observability.md`](../../cache-observability.md) §5 holds the
  keyed-digest design, and states why an unkeyed hash is forbidden.
- [`README.md` § Standing product constraints](../../README.md#standing-product-constraints)
  holds the eight constraints that bind every feature.
- [`support-report.md` § Diagnostic facts have production emitters](../../support-report.md#diagnostic-facts-have-production-emitters)
  states which facts have a shipped emitter, rather than only a schema and a
  test.
