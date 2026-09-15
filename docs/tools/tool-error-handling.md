# LC — Tools Error Handling Reference

> Updated: 2026-08-31

This document explains how each tool handles wrong paths, bad content, and
invalid parameters. It also assesses whether the model can correct the call.

---

## Pattern: "Echo + Error"

Most tools return the invalid path or input with the error message. The model
can compare its input with the error in one response.

Native failures cross the bridge as structured `ToolError` values. The runner preserves their code, message, path, and allowed-root details in a `ToolResultEnvelope`:

```json
{
  "status": "error",
  "issues": [{
    "code": "path_outside_roots",
    "message": "...",
    "path": "D:\\outside\\file.txt"
  }],
  "warnings": [],
  "metrics": { "durationMs": 4 }
}
```

`aborted` and `timeout` remain distinct statuses. Unknown, invalid, and unexposed calls are rejected before a popup. LC does not parse human-readable error strings to recover authorization scopes.

LC copies at most 16 KiB of UTF-8 validation detail or arbitrary thrown
provider/native text into `issues[].message` and marks a shortened message.
Structured recovery fields remain separate. Unknown operational calls use at
most the first 80 Unicode characters of an untrusted tool name for suggestion
ranking and mark a shortened name in the issue.

Generic orchestration notices are the one exception to field-owned control
text. LC puts a bounded, recognized `[LC]` paragraph before the unchanged
serialized result. These notices report repeated calls, duplicate call IDs,
same-batch read/write contention, or the remaining tool-round limit. Shared
builders and one strict decoder own this framing. Unknown `[LC]` prefixes are
not treated as structured result framing.

`ToolResultIssue` can also carry these optional recovery fields:

```typescript
{
  remedy?: string
  help?: { tool: string, query: string }
  suggestions?: Array<{ tool: string, purpose: string }> // At most 3.
  suggested_call?: Record<string, unknown>               // Existing field.
}
```

Recovery is owned by the typed catalogs for `lc_grep`, `lc_read_file`,
`lc_read_pdf`, and `lc_whiteboard`. The same catalog owns each emitted help
query. A catalog mapping
can reference only a declared stable error code. LC does not select recovery by
parsing a human-readable message.

<!-- lc-tool-guidance-sync:recovery-index:start -->
These tables are checked against the typed guidance catalogs. Edit the catalog first.

| Tool | Stable code | Catalog remedy | Help query |
|---|---|---|---|
| `lc_grep` | `invalid_arguments` | Correct the invalid grep arguments and submit a new call. | `regex` |
| `lc_grep` | `invalid_regex` | Correct the regular expression and submit a new call. | `regex` |
| `lc_grep` | `path_resolution_failed` | Correct or remove the unresolved path, then submit the complete batch again. | — |
| `lc_read_file` | `binary_detected` | Use the dedicated reader for a known image or PDF. Ask the user about other binary data. | `binary files` |
| `lc_read_file` | `encoding_not_utf8` | LC has no conversion tool. Ask the user to convert the file to UTF-8. | — |
| `lc_read_file` | `invalid_arguments` | Correct the invalid read arguments and submit a new call. | `line ranges size limits` |
| `lc_read_file` | `too_large` | Narrow the line range or increase max_bytes within the 32 MiB limit. | `size limits` |
| `lc_read_pdf` | `invalid_arguments` | Correct the named PDF field and submit a new call. | `summary-free reads` |
| `lc_read_pdf` | `invalid_page_selection` | Omit pages to read every page. Otherwise, use one-based pages such as "1-5,12". | `page ranges` |
| `lc_read_pdf` | `invalid_render_selection` | Omit force_render to force no extra pages. Otherwise, use one-based pages such as "1-5,12". | `force render` |
| `lc_read_pdf` | `timeout` | Narrow the page range before you submit a new call. | `truncation budgets` |
| `lc_read_pdf` | `too_large` | Increase max_bytes within 100 MiB or use a smaller PDF. | — |
| `lc_whiteboard` | `aborted` | Read the current boards in a later turn before you continue. | — |
| `lc_whiteboard` | `invalid_arguments` | Send one valid read, replace, or edit input. Do not send fields from another action. | — |
| `lc_whiteboard` | `whiteboard_batch_conflict` | Send one intended whiteboard call in a later batch and wait for its result. | — |
| `lc_whiteboard` | `whiteboard_not_initialized` | Retry once after LC repairs initialization. If it repeats, continue without the board. | — |
| `lc_whiteboard` | `whiteboard_old_string_not_found` | Call lc_whiteboard with action read before you retry the edit. | `exact edit` |
| `lc_whiteboard` | `whiteboard_old_string_not_unique` | Use a longer exact string that occurs once. | `exact edit` |
| `lc_whiteboard` | `whiteboard_read_failed` | Retry the read once. Continue without the board if the read fails again. | — |
| `lc_whiteboard` | `whiteboard_too_large` | Reduce the resulting Markdown to 32 KiB or less. | `size limits` |
| `lc_whiteboard` | `whiteboard_version_missing` | Do not retry the missing ID. Report that the retained version is unavailable. | — |
| `lc_whiteboard` | `whiteboard_write_failed` | Retry after LC storage is available. Read the board before a later exact edit. | — |

| Tool | Automatic signal | Catalog warning |
|---|---|---|
| `lc_grep` | `completeness_unknown` | WARNING: Grep could not determine completeness. Read truncated_reason, then narrow the path or split the searches. |
| `lc_grep` | `replacement_character` | WARNING: A grep match contains U+FFFD. Do not write that match text back. Ask the user to convert the file before a write. |
| `lc_grep` | `truncated` | WARNING: The grep result is incomplete. Read truncated_reason, then narrow the path or split the searches. |
| `lc_read_file` | `replacement_character` | WARNING: Returned text contains U+FFFD. Do not write this text back automatically. Ask the user to verify or convert the source. |
<!-- lc-tool-guidance-sync:recovery-index:end -->

`retryable: true` means that the same arguments can succeed later without a
correction. Every `invalid_arguments` issue uses `retryable: false`. Exact
corrections use a complete `suggested_call`, but LC never executes that call
implicitly. Unknown operational names receive at most three ranked
`suggestions`. LC does not execute the request under a corrected name.

A repeated call with a new call ID still executes. LC compares normalized
arguments and ignores object key order. It assigns repeat counts in the
model-declared order before concurrent workers run. LC adds a same-call notice
to the second and later results. The model can inspect the notice before
another retry.

Duplicate call IDs are different. LC keeps the first declared occurrence and
does not execute later occurrences. Every result produced by the tool round for
the surviving call carries the duplicate-ID notice. This includes a call that
fails before its handler starts.

