# LC — Tools Reference

> Updated: 2026-08-31 | Version: 1.0.0

Complete tool catalog with input/output schemas, edge cases, and batch semantics.

---

## Tool Catalog

The numbered catalog follows the canonical `BUILTIN_TOOLS` registry order.
Category membership remains defined separately by the category name lists.

| # | Tool | Handler | Backend | Authorization | Destructive |
|---|------|---------|---------|------------|-------------|
| 1 | `lc_read_image` | `builtin/read_image.ts` | `fs_ops.rs` | Directory grant or prompt | No |
| 2 | `lc_read_pdf` | `builtin/read_pdf.ts` | `pdf.rs` | Directory grant or prompt | No |
| 3 | `lc_read_file` | `builtin/read_file.ts` | `fs_ops.rs` | Directory grant or prompt | No |
| 4 | `lc_write_file` | `builtin/write_file.ts` | `fs_ops.rs` | Directory grant or prompt | Yes |
| 5 | `lc_list_dir` | `builtin/list_dir.ts` | `fs_ops.rs` | Directory grant or prompt | No |
| 6 | `lc_web_fetch` | `builtin/web_fetch.ts` | `web.rs` | Conversation grant or prompt | No |
| 7 | `lc_get_current_time` | `builtin/get_current_time.ts` | *pure JS* | No prompt when Workspace is on | No |
| 8 | `lc_run_shell` | `builtin/run_shell.ts` | `shell.rs` | Approval-controlled | Yes |
| 9 | `lc_todo_write` | `builtin/todo_write.ts` | *pure JS* | No prompt when Workspace is on | No |
| 10 | `lc_ask_user` | `builtin/ask_user.ts` | *pure JS + modal* | No prompt when Workspace is on | No |
| 11 | `lc_whiteboard` | `whiteboard.ts` | *pure TypeScript + conversation store* | No prompt when exposed | No (versioned) |
| 12 | `lc_grep` | `builtin/grep.ts` | `grep.rs` | Directory grant or prompt | No |
| 13 | `lc_edit_file` | `builtin/edit.ts` | `edit.rs` | Directory grant or prompt | Yes |
| 14 | `lc_web_search` | `builtin/web_search.ts` | `web_search.rs` | Conversation grant or prompt | No |
| 15 | `lc_web_research` | `builtin/web_research.ts` | *JS + sub-agent LLM* | Conversation grant or prompt | No |
| 16 | `lc_stat` | `builtin/stat.ts` | `fs_ops.rs` | Directory grant or prompt | No |
| 17 | `lc_glob_files` | `builtin/glob_files.ts` | `glob.rs` | Directory grant or prompt | No |
| 18 | `lc_apply_patch` | `builtin/apply_patch.ts` | `apply_patch.rs` | Directory grant or prompt | Yes |
| 19 | `lc_tool_help` | `builtin/tool_help.ts` | *pure JS* | No prompt when exposed | No |
| 20 | `lc_tool_history` | `builtin/tool_history.ts` | *pure JS* | No prompt when exposed | No |
| 21 | `lc_skill` | `builtin/skill.ts` | *pure JS* | No prompt when exposed | No |

The authorization column describes actual behavior. Category toggles expose
complete categories. Checkmarks only suppress popups. File calls use canonical
directory/tool grants. Web Access uses conversation/tool grants.
`lc_todo_write`, `lc_ask_user`, and `lc_get_current_time` are foundation tools
and do not use grants.
Whiteboard is a default-off conversation-state category with no grant or
permission popup.

Shell
is approval-controlled. Tool History and Skills never prompt when exposed. LC
rejects unknown, invalid, or unexposed calls without a popup. See
[TOOL-POLICY-MODEL.md](./TOOL-POLICY-MODEL.md).

For File I/O, LC canonicalizes all targets before authorization. Targets include
`..`, links or junctions, Windows aliases, and the nearest existing parent of
create targets. A directory/tool grant covers that directory and its
descendants. Overlapping roots are additive per tool. LC uses the most-specific
containing root that grants the requested tool.

A child root without that tool
does not shadow an enclosing grant. A child grant does not authorize its parent
or siblings.

A valid request can ask for approval for an ungranted target directory. This
includes a directory outside configured roots. Approval covers that exact
canonical scope once or for the conversation. Malformed or
non-canonicalizable paths fail before approval. The popup, stored grant, and
native operation use the same scope identity.

For `lc_apply_patch`, argument validation and exposed-tool admission occur
before metadata-only target discovery. After approval, LC runs a new full
native preflight. It verifies the target set against discovery and executes the
exact native plan ID. `lc_run_shell.cwd` is different. An explicit working
directory must be in an allowed root.

---

## Input / Output Schemas

The runner limits the complete serialized result from each tool. The default
limit is 4 MiB of UTF-8. `lc_read_file` and `lc_web_fetch` use 64 MiB because
their documented per-item limits are larger. `lc_run_shell` uses 16 MiB because
JSON escaping can expand its two 1 MiB output streams.

If a result exceeds its limit, LC discards the result and returns a
`result_too_large` issue. The issue reports the measured bytes and the limit.
Its remedy tells the model to narrow the request or split the work into several
calls.

### lc_read_file

Read one or more text files. LC returns UTF-8 unchanged and transcodes
BOM-marked UTF-16 without lossy replacement. A NUL byte in the first 8 KiB of
an unmarked file gives `binary_detected`. Other invalid UTF-8 gives
`encoding_not_utf8`. `max_bytes` limits full reads. LC streams focused line
ranges from larger files without buffering the full file.

```typescript
// Input
{
  paths: string[]              // Absolute file paths (1–20)
  start_line?: number          // 1-based start line, max 4,294,967,295
  end_line?: number            // 1-based end line (inclusive), same maximum
  max_bytes?: number           // Default 1 MiB, hard cap 32 MiB for full content/range
}

// Output
{
  results: Array<{
    path: string
    content: string            // Empty on error
    sha256: string | null      // SHA-256 hash of raw file bytes; null on error
    encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | null
                               // How content was decoded; null on error.
                               // utf-16* means transcoded; every write tool refuses it.
    total_lines: number
    size_bytes: number
    truncated: boolean          // Always false; oversized requests return an error
    error_code?: string         // Stable code on an error entry; absent on success
    error: string | null       // e.g. "2546 bytes > max 500 bytes", "binary_detected",
                               // or "encoding_not_utf8"
  }>
}
```

**Edge cases:** One call accepts 1–20 paths. The default limit is 1 MiB.
`max_bytes` can increase the per-file limit to 32 MiB. It is not a call-wide
content limit. The complete serialized result has the runner's 64 MiB limit.
Model-facing validation rejects larger per-file values. The native boundary
separately clamps direct calls to the same per-file limit.

Line numbers are positive 32-bit values. LC rejects larger numbers instead of
treating them as omitted range endpoints. If a full source exceeds the limit,
LC returns `error` with empty content. A focused range streams the source. It
succeeds only if the selected content fits within the limit. An oversized range
returns an error, not partial content.

The streaming range reader uses fixed-size chunks. One unbroken source line
cannot allocate its complete length. Full reads and buffered UTF-16 ranges read
at most their limit plus one byte, so file growth after the metadata check is
rejected. The native operation is registered under its call and group IDs.
Cancellation stops at the next chunk or path and returns `aborted`.

After a successful full or ranged read, `size_bytes`, `total_lines`, and
`sha256` describe the complete source file. An overflow error contains zero
counter values. The error text gives the actual byte count.

If one path fails, LC returns the existing `ToolResultEnvelope`. A mixed batch
uses `status: "partial"` and keeps the results plus one issue per failed path.
If every path fails, it uses `status: "error"` and omits `data`. Recovery is
selected from `error_code`, not by parsing `error`.

**Encoding:** LC transcodes UTF-16 files that have a byte-order mark. It sets
`encoding` to `utf-16le` or `utf-16be`. `sha256` still hashes the raw bytes.
`lc_write_file`, `lc_edit_file`, and `lc_apply_patch` reject marked UTF-16
targets. Writing UTF-8 would change the encoding.

Convert the file before you
edit it. Without a mark, a NUL in the first 8 KiB gives `binary_detected`.
Invalid UTF-8 gives `encoding_not_utf8`. LC does not use a lossy decode. Convert
transcoded sources larger than 64 MiB before a ranged read.

---

### lc_read_image

Inspect images with optional sub-agent vision analysis, downscaling, encoding, and per-image size caps. The Rust bridge creates data URLs for non-analyze delivery, but the handler keeps those bytes in a transient side channel and does not return them in the persisted tool result.

```typescript
// Input
{
  paths: string[]              // Absolute image paths (1–20)
  max_bytes?: number           // Default 10 MiB, hard cap 50 MiB
  encoding?: 'original' | 'low_jpeg' | 'medium_jpeg'
                               // Default: "original" (analyze:false), "medium_jpeg" (analyze:true)
  downscale?: number           // [0.1–1.0], default 1.0 (no resize). 0.5 = half dimensions.
  analyze?: boolean            // Sub-agent vision description via LLM
  instruction?: string         // Custom instruction for analyze mode
}

// Output (all modes; non-applicable fields use null, false, zero, or [])
{
  images: Array<{
    path: string
    mime: string | null        // Detected from file contents; null on a read/decode error
    size_bytes: number         // Encoded size
    original_size_bytes: number
    original_wh: [number, number] | null  // [width, height] before downscale
    wh_downscale: number       // Downscale factor actually applied (1.0 = no resize)
    encoding: string
    truncated: boolean          // Always false; invalid/oversized images return per-entry errors
    error: string | null       // Per-image error (batch continues)
  }>
  analyzed: boolean            // true only when a vision sub-agent returned a description
  description: string | null   // Vision text only; null when no description was produced
  truncated: boolean           // analyze only: true when paths after the first 10 were not attempted
  total_requested: number
  processed_count: number      // ordinary: all paths; analyze: leading paths admitted (max 10)
  analyzed_count: number       // encoded and admitted to a vision request; zero in ordinary delivery
  described_count: number      // usable bounded descriptions returned; zero in ordinary delivery
  dropped_count: number        // analyze cap omissions; zero in ordinary delivery
  warning: string | null       // Capability, delivery, or truncation recovery guidance
}
```

During the current turn, a non-analyze result also has transient delivery
metadata. LC removes that metadata before it stores the tool result. A cache
buffers pixel delivery for five minutes. The cache holds eight batches and 64
MiB of data URLs. A large batch or concurrent reads can evict a batch before
the next model request.

If this occurs, LC sets `warning` to state that it sent no image. The warning
tells the model to call `lc_read_image` again with fewer paths, a smaller
`downscale`, or JPEG encoding. If the chat model cannot process images,
`analyze:false` returns `description: null` and a capability warning. Use
`analyze:true` instead.

**Image count:** every call accepts up to 20 paths and rejects a larger batch. `analyze: true` processes the first 10 accepted paths and, when 11–20 were requested, sets `truncated`, reports the requested/processed/analyzed/described/dropped counts, and includes a warning telling the caller to re-issue the remaining paths. `analyzed_count` is the number successfully encoded and admitted to a vision request; it does not assert network delivery or a usable response. `described_count` is the number that returned usable text. The warning is not copied into `description`. Per-image labels retain their original request positions, so the admitted subset is never restated as the complete request.

