# A06 — CPU and responsiveness

**Template code:** `A06` · **Version:** 1.0 · **Status:** Active

> Codes are stable identifiers. Never reuse a code, and never reassign one.
> Record `A06 v1.0` in the audit that uses this template. A major version change
> means that the invariants or the matrix changed. Audits that ran against
> different majors are not comparable.

**Siblings:** [`a07-memory-and-lifetimes.md`](./a07-memory-and-lifetimes.md) for
retention and cache lifetime. [`a10-overlay-and-input-ownership.md`](./a10-overlay-and-input-ownership.md)
for user scroll ownership.
[`a15-accessibility-and-assistive-tech.md`](./a15-accessibility-and-assistive-tech.md)
for live-region and announcement behavior.
[`a04-streaming-and-turn-lifecycle.md`](./a04-streaming-and-turn-lifecycle.md)
owns live/terminal accounting correctness, while
[`a03-protocol-adapters.md`](./a03-protocol-adapters.md) owns provider carrier
and usage semantics. A06 measures the cost of their selected projection.

---

## Scope

**In.** Anything on the render path or the streaming hot path. This covers
`countTokens`, live token accounting, markdown rendering and chunking, preview
windowing and auto-scroll, rAF batching, virtualization, store selectors and
re-render fan-out, SSE decode, the tool-result formatting path, to-do snapshot
indexing, and the ask-user modal's bounded question and custom-answer rendering.
It includes simultaneous conversation streams, conversation-keyed phase/TPS
subscriptions, Sidebar aggregate/session projections, and navigation while
background generations continue.

**Out.** Retained memory and listener lifetime (sibling). User ownership of
auto-following scroll containers (sibling). Accessibility semantics (sibling).
Bundle size, and differences between dev and packaged builds
([`a08-build-and-runtime-parity.md`](./a08-build-and-runtime-parity.md)).

## Invariants