If interruption leaves the call unanswered, LC instead persists a terminal
`aborted` or `timeout` result for that ID. This repair row does not carry the
duplicate-ID notice.

A replayed ID keeps its earlier result. LC adds a distinct replay notice to
that result and does not execute the replay.

Exposure and grants remain separate. The Workspace master exposes foundation
tools, and category toggles add optional tools. Visible checkmarks only suppress prompts for
their documented scope. File permission popups show canonical directory scopes
as read-only information. The user approves or denies the complete logical call.
The popups do not offer partial per-directory approval.

**File I/O path preflight (complete call).** Before execution, each target path
must resolve to an absolute path on disk. An empty or non-absolute path rejects
the **complete call** with `path_resolution_failed`. For example, relative
`src/foo.ts` gives `Target path must be absolute: <path>`. This rule applies to
**all ten** File I/O tools. For `lc_list_dir`, `lc_grep`, and `lc_glob_files`, a *missing* path
rejects the whole call the same way (`Target path does not exist or cannot be
resolved: <path>`).

Every other File I/O tool reports a missing path per
entry. A whole-call rejection does not return a `results` array. Fix or remove
the named path, and then send the batch again.


A file grant covers its canonical root and descendants for the same tool.
Overlapping roots are additive per tool: a child grant never broadens to its
parent or siblings, and a child root that lacks a tool does not shadow an
enclosing grant for that tool.

**Bounded loss must be explicit.** A tool can return only a prefix when it
reaches a count, byte, traversal, or time limit. The result then includes a
machine-readable truncation or drop signal. Counts or warning text tell the
model how to recover. A hard rejection returns the applicable limit. Neither
path can silently present a partial result as complete.

For `lc_glob_files`, a traversal error fails the complete call. The error names
the affected path and asks the caller to check access or choose another root.
The tool does not silently skip unreadable directories and report a complete listing.

**Complete results have a serialized byte limit.** The default is 4 MiB of
UTF-8. `lc_read_file` and `lc_web_fetch` use 64 MiB. `lc_run_shell` uses 16 MiB.
The runner measures the exact JSON result after the handler returns.

An oversized result becomes a terminal `result_too_large` issue. The issue
reports the measured bytes and the limit. It returns no partial `data`. The
remedy tells the model to narrow the request or split the work into several
calls.

**A message's remedy must be correct for the named field.** The model uses the
error text to write its next call. Therefore, the remedy affects behavior. If
one validator serves several parameters, it must accept the active field name.
It must write the remedy for that field in every message shape.

Borrowed wording is a defect even when the rejection is correct. A shared range
parser once told callers to omit invalid `force_render` “to read every page.”
That remedy applies to `pages`. Omitting `force_render` does not render extra
pages. Tests that check only the `Invalid "<field>" value:` prefix cannot detect
this defect.

**A message quotes the caller's text, not a derived value.** Derived values can
lose fidelity. One page-range parser printed parsed bounds as `page 1e+30` and
`page Infinity` for long digit sequences. The caller did not send those values.
The model must compare the message with its input to correct the call.

**An optional parameter accepts its own absence.** Omission, `null`, and an
empty or whitespace-only string mean “not supplied.” Each form uses the
documented default. Models sometimes fill every declared optional field.
Rejecting filler teaches a rule that the schema does not contain. The model can
then invent a valid value and request unwanted work. Error rates do not show
this failure because the call succeeds.

Failing closed remains correct for input that could be misread as an
instruction, such as an unparseable page range. An empty value carries no
instruction to misread. The runner applies this rule from the actual wire
schema before path sanitation and validation, including non-string optional
fields that a constrained decoder filled with `""`. The conditional flat
fields of `lc_edit_file` are preserved when flat mode is selected, because an
empty `new_string` is a real deletion rather than absence.
The same preservation applies to `lc_whiteboard.content`, `old_string`, and
`new_string`: empty replace content clears the model board, empty
`new_string` deletes a match, and whitespace can be exact content.
The `lc_run_shell.stdin` field also preserves empty and whitespace-only data
exactly because the child process can assign meaning to every byte.

**A rejection names the rule it enforced.** For a positional, ordered, or
conditional constraint, say the constraint. `lc_apply_patch` reports a
misplaced `*** Move to:` by naming where the header belongs, because calling a
real header "unknown" denies it exists and the caller repeats the same layout.

**An empty collection is not a successful no-op.** The model-facing batch and
collection fields on read, image, PDF, write, list, stat, grep, edit, and todo
tools all require at least one entry. Their validation errors name the field
and say what kind of entry to add. Upper-bound errors likewise give a remedy
true for that collection: filesystem requests can be split, `lc_stat` can be
split at 100 paths, and the complete todo list must be reduced to 20 items.

**Control text uses control fields.** A content field contains only content of
the declared type. LC puts non-blocking recovery guidance in `warning` or
`warnings`. It puts per-item failures in `error` and terminal failures in
`issues`. In particular, image descriptions and PDF summaries do not contain
LC warning prose. Cancellation does not become fetched content or process
output.

---

## Per-Tool Breakdown

### lc_read_file

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| Full file exceeds `max_bytes` | `too_large` issue with the path, `retryable: false`, remedy, and a help query | ✅ Narrow the range or increase the cap. |
| Selected line range exceeds `max_bytes` | `too_large` issue with the path, `retryable: false`, remedy, and a help query | ✅ Narrow the range or increase the cap. |
| Binary detected | `binary_detected` issue with the path and catalog recovery | ✅ Use the dedicated image or PDF reader for a known format. |
| Not valid UTF-8 | Terminal `encoding_not_utf8` issue with the path and `retryable: false` | ⚠️ LC has no conversion tool. Ask the user to convert the file. |
| Path outside roots | `{ path, error: "..." }` (Rust-side) | ✅ Path echoed |
| Non-existent file | `{ path, error: "..." }` (Rust-side) | ✅ Path echoed |
| More than 20 paths | Validation error naming `paths` and the cap | ✅ Split into batches of 20 or fewer. Native direct calls enforce the same cap. |

For a mixed batch, the envelope uses `status: "partial"`. Each failed path owns
its issue and recovery. If every path fails, the envelope uses `status: "error"`
and omits `data`. An `encoding_not_utf8` issue omits `help` and
`suggested_call` because the required conversion is external. LC does not
recommend `iconv` as an available LC action.

**Observed behavior:** LC supplies a correction when one exists. Terminal
encoding failures name the required user action.

---