An encoding or vision-request failure stays on the affected image entry in
`error`. LC excludes that control text from `description`. If no vision request
returns a description, `analyzed` is false and `description` is null.

Each per-image provider request asks for at most 4,000 output tokens. LC also
caps a successful response body at 1 MiB, non-success response detail at 16
KiB, and usable description text at 64 KiB of UTF-8. A blank, malformed,
oversized, or non-success response becomes the
affected image's bounded `error`; LC does not return partial description text.
The request sends the encoded image, the chosen instruction, and its ordinal in
the original batch. It does not send the local filesystem path to the vision
provider. LC adds the path back only when it labels the returned description for
the calling model.

**Input limits:** The default is 10 MiB per image. You can increase the limit
to 50 MiB. LC rejects decoded images above 100 megapixels or 16,384 pixels in
either dimension. These checks occur before downscaling. LC has **no
minimum-dimension check**. A 3×2 px image can return a normal success entry.

However, a vision provider can reject an image below its own minimum
dimensions. Rejection aborts the model turn in delivery mode. Analyze mode
returns the rejection as an error on the affected image. No parameter can
increase image dimensions because `downscale` only shrinks. Enlarge the source
image.

**Encodings:** `original` (raw), `low_jpeg` (quality 30), `medium_jpeg` (quality 60).  
**Downscale:** Applied before encoding. Reduces resolution to shrink output size and encoding time.  
- **Sub-agent:** `analyze: true` offloads the image to a separate LLM call for a text description.  
  - Default encoding is `medium_jpeg` (not `original`).
  - Hard cap: **5 MiB per encoded image**. If exceeded, the error tells the model to lower encoding quality or downscale.
  - Analysis has a separate time limit for each image. Provider-specific paths
    can select different durations. Timeout errors report the selected
    duration. Bounded concurrency processes images without one serial
    total-time formula.

---

### lc_read_pdf

Read one or more PDFs and return page metadata plus a model-generated summary. Two depths are available:

- `text_only` (default) extracts and summarizes the text layer. It does not rasterize pages or require a vision-capable model.
- `full` additionally rasterizes pages carrying a figure, chart, table, equation, broken glyph mapping, or no text layer. The summarizer receives both the extracted text and those selected page images.

The two representations are complementary. Extracted text preserves prose,
names, and table-cell text. It cannot represent figures and can damage
equations. Rendered pages preserve layout, equations, and figures. However,
vision can misread characters and numbers.

At `full`, the summarizer can
cross-check both representations. The `summary` is a model-generated
paraphrase. Do not quote it as the document's wording.

Rust owns PDF parsing, rendering, chunking, model requests, per-file map/reduce,
and final result assembly. TypeScript validates ranges and resolves model
profiles and credentials. The webview receives only final public results.
PDF bytes, rendered page images, and intermediate summaries stay in Rust.

```typescript
// Input
{
  paths: string[]              // Absolute PDF paths (minimum 1)
  depth?: 'text_only' | 'full' // Default: "text_only"
  pages?: string               // 1-based selection, e.g. "1-5,12,40-55". Omitted = all.
  force_render?: string        // Rasterize these pages regardless of the predicate.
                               // Omitted = render nothing beyond the predicate's choice.
                               // Both ranges accept "" as omitted; a malformed value errors.
  include_text?: boolean       // Return verbatim per-page text (default false)
  summarize?: boolean          // Default true. False always includes text, overriding include_text.
  instruction?: string         // Steer the summarizer
  max_bytes?: number           // Default 25 MiB, hard cap 100 MiB
}

// Output
{
  files: Array<{
    path: string
    pages_total: number
    pages_processed: number[]
    has_text_layer: boolean
    depth: 'text_only' | 'full'   // May be downgraded from "full" — see vision gate
    summary: string | null        // PARAPHRASE — null when skipped or unavailable
    pages: Array<{
      page: number                // 1-based
      chars: number
      provenance: 'text_layer' | 'none'
      kind: string | null         // Native page classifier, when available
      image_rendered: boolean
      render_reason: string | null
      planned_render_reason: string | null   // set when pixels were needed but not produced
      render_skipped: string | null          // render_budget | output_budget | page_too_large
                                             // | render_failed | aborted | deadline
      tables_md: string[]         // cell text exact, structure INFERRED
      text: string | null         // Present with include_text:true or summarize:false
      error: string | null
    }>
    pages_rendered: number
    truncated: boolean
    error: string | null          // Per-file error (batch continues)
  }>
  warnings: string[]
}
```

**Authorization.** `lc_read_pdf` is a read-only File I/O tool. It participates in directory+tool grants exactly like `lc_read_file`. LC canonicalizes its `paths` and checks them against `allowed_roots`. If the directory does not grant this tool, LC prompts for approval.

**Provenance is the contract.**

| Field | Trust |
|---|---|
| `text` (with `include_text`) | Exact characters from the file. Quotable verbatim. |
| `tables_md` cell text | Exact characters from the file. |
| `tables_md` row/column structure | **Spatially inferred.** May be wrong. |
| `summary` | **Model-generated paraphrase. Never quotable.** |
| any page with `provenance: "none"` | No text layer. A visual summary can derive details from rendered pixels at full depth. |

Use returned page text for quotations. If text was not included, request
`include_text:true` and a bounded `pages` range. The summary is never a source
of quotations.

**Summary-free reads.** `summarize:false` skips all model requests and returns
extracted text with `summary:null`, even if `include_text` is false or omitted.
This precedence needs no correction warning and does not rewrite the recorded
tool-call arguments. It needs no model configuration. Use `text_only` and omit
`force_render`; `full` or a nonempty forced range in this mode gives
`invalid_arguments`. Empty or whitespace-only ranges remain omitted.
Scans return empty text, not OCR. Visual recovery requires both
`summarize:true` and `depth:"full"` with a vision-capable model.

Text-page budgets also apply to summary-free reads. The complete serialized
result has a 4 MiB ceiling. A larger result is replaced with
`result_too_large` and a remedy to narrow or split the request. Partial text
and the original page warnings are not returned in that error.

Each map and reduce request asks the provider for at most 4,000 output tokens.
LC separately rejects visible summary text above 64 KiB of UTF-8. It returns no
oversized chunk output and adds a warning that names the measured and allowed bytes.
Successful sibling chunks can still contribute to the file summary.

**Selective rasterization.** At `depth: "full"` a page is rendered when any of these is measured — each pinned by an independent fixture in `src-tauri/tests/fixtures/pdf/`:

| `render_reason` | Trigger | Measured with |
|---|---|---|
| `no_text_layer` | scanned page, no extractable text | `classify_page` |
| `image_page` | native text plus a full-page raster | `classify_page` |
| `garbled_text` | unmappable glyphs (missing ToUnicode/CID map) | `classify_page` |
| `raster_image` | an embedded raster image | `extract_images` |
| `table` | a detected table (structure is inferred) | `extract_tables` |
| `vector_graphics` | a chart or diagram drawn as paths | `extract_paths` |
| `math_font` | equations set in CM/STIX/Symbol families | `extract_spans` fonts |
| `forced` | named in `force_render` | — |

The predicate deliberately favors rendering. A chart classified as prose does
not produce an image, and downstream code cannot detect this failure. Rendering
always uses the **complete page**. Region crops are not implemented.

**Vision gate.** `depth: "full"` requires a model that can see images. If no separate vision model is configured **and** the chat model is not vision-capable, the call is downgraded to `text_only` **before** any rendering, and a warning names the setting to change. Nothing is rasterized and no multimodal request is made.

**Sub-agent model selection.** LC routes each summary call by its payload, not
its requested depth. A map call with a rendered page goes to **Model for image
analyze**. Every other call goes to **Model for PDF summarize**. This rule
covers all `text_only` calls. It also covers `full` chunks without rendered
pages and every reduce call. Reduce calls contain section summaries, not pages.

Thus, LC does not use a vision model when a request has no images.

An empty setting means **Same as chat model**. A configured model uses its
owning profile and credentials. The PDF picker offers every tool-capable model,
not only vision-capable models. It releases a selection only when the profile
becomes inactive. The image picker also releases a model when effective
metadata says it cannot process images. Warnings identify the setting that
handled a failed call.

**Sub-agent requests use fixed output limits and server defaults.** Every map
and reduce request asks the provider for at most 4,000 output tokens. LC also
rejects visible output above 64 KiB of UTF-8, so a provider that ignores its
token ceiling cannot create an unbounded tool summary. LC does not override
other generation parameters. This includes `temperature`,
`top_p`, `top_k`, `repeat_penalty`, `stop`, and reasoning effort. The
conversation parameter panel configures only the chat model.

It does not affect
these calls. The OpenAI Responses adapter also sends `store: false`.

Omitting the reasoning field does not disable reasoning. An always-thinking
model uses its default. Therefore, LC validates visible output.

**Visible-summary validation.** Map and reduce requests validate visible
assistant text. Each chunk gets exactly one request. Blank output and requests
for missing input are not summaries. If no usable answer exists, `summary` is
`null`. A warning recommends a different **Model for image analyze** or a
narrower page range.

LC never substitutes hidden reasoning for the summary. If
a model exceeds the round deadline, reduce the input by narrowing `pages`.

**Summaries are previews.** The sub-agent produces the shortest useful preview
under a 1,000-word limit. It states what the document is and gives key
takeaways. Completeness is not the goal. Each successful summary adds a
top-level warning that names the file and labels the summary as a paraphrase
that may omit details. Only when text was not included does it add the
instruction to re-read with `include_text:true` and a bounded range within
`pages_total`. No paraphrase warning appears when there is no summary. Actual
generation failures still warn; an intentionally skipped summary does not.
LC keeps this control text outside `summary`.

**Page selection fails closed.** An empty or whitespace-only `pages` / `force_render` value is omission, as the input schema above states. A non-empty malformed expression (`"abc"`, `"1-"`, `"0"`), an expression over 400 characters, or a selection covering more than 2,000 pages is an **error** — never a silent fall back to "all pages". Cardinality is checked arithmetically before enumeration, so `"1-1000000000"` cannot expand in the webview. A selection entirely outside the document is an error naming the real page count, not an empty read that looks like a scan.

**Budgets are call-wide**, not per file. LC admits the first 4 PDF paths
and reports the requested, admitted, and dropped counts in one warning.
The caller can re-issue the remaining paths; admission does not imply success. Other limits are 200 text pages
(hard cap 500), 20 rendered pages (hard cap 50), and 24 MiB of encoded PNG.
A page above 40 megapixels uses a lower DPI. LC skips the page if 72 DPI is
still too large. LC reports dropped pages in one warning for each file.

**Cancellation and deadline.** `lc_read_pdf` has no timeout argument. Its outer
deadline is the tool-execution round deadline supplied by the conversation's
`sse_read_timeout_min` setting. The default is five minutes, and the range is 1–60
minutes. All accepted calls in that round share it. A legacy persisted tools
config with no setting uses a two-minute fallback.

