# Reasoning-only loop detection

LC has a client-side guard for a model that emits reasoning indefinitely. The
guard applies when the model produces no answer and starts no tool call. It is
a streaming guard. It does not judge the quality of the model's reasoning.

The implementation is provider-independent and lives in
[`src/utils/reasoning-loop-detector.ts`](../src/utils/reasoning-loop-detector.ts).
The live integration is in
[`src/modules/chat-pipeline/orchestrator.ts`](../src/modules/chat-pipeline/orchestrator.ts).

## Why this exists

The normal SSE idle watchdog only detects a quiet connection. A model can keep
sending reasoning bytes indefinitely while it repeats the same plan. The
connection remains active, but the assistant makes no progress. The guard
handles this failure mode.

The guard does not replace transport timeout handling, tool-call round limits,
or the user's Stop button:

| Situation | LC behavior |
|---|---|
| No stream bytes within the configured idle window | `disconnected` |
| User presses the owning conversation's Stop control or the stream is externally aborted | `disconnected` |
| User switches conversations | The generation continues in the background. Detector state remains owned by that generation. |
| The model emits visible answer text | Detector is disabled for that provider turn |
| The model begins a tool/function call | Detector is disabled for that provider turn |
| Repeating reasoning-only sequence reaches the threshold | `infinite_reasoning_loop` |

`infinite_reasoning_loop` is an LC-owned finish reason. LC does not send it to the
provider and is not claimed to be an OpenAI, Anthropic, DeepSeek, or LM Studio
finish reason.

## Detection contract

Detection is evaluated independently for each HTTP response/provider turn,
including each re-stream inside a tool loop.

1. The detector observes the first reasoning delta and starts a wall-clock
   grace timer.
2. After 60 seconds of reasoning-only output, the detector arms. Text received
   during the grace period is observation only. It cannot become the loop
   anchor.
3. It normalizes runs of whitespace to one space and captures a fixed 128
   UTF-16-code-unit anchor block as block `001`.
4. It searches the later stream for the exact normalized block `001`. When it
   finds it, the following 128-unit block becomes `002`.
5. It searches for the growing exact sequence `001 + 002`, then captures the
   following block as `003`, and continues through `005`.
6. Capturing `005` is not enough to stop the stream. LC then searches for one
   complete repeat of `001 + 002 + 003 + 004 + 005`.
7. Only after that full five-block sequence repeats does LC abort the internal
   stream reader and finalize the assistant message with
   `finish_reason: "infinite_reasoning_loop"`.

The sequence is exact after whitespace normalization. The detector does not use
embeddings, fuzzy similarity, tokenization, or a model call. Therefore, it
cannot identify a paraphrased or thematic loop. This design keeps the guard
deterministic and inexpensive. It also requires strong evidence before the
guard stops a response.

### State machine

```text
reasoning starts
      |
      v
observe for 60 s -- visible text/refusal --> disabled
      |
      | timer reached
      v
capture 001 -- tool-call activity --------> disabled
      |
      v
001 repeats -> capture 002
      |
      v
001+002 repeats -> capture 003
      |
      v
001+002+003 repeats -> capture 004
      |
      v
001+002+003+004 repeats -> capture 005
      |
      v
001+002+003+004+005 repeats -> abort internal reader
      |
      v
finish infinite_reasoning_loop
```

## Resource behavior

The matcher is incremental. It does not retain or repeatedly scan the full
reasoning transcript:

- after the 60-second grace period, whitespace normalization occurs as deltas
  arrive. Pre-arm text is counted but not normalized because it cannot become
  the loop anchor
- a KMP-style prefix table matches the growing sequence without rescanning the
  transcript
- the retained matching state is bounded by the configured block sequence,
  not by the total response length
- the default maximum pattern is approximately `5 x 128` UTF-16 code units,
  plus small bounded tails and matcher state
- no hash is used, so there is no hash-collision decision path.

SSE chunk boundaries do not affect detection. One or many provider chunks can
contain parts of a block. The detector still matches the same normalized text.

## Stream and tool semantics

The orchestrator owns the detector because it is the layer that sees all
provider adapters and owns message finalization.

Adapters expose an optional `onToolCall()` activity callback in addition to
`onDelta()` and `onReasoning()`:

- Chat Completions reports `tool_calls` deltas
- Responses reports function-call item and argument events
- Anthropic reports `tool_use` blocks and input JSON deltas.

The first visible non-whitespace content, refusal, or tool-call activity
disables detection for the current provider turn. If the detector has fired,
LC does not execute a partial tool call. It finalizes the response with the loop
condition. It does not send partial calls to `runToolLoop()`.

The detector uses an internal `AbortController`. The user's external abort
signal remains separate. Therefore, manual Stop produces `disconnected`, not a
reasoning-loop result.

## Provider coverage

The guard runs at the normalized orchestrator layer across these paths:

| Path | Reasoning observed | Tool activity observed |
|---|---|---|
| OpenAI Chat Completions and compatible APIs | `reasoning_content`, `reasoning`, and provider-specific reasoning details | Chat Completions `tool_calls` deltas |
| OpenAI Responses | reasoning text/summary events and batched reasoning summaries | function-call item and argument events |
| Anthropic Messages | thinking deltas | `tool_use` blocks and input JSON deltas |
| LM Studio native REST | native reasoning deltas | Native REST is deliberately used only without tools |

DeepSeek request mapping is unchanged. Its `thinking` and
`reasoning_effort` fields, reasoning-content passback for tool turns, and tool
call protocol continue to work as before. The guard only observes normalized
stream activity and can stop a confirmed reasoning-only loop.

## Finish metadata

When the guard fires, LC stores:

```typescript
message.meta.finish_reason === 'infinite_reasoning_loop'
message.meta.error_message ===
  'LC stopped the stream after detecting a repeating reasoning-only loop.'
```

The provider's finish reason, when available, remains separate in
`provider_finish_reason`. The UI renders the LC-owned status as
`reasoning loop`.

## Testing and tuning

The detector has an offline, self-contained test fixture in
[`src/utils/reasoning-loop-detector.test.ts`](../src/utils/reasoning-loop-detector.test.ts).
It generates a long repeated reasoning stream in memory. It replays the stream
with different artificial chunk sizes. It verifies reset behavior for visible
text, tool activity, and whitespace boundaries. It does not use a captured log
file.

Adapter tests also verify that Chat Completions and Responses expose tool
activity before the final argument/event arrives.

Run the relevant checks with:

```text
npm test
npx tsc -p tsconfig.app.json --noEmit
```

The defaults are deliberately conservative. If they are changed, update the
contract above and the standalone tests together:

- `armAfterMs`: reasoning-only grace period. The default is `60_000`.
- `blockSize`: normalized block length. The default is `128`.
- `requiredBlocks`: number of blocks established before the confirmation
  repeat. The default is `5`.