### lc_read_image

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| File too large or incomplete read | `{ path, error, truncated: false }` | ✅ Path echoed. A size error states the source size and `max_bytes` limit. Increase the limit within 50 MiB or use a smaller source image. LC returns no incomplete image bytes. |
| SVG source | `{ path, error: "svg is vector markup…lc_read_file" }` | ✅ Names the format and the tool that reads it |
| TIFF or ICO source | `{ path, error: "…not supported by this build…" }` | ✅ Names the format instead of calling it undetermined |
| Any other unreadable format | `{ path, error: "image decode failed (…). Supported formats are png, jpeg, gif, webp, and bmp." }` | ✅ Lists what would work |
| Path outside roots | Per-entry error | ✅ Path echoed |
| Non-vision chat model with `analyze:false` | `{ analyzed: false, description: null, warning: "This model does not support vision..." }` | ✅ Retry with `analyze:true` |
| Transient delivery cache miss | The persisted JSON result gets an actionable `warning`; `description` remains null | ✅ Retry with fewer paths, more downscaling, or JPEG encoding |
| Analyze request exceeds 10 paths | `{ truncated: true, total_requested, processed_count: 10, analyzed_count, described_count, dropped_count, warning }` | ✅ Counts distinguish processed, request-admitted, described, and dropped paths. The warning explains how to continue. |
| Image encoding or vision request fails | The affected image gets `error`. LC does not copy the failure into `description`. | ✅ Inspect the named image and correct its input or model configuration. |
| Successful provider body exceeds 1 MiB, non-success detail exceeds 16 KiB, or visible description exceeds 64 KiB UTF-8 | The affected image gets a bounded `error`; `described_count` excludes it. | ✅ Narrow the instruction or select another model. LC returns no partial description. |
| No vision request returns a description | `{ analyzed: false, description: null }` plus per-image errors | ✅ No placeholder is presented as image analysis |
| Any request exceeds 20 paths | Validation error naming `paths` and the cap | ✅ Split into batches of 20 or fewer |
| Undersized image | No LC error. The receiving vision provider can reject an image below its provider-specific minimum dimensions. Rejection aborts the turn in delivery mode. Analyze mode records an error on the affected image. | ⚠️ The minimum depends on the provider. No `lc_read_image` parameter can increase dimensions because `downscale` only shrinks. Enlarge the source image. |

**Observed behavior:** LC supplies a correction for each rejected input. The ⚠️ row is
a provider rejection of input that LC accepts. LC enforces maximum dimensions
of 100 MP and 16,384 px. It does not enforce a minimum because providers have
different limits. LC caches images at module scope. The model sees metadata and
the optional `description` in analyze mode.

**Format detection.** `mime` reports what the decoder actually read, sniffed from the file's magic
bytes. It is not derived from the extension, so a PNG named `.jpg` reports the PNG media type, and
a valid image with no extension reports its real type rather than a generic byte stream.

---

### lc_read_pdf

| Failure or degradation | Response shape | Self-correctable? |
|------------------------|----------------|-------------------|
| Malformed or oversized `pages` expression | `invalid_page_selection` with the failed expression, an omission remedy, and `page ranges` help | ✅ Correct the expression or omit `pages` to read every page. The tool never falls back silently. |
| Malformed or oversized `force_render` expression | `invalid_render_selection` with the failed expression, an omission remedy, and `force render` help | ✅ Correct the expression or omit `force_render` to force no extra pages. LC never substitutes a page automatically. |
| Empty or whitespace `pages` / `force_render` | Treated as omitted: all pages, and no forced render | ✅ Not an error — absence is honored, so a filler value is never needed |
| Selection entirely outside the document | Per-file `error` naming the real page count | ✅ Choose an in-range page |
| PDF exceeds `max_bytes` | Per-file `error` naming its size, effective limit, and 100 MiB hard cap | ✅ Raise `max_bytes` within the cap or use a smaller PDF. Selecting fewer pages does not shrink the input file. |
| Encrypted PDF requires a password | Per-file `error` stating that LC cannot open it | ⚠️ Requires an unlocked copy |
| Invalid/missing/out-of-root PDF | Per-file `path` plus `error`. Normal File I/O authorization runs before native access. | ✅ Correct the path or approve the required canonical directory. |
| Scan at `text_only` | Successful file entry with `has_text_layer: false`, empty text, no summary, and a no-text-layer warning | ✅ Retry with `summarize:true`, `depth:"full"`, and a vision-capable model. This tool does not perform OCR. |
| Successful model summary | `summary` contains only model output. A top-level warning labels it as a paraphrase. The bounded `include_text` recovery pointer appears only when text was not included. | ✅ Use returned text for quotations. |
| `summarize:false` with false or omitted `include_text` | Extracted text is returned automatically, with `summary:null`. No correction or summary-generation warning. | ✅ No retry required. |
| `summarize:false` with `full` or a nonempty `force_render` | `invalid_arguments` before native file access | ✅ Use `text_only` and omit `force_render`, or enable summarization. |
| `full` requested without vision capability | Downgraded `depth: "text_only"` plus warning. No pages rendered. | ✅ Select **Model for image analyze** or use a vision-capable chat model. |
| Render/page/output budget reached | `truncated: true`, per-page `planned_render_reason`/`render_skipped`, and an aggregated warning | ✅ Narrow `pages` or re-call for the skipped pages |
| More than four PDF paths | The first four are admitted. A warning names requested, admitted, and dropped counts. | ✅ Re-issue the remaining paths. |
| Map/reduce sub-agent failure, blank output, or output above 64 KiB UTF-8 | Each request uses the shared deadline, a 4,000-token provider ceiling, and a 64 KiB visible-text limit. Failed chunks warn while usable siblings survive. Failed reduction or no usable chunks yields `summary:null` with failure warnings. LC does not retry at a larger limit. | ✅ Select another configured summary model, narrow `pages`, or use `summarize:false` for extracted text. |
| Complete serialized result exceeds 4 MiB | `result_too_large` replaces the result, including its original warnings. No partial text is returned. | ✅ Narrow `pages` or split the files across calls. |
| Deadline or user Stop | Structured `timeout` or `aborted` terminal status | ✅ Narrow the request or retry. Cancellation is distinct from timeout. |

**Observed behavior:** Results are bounded. Verbatim text stays distinct from
inferred or model-derived material. Rendered page images are transient and are
not stored in the conversation.

`pages` and `force_render` use separate stable error codes because their
omission behavior differs. Generic PDF schema failures keep
`invalid_arguments`. They do not receive page-range help automatically.
All three codes use `retryable: false` because unchanged input cannot succeed.

---

