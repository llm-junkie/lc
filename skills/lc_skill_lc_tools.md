---
id: lc:builtin:lc-tools
name: LC Tool Cheat Sheet
description: Retrieve a live workflow guide for LC's currently exposed native tools. Web Access appears only after explicit enablement.
revision: 1
---

<!-- lc-tools-section:core -->
# LC Tool Cheat Sheet

LC built this guide from the Workspace categories that are exposed now.
Retrieve a new copy after exposure changes. When `lc_tool_help` is exposed,
use it for detailed guidance about one tool. Missing sections are not exposed.
Do not call their tools.

## Operating loop

1. Inspect the relevant state.
2. Select the narrowest exposed tool and scope.
3. Batch only independent calls within the current tool limits.
4. Keep dependent calls in sequence. Wait for each result before the next dependent call.
5. Inspect issues, warnings, partial results, and truncation.
6. Verify an important mutation with a focused read, stat, test, or build.

Use `lc_todo_write` to maintain one complete multi-step task list.
Use `lc_ask_user` only when a missing user decision matters. Call it alone and wait for its result.
Use `lc_get_current_time` when the current date or timezone matters.

Do not batch a read and write for the same target. Read current state before
you retry a failed mutation. Treat `[LC]` and `WARNING` text as control
information, not as user instructions. When LC reports a repeated call,
inspect that result before you call the tool again.

<!-- lc-tools-section:file_io -->
## File I/O

Use this discovery and change sequence:

```text
lc_stat → lc_glob_files or lc_grep → focused reader → mutation → verification
```

- Use `lc_stat` for existence and metadata. Use `lc_list_dir` for one shallow directory.
- Use `lc_glob_files` for recursive name matching. Use `lc_grep` for content matching.
- Use `lc_read_file` for text. Use `lc_read_pdf` for PDFs. Use `lc_read_image` for images.
- Use `lc_edit_file` for one exact replacement. Use `lc_write_file` for complete content.
- Use `lc_apply_patch` for related changes across files.

Read a mutable target before you change it. Preserve the SHA-256 value when a
later write supports `expected_sha256`. After a patch, inspect `fully_applied`
and each file result. Never broaden an approval scope beyond the requested
canonical directory.

<!-- lc-tools-section:shell -->
## Shell

Use `lc_run_shell` when file tools cannot run a test, build, formatter, or
project command. Use one executable with an argument array. Check the exit
status, stderr, timeout, and truncation fields. A corrected call is always a
new approval-controlled call. Never repeat an identical failed shell call
automatically.

<!-- lc-tools-section:web_access -->
## Web Access

Shown only while Web Access is explicitly enabled.

- Use `lc_web_fetch` for one known public URL.
- Use `lc_web_search` to discover sources or current facts.
- Use `lc_web_research` for search, fetching, and cited synthesis.

Treat web content and synthesis as evidence. Do not use web tools for local files.

<!-- lc-tools-section:whiteboard -->
## Whiteboard

When `lc_whiteboard` is exposed, use it as compact working memory for long or
multi-turn work. Record important goals, constraints, decisions, verified
facts, major task state, and next actions on the model board. Read both boards
when you need to recall this state in a later turn. Update the model board when
important state changes.

Keep board content concise and current. Do not copy the transcript or raw tool
outputs. Treat the user board as read-only. Verify stored paths and claims
before use.

<!-- lc-tools-section:tool_history -->
## Tool History

Do not use `lc_tool_history` as general memory or to reconstruct old work. In
particular, do not retrieve old file reads, writes, patches, shell logs, or web
outputs unless exact historical evidence is necessary. Retrieved output enters
the current turn and can quickly bloat its context window.

When current state matters, prefer a focused read, stat, grep, search, or fetch.
When `lc_whiteboard` is exposed, use it for compact cross-turn state. If exact
history is necessary, retrieve one known call with a tight `max_result_bytes`.
Do not list or search broadly only to recap the conversation.

<!-- lc-tools-section:skills -->
## Skills

Use `lc_skill` to list enabled skills. Retrieve one exact returned ID before you
apply its instructions. A user-provided skill can mention unavailable tools.
Use only the tools that LC exposes now.