The call registers a native
cancellation token under its operation/group id and checks it between files,
between pages, and before each render. An individual `pdf_oxide` extraction or
render is not preemptible. Stop takes effect at the next checkpoint.

Extraction and every map/reduce request use the same remaining deadline in
Rust. Without a configured deadline, the call defaults to five minutes. The
native pipeline does not start a fresh timer for each chunk or pair and does
not impose a separate five-minute extraction cap on longer configured rounds.
Cancellation or deadline expiry stops active provider waits and prevents later
work, returning `Aborted` or `Timeout`. Blocking extraction/rendering stops at
its next checkpoint.

**Batch summaries.** Native extraction stays sequential over shared budgets.
Rust summarizes files in pairs, with at most two model requests in flight per
tool call. Each file's chunks and reductions run sequentially; the next pair
waits for both files in the current pair. Results and per-file warnings retain
input order. An ordinary failed chunk warns while usable siblings survive.
Failed reduction or no usable chunks yields `summary:null` with warnings.
Results remain separate in `files`; there is no combined-summary field or
extra cross-document model request.

**Rendering.** LC requests PNG at 150 DPI. It renders oversized pages at a
lower DPI to meet the 40-megapixel limit. The minimum is 72 DPI. LC does not
resample after rendering. It does not use JPEG because ringing around glyphs
can turn a `3` into an `8` in a dense table.

Rendering and PNG encoding occur
in memory. LC does not write converted pages or temporary PNG files. It opens
the PDF from its existing path. Encoded pages remain native and go directly
to the selected model provider.

**Images never enter the conversation.** Rendered pages go only to the
summarizing sub-agent. Native result assembly excludes `data_url` before IPC
and persistence. The configured model provider receives the
images, so its retention policy still applies.

**Degradation.** A scan at `depth: "text_only"` returns `has_text_layer: false` with a warning naming the retry (and saying so plainly when no vision model makes that retry possible). With no sub-agent available, page metadata and text are still returned. Encrypted PDFs fail with a clear message rather than an empty extraction.

**OCR is not enabled.** The handler pins `ExtractMode::TextOnly`, so `pdf_oxide`'s OCR path — which would want to download recognition models at runtime — never engages.

**Attachments.** You cannot attach or drop PDFs on the composer. Read them only
through this tool. The OS drag listener and native file picker stop PDF loading
before they read the bytes. They show the absolute path through
`src/ui/chat/pdf-drop-notice.ts`.

---

### lc_write_file

Write or append content to files. Per-file errors don't abort the batch.
Each entry commits independently. A later failure does not roll back earlier
changes.

```typescript
// Input
{
  files: Array<{
    path: string               // Absolute file path
    content: string            // Text content to write
    expected_sha256?: string   // Reject the write if the file no longer hashes to this
  }>                            // 1–20 entries
  mode?: 'create' | 'overwrite' | 'append'  // Default 'create'
}

// Output
{
  results: Array<{
    path: string
    bytes_written: number
    mode: string
    lines_added: number
    lines_removed: number | null // Null when the prior file exceeded the 32 MiB scan budget
    error: string | null       // "already exists" when mode=create hits existing file
  }>
}
```

**Modes:** `create` (atomic — fails if file exists), `overwrite` (truncate + write, and creates the file when it does not exist), `append`.

Rust enforces 32 MiB for each requested content value and final append target,
and 64 MiB for all requested content in one call. Append checks and reads an
existing regular file through a limited reader. A missing target starts empty;
any other inspect or read failure stops that entry instead of replacing the
unread content.

`mode` is one top-level field that applies to every entry in `files`. A nested
`files[].mode` is rejected instead of being silently ignored.

The native writer creates missing parent directories. A path in a new
subfolder needs no separate step. Approval resolves grant scope through
`resolveDirForApprovedScope`. This function canonicalizes a directory that
does not exist yet. Before this behavior, the first write to a new subfolder
failed with `path_outside_roots`. A later write succeeded after the enclosing
root received the grant.

**Optimistic concurrency (`expected_sha256`).** `lc_read_file` returns a `sha256` over the whole file. Passing that value back makes the native side re-hash the current file under LC's cross-process mutation lock and reject the write if it differs. The check is case-insensitive, streams the file rather than buffering it, and fails closed — if the current content cannot be read, the write does not proceed. Arbitrary external editors do not honor LC's lock, so this is not an OS-atomic compare-and-swap against a write occurring inside LC's native critical section.

For a file that does not exist yet, `expected_sha256` is ignored under `create` and `overwrite` (there is nothing to have changed) and is an error under `append`. An empty or whitespace-only `expected_sha256` is treated as omitted.

**`lines_removed` is measured, not estimated.** It comes from a streaming scan of the prior content, capped at a 32 MiB budget. Past that the field is `null` rather than reported as `0` — the write itself is unaffected.

---

### lc_list_dir

List entries of one or more directories.

```typescript
// Input
{
  paths: string[]              // Absolute directory paths (1–20)
  pattern?: string             // Glob filter (e.g. "*.ts", "*.{py,js}")
  include_hidden?: boolean     // Default false
  max_entries?: number         // Default 1000, hard cap 5000 per directory
}

// Output
{
  results: Array<{
    path: string
    entries: Array<{
      name: string
      kind: 'file' | 'dir' | 'symlink' | 'other'
      size: number | null
      mtime: number | null      // Unix ms
    }>
    truncated: boolean
    error: string | null
  }>
}
```

**Edge cases:** One call accepts 1–20 directories. `max_entries` defaults to
1000 and has a 5000-entry limit for each directory. Therefore, a maximum batch
can select 100,000 rows. The complete serialized result has the runner's 4 MiB
limit. Model-facing validation rejects larger `max_entries` values.

The native boundary
separately clamps direct calls. `truncated: true` indicates that more entries
matched.

`pattern` uses the shared glob dialect: `*`, `**`, `?`, `[abc]`, and `{a,b}`.
It matches only the basename of each entry. This call is not recursive. With
`include_hidden=false`, LC omits only entries that start with a dot. It does not
use a fixed grep/glob skip list.

Thus, `node_modules`, `dist`, and `vendor`
remain available. An empty `pattern` means no pattern filter. An invalid
`pattern` fails the complete call with `invalid_glob_pattern`.

**Batch preflight:** Each listed directory must resolve before execution. A
missing directory rejects the **complete call** with `path_resolution_failed`.
The error names the path. LC returns no `results` array and does not list valid
directories in the batch. In the same situation, `lc_read_file` returns one
error for the missing path and processes the rest.

`lc_grep` and
`lc_glob_files` use the complete-call behavior. If uncertain, confirm paths
with `lc_stat`. A non-absolute path also rejects the complete call. This rule
applies to **every** File I/O tool. The message is
`Target path must be absolute: <path>`.

---

### lc_stat

Get file/directory metadata without reading content. Much faster than `lc_read_file` for existence checks.

```typescript
// Input
{
  paths: string[]              // Absolute paths (min 1, max 100)
}

// Output
{
  results: Array<{
    path: string
    exists: boolean
    is_file: boolean
    is_dir: boolean
    size_bytes: number | null
    mtime_ms: number | null     // Unix ms
    canonical: string | null    // Canonical path, when the entry exists and resolves
    error: string | null
  }>
}
```

**Edge cases:** Non-existent paths return `exists: false` with no error. The
100-path cardinality cap works with the runner's 4 MiB serialized-result limit.

---

### lc_glob_files

Find files and directories recursively with a glob pattern under a root directory.

```typescript
// Input
{
  pattern: string              // Provide a glob pattern. Examples are "**/*.{ts,tsx}" and "src/**/*.test.ts".
  root: string                 // Set the root directory for the recursive search.
  include_hidden?: boolean     // Include .dot files/dirs (default false)
  max_results?: number         // Default 1000, hard cap 5000
}

// Output
{
  matches: Array<{
    is_dir: boolean
    path: string               // Absolute path
    size_bytes: number | null  // null for directories
  }>
  pattern_used: string         // Echoes the input pattern
  truncated: boolean
  visited_entries: number
}
```

**Glob syntax:** The shared engine supports `*`, `**`, `?`, character classes
such as `[abc]`, and brace expansion such as `{ts,tsx}`. Matching uses
root-relative paths normalized to `/`. In this engine, `*` can span `/`.
Invalid patterns fail as `invalid_glob_pattern`.

The 5,000-match hard limit is a row-count limit. The complete serialized result
also has the runner's 4 MiB limit.

**Root preflight:** The root must resolve before execution. A missing root
rejects the **complete call** with `path_resolution_failed`. `lc_list_dir` and
`lc_grep` use the same rule for each path in their batches. `lc_read_file`
reports a missing path for each entry. If uncertain, confirm the root with
`lc_stat`.

A non-absolute root also rejects the complete call with
`Target path must be absolute: <root>`. This absolute-path rule applies to
**every** File I/O tool.

**Skips and hidden entries:** Traversal always prunes these directory basenames: `.git`, `node_modules`, `target`, `__pycache__`, `.venv`, `venv`, `.env`, `dist`, `build`, `.next`, `.nuxt`, `.cache`, `coverage`, `.idea`, `.vscode`. With `include_hidden=false`, a matching entry whose own basename starts with `.` is suppressed after walker descent. A hidden directory outside the fixed list can still be traversed, so an ordinary descendant such as `.github/workflows/build.yml` can match. Zero matches do not prove an excluded path is absent.

`truncated` means traversal stopped because of a limit, deadline, or
cancellation. Limits include result count and visited entries. Cancellation
returns a normal `GlobFilesResult` with `truncated: true`. It preserves matches
collected before traversal stopped. It does not replace the partial result with
an aborted error.

Results include files and directories. Inspect `is_dir`.

---

### lc_grep

Search file contents under directories. Each search has its own path + pattern pair.

```typescript
// Input
{
  searches: Array<{
    path: string               // Directory or file to search (recursive for dirs)
    pattern: string            // Regular expression (escape metacharacters for literal text)
    include?: string           // Per-search include; replaces the batch-wide one
  }>                            // 1–20 entries
  include?: string             // Glob file filter applied to ALL searches (e.g. "*.ts", "*.{py,js}")
  exclude?: string             // Glob file filter that SKIPS matching files, batch-wide
  ignore_case?: boolean        // Default false
  max_results?: number         // Default 1000, hard cap 5000; larger values reject
  context_lines?: number       // 0–10 numbered context lines around each match (content mode only)
  output_mode?: 'content' | 'files_with_matches' | 'count'
  max_matches_per_file?: number // Sampling cap per file; signals proven omissions
  include_excluded_dirs?: boolean // Search inside the always-pruned directories
}

// Output
{
  results: Array<{
    path: string
    pattern: string
    matches: Array<{
      file: string             // Absolute file path
      line: number             // 1-based line number
      content: string          // Matching line, capped at 2000 characters
      content_truncated: boolean
      encoding: 'utf-16le' | 'utf-16be' | null
      before: Array<{ line: number; content: string; content_truncated: boolean }>
      after: Array<{ line: number; content: string; content_truncated: boolean }>
    }>
    files: string[]            // populated in files_with_matches mode; otherwise empty
    counts: Array<{ file: string; count: number }> // populated in count mode; otherwise empty
    truncated: boolean | null  // null means completeness was not determined
    truncated_reason: 'cancelled' | 'deadline' | 'results'
                     | 'match_bytes' | 'bytes' | 'visited' | 'per_file_matches'
                     | null
    error: string | null       // Real failures only; never cancellation
    error_code?: string        // Stable code on an error entry; absent on success
    // Diagnostics are always present, including on error and cancelled entries.
    visited_entries: number    // Directory entries walked
    files_selected: number     // Files chosen for content search after all filters
    bytes_read: number
    skipped_large: number      // Files skipped because >1 MiB
    skipped_binary: number     // Files skipped as binary (extension, NUL byte, or content)
    skipped_symlink: number    // Symlinked files skipped by the walk
    skipped_unreadable: number // Files whose metadata or content could not be read
    files_transcoded: number   // Files decoded from UTF-16 before searching
  }>
}
```