### lc_write_file

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| Target is marked UTF-16 | `{ path, error: "…byte-order mark…" }` | ✅ Writing would store UTF-8 and change the encoding. Nothing is written |
| `mode: "create"` + file exists | `{ path, bytes_written: 0, error: "already exists: D:\\...\\file.txt", mode: "create" }` | ✅ Path + full path in error |
| `expected_sha256` mismatch | `{ path, bytes_written: 0, error: "expected_sha256 mismatch: expected …, got …. File was modified concurrently." }` | ✅ Both hashes shown. Read the file again and retry. |
| `expected_sha256` on missing file, `mode: "append"` | `{ path, error: "expected_sha256 provided but file does not exist" }` | ✅ Names the contradiction |
| Empty or whitespace `expected_sha256` | Treated as omitted: write proceeds without optimistic concurrency check | ✅ Not an error — absence is honored |
| Current content unreadable during `expected_sha256` check | `{ path, error: "could not read current content to verify expected_sha256: …" }` | ✅ Fails closed — no write occurs |
| Path outside roots | `{ path, error: "..." }` (Rust-side) | ✅ Path echoed |
| Disk full / I/O error | `{ path, error: "..." }` | ✅ Path echoed |

**Observed behavior:** The "already exists" error includes the full absolute path.

**Lost-update protection.** A write that carries `expected_sha256` (from the `sha256` in a prior `lc_read_file` result) reports a file changed before LC acquired its native mutation lock instead of clobbering it. This is content-identity rather than path spelling, so aliases do not defeat the comparison. Arbitrary external editors do not honor LC's lock, so the check is not an OS-atomic compare-and-swap against a write occurring inside LC's native critical section.

---

### lc_list_dir

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| Path outside allowed roots | `{ path, error: "..." }` (Rust-side) | ✅ Path echoed, error from `resolve_under_roots` |
| Non-existent directory | Complete-call `path_resolution_failed` before execution. See "File I/O path pre-flight" above. No `results` array, and valid siblings do not run. | ✅ Path echoed. Fix or remove it, and send the call again. |
| Non-absolute or empty path | Complete-call `path_resolution_failed` (`Target path must be absolute: <path>`) before execution | ✅ Path echoed. Make it absolute and retry. |
| Pattern matches nothing | `{ path, entries: [], truncated: false }` | ✅ Expected behavior |
| Empty or whitespace `pattern` | Treated as omitted: lists all directory entries without pattern filter | ✅ Not an error — absence is honored |
| More entries than the effective limit | `{ path, entries: [...], truncated: true }` | ✅ Partial listing is explicit. `max_entries` defaults to 1000 and cannot exceed 5000. |

**Observed behavior:** `resolve_under_roots` returns the rejected path and the
reason for an out-of-root path.

---

### lc_stat

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| Non-existent file | `{ path, exists: false }` | ✅ Clear — no `is_file`/`is_dir`/`size_bytes` keys present |
| Path outside roots | `{ path, exists: false, error: "path_outside_roots: ..." }` | ✅ Structured error — model sees the path and reason |
| Empty `paths` | Validation error naming `paths` | ✅ Add at least one path and retry |
| Too many paths (>100) | Zod validation error in the model path. Native `too_large` error on direct invocation. | ✅ Split into batches of 100 or fewer paths. |

**Observed behavior:** The handler passes `allowed_roots` to the Rust sandbox.
Outside-root paths have a structured `error` field. Missing paths do not.

---

### lc_glob_files

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| No matches | `{ matches: [], pattern_used: "...", truncated: false }` | ✅ Pattern echoed |
| Invalid root | A root outside the allowed roots returns a top-level Rust error. A missing or non-absolute root rejects the complete call with `path_resolution_failed`. See "File I/O path pre-flight" above. | ✅ Root echoed either way. |
| Too many results | `{ matches: [...], truncated: true }` | ✅ `truncated` flag |

**Observed behavior:** LC attributes an invalid root to its rejecting layer.
Outside-root failures are native errors. Pre-flight rejects missing or
non-absolute roots.

---

### lc_grep

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| `include` filter matches nothing | `{ matches: [] }` | ⚠️ Model may not realize `include` applies to ALL searches |
| Empty or whitespace `include` | Treated as omitted: searches all non-excluded files in the target | ✅ Not an error — absence is honored |
| File > 1 MiB skipped | `{ skipped_large: N }` in output | ✅ Count reported — model knows how many were skipped |
| Binary file skipped | `{ skipped_binary: N }` in output | ✅ Count reported. Includes malformed or unmarked UTF-16 and any other file with a NUL in its first 8 KiB |
| Symlinked file skipped | `{ skipped_symlink: N }` in output | ✅ Count reported |
| Metadata or content unreadable | `{ skipped_unreadable: N }` in output | ✅ Count reported — a candidate that vanished mid-search is visible |
| Search stopped early | `{ truncated: true, truncated_reason }` | ✅ LC proved that work or output was omitted |
| Completeness unknown | `{ truncated: null, truncated_reason }` | ✅ A spent budget prevented proof. Narrow the path or raise the named limit |
| Cancelled | `{ truncated: true, truncated_reason: "cancelled" }` | ✅ Keeps every match collected first. Not an `error` |
| Result budget filled | `{ truncated, truncated_reason: "results" }` | ✅ `true` proves a further match. `null` means LC did not determine completeness |
| Per-file sampling omitted a match | `{ truncated: true, truncated_reason: "per_file_matches" }` | ✅ Raise or omit `max_matches_per_file` |
| Invalid regular expression | `invalid_regex` issue with the search path, catalog remedy, and `help: { tool: "lc_grep", query: "regex" }` | ✅ Correct the expression and submit a new call. |

**Observed behavior:** The `include` scope is documented. Each skip path reports
a count, and each early stop gives its cause. An unresolvable path never becomes
a grep `error`. Preflight rejects the complete call before search.

Thus,
An invalid regular expression uses a stable per-search code. A mixed batch has
`status: "partial"`, and each failed search owns its issue. Cancellation never
appears as an error.

---