1. **No unbounded work on untrusted text.** Every function reachable from model
   output or tool output is total, and at worst linear in input size. Two
   whole-app freezes came from violating this. See
   [`architecture.md`](../../architecture.md#token-counting-is-hostile-input-hardened).
2. **An append-only stream does not process its full prefix repeatedly.** A
   linear tokenizer, splitter, or Markdown pass run after every append is
   quadratic over the complete stream. Reuse, sample, or window the settled
   prefix. Reconcile exactly once, at a phase boundary.
3. **The main thread is never blocked past a frame budget** by one synchronous
   unit of work during streaming.
4. **Streaming cost is bounded per frame, not per delta.** rAF batching
   coalesces the work, so a burst of deltas does not become a burst of renders.
5. **Live preview complexity is independent of accumulated stream length.** A
   very long reasoning stream has an explicit Markdown threshold and display
   window. Raw text length must not determine live DOM size or parse cost.
6. **Re-render fan-out is scoped.** A delta, phase, or TPS update in one
   conversation does not re-render unrelated transcripts or the whole Sidebar.
   Aggregate active-count changes may update shared navigation; per-token
   changes may not.
7. **Memoization is keyed on identity that changes.** A memo keyed on a value
   recreated every render is worse than no memo.
8. **Every cost is bounded by an explicit cap**, not by an assumption about
   realistic input.
9. **Parallel streams multiply bounded work, not full-app work.** At the hard
   maximum of three, each stream keeps independent bounded decode, projection,
   token, and persistence work. Foreground navigation and composer input remain
   responsive while siblings stream in the background.

## Check matrix

| Axis | Required variations |
|---|---|
| Input shape | Ordinary prose, a very long message, a long unbroken run with no whitespace, a base64 blob, deeply nested markdown, a huge table, many code blocks |
| Hostile text | Tokenizer sentinels such as `<\|endoftext\|>`, control characters, text that claims to be a prompt |
| Conversation scale | Small, large enough to force a lazy load, many tool results, many attachments |
| Growing field | Paragraph-rich reasoning, one unbroken paragraph, an unfinished fence or table or math block, a 256 KiB fixture stream, and the real archive fields of about 549K and about 895K |
| Streaming rate | Slow token-by-token, fast burst, reasoning-heavy, interleaved tool activity |
| Concurrency | One, two, and three simultaneous streams; foreground and background phase/TPS churn; middle-stream cancellation; streaming while a preview overlay renders; streaming while the token meter tooltip is open; Sidebar expanded and collapsed; and rapid navigation with a fourth editable draft blocked at capacity |
| Tool UI | One and several same-turn to-do lists, repeated updates to one list, the maximum tasks per list, three ask-user questions with five choices each, long labels, and a custom answer that grows from two through more than five lines |
| Phase transition | Live bounded estimate and window, stream completion, exact token reconciliation, reopening completed reasoning through its initial bounded window, repeated 2x expansion, and the explicit full-Markdown endpoint |
| Platform | Dev server and packaged build. The two differ |

## Domain-specific evidence rules

- **Measure before and after.** A performance finding without a number is an
  opinion. Record the input, the metric, and the build.
- **Reproduce the freeze. Do not infer it.** A real archive found both
  tokenizer defects. Reading the code did not.
- **Run the long-reasoning benchmark.** Use
  `node --import tsx scripts/bench-reasoning-stream.mjs`. Record the fixture,
  the prefix sizes, the per-update TokenMeter cost, the cumulative append cost,
  full-prefix splitting against append-aware splitting, and the final
  exact-reconciliation cost.
- **A microbenchmark is not the render path.** If the claim is that the app is
  responsive, the evidence must come from the app.
- **Exercise the bounded live state in the app.** Start the deterministic
  provider with `npm run fixture:providers`. Send `AUDIT_LONG_REASONING` through
  its OpenAI-compatible profile. Measure the overlay while the stream is active.
  Record displayed characters, live Markdown trees, descendant count,
  interaction latency, and the completed-reasoning reopen cost separately.
- **Run `AUDIT_CONCURRENCY` with overlapping streams.** Record frame delay,
  composer input latency, transcript render counts, Sidebar render counts, and
  per-conversation selector notifications at one, two, and three sessions.
  Cancelling the middle stream must reduce only its work.
- **Do not hide terminal costs in the streaming average.** The one-time exact
  token recount and the full settled Markdown render are distinct measurements.
  Both remain residual risks even when progressive streaming is smooth.

## Known-load-bearing context

- `countTokens` bounds unbroken runs, and treats tokenizer sentinels as ordinary
  text. Both guards look removable, and neither is. See
  [`architecture.md`](../../architecture.md#token-counting-is-hostile-input-hardened).
- The TokenMeter counts retained conversation context under Tool History. It
  never replaces stored fields with provider usage for a completed response. See
  [`cache-observability.md`](../../cache-observability.md).
- [`architecture.md`](../../architecture.md#long-reasoning-streaming-is-bounded)
  owns the canonical contract for live accounting, preview windowing, Copy,
  cadence, and settled render. This matrix exercises that contract.
- Live TokenMeter accounting is append-aware and bounded. It counts reasoning
  and visible reply fields simultaneously, then reconciles each complete field
  exactly when the turn becomes idle. Tests must cover bounded live inputs,
  idle exact counts, provider-usage invariance, and policy-complete tool
  categorization.
- The reasoning overlay renders Markdown only while the live field is small.
  Above the live threshold it shows a bounded plain-text tail. Completed fields
  over 6,400 characters also open and reopen through a 6,400-character
  progressive window. Copy remains attached to the full source value.
  Auto-scroll follows the same throttled display cadence, not every store
  update.
- Completed very long reasoning is intentionally not virtualized after the user
  repeatedly expands it to the full value. That explicit endpoint can still
  create a large Markdown DOM. An audit must report that cost, and must not
  treat either bounded initial window as end-to-end proof.