**Diagnostics:** every field above is reported on every entry, so an absent field never has to
be told apart from a zero one. `files_selected` counts **files, not matches** — a search with
`files_selected` above zero and an empty `matches` array means the pattern was absent from those
files.

**Truncation:** on an error-free entry, `truncated_reason` names why
completeness failed or was not determined. A `true` value proves that work or
output was omitted. A `false` value proves that every selected candidate
completed. A `null` value means a spent budget prevented proof either way.

LC checks the current file and one bounded candidate for a further match after
the result budget fills. A found match sets `truncated: true`. A finished search
sets `false`. Remaining unsearched candidates set `null` with reason `results`.
Re-run with a higher `max_results` or a narrower path after a `true` or `null`
value.

Causes use this precedence when LC proves several: `cancelled`, `deadline`,
`results`, `match_bytes`, `bytes`, `visited`, then `per_file_matches`.

**Cancellation:** a normal truncated result with `truncated_reason: "cancelled"` that keeps every
match collected before the stop. An unresolvable path never becomes a grep `error` — the shared
pre-flight (see Batch pre-flight above) rejects the whole call first — so `error` is reserved for
real search-side failures such as an invalid regex. A mixed batch uses a
`partial` envelope with one issue per failed search. If every search fails, the
envelope uses `error` and omits data. Recovery uses `error_code`.

**Binary policy:** A NUL byte in the first 8 KiB marks binary content.
`lc_read_file` uses the same window. Both tools first transcode valid UTF-16
with a byte-order mark. Thus, `cmd /u` output is searchable and readable. LC
skips binary files, unmarked UTF-16, and malformed marked streams. These files
increase `skipped_binary`, so one rejected file cannot fail a complete batch.

**Output modes:** `output_mode: "files_with_matches"` returns matching paths in `files` with an
empty `matches` array. `"count"` returns per-file counts in `counts`. Both spend **one result unit
per file**, not per match, so a count is complete even when a file holds far more matches than
`max_results`. `truncated_reason: "results"` in either mode means the batch ran out of file rows.
Both are far smaller than content mode for broad searches. `context_lines` (content mode only) attaches numbered, capped `before`/`after` lines to
each match, charged to the same matched-content budget.

**Sampling and scoping:** `max_matches_per_file` caps matches per file and moves
on. LC scans the loaded file until another match proves an omission. That proof
sets `truncated: true` with reason `per_file_matches`. An exact cap without a
further match does not claim truncation. `exclude` skips glob-matching files
batch-wide. A search entry's `include` replaces the batch-wide value.
`include_excluded_dirs: true` disables fixed directory pruning.

**Hidden files:** unlike `lc_glob_files` and `lc_list_dir`, which hide dot-prefixed names unless
`include_hidden` is set, `lc_grep` searches them. A match inside a dotfile that `lc_glob_files`
did not list is expected.

**Size ceiling:** grep's 1 MiB limit is the strictest in the tool set. A larger file is still
range-readable, editable, and patchable, but grep only counts it in `skipped_large`.

**Regex behavior:** Patterns are always regular expressions. Invalid regex
returns an error. LC never uses literal search as a fallback. Escape regex
metacharacters when you intend literal text.

**Fixed skips:** Recursive traversal always prunes these directory basenames: `.git`, `node_modules`, `target`, `__pycache__`, `.venv`, `venv`, `.env`, `dist`, `build`, `.next`, `.nuxt`, `.cache`, `coverage`, `.idea`, `.vscode`. It always skips files with these extensions: `exe`, `dll`, `so`, `dylib`, `bin`, `png`, `jpg`, `jpeg`, `gif`, `ico`, `webp`, `bmp`, `woff`, `woff2`, `ttf`, `eot`, `pdf`, `zip`, `tar`, `gz`, `7z`, `rar`. Zero matches do not prove text is absent from an excluded path or type.

**Batch preflight:** Every `searches[].path` must resolve before execution. One
missing path rejects the **complete call** with `path_resolution_failed`. The
error names the path, and no search runs. `lc_list_dir` and `lc_glob_files` use
the same behavior. `lc_read_file` reports missing paths per entry.

If uncertain,
confirm paths with `lc_stat`. A non-absolute path also rejects the complete call
with `Target path must be absolute: <path>`. This absolute-path rule applies to
**every** File I/O tool.

**Edge cases:** One call accepts 1–20 searches. `include` applies to ALL searches in the batch
unless a search sets its own value. The shared glob engine supports `*`, `**`,
`?`, `[abc]`, and `{ts,tsx}`. Directory matching uses root-relative paths
normalized to `/`. A single-file target matches its basename.

An empty
`include` filter searches all non-excluded files. An invalid `include` fails the
complete call with `invalid_glob_pattern`.

The searches share result, visited-entry, byte-read, matched-content, and
deadline budgets. They consume the budgets in `searches` order, so put
important searches first. `truncated=true` means that a search stopped early.
`truncated_reason` identifies the limit, deadline, or cancellation. Files above
the 1 MiB limit increase `skipped_large`.

---

### lc_edit_file

Replace exact strings in one or more files. Each file change is atomic through
a temporary file and rename. Batch entries commit independently. A later
failure does not roll back earlier changes.

```typescript
// Input — batch form, or a flat form for a single file
{
  files: Array<{
    path: string               // Absolute file path
    old_string: string         // Exact text to replace (must appear exactly once)
    new_string: string         // Replacement text
  }>                            // 1–20 entries
  create_if_missing?: boolean  // Default false
}
// Flat single-file form: { path, old_string, new_string, create_if_missing? }
// normalize() converts it to a one-entry batch. The forms are exclusive.
// Missing fields or a mixed form fail validation before filesystem access.

// Output
{
  results: Array<{
    path: string
    replaced: boolean
    occurrences: number        // 1 = success, 0 = not found, >1 = ambiguous (no change made)
    file_exists: boolean
    bytes_before: number
    bytes_after: number
    lines_added: number
    lines_removed: number
    created: boolean           // create_if_missing wrote a new file rather than replacing
    hint: string | null        // Why the edit did not apply, or what to fix
    match_lines: number[]      // 1-based start line of each match when occurrences > 1 (max 20)
    near_match_lines: number[] // 1-based lines that matched only under relaxed whitespace
    error: string | null
  }>
}
```

`create_if_missing` is one top-level flag that applies to every batch entry. A
nested `files[].create_if_missing` is rejected instead of being silently
ignored.

**Size cap:** 32 MiB per target file (matches `lc_apply_patch`). Larger files return `error` without being read.

**Edge cases:** Non-matching `old_string` returns `occurrences: 0, replaced: false` — no exception, safe retry. Multiple occurrences also treated as failure (ambiguous). An empty `old_string` on an existing file is an error, not an ambiguous match.

**Miss diagnosis.** Replacement is strictly exact (apart from line-ending normalization) — `lc_edit_file` never applies a fuzzy match, because a silent wrong edit is worse than a failed one. When the exact match fails, the same comparator ladder `lc_apply_patch` uses for recovery runs here purely to explain the miss, and `hint` reports the most specific cause:

| Cause | `hint` says | `near_match_lines` |
|---|---|---|
| Trailing whitespace differs | Copy the file's trailing whitespace into old_string. | Matching lines |
| Leading or trailing whitespace differs | Copy the file's leading and trailing whitespace into old_string. | Matching lines |
| First line matches, rest drifted | Reread the file and copy current text | First-line hits |
| First requested line is absent | Reread the file and verify the path. Later requested lines can still exist. | Empty |

---

### lc_apply_patch

Apply multi-file edits in one call. Uses OpenCode patch format.

**Recommended model procedure:** Read each existing target first. For updates,
use one bare `@@` hunk. Copy the exact lines from the file. A leading space
keeps a line. `-` removes it, and `+` adds it.

Put replacements in the same
hunk. `Add File` does not need `@@`. Put `Move to` immediately after
`Update File`. Use `lc_edit_file` for one simple file replacement.

```typescript
// Input
{
  patch: string                // Full patch text (max 1 MiB)
}

// Output
{
  files: Array<{
    action: string             // "add" | "update" | "delete" | "move"
    path: string
    move_to: string | null
    hunks_applied: number
    lines_added: number
    lines_removed: number
    warnings: string[]
    error: string | null       // Per-file commit-time error (stale source, I/O, etc.)
  }>
  summary: string              // Human-readable summary, for example "A foo.md, D bar.txt"
  fully_applied: boolean       // true only if ALL file actions succeeded
}
```

**Format (patch-language filesystem paths, not JSON string literals):**
```
*** Begin Patch
*** Add File: D:\path\to\new.md
+Content for the new file...

*** Update File: D:\path\to\existing.txt
@@
-old line
+new line

*** Update File: D:\path\to\old-name.txt
*** Move to: D:\path\to\new-name.txt
@@
-old content
+new content

*** Delete File: D:\path\to\remove.txt
*** End Patch
```

**Edge cases:**
- Put add content directly after `*** Add File:`. It does not need an `@@`
  header. For compatibility, LC accepts positional headers such as `@@ 1,0`
  and omits them from the created file. Prefix a literal leading `@@` content
  line with `+`.
- Update hunks accept bare `@@`, unified range headers such as
  `@@ -1,2 +1,3 @@`, and positional shorthand such as `@@ 1,2`. They also
  accept named context such as `@@ function_name`. Range numbers are
  compatibility metadata. The hunk body controls matching. Start each hunk
  body line with a space, `-`, or `+`.

  Represent a blank context line with one
  space. Each `@@` starts a separate hunk, not an old/new block pair. Put
  replacement `-` and `+` lines in one hunk.
- Use `lc_read_file` first and provide exact context. If exact matching fails, the bounded matcher tries `rstrip`, trim, then Unicode-normalized matching and returns warnings when a fallback is used. Unchanged context lines retain their original source text even when matched fuzzily, so source indentation, trailing whitespace, and punctuation are not rewritten.
- Native target discovery first parses and canonicalizes every source and destination without authorizing file access. Malformed or unsafe targets fail without a permission prompt. LC then requests every ungranted exact canonical directory, runs a fresh full native preflight against the expanded approved roots, verifies that its targets exactly match discovery, and executes only the issued plan ID.
- Denial performs no mutation. Once/conversation approval and already-granted
  calls run a new full preflight. Multi-target approval does not broaden a
  target to an enclosing root.