### lc_edit_file

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| Binary or non-UTF-8 target | `{ path, error: "binary_detected…" / "encoding_not_utf8…" }` | ✅ Same rules as `lc_read_file`. The file is not modified |
| `old_string` not found | `{ path, replaced: false, occurrences: 0, file_exists: true, bytes_before: N, bytes_after: N, hint, near_match_lines }` | ✅ Clear — `hint` names the cause (whitespace, indentation, stale anchor, absent) |
| `old_string` appears >1 time | `{ path, replaced: false, occurrences: >1, match_lines, hint }` | ✅ Clear — `match_lines` gives at most 20 locations. occurrences reports the total. |
| `old_string` empty on existing file | `{ path, error: "old_string must not be empty…" }` | ✅ Names `lc_write_file` as the right tool |
| File doesn't exist | `{ path, file_exists: false, replaced: false }` | ✅ Clear |
| File created via `create_if_missing` | `{ path, replaced: true, created: true, occurrences: 0 }` | ✅ `created` disambiguates from a replacement |
| File over 32 MiB | `{ path, error: "file too large to edit…" }` | ⚠️ LC's patch tool has the same source-file limit. Reduce the file below the limit or use an external editor. |
| Path outside roots | `{ path, error: "..." }` (Rust-side) | ✅ Path echoed |
| Empty `files` batch | Validation error naming `files` | ✅ Add a file edit or use the flat `path` / `old_string` / `new_string` form |
| Missing flat-form field or mixed flat and batch forms | `invalid_arguments` naming every missing or conflicting field before execution | ✅ Complete one form, or remove all fields from the other form. LC never discards one valid form silently. |

**Observed behavior:** Results include `occurrences`, `file_exists`,
`bytes_before`, and `bytes_after`. A nonmatching `old_string` is a successful
no-change result. `hint` and diagnostic lines identify possible adjustments.

The replacement itself is never fuzzy. The relaxed comparators run for diagnosis only.

Whitespace remedies name the whitespace that differs in old_string.
Changing CRLF to LF cannot fix a trailing-space mismatch because matching already normalizes line endings.
If the first requested line is absent, the hint states only that fact. Later requested lines can still exist.
The structural STE checker includes native edit hints and shared text-admission remedies.

---

### lc_apply_patch

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| Empty patch | `invalid_arguments` names `patch` and the required markers | ✅ Send one complete marker-delimited patch. |
| Patch above 1,048,576 characters | `invalid_arguments` names `patch` and the character limit | ✅ Split unrelated changes into smaller patches. |
| Patch above 1 MiB of UTF-8 | Native error names the byte limit | ✅ Split unrelated changes into smaller patches. |
| Multiple actions target one source or move destination | Native error names the conflicting path | ✅ Combine same-source actions. For one move destination, choose one source or another destination. |
| Binary or non-UTF-8 update source | Call fails, naming the path and the rule | ✅ Same rules as `lc_read_file`. Fails before any commit |
| Context mismatch | Tool error before mutation: `"Failed to find expected lines in …"` | ✅ Shows the model-supplied lines. Read the file again and retry. |
| Malformed patch | Tool error with patch line number and path when available | ✅ Points to the invalid line |
| Misplaced `*** Move to:` | Tool error naming the placement rule: the header follows `*** Update File:` and precedes any `@@` hunk | ✅ Move the header rather than removing it — it is never reported as "unknown" |
| Unrecognized line | Tool error quoting the line and listing the three valid file headers | ✅ Names what a file entry may start with |
| Failed native preflight / stale plan | Tool error before mutation | ✅ Retry after reading current files |
| Existing Add/move destination | Tool error during native preflight with `code: "already_exists"`. Destination unchanged. | ✅ Choose a different action or path. |
| Move source-removal failure | `fully_applied: false` plus exact destination-cleanup outcome | ✅ Final filesystem state is explicit |
| Partial success | Mix of succeeded + failed entries, `fully_applied: false` | ✅ Top-level flag makes detection instant |
| Full success | `fully_applied: true` | ✅ |

**Observed behavior:** Strict parse and pre-flight failures occur before
mutation. Commit-time partial failures include the exact result for each file.
Context errors include the model-supplied lines for comparison with
`lc_read_file`. Preflight rejections preserve the native `ToolError` code.

Examples include `already_exists`, `not_found`, `not_a_file`, and
`path_outside_roots`. They do not label every failure as a sandbox violation.

---

### lc_run_shell

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| Binary not in allowlist | `shell_binary_not_allowed`, with the configured list | ⚠️ The same call is non-retryable. The user must allow the executable, or the model must choose one already allowed. |
| cmd.exe builtin used standalone | `windows_builtin_requires_cmd` plus `suggested_call: { cmd: "cmd", args: ["/d", "/u", "/c", ...] }` and `required_allowlist_entry: "cmd"` | ✅ Corrected call is machine-readable but is never executed implicitly |
| Missing explicit cwd | `cwd_not_found` with `path`, `native_code`, and `native_reason` | ⚠️ Requires a different existing directory |
| Empty or whitespace `cwd` | Treated as omitted: uses first allowed root or system temporary directory | ✅ Not an error — absence is honored |
| File used as cwd | `cwd_not_directory` with `path` | ⚠️ Requires a different directory |
| cwd outside allowed roots | `cwd_outside_roots` with `path` and `allowed_roots` | ⚠️ Shell approval cannot expand roots. Configure Workspace or use a different cwd. |
| Timeout | `{ status: "timeout", issues: [{ code: "timeout", ... }] }` | ✅ Distinct terminal state |
| User cancellation | `{ status: "aborted", issues: [{ code: "aborted", ... }] }` | ✅ Distinct from timeout/failure |
| Non-zero exit / output contains “cannot find” | `{ stdout, stderr, exit_code: N }` | ✅ A launched process is never relabelled from output text |
| Executable not found | `executable_not_found` with `executable`, `native_code`, and `native_reason` | ⚠️ The same call is non-retryable. PATH or input must change. |
| Permission denied | `permission_denied` with operation, target/executable, and native detail | ⚠️ External permission/configuration change is required |
| Other native spawn failure | `spawn_failed` with executable and native detail | ⚠️ Evidence is retained, but LC does not guess that replay is safe |

**Observed behavior:** LC returns launch evidence and never
retries shell calls automatically. Each terminal launch issue has
`retryable: false`. A completed process result remains a process result
regardless of text in stdout or stderr. Only the native launch boundary can
produce a launch error. A pre-spawn cancellation produces the same aborted
envelope. It never returns `stderr: "aborted by user"` as a successful process.

---

### lc_web_fetch

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| HTTP 4xx/5xx | `{ status: 404, final_url: "...", body: "..." }` | ✅ Status code + final URL shown |
| Timeout | Error from Rust side | ✅ |
| User cancellation | `{ status: "aborted", issues: [{ code: "aborted", ... }] }` | ✅ Cancellation never appears as a fetched response body. |
| SSRF blocked (non-global target or redirect) | `blocked_host` issue | ✅ Identifies the rejected target. Blocked redirects are not returned as successful 3xx responses. |
| Invalid URL | Zod validation error (must be valid URL) | ✅ |

**Observed behavior:** `final_url` shows the accepted post-redirect destination.
LC resolves, validates, and DNS-pins each hop before connection. It blocks
IPv4-mapped IPv6 and reserved or non-global targets.

---

### lc_web_search

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| No provider configured | Error naming all three options | ⚠️ Model can't fix — user must configure in Settings |
| Blank or whitespace-only `query` | `invalid_arguments` naming `query`, with `retryable: false` | ✅ Send the topic or question to search for |
| No results | `{ results: [], source: "<provider>" }` | ✅ Clear |
| Network error | Retried 2×, then error | ✅ |
| Empty or whitespace `freshness` | Treated as omitted: searches all time without recency filter | ✅ Not an error — absence is honored and not added to `ignored_params` |
| Parameter unsupported by the active provider | `ignored_params: ["freshness"]` alongside normal results | ✅ The model can see its filter was dropped |
| Marginalia rate limit (`429`) | Error naming the ~3 queries/minute ceiling on the shared key | ⚠️ User action, but the cause is stated |
| SearXNG JSON disabled (`403`) | Error naming `search.formats` in the instance's `settings.yml` | ⚠️ User action, but the fix is stated |
| SearXNG returns nothing, all engines suspended | Error naming the failed engines and stating this is an instance problem | ✅ Distinguishes "broken" from "nothing found" |

**Observed behavior:** Configuration failures need user action. Each failure
names the required change instead of returning only a status code.

The last two entries prevent silent failures. Without a warning, a dropped
`freshness` filter returns all-time results that the model can present as
recent. If all engines have rate limits, an instance can return an empty list.
That list looks like a genuine miss. The model could then report that the
information does not exist, although no engine completed the search.

---

### lc_web_research

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| Niche topic, sparse sources | `{ summary, sources, confidence_note: "Only 2 source(s)…" }` | ✅ Note warns the model to cross-check |
| Blank or whitespace-only `query` | `invalid_arguments` naming `query`, with `retryable: false` | ✅ Send the topic or question to research |
| Blank synthesis or synthesis above 64 KiB UTF-8 | Terminal `invalid_model_output` or `model_output_too_large` issue with a bounded message | ✅ Select another model or narrow the research request. No partial synthesis is returned. |
| No sources at all | `{ summary: "No search results…", sources: [], confidence_note: "…" }` | ✅ Clear |
| Focused search returns another hostname | Result is discarded. `confidence_note` explains when no preferred result remains. | ✅ Remove `preferred_domains` for one broad call or explicitly enable `cross_check` on providers other than Marginalia. |
| Page is blocked, empty, or duplicated after redirect | A reserve candidate from the same search response is fetched, up to the bounded attempt cap | ✅ No extra search call is spent |
| `cross_check` requested on Marginalia | Silently capped to one search, reported in `research_info.ignored_params` | ✅ The model can see the request was narrowed |

**Observed behavior:** Search-call counts are bounded. A normal run makes one logical
search call. With preferred domains, `cross_check: true` makes two calls.
Marginalia limits it to one call to stay within approximately three queries per
minute. `research_info` reports the provider, ignored parameters, and search
mode.

It also reports logical search calls, direct fetch requests, matched
preferred domains, and hostname diversity. Native transport retries remain
internal to the search client.

---

### lc_get_current_time

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| Invalid timezone | `{ time, tz: "Europe/Brussels", unix_ms, tz_warning: "The tz value is not a valid IANA timezone. LC used Europe/Brussels. Use …" }` | ✅ Warning names the field, reports the timezone used, and gives valid examples. |
| `tz` over 255 characters | `invalid_arguments` identifies `tz` and asks for a shorter IANA timezone name | ✅ The input is rejected before execution. |
| Empty or whitespace `tz` | Treated as omitted: produces time in OS local timezone with `tz_warning: null` | ✅ Not an error — absence is honored |
| All inputs valid | `{ time, tz, unix_ms, tz_warning: null }` | ✅ |

**Observed behavior:** `Intl.DateTimeFormat` detects invalid timezones. The
bounded `tz_warning` gives the selected timezone and valid examples. It does
not echo the rejected value. RFC 2822 output includes the requested numeric
offset for supported timezones.

---

### lc_todo_write

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| Invalid status (typo: "pending", "done") | `{ status: "error", issues: [{ code: "invalid_arguments", message: "todos.1.status: Invalid option: expected one of ..." }], warnings: [] }` | ✅ Lists valid values and names the field and index. |
| Missing required field | `{ status: "error", issues: [{ code: "invalid_arguments", message: "<field>: Required" }], warnings: [] }` | ✅ |
| Empty `todos` | Validation error naming `todos` | ✅ Add one todo and submit the complete list. |
| More than 20 todos | Validation error naming `todos` and the cap | ✅ Reduce the complete list to 20 or fewer items. |
| Duplicate, non-positive, fractional, or unsafe ID | Validation error naming the indexed `id` | ✅ Use one unique, stable, positive safe integer. |
| Multiple in-progress items | Successful update | ✅ Zero or more items can be in progress. |
| Blocked item without a note | Validation error naming the indexed `note` | ✅ Add a blocker note. |
| Completed item without `completion_evidence` | One successful warning naming every affected task ID | ✅ Add concise evidence to make the status transparent. |
| Invisible-only completion evidence | Validation error naming `completion_evidence` | ✅ Add visible text or omit the field. |
| Unknown outer or item field | Strict-object validation error | ✅ Remove the unknown field. |

Every malformed state uses `invalid_arguments` with `retryable: false`. Repeating
the same call cannot succeed. A successful result contains only completed,
blocked, and total counts, so it does not duplicate the list from the call.
Missing optional completion evidence produces a warning instead of an error.

**Observed behavior:** Validation errors name the rejected field and reject
invalid state before execution.

---

### lc_ask_user

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| Invalid question, ID, choice, bound, or unknown field | `invalid_arguments` with the indexed path and `retryable: false` | ✅ Correct the named field or bound. |
| Mixed or duplicate-interactive batch | `interactive_tool_must_run_alone` with a remedy to submit one isolated call | ✅ Retry with only one `lc_ask_user` call. No sibling executed. |
| Modal host is not ready | `ask_user_ui_unavailable` with `retryable: true` | ✅ Retry after an LC window is ready. |
| The presentation host reports an unexpected second request despite application FIFO arbitration | `ask_user_ui_busy` with `retryable: false` | ✅ End the current round. This is a defensive host fallback, not the normal concurrent-chat queue result. |
| Parent generation or host teardown aborts the request | Normal aborted envelope for the matching call ID | ✅ Start a new turn if the question is still needed. |