- Concurrent patch calls reserve the global patch queue before discovery and retain that reservation through authorization, preflight, and execution. This prevents a later patch from validating stale filesystem state while an earlier patch is still pending.
- LC prepares deterministic parse, path, context, and action failures before
  the first commit. Therefore, they cause no mutation. A later filesystem
  failure can leave earlier files committed. Check `fully_applied` and each
  file result.
- Native cancellation stops before the next file commit. Files committed
  before that checkpoint remain listed as applied. Every remaining file gets
  `cancelled before this file was changed`, and `fully_applied` is false.
- `*** Move to:` is a secondary header. Put it immediately after
  `*** Update File: <source>`. A pure rename can end without an `@@` hunk.
  Include normal hunks to edit content during a move. It is not a standalone
  action header.
- Add and `*** Move to:` destinations are no-clobber. Existing destinations and same-canonical-path moves are rejected.
- Updates preserve UTF-8 BOMs, LF/CRLF style, and final-newline state. `*** End of File` is supported as an EOF-only hunk anchor.
- Patch text is limited to 1 MiB, each existing target to 32 MiB, and all prepared output to 64 MiB per call.
- Reapplying a patch is not generally idempotent: after a replacement changes its source context, the same patch normally fails unless its original hunk still matches. Call-level duplicate suppression is separate from patch semantics.

---

### lc_run_shell

Execute an approval-controlled shell command.

```typescript
// Input
{
  cmd: string                  // Canonical: one binary name (e.g. "cmd", "python", "git")
  args?: string[]              // Arguments array
  cwd?: string                 // Explicit value must be an existing directory under an allowed root
  timeout_ms?: number          // Default 30s, hard cap 120s
  env?: Record<string, string> // Extra environment variables
  stdin?: string               // Exact data for stdin, including whitespace (max 1 MiB as UTF-8)
}

// Output
{
  stdout: string
  stderr: string
  exit_code: number | null     // null on timeout
  duration_ms: number
  timed_out: boolean
  stdout_truncated: boolean
  stderr_truncated: boolean
}
```

The canonical model-facing form is `{"cmd":"git","args":["status","--short"]}`: one executable in `cmd`, with every argument in `args`. Full command strings previously accepted in `cmd` remain supported for archive/model compatibility, but are not the advertised form.

**Windows:** cmd.exe built-ins are not stand-alone executables. They include
`echo`, `dir`, `cd`, `type`, `rmdir`/`rd`, `del`/`erase`, `copy`, `move`, and
`set`. Invoke them with `{"cmd":"cmd","args":["/c","..."]}`. The allowlist
must include `cmd`. Before approval and audit storage, LC normalizes explicit
`cmd /c` requests to `cmd /d /u /c`.

The approval popup shows this normalized
call. `/d` disables AutoRun, and `/u` requests Unicode built-in output. The
`/c` command tail remains one string to preserve embedded quotes and spaces.
LC does not silently correct bare built-ins. Their structured error includes a
machine-readable `suggested_call`.

**Working directory:** An explicit `cwd` is canonicalized under the allowed roots and must already exist as a directory. An empty or whitespace-only `cwd` is treated as omitted. Missing paths, files used as directories, and out-of-root paths have distinct structured codes. Otherwise LC uses the first allowed root, then the system temporary directory.

**Timeout:** Model-facing validation rejects `timeout_ms` above 120,000. It
does not silently shorten it. A timeout returns `timed_out: true`,
`exit_code: null`, and capped output captured before termination. User
cancellation returns a separate aborted status.
**Stdin:** Up to 1 MiB of UTF-8 data, validated in JS and enforced again by Rust before spawn.  

**Env:** LC copies only a small parent allowlist, clears nine dangerous loader/runtime variables, and applies ordinary explicit overrides. Overrides cannot restore the dangerous names (case-insensitive on Windows), and secret-shaped override names are ignored. This is scrubbed but not claimed to be hermetic isolation.

A launched process always returns the process-result shape above. This rule
also applies to nonzero exits and text such as “cannot find” or “spawn.” Launch
errors use structured issue codes: `executable_not_found`, `cwd_not_found`,
`cwd_not_directory`, `cwd_outside_roots`, `permission_denied`,
`windows_builtin_requires_cmd`, or `spawn_failed`. LC retains native reason and
code fields when available. These issues set `retryable: false`. LC does not
retry shell calls automatically. A corrected call requires new approval unless
the concealed grandmaster setting applies.