The user wait has no ordinary operational deadline. All permission and ask-user
requests share one strict application FIFO; queued operational time is credited
back, while a separate 30-minute absolute attention cap bounds the interaction.
Host registration is bounded to five seconds, and parent generation abort still
settles the pending call. A
suppressed mixed batch emits one result for every declared call ID without
running a handler, grant check, permission prompt, or sibling side effect.

**Observed behavior:** Stable codes distinguish malformed
input, batch isolation, unavailable UI, busy UI, and owner cancellation.

---

### lc_whiteboard

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| Fields do not match the selected action | `invalid_arguments`, `retryable: false`, the catalog remedy, and validation details naming the rejected fields and rule | ✅ Remove fields from another action or supply the required exact fields. No store access occurs. |
| Initial records are unavailable | `whiteboard_not_initialized`, `retryable: true` | ✅ Retry once after LC repairs initialization; then continue without the board if it repeats. |
| A pinned/current retained row is missing | `whiteboard_version_missing`, `retryable: false` | ⚠️ Do not retry the missing ID. Report that the retained version is unavailable. |
| Read storage fails | `whiteboard_read_failed`, `retryable: true` | ✅ Retry once, then continue without the board. |
| Mutation storage fails | `whiteboard_write_failed`, `retryable: true` | ✅ Retry after storage is available. Read again before a later exact edit. |
| `old_string` is absent | `whiteboard_old_string_not_found`, `retryable: false`, plus at most three `suggestions` | ✅ Suggestions use deterministic whitespace comparisons. A total miss returns none and says to read first. |
| `old_string` is not unique | `whiteboard_old_string_not_unique`, `retryable: false`, complete `occurrence_count`, and at most three `excerpts` | ✅ Use a longer exact string that occurs once. |
| Result exceeds 32 KiB UTF-8 | `whiteboard_too_large`, `retryable: false`, `limit_bytes: 32768`, and exact `measured_bytes` | ✅ Reduce the complete resulting Markdown. LC never truncates it. |
| Batch declares two or more exact Whiteboard calls | Every Whiteboard call gets `whiteboard_batch_conflict`, `retryable: false` | ✅ No Whiteboard handler ran. Send one intended call later and wait for it. |
| Owning generation times out before completion | `status: "timeout"` with a `timeout`, `retryable: false` issue and explicit no-change truth | ✅ Read the current boards in a later turn before continuing. |
| Owning generation ends before completion | `status: "aborted"` with an `aborted`, `retryable: false` issue | ✅ Read the current boards in a later turn before continuing. |

Suggestion and excerpt arrays contain at most three items, each capped at 160
UTF-8 bytes. They are derived only from the model board and never disclose the
user board. Actual editing remains exact. Identical replacement content or an
identity edit succeeds with `changed: false` and creates no provisional row.

If a changed mutation commits before the generation ends, terminal settlement
retains it and repairs a missing ordinary result from the mutation receipt.
The repaired result is compact and includes no board Markdown. A worker that
reaches storage after settlement returns `aborted` without writing.

**Observed behavior:** Stable codes distinguish
schema, initialization, retained-reference, read, write, edit-match, size,
batch, timeout, and ownership failures without parsing error text.

---

### lc_tool_help

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| Unknown query | `status: "ok"`, `data.mode: "no_match"`, and bounded keywords when available | ✅ Revise the query inside the resolved tool. |
| Ambiguous tool name | `data.mode: "ambiguous"` with at most three suggestions | ✅ Choose one named tool. |
| Unexposed tool | `data.mode: "not_exposed"` without detailed guidance | ✅ Enable the operational category or use an exposed tool. |
| Duplicate lookup | `data.mode: "already_returned"` without repeated guidance | ✅ Use the result already returned in this turn. |
| Turn limit | `data.mode: "limit_reached"` with the applicable total, guidance, or unresolved message | ✅ Continue without more help calls this turn. |
| `tool` exceeds 80 trimmed characters | `invalid_arguments` names `tool` and its bound | ✅ Use one exposed tool name within the limit. |
| `query` exceeds 160 trimmed characters | `invalid_arguments` names `query` and its bound | ✅ Shorten the query or omit it for basic help. |
| `query` exceeds eight distinct terms | `invalid_arguments` names `query` and its term bound | ✅ Remove extra terms or omit the query for basic help. |

The limits are six total attempts, three guidance results, and two unresolved
lookups per turn. Batch-index order decides admission. Duplicate and limit
results use the existing `ToolResultEnvelope`; help mode is only in `data.mode`.

---

### lc_tool_history

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| Invalid message_id (not found) | `{ message_id, total_archived: 0, returned: 0, results: [], available_message_ids: [...] }` | ✅ Up to 20 real archived turn IDs make the retry concrete |
| tool_call_id not found | `{ total_archived: 0, returned: 0, results: [], available_message_ids: [...] }` | ✅ The same bounded turn-ID inventory provides a recovery path |
| Query exceeds 512 characters or 16 distinct terms | Validation/search error naming `query`, the applicable limit, and a narrowing remedy | ✅ Shorten or narrow the query. No input is silently dropped. |
| Result exceeds `max_result_bytes` | `{ truncated: true, truncated_bytes: N }` | ✅ Clear — model can increase `max_result_bytes` (up to 524288) |
| Per-result exceeds 256 KB cap | `{ output_truncated: true }` per entry | ✅ Clear per-entry flag |
| No filters (list mode) | Returns bounded structured `summary` entries with message IDs | ✅ Model can then query by message_id |
| Archived Whiteboard result | Action-only `arguments` and fixed redacted `output`. Owning-message or exact-call retrieval adds top-level `whiteboard_refs` when the assistant has them, including for an ordinary sibling result. | ✅ Call `lc_whiteboard` with `action: "read"` for current content. Historical Markdown is intentionally unavailable. |
| Whiteboard content used as a search query | No hit from board Markdown or mutation fields | ✅ Search can find the projected action, tool name, or call ID without exposing board text. |
| Result has no resolvable owning call | `tool_name: "unknown"`, empty arguments, bounded generic redacted output; excluded from search | ⚠️ Fails closed. LC does not expose an unowned payload under an invented name. |

**Observed behavior:** Unknown IDs return a bounded inventory of real archived
turn IDs instead of a bare miss. The caller's UTF-8 byte limit applies to every
mode. It covers direct lookup, list summaries, and the first oversized result.
Returned text always remains valid UTF-8. Whiteboard and unresolved-call
projections remain bounded even though canonical local history is unchanged.

---

### lc_skill