> **Secret master virtual binary:** Adding `*****` to the shell allowlist
> bypasses the binary name check entirely — the model can invoke any
> binary. All other sandboxing (env filtering, byte-accurate I/O caps, timeout,
> CWD sandboxing) remains active, and the permission popup still fires
> on every invocation. This is a power-user escape hatch with zero UI
> surface. See [tools.md](tools.md#secret-master-virtual-binary-) for implementation details.

> **Secret grandmaster virtual binary:** Adding `*******` (seven stars) to
> the shell allowlist implies the master behavior (any binary) **and
> auto-approves** — the permission popup is suppressed on every invocation.
> All other sandboxing remains active. It is the only allowlist entry that
> disables the human-in-the-loop prompt, and is strictly more permissive
> than `*****`. Same zero-UI-surface escape hatch. See
> [tools.md](tools.md#secret-grandmaster-virtual-binary-) for details.

---

### lc_web_fetch

Fetch a URL and return its text content.

```typescript
// Input
{
  url: string                  // Full URL (http/https only)
  max_bytes?: number           // Default 1 MiB, hard cap 32 MiB
  timeout_ms?: number          // Default 10s, hard cap 30s
  strip_mode?: 'minimal' | 'clean' | 'raw'  // Default 'minimal'
}

// Output
{
  body: string
  status: number
  final_url: string            // After redirects
  content_type: string
  truncated: boolean
}
```

**SSRF blocked:** LC blocks registered non-global IPv4 and IPv6
special-purpose targets. These include loopback, private, link-local, ULA,
documentation, and reserved ranges. It also blocks IPv4-mapped IPv6, local-use
translation, discard-only, Dummy IPv6 Prefix, and SRv6 SID space. The globally
reachable well-known NAT64 prefix remains available. Embedded non-global IPv4
is blocked.

Globally reachable exceptions in `192.0.0.0/24` and `2001::/23`
remain available. LC disables automatic redirects. A bounded manual loop
resolves, validates, and pins each hop. Blocked redirects return `blocked_host`,
not a successful 3xx.
**Strip modes:** `minimal` keeps `<script>` blocks (SPA-friendly), `clean` removes all HTML tags, `raw` returns unmodified.

The model-facing schema rejects values above the 32 MiB body limit or 30,000 ms
timeout. It does not silently clamp them. The native boundary has the same
defensive limits for direct calls.

User cancellation returns the shared `aborted` tool envelope. LC does not use
HTTP `status: 0` or put cancellation text in `body`.

---

### lc_web_search

Search the web via the user's configured provider: Brave Search, a self-hosted SearXNG instance, or Marginalia. Exactly one serves a call — there is no fallback chain. Generation admission captures the provider from settings. Calls and re-streams reuse it. Callers without a snapshot resolve current settings separately. The model never chooses the provider. See [`search-providers.md`](../search-providers.md).

```typescript
// Input
{
  query: string                // Search query
  max_results?: number         // Default 5, max 10
  freshness?: 'pd' | 'pw' | 'pm' | 'py'  // Past day/week/month/year
                               // Or YYYY-MM-DDtoYYYY-MM-DD. Brave only.
  extra_snippets?: boolean     // Brave only
}

// Output
{
  results: Array<{
    title: string
    url: string
    snippet: string
    extra_snippets: string[]   // Brave only; empty when unavailable/not requested
  }>
  source: string               // "brave" | "searxng" | "marginalia"
  ignored_params: string[]     // Empty when every supplied parameter was honoured
}
```

**Provider differences.** `source` always names the backend that actually served the call. Generation admission captures the tool description with the active provider. Calls and re-streams reuse it. The description warns that an absent Marginalia result does not imply the information does not exist.

`max_results` above 10 is rejected by the model-facing schema rather than silently clamped. The native provider boundary retains the same defensive ceiling for direct invocations.

The wire schema for `freshness` is a single `type: "string"` with one regex
covering empty/whitespace input, the four presets, and the custom range. No tool schema uses `anyOf` or
`allOf`: those keywords cause strict OpenAI-compatible backends (including
LM Studio) to reject the whole `tools` payload.

| Parameter | Brave | SearXNG | Marginalia |
|---|---|---|---|
| `query` | ✅ | ✅ | ✅ |
| `max_results` | ✅ | ⚠️ Capped client-side. The instance ignores it. | ✅ |
| `freshness` `pd`/`pw`/`pm`/`py` | ✅ | ✅ mapped to `time_range` | ❌ reported |
| `freshness` `YYYY-MM-DDtoYYYY-MM-DD` | ✅ | ❌ reported | ❌ reported |
| `extra_snippets` | ✅ | ❌ reported | ❌ reported |

Capability decreases in a consistent order — Brave, SearXNG, Marginalia —
because of how each backend is built, not how good its results are. **Marginalia
has no recency filter of any kind**, so a query needing recent material should
prefer another provider rather than expecting `freshness` to work.

On SearXNG the four freshness presets map 1:1 onto `time_range`
(`pd`→`day`, `pw`→`week`, `pm`→`month`, `py`→`year`). Only a custom date range
has no equivalent. The filter reaches only those engines the instance has
enabled that support it, so its strength varies per instance.

Native parameters LC does not expose (per-provider country/language/category
options, Marginalia's per-domain cap) are catalogued in
[`search-providers.md` § Native parameters LC does not use](../search-providers.md#35-native-parameters-lc-does-not-use).
LC deliberately keeps one
parameter set across all providers so the model never needs to know which
backend is active.

Unsupported parameters are **reported in `ignored_params`, never silently dropped**. Without that signal a model asking for last-week results receives all-time results with nothing to indicate the difference, and presents them as recent.

**No provider configured:** the tool remains exposed (exposure is governed solely by `web_access_enabled` — see [TOOL-POLICY-MODEL](./TOOL-POLICY-MODEL.md) §3.3) and returns an error naming all three options.

**Retries:** Transient network errors are retried within the call deadline. Cancellation covers retry waits, response reads, and all active research children. Response and error bodies are bounded at 2 MiB, and error previews truncate on Unicode character boundaries.

**Provider-specific failures** carry an actionable hint rather than a bare status code:

| Condition | Message adds |
|---|---|
| Marginalia `429` | The shared `public` key allows approximately 3 queries per minute. Request a free key for more capacity. |
| SearXNG `403` | The instance has not enabled JSON output — add `json` under `search.formats` in its `settings.yml` and restart |
| SearXNG `429` | The instance's limiter is limiting LC. Set `limiter: false`. |
| SearXNG returns nothing and every engine failed | Names the failed engines and states this is an instance problem, not an absence of information |

---

### lc_web_research

Research a topic: one cost-aware search by default → diverse candidate selection → adaptive page fetching → sub-agent LLM synthesis with cited sources. Uses the same configured provider as `lc_web_search`.

```typescript
// Input
{
  query: string                // Research question or topic
  max_results?: number         // Desired usable sources (default 5, max 10)
  preferred_domains?: string[] // Up to 5 hostnames; focused search when present
  cross_check?: boolean        // With preferred_domains, also run one broad search
                               // (2 logical search calls instead of the normal 1;
                               //  ignored on Marginalia — see below)
  freshness?: 'pd' | 'pw' | 'pm' | 'py'
                              // Or YYYY-MM-DDtoYYYY-MM-DD
  extra_snippets?: boolean    // Brave only; reported in research_info.ignored_params
}

// Output
{
  query_used: string
  summary: string              // Sub-agent LLM synthesis with inline citations
  sources: Array<{
    url: string
    title: string
    snippet: string
    discovery: 'broad' | 'preferred' | 'both'
    extra_snippets: string[]
  }>
  research_info: {
    search_mode: 'broad' | 'focused' | 'cross_check'
    provider: string                   // Backend that served this run
    ignored_params: string[]           // Params the provider could not honour
    search_requests_used: number       // Logical calls; excludes native retries
    preferred_domains: string[]
    matched_preferred_domains: string[]
    preferred_sources_fetched: number
    fetch_requests_used: number        // Direct page requests, including retries
    distinct_hostnames: number
  }
  confidence_note: string | null // Non-null when evidence quality is limited
}
```

Without `preferred_domains`, the tool makes one broad search call. With preferred domains it makes one focused `site:` search and verifies returned hostnames literally (`host === domain` or a subdomain match). `cross_check: true` deliberately adds one broad search and interleaves both candidate pools. `cross_check` has no extra effect without preferred domains. Native transport retries are not included in `search_requests_used`.

**On Marginalia, `cross_check` is ignored** and reported in `research_info.ignored_params`. The shared `public` key sustains roughly 3 queries per minute, so a single research call with cross-check would exhaust the budget on its own. LC cannot detect a private key's tier, so the conservative path is the default.

Preferred domains must be hostnames, not URLs or paths. They are query-specific relevance hints, never automatic trust labels. The main chat model may supply domains it confidently knows, the user may name them directly, and an active personal skill may define source preferences. When uncertain, omit them and use broad search.

Each logical search asks for at most 10 candidates. `max_results` is the
desired number of usable fetched sources. It is not the search-pool size. LC
removes tracking variants and favors hostname diversity. It fetches in batches
of four. It rejects unsuccessful, empty, or blocked pages. LC retries sparse
HTML once with `minimal` extraction.

LC uses remaining candidates from the original search pool to replace
failures. Backfill does not use another search call. It stops after
`max_results + 3` candidate attempts or 10 total candidate attempts.

Cancellation or the inherited tool-round deadline stops later batches. Each
new search or fetch timeout uses the remaining parent budget. Cancellation
uses the shared execution group to abort active native children.

If one cross-check search fails, LC waits for the sibling search to settle.
Then LC reports the failure. Therefore, a search child cannot outlive its
parent tool.

Fetched content is capped separately from the synthesis prompt. LC gives the sub-agent at most 160,000 characters for the complete user prompt—including instructions, source labels, titles, URLs, separators, and truncation notices—and at most 40,000 body characters per source. It labels source provenance, treats preferred domains as hints rather than authority, and instructs the model to ignore commands embedded in untrusted pages.

The synthesis request asks for at most 4,000 output tokens. LC also requires
non-whitespace visible text of at most 64 KiB in UTF-8. A blank or oversized
answer fails with a bounded model-output issue instead of becoming `summary`.

**⚠️ Risk of a confident but incorrect answer:** The sub-agent can create a
plausible but incorrect answer for a niche topic. Inspect citations and
`research_info`. If `confidence_note` is not null, cross-check important
claims. Enable the paid second search only if independent discovery justifies
its cost.

---

### lc_get_current_time

Return current date and time. Pure JS, no backend round-trip.

```typescript
// Input
{
  tz?: string                  // IANA timezone, at most 255 characters. Default: OS timezone
  format?: 'iso' | 'rfc2822' | 'unix_ms'  // Default 'iso'
}

// Output
{
  time: string                 // Formatted per requested format; ISO uses ±HH:MM, RFC 2822 uses ±HHMM
  tz: string                   // Actual timezone used (may differ from requested if invalid)
  unix_ms: number              // Always included regardless of format
  tz_warning: string | null    // Non-null for invalid tz. Names the field and actual timezone
}
```

**Edge cases:** The runtime validates timezones with `Intl.DateTimeFormat`.
This accepts valid aliases and supported names such as `UTC`, `Asia/Kolkata`,
and `Asia/Kathmandu`. An empty `tz` uses the OS local timezone without a
warning. Invalid names still return a successful result. `tz` then contains the
system timezone, and `tz_warning` names the rejected field without echoing its
value. RFC 2822 output uses
the requested timezone's numeric offset, such as `+0900` or `-0400`.

---

### lc_todo_write

Replace the complete structured task list for the current conversation. The
tool is pure JS and is exposed whenever Workspace is on with a tool-capable
provider. It has no category toggle, settings row, grant, or permission popup.

```typescript
// Input
{
  todos: Array<{
    id: number                 // Stable, unique, positive safe integer
    title: string              // Trimmed, 1–120 characters
    status: 'not-started' | 'in-progress' | 'blocked' | 'completed'
    note?: string              // Trimmed, 1–240 characters when present
    completion_evidence?: string // Model-reported, trimmed, 1–240 characters
  }>                            // Min 1, max 20 entries
}

// Existing ToolResultEnvelope. The list remains only in the call arguments.
{
  status: 'ok'
  data: {
    completed: number
    blocked: number
    total: number
  }
  issues: []
  warnings: string[]
}
```

**Rules:** Send the complete list on every call. A call replaces the prior
list. IDs can be sparse or reordered, but each item keeps one stable ID. Zero
or more items can be in progress. Every blocked item requires a note. The outer
object and each item reject unknown fields. Malformed state returns a precise
`invalid_arguments` issue with `retryable: false`.

Completion evidence is optional and model-reported. LC does not verify it. One
successful warning names all completed task IDs that omit it. Empty or
whitespace-only values are omission. Invisible-only supplied text is invalid.

Each successful call and matching result form an immutable snapshot. LC
reconstructs the list from the normalized call arguments and uses the count-only
result as success proof. The shared selector scans at most 4,096 stored
messages and accepts at most 64 KiB of result content after no more than 256
recognized leading LC notices.

Tool History keeps its generic archive stub. When that stub hides the source
call, LC appends one incomplete current-list projection to the request-only copy
of the latest real user message. It does not change stored content or the
system prompt. The projection includes every ID, title, and status, the first
in-progress note, and the first five blocked notes. It omits completion evidence
and reports omitted active or blocked notes. A completed list is not projected.

The Preview Overlay To do list tab resolves the latest state of each logical
list from the selected assistant message's user turn up to that message. The
**Settings → Chat → To-do list preview** preference controls which resolved
lists are presented. **latest only** is the default and shows the final visible
logical list; **all updates** shows the complete ordered multi-list view. Copy
uses the same visible selection. This preference changes presentation only; it
does not alter stored snapshots or the model-visible request projection. The
same complete set of stable task IDs and a strict majority of unchanged titles
match one list update. This permits minority title refinements but keeps unrelated
lists that reuse IDs separate. A longer replacement also matches when its
ordered unchanged titles form a strict majority of the prior snapshot and at
least half of the new snapshot. This collapses an evolving list when inserted
tasks renumber later IDs. The rule applies only to growth, so a shorter nested
or sub-task list remains separate. Status, note, evidence, and order changes do
not create duplicate sections. A selected turn with no accepted update up to
that message shows the empty state; it does not inherit a previous turn's
effective snapshot. The UI does not otherwise infer nesting between lists.
Only a message that directly owns a successful snapshot gets the bubble
checklist button. In **all updates**, when more than one list is visible, each
summary starts with `List n:`. A single visible list keeps the summary without a
redundant number.

Todo state is model-maintained progress metadata, not an authoritative record
of executed work. A model can run later tools or finish the request without a
final todo update, so the latest accepted snapshot can be stale. LC preserves
it without inferring completion, adding list-level lifecycle values such as
`stalled` or `pass_to_next_turn`, blocking the final response, or starting an
extra reconciliation call. A projected incomplete list is saved state for
context; it is not a command to repeat work.

---

### lc_ask_user

Ask the user from one through three structured questions when a missing choice
can materially change the current work. The tool is exposed whenever Workspace
is on with a tool-capable provider. It has no category toggle, settings row,
grant, or permission popup.

```typescript
// Input. Every object is strict and rejects unknown fields.
{
  questions: Array<{
    id: number                  // Unique positive safe integer
    question: string            // Trimmed, 1–240 characters
    choices: Array<{
      title: string             // Trimmed, unique in this question, 1–80 characters
      description?: string      // Trimmed, 1–160 characters when present
    }>                           // Min 2, max 5 choices
  }>                             // Min 1, max 3 questions
}

// Existing ToolResultEnvelope.
{
  status: 'ok'
  data: {
    answers: Array<
      | { id: number; answer: string }
      | { id: number; skipped: true }
    >
  }
  issues: []
  warnings: []
}
```

LC pauses the current tool round and schedules its request in the strict FIFO
application interaction queue shared with permission prompts from every
conversation. One global modal presents the visible request and shows its
owning conversation title and exact model ID with accent-highlighted values.
Conversation, generation, assistant, and tool-call
ownership is checked at enqueue, visibility, and delivery, so a cancelled or
replaced background request cannot receive a late answer. Each question accepts
one listed choice, one custom answer of at most 500 trimmed characters, or Skip.
The custom text area
starts at two lines, grows through five lines, and scrolls from line six.
Selecting a listed choice or Skip automatically advances when another question
remains in a multi-question request; Custom stays on the current question.
Previous and next navigation preserves answers. The question starts with its `(n/total)` count,
and the horizontal navigation pair sits in the bottom action row immediately
before Done. Its buttons match the action-button height. Skip is left-aligned,
and Done is available after every question has an answer or skip.

Escape, backdrop clicks, and a close icon do not dismiss the modal. Parent
generation cancellation, conversation teardown,
host teardown, and app close still settle the call. The user wait has no
ordinary operational deadline. Time behind an earlier interaction is excluded
from operational tool deadlines. A separate 30-minute absolute attention cap
bounds the complete queued/visible lifetime, and a later tool round receives a
fresh normal deadline. A five-second host-registration timeout and
`ask_user_ui_busy` are defensive presentation-host fallbacks; the application
FIFO normally prevents concurrent requests from contending at that host.

`lc_ask_user` must be the only model-declared call in its batch. If the batch
contains another call, LC executes no sibling. Otherwise-valid admitted calls
receive `interactive_tool_must_run_alone`; prior JSON, schema, ID, unknown-name,
and exposure errors remain specific. Each admitted call ID receives one
matching result. Suppressed results use declared order. Normal concurrent tool
results keep completion-order persistence.

The answers are user input carried through a `role: "tool"` result so provider
call/result pairing remains valid. LC inserts no synthetic user message. Tool
History applies its normal generic stubbing after the turn. A hidden answer can
be retrieved through `lc_tool_history`; LC adds no automatic answer projection.

---

### lc_whiteboard

Read both conversation Markdown boards or change only the model-owned board.
The tool is exposed only when Workspace and Whiteboard are on and the provider
supports structured tool calling. It has no grant or permission popup. Board
content is never injected automatically into the system prompt or ordinary
messages; the model must call this tool explicitly.

```typescript
// Input. The object is flat and strict; unknown fields are rejected.
{
  action: 'read' | 'replace' | 'edit'
  content?: string             // replace only: complete model-board Markdown
  old_string?: string          // edit only: one non-empty exact occurrence
  new_string?: string          // edit only: exact replacement; empty deletes
}

// Successful read
{
  status: 'ok'
  data: {
    refs: {
      user_board: string
      model_initial_board: string
      model_latest_board: string
    }
    user_markdown: string
    model_markdown: string
  }
  issues: []
  warnings: []
}

// Successful replace or edit
{
  status: 'ok'
  data: {
    refs: {
      user_board: string
      model_initial_board: string
      model_latest_board: string
    }
    changed: boolean
    model_bytes: number         // Resulting UTF-8 bytes, not characters
  }
  issues: []
  warnings: []
}
```

**Action rules:** `read` accepts only `action`. `replace` requires `content`
and accepts no edit fields. An empty `content` clears the model board. `edit`
requires `old_string` and `new_string`, accepts no `content`, and interprets no
Markdown. `old_string` must have nonzero string length and occur exactly once;
whitespace-only exact matches are valid. `new_string` can be empty. The
optional-string normalizer preserves empty and whitespace-only values for this
tool because they can be meaningful content.

Each board holds at most 32 KiB (32,768 bytes) of UTF-8 Markdown. LC checks the
complete result after replace or edit and never truncates it. Identical replace
content and an edit whose result is identical return `changed: false` and
create no provisional version. Mutation output does not echo the board; call
`read` when the resulting Markdown is needed.

**Turn visibility and versions:** A read returns the user version pinned when
the turn started and the latest applied model state from that same turn. It
does not return a saved pending user edit or accept a historical version ID.
User edits made during generation appear to the next turn. Changed model
mutations share one provisional record during the turn, and terminal settlement
retains at most one new model version. The three references use conversation-
scoped owner-prefixed IDs (`u_...` and `m_...`).

**Batch rule:** One exact `lc_whiteboard` call can run beside ordinary
noninteractive tools. If a model-declared batch contains two or more exact
Whiteboard calls, every such call receives `whiteboard_batch_conflict` before
any Whiteboard handler runs. Unrelated siblings keep their ordinary behavior.
Whiteboard has no special per-turn call or read limit; global tool-round limits
still apply.

**Stable issues:**

| Code | Retryable | Additional data and recovery |
|---|---:|---|
| `invalid_arguments` | No | Send exactly one valid action shape. |
| `whiteboard_not_initialized` | Yes, after repair | Retry once after LC repairs initialization; otherwise continue without the board. |
| `whiteboard_version_missing` | No | The pinned or current retained ID is unavailable; do not retry that ID. |
| `whiteboard_read_failed` | Yes | Retry one read, then continue without the board if it repeats. |
| `whiteboard_write_failed` | Yes | Retry after storage is available; read before a later exact edit. |
| `whiteboard_old_string_not_found` | No for the same input | `suggestions` has at most three model-board candidates of at most 160 UTF-8 bytes each. A total miss returns no suggestions and says to read first. |
| `whiteboard_old_string_not_unique` | No for the same input | `occurrence_count` is complete; `excerpts` contains at most three locations of at most 160 UTF-8 bytes each. |
| `whiteboard_too_large` | No for the same input | `limit_bytes` and `measured_bytes` report the exact UTF-8 sizes. |
| `whiteboard_batch_conflict` | No for that batch | No Whiteboard call in the batch ran. Send one intended call later and wait for it. |
| `timeout` | No | The owning generation timed out before the operation committed. No change was applied by that call; read in a later turn. |
| `aborted` | No | The owning generation ended before the operation completed. Read in a later turn before continuing. |

Not-found suggestions and non-unique excerpts come only from the model board;
they never disclose the user board. Matching for the actual edit remains exact.

**Tool History privacy:** Canonical conversation storage and conversation
archives keep the original calls and results. With Tool History off, provider
requests replay those complete historical values. With Tool History on,
completed turns use generic archive stubs and the active turn stays complete.
When `lc_tool_history` retrieves an archived Whiteboard result, that item has
action-only arguments and a fixed redacted output notice. An owning
`message_id` lookup, or exact `tool_call_id` lookup for any result whose
assistant has Whiteboard references, adds the owning turn's optional
`whiteboard_refs` once at the top level.
List and broad search do not repeat references. Search can match the tool name,
call ID, action, or fixed redaction notice, but never indexes board Markdown
or mutation payloads.

---

### lc_tool_help

Get bounded guidance for one exposed tool. This read-only local tool does not
read files, run a shell command, use the network, or call another model.

```typescript
// Input. Unknown properties are rejected.
{
  tool: string       // Required. 1–80 characters after trimming.
  query?: string     // Optional. 160 characters and 8 distinct terms maximum.
}

// Existing ToolResultEnvelope. data.mode is the help mode.
{
  status: "ok"
  data: {
    mode: "basic" | "matched" | "no_match" | "ambiguous" |
          "not_exposed" | "already_returned" | "limit_reached"
    requested_tool: string
    resolved_tool?: string
    correction?: "normalized" | "alias" | "unique_typo_match"
    guidance?: string
    matches?: Array<{ section: string, guidance: string }>
    available_keywords?: string[]
    suggestions?: Array<{ tool: string, purpose: string }>
    message?: string
  }
  issues: []
  warnings: []
}
```

Omit `query` for basic guidance. A query searches only the resolved tool's
catalog. Matching is NFKC-normalized, case-folded, lexical, and deterministic.
Title and alias matches rank before guidance-text matches. LC returns at most
three sections, 12 keywords, three name suggestions, and 16 KiB of serialized
output. Optional fields are absent when they do not apply.

The tool can resolve a curated alias or one confident normalized name error.
It reports every correction in `correction`. An operational call with the same
misspelled name is never executed under the correction. An unexposed tool
returns `not_exposed` without detailed guidance.

The per-turn governor processes accepted help calls in batch-index order. It
allows six total attempts, three guidance results, and two unresolved lookups.
Repeated tool-and-query pairs consume only the total counter and return
`already_returned` without the repeated body. Counters saturate at their limits.
Malformed help calls consume the total counter and keep their normal
`invalid_arguments` envelope. There is no list mode, catalog revision,
embedding search, external search, or nested model call.

Interactive isolation rejects a complete mixed batch before help admission.
Therefore, rejected help siblings do not change any help counter.

Detailed catalogs currently exist for `lc_grep`, `lc_read_file`,
`lc_read_pdf`, and `lc_whiteboard`. A known exposed tool without a detailed
catalog returns `no_match`.

<!-- lc-tool-guidance-sync:catalog-index:start -->
This table is checked against the typed guidance catalogs. Edit the catalog first.

| Tool | Purpose | Help keywords | Advanced sections |
|---|---|---|---|
| `lc_grep` | Search file contents with regular expressions. | `regex`, `include`, `exclude`, `output modes`, `truncation`, `budgets`, `encoding`, `U+FFFD`, `excluded files`, `diagnostic counters` | `Regular expressions`, `Include and exclude globs`, `Output modes`, `Truncation and budgets`, `Encoding and replacement characters`, `Excluded files`, `Diagnostic counters` |
| `lc_read_file` | Read text files and focused line ranges. | `line ranges`, `size limits`, `encoding`, `UTF-16`, `binary files`, `safe writes`, `SHA-256`, `U+FFFD` | `Line ranges`, `Size limits`, `Encoding`, `Binary files`, `Safe writes`, `Replacement characters` |
| `lc_read_pdf` | Read and summarize PDF files. | `exact text`, `provenance`, `page ranges`, `force render`, `vision requirements`, `scans`, `summary limits`, `summarize`, `summary-free reads`, `tables`, `charts`, `truncation` | `Summary-free reads`, `Exact text and provenance`, `Page ranges`, `Vision requirements`, `Summary limits`, `Tables and charts`, `Truncation and budgets` |
| `lc_whiteboard` | Read both conversation boards or change only the model board. | `ownership`, `read visibility`, `replace`, `exact edit`, `size limits`, `turn versions` | `Ownership`, `Read visibility`, `Replace`, `Exact edit`, `Size limits`, `Turn versions` |
<!-- lc-tool-guidance-sync:catalog-index:end -->

---

### lc_tool_history

Retrieve archived tool call results from previous conversation turns. When
tool history is enabled, completed turns' tool results are replaced with
stubs in context. This tool lets the model retrieve specific past results
on demand. Pure JS — reads from the conversation store.

```typescript
// Input
{
  message_id?: string          // Assistant message id whose tool results to retrieve
  tool_name?: string           // Filter to a specific tool (e.g. 'lc_grep')
  tool_call_id?: string        // A specific tool_call id (exactly one result)
  query?: string               // Lexical search over this conversation's archive;
                               // max 512 characters and 16 distinct terms.
                               // Mutually exclusive with tool_call_id.
  max_results?: number         // Search hits returned (default 10, hard maximum 50)
  max_result_bytes?: number    // Max total bytes returned (default 65536, range 1–524288)
                               // Individual results also capped at 262144 bytes head+tail
}

// Output (with filters — message_id or tool_call_id)
{
  message_id: string | null
  whiteboard_refs?: {          // Owning assistant turn only; message/exact lookup
    user_board: string
    model_initial_board: string
    model_latest_board: string
  }
  total_archived: number       // Results matching this lookup/filter
  returned: number             // Results actually returned (after caps)
  truncated: boolean           // true if byte cap was exceeded
  truncated_bytes: number      // Available output bytes omitted by caps; zero when complete
  available_message_ids: string[] // Real ids offered after a miss; otherwise empty
  coverage_pct: number         // Percentage of available bytes returned (0–100), e.g. 88.99
  results: Array<{
    tool_call_id: string
    tool_name: string
    arguments: string          // Ordinary tools: original JSON. Whiteboard: action only.
    output: string             // Ordinary result, or fixed Whiteboard/unresolved redaction.
    output_truncated: boolean  // true if per-result cap was hit
    is_error: boolean
    duration_ms: number
    created_at: number | null  // Epoch ms timestamp
  }>
  summary: []
}

// Output (list mode — no filters)
{
  message_id: null
  total_archived: number       // Total tools across all turns
  returned: number             // Tool calls covered by the summary entries —
                               // same unit as total_archived, not a row count
  truncated: boolean           // true when summary entries exceed the byte cap
  truncated_bytes: number
  available_message_ids: string[]
  coverage_pct: number
  results: []
  summary: Array<{
    type: "summary"
    message_id: string
    tool_count: number
    tools: string[]
  }>
}

// Output (search mode — query present)
{
  query: string                // The original query text, echoed back
  eligible_calls: number       // Archived calls left after message_id/tool_name filters
  scanned_calls: number        // Calls actually examined before a bound was reached
  scanned_bytes: number        // UTF-8 bytes actually examined
  matched_calls: number        // Calls that matched, before result caps
  returned: number             // Hits in this response
  truncated: boolean           // true when any bound was reached
  truncation_reasons: Array<   // Empty when not truncated
    'scan-call-limit' | 'scan-byte-limit' | 'time-limit' |
    'result-count-limit' | 'result-byte-limit'
  >
  scan_coverage_pct: number    // scanned_calls / eligible_calls, 0–100
  hits: Array<{
    message_id: string
    tool_call_id: string       // Always valid for exact retrieval
    tool_name: string
    matched_fields: Array<'tool_call_id' | 'tool_name' | 'arguments' | 'output'>
    snippet_field: 'tool_call_id' | 'tool_name' | 'arguments' | 'output'
    snippet: string            // Verbatim substring of the stored field
    snippet_truncated: boolean // true when the byte cap cut the context window
    output_bytes: number
    is_error: boolean
    created_at: number | null
  }>
}
```

All non-search modes use one complete envelope: `message_id`, `truncated_bytes`,
`available_message_ids`, `coverage_pct`, `results`, and `summary` are always
present. Non-applicable values are `null`, `0`, or `[]`. A missing field never
has to be distinguished from a clean zero result. Search mode likewise always
returns `truncation_reasons` (empty when complete) and `created_at` (nullable)
on every hit.

**Query modes:**

| Mode | Parameters | Returns |
|---|---|---|
| **List turns** | (none), or `tool_name` alone to filter | Structured `summary: [{message_id, tool_count, tools}]` entries. No full payloads. |
| **Turn lookup** | `message_id` | All results for that assistant message |
| **Filtered** | `message_id` + `tool_name` | Results matching the tool within that message |
| **Specific** | `tool_call_id` | Exactly one result |
| **Search** | `query`, optionally narrowed by `message_id` and/or `tool_name` | Ranked `hits` with snippets and retrievable `tool_call_id`s |

**Search mode.** `query` searches only the current conversation's archived
`tool_call_id`, `tool_name`, `arguments`, and `output` values. It performs no
network request, embedding call, model call, migration, or cross-conversation
lookup, and builds no index or secondary database.

For query and candidate text, LC groups each code point with its immediately
following Unicode combining marks. LC applies NFKC and locale-independent
lowercasing separately to each group. This does not provide whole-string NFKC
equivalence. For example, decomposed Hangul Jamo `\u1100\u1161` does not match
the precomposed syllable `\uac00`. Use `tool_call_id` for exact retrieval when
equivalent spellings do not match. Snippets quote the unchanged original.
Matching is lexical and deterministic, ranked in this order:

1. Exact `tool_call_id`
2. Exact `tool_name`
3. Exact phrase
4. All distinct query terms present
5. Number of distinct matched terms
6. Newer `created_at`
7. Lexical `tool_call_id` order

`snippet` is always a literal substring of the stored field — no ellipsis or
marker is ever inserted, so a snippet can never be mistaken for content LC
synthesized. `snippet_field` names which field it came from, because
`matched_fields` can name several. `snippet_truncated` reports byte-cap cutting
instead of adding visible truncation text.

Hard limits are 512 query characters and 16 distinct query terms. A scan
examines at most 2,000 calls, 8 MiB total, and 1 MiB per field. It also has a
1,500 ms time limit. A response has at most 50 hits, 512 bytes per snippet, and
the existing `max_result_bytes` budget. The scan yields every 32
calls so a large history cannot freeze the renderer.

Reaching any bound
returns partial deterministic results with `truncation_reasons` and
`scan_coverage_pct`. The elapsed-time fail-safe is the one bound whose stopping
point can vary between runs, and it is always reported as `time-limit` rather
than presented as a complete miss. A non-empty query plus a non-empty
`tool_call_id` is rejected because the two select different modes. Empty or
whitespace-only optional strings are normalized to omission before mode
selection. This tolerates constrained decoders that serialize every optional
field as `""`.

A query over either input cap is rejected with the exact limit
and a narrowing remedy. No query text or term is silently dropped.

**Edge cases:** When `message_id` is provided but not found, returns
`{ message_id, total_archived: 0, returned: 0, truncated: false, results: [], available_message_ids: [...] }`
(no `error` field). `available_message_ids` lists up to 20 real archived turn
IDs. Without this list, a miss looks like a turn that archived nothing. A
guessed ID would cost a round trip without giving the model new information.
The same field accompanies a `tool_call_id` that matches nothing.

Results from
the active assistant turn are excluded. This matches the context-stubbing
boundary. `max_result_bytes` applies to list, message, and direct-call modes.
It also applies to the first oversized result. Truncation preserves valid UTF-8
and does not exceed the requested byte count.

Each result's `output` has a 256 KiB limit.

**Whiteboard projection:** `lc_tool_history` never returns archived board
Markdown or mutation payloads. A resolved `lc_whiteboard` result keeps only
`{"action":"read"}`, `{"action":"replace"}`, or `{"action":"edit"}` in
`arguments`, and `output` becomes a fixed redaction notice. Message lookup and
exact call lookup add the owning assistant message's `whiteboard_refs` once at
the top level when that assistant has them, even when the exact result is an
ordinary sibling tool. List mode and search mode do not return those
references for each result. Search indexes only the projected action, tool
name, call ID, and fixed redaction notice,
not `content`, `old_string`, `new_string`, `user_markdown`, or
`model_markdown`.

If a stored tool result cannot be matched to its owning assistant tool call,
retrieval fails closed. It reports `tool_name: "unknown"`, empty arguments,
and a bounded generic redaction notice. That unresolved item is excluded from
all search candidates, including searches for its call ID or the invented
`unknown` name.

**Exposure:** Archiving/stubbing occurs only when resolved exposure contains
`lc_tool_history`, which requires both Workspace and Tool History to be on.
Workspace off never creates a stub that tells the model to call an unavailable
tool. When Tool History is off, provider requests keep complete historical
Whiteboard calls and results just like all other explicit tool history; the
reference-only rule applies only to retrieval through `lc_tool_history`.

---

### lc_skill

Discover and retrieve user-enabled Markdown guidance. Pure JS. Resolves
built-in skills from the LC built-in registry and custom skills from the
current conversation's `custom_skills` list. Has no filesystem, network,
shell, or permission popup behavior.

```typescript
// Input
{
  id?: string                 // At most 256 characters. Omit, empty, or whitespace selects list mode
}

// Output (list mode)
{
  mode: "list"
  skills: Array<{
    id: string
    name: string
    description: string
    revision: number
    source: "builtin" | "custom"  // LC-owned vs conversation-imported
  }>
}

// Output (retrieve mode)
{
  mode: "skill"
  source: "builtin" | "custom"
  skill: {
    id: string
    name: string
    description: string
    content: string            // Full Markdown body
    revision: number
  }
}

// Output (limit error)
{
  mode: "error"
  code: "skill_limit_exceeded" | "skill_result_too_large"
  message: string
  total?: number
  limit?: number
  limit_bytes?: number
}
```

**Skill sources.** Built-in skills use stable LC-owned IDs (e.g.
`lc:builtin:lc-tools`) and are shipped with LC — they are
not editable, deletable, or importable. Custom skills are imported
per-conversation from Markdown files through the Workspace side panel.
Each receives a conversation-scoped UUID. Both built-in IDs and
custom UUIDs are valid in `enabled_skill_ids`.

`lc_skill` is exposed only when Workspace and Skills are enabled. Its list
and retrieve results are filtered by the conversation's `enabled_skill_ids`.
Unavailable IDs return a structured `skill_unavailable` result. Full Markdown
is returned on demand and is not injected into the system prompt automatically.
List mode accepts at most 100 enabled skills. A larger list returns
`skill_limit_exceeded` with the observed count and the limit. The model does
not receive a silently incomplete list.

The complete serialized list or retrieve result has a 2 MiB UTF-8 limit. A
larger result returns `skill_result_too_large` without partial skill content.
This limit also protects conversations with invalid persisted skill metadata.
Imported Markdown content retains its separate 256 KiB source limit.
The `lc:builtin:lc-tools` record is dynamically materialized from a strict
category-section template: retrieval returns Core plus only the Workspace
categories currently exposed in the structured tool payload.

This filtering
does not change exposure. Its result is a current snapshot rather than fixed
documentation. A later turn should retrieve it directly again instead of using
an earlier call or Tool History copy. User-provided skills are outside LC's
control and can mention unavailable tools. They do not change Workspace
exposure.

---

## Batch Support

| Tool | Field | Semantics |
|------|-------|-----------|
| `lc_read_file` | `paths: string[]` | Same line range options for all. Maximum 20. |
| `lc_read_image` | `paths: string[]` | Same encoding for all. Maximum 20. Analyze processes 10. |
| `lc_read_pdf` | `paths: string[]` | Same depth and page range for all. First 4 paths admitted; summaries run in pairs. |
| `lc_write_file` | `files: [{ path, content }]` | Each file has its own content. Maximum 20. |
| `lc_list_dir` | `paths: string[]` | Process each directory independently. Maximum 20. |
| `lc_stat` | `paths: string[]` | Process each path independently. Maximum 100. |
| `lc_grep` | `searches: [{ path, pattern, include? }]` | Each path has its own pattern and optional include override. Maximum 20. |
| `lc_edit_file` | `files: [{ path, old_string, new_string }]` | Each file has its own replacement. Accepts 1–20. |
| `lc_apply_patch` | N/A (single `patch` string) | Multi-file via patch format |
| `lc_whiteboard` | N/A (one flat action) | At most one exact Whiteboard call per model-declared batch. It can run beside ordinary noninteractive tools. |

Every collection shown here, plus `lc_read_pdf.paths` and
`lc_todo_write.todos`, requires at least one entry. Empty arrays fail validation
with a field-specific remedy instead of reaching a handler as a no-op.
Per-entry errors don't abort the batch.

---

## Quick Reference: When to Use Which

| Goal | Use |
|------|-----|
| Check if a file exists | `lc_stat` |
| Read file contents | `lc_read_file` |
| Find files by name pattern | `lc_glob_files` |
| Search file contents | `lc_grep` |
| Create/modify files one at a time | `lc_edit_file` |
| Multi-file refactor | `lc_apply_patch` |
| Read images for vision models | `lc_read_image` |
| Read a PDF | `lc_read_pdf` |
| Quote a clause or total from a PDF | `lc_read_pdf` with `include_text: true` |
| Run a command | `lc_run_shell` |
| Get current time | `lc_get_current_time` |
| Fetch a webpage | `lc_web_fetch` |
| Search the web | `lc_web_search` |
| Research a topic | `lc_web_research` |
| Track multi-step progress | `lc_todo_write` |
| Read both conversation boards | `lc_whiteboard` with `action: "read"` |
| Replace the complete model board | `lc_whiteboard` with `action: "replace"` |
| Change one exact model-board occurrence | `lc_whiteboard` with `action: "edit"` |
| Retrieve past tool results | `lc_tool_history` |
| Get detailed guidance for one exposed tool | `lc_tool_help` |
| Retrieve Markdown guidance | `lc_skill` |