| Failure | Response shape | Self-correctable? |
|---------|---------------|-------------------|
| Unknown or disabled skill ID | `{ mode: "error", code: "skill_unavailable", id, message: "..." }` | ✅ Clear — the model can list enabled skills and retry with an available ID |
| Empty or whitespace `id` | Treated as omitted: returns `{ mode: "list", skills: [...] }` | ✅ Not an error — absence is honored |
| `id` over 256 characters | `invalid_arguments` identifies `id` and asks for an enabled ID from list mode | ✅ The input is rejected before execution. |
| No enabled skills in list mode | `{ mode: "list", skills: [] }` | ✅ Clear — no skill guidance is available to retrieve |
| More than 100 enabled skills | `{ mode: "error", code: "skill_limit_exceeded", total, limit, message }` | ✅ Clear — ask the user to disable or delete skills before retrying |
| Serialized result above 2 MiB | `{ mode: "error", code: "skill_result_too_large", limit_bytes, message }` | ✅ Clear — ask the user to shorten or remove enabled skills before retrying |
| Valid enabled skill ID | `{ mode: "skill", source: "builtin" | "custom", skill: { id, name, description, content, revision } }` | ✅ |

**Observed behavior:** `lc_skill` never opens a permission popup. Exposure and
per-skill availability determine what it can return. Count and byte limits
reject an oversized result without partial skill content.

---

## Text-admission policy

Four tools inspect file content. They share the byte-order-mark decoder and the
first-8-KiB NUL boundary. Therefore, they classify marked UTF-16 and binary
content with NUL bytes consistently. The whole-file reader and two writers also
share a strict UTF-8 classifier. Grep handles invalid UTF-8 without a NUL
differently. It searches mostly valid content with a lossy decode instead of
rejecting the complete file.

| Rule | Applies to | Result |
|---|---|---|
| A byte-order mark (`FF FE` / `FE FF`) | UTF-16, transcoded by the readers | text, with `encoding` set (read) |
| A NUL byte in the first 8 KiB, no mark | Real binary, and mark-less UTF-16 | `binary_detected` |
| Not valid UTF-8, with no NUL or transcodable mark | Latin-1 and other legacy encodings | `encoding_not_utf8` |
| Malformed UTF-16 behind a mark | Marked content with odd length or an unpaired surrogate | `encoding_not_utf8` from `lc_read_file`; `skipped_binary` from `lc_grep` |

| Tool | BOM-marked UTF-16 | NUL rule | Invalid UTF-8 rule | On a rejected file |
|---|---|---|---|---|
| `lc_read_file` | **transcodes** | applies | applies | Per-path error naming the rule and the remedy |
| `lc_edit_file` | refuses (message names the mark) | applies | applies | Per-file error. The file is not modified |
| `lc_apply_patch` | refuses, `Update` sources | applies | applies | Call fails before any commit |
| `lc_grep` | **transcodes** | applies | **permissive** | Skips the file and counts it in `skipped_binary` |

Two deliberate differences, both in `lc_grep`:

- **It skips rather than fails.** One unreadable file must not fail a batch of twenty searches.
- **It does not apply the strict UTF-8 rule.** It uses a threshold. Therefore,
  it can search a mostly valid UTF-8 file that has some invalid bytes. Without
  this rule, one Latin-1 byte in a comment could exclude a complete source
  file. A returned match can contain `U+FFFD` in place of an invalid byte. This
  result is acceptable because grep is read-only and returns single lines. It
  is not acceptable for tools that return or write complete files.

`lc_apply_patch` classifies `Update` sources. A `Delete` hunk needs no decode, so deleting a
binary file stays allowed.

**Why not use a lossy decode.** `String::from_utf8_lossy` replaces each invalid
sequence with `U+FFFD`. The result does not indicate that the content changed.
If a caller writes edited text back, it destroys the replaced bytes.
`expected_sha256` does not detect this problem because the source file did not
change. Only the caller's copy is incorrect. Rejection prevents this failure.

**Transcoding policy.** The two read-only tools transcode UTF-16 that has a
byte-order mark. `lc_read_file` and `lc_grep` use one decoder in `fs_ops.rs`.
The mark is the only safe trigger. LC cannot reliably distinguish unmarked
UTF-16 from binary data. LC rejects UTF-32 marks as binary because it has no
UTF-32 decoder.

`lc_read_file` reports transcoding in `encoding` and hashes raw
bytes. Therefore, `expected_sha256` still describes the file on disk.

All three writers refuse a marked UTF-16 target, each saying why: writing, editing, or patching
through a transcode would store UTF-8 and silently change the file's encoding. `expected_sha256`
cannot catch that on its own, because the file has not changed — only the caller's copy of it
has. `lc_read_file` still reports the encoding in `encoding`, so a caller can see what it read. A malformed marked
stream (odd length, unpaired surrogate) is refused everywhere rather than patched in place.
Ranged reads buffer transcoded sources up to 64 MiB. LC rejects larger sources
and reports their size.

---

## Summary: Recovery coverage

| Condition | Result evidence |
|---|---|
| Rejected input | The result names the rejected field, path, or rule. |
| Bounded partial work | The result reports truncation, counts, or per-entry failures. |
| External action required | The result names the required user or configuration action. |
| Retry cannot help | The issue uses `retryable: false` or gives an alternative action. |

### Key principle across all tools

**Path and error always travel together.** Every file-system tool returns the
invalid path in its result. The model does not need to guess which path failed.
This behavior supports correction across turns.

**Presence of information is necessary, not sufficient.** A path, code, and
field can still accompany a wrong remedy. The cross-cutting rules also require
accurate remedies, absence handling, and the enforced rule's name.

---

## `repairWindowsJson` is only ever a fallback

Some servers emit Windows paths with invalid backslash escaping.
`repairWindowsJson` in `tool-engine/runner.ts` makes the argument string valid
JSON. It doubles each `\` that is not a valid JSON escape or a `\\` pair. It
does not change valid JSON. `repair-windows-json.test.ts` covers valid single
and double backslashes, valid escapes, and a broken single backslash.

Production callers use `repairWindowsJsonAfterParseFailure`. It first returns
valid input byte-for-byte. It invokes `repairWindowsJson` only after
`JSON.parse` rejects the input. Do not use repair as a normalizer. A future
change could damage valid arguments:

- at the wire/store boundary and orchestrator sanitize step, **only after
  `JSON.parse` has already failed**. Well-formed arguments remain unchanged.
- at the permission boundary through the same gate, so the user reads the
  repaired real path without making the modal a second normalization path.

Any new call site must preserve that ordering: parse first, repair only on
failure.
