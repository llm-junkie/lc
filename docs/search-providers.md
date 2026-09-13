# Search providers

**Audience:** Maintainer and contributors
**Updated:** 2026-08-06
**Affects:** `lc_web_search`, `lc_web_research`, Settings → Workspace, settings export/import

This document explains how LC reaches the web. One of three backends serves
`lc_web_search` and `lc_web_research`. The user selects Brave Search, a
self-hosted SearXNG instance, or Marginalia.

---

## 1. One provider per call

**There is no fallback chain.** Exactly one provider serves each call. Most
other design decisions in this document follow from this rule.

| Decision | Behavior | Why |
|---|---|---|
| Who chooses the provider | User configuration, never the model | The model must not be able to change which index it queries mid-conversation |
| Several configured | Exactly one is used, no cascade | Prevents one rate limit from draining another, and prevents mixed-provenance results |
| Default when several are set | `auto` → Brave > SearXNG > Marginalia | Best index first, with an explicit selector to override |
| Unsupported parameters | Reported in `ignored_params`, never silently dropped | The model must be able to detect an ignored filter. |
| Credentials | User-supplied for every provider | LC ships no shared key and no licence-encumbered default |

A cascade would also make provenance unanswerable. A model told it searched
"the web" that actually received Marginalia results after a Brave rate-limit
would describe an independent-web sample as a mainstream one.

---

## 2. Configuration and resolution

### 2.1 Settings surface

Three credential rows and one chip row in Settings → Workspace provide
configuration (`SettingsPage.tsx`):

```
Brave Search API key   [BSAxxx (Get a key at brave.com/search/api)]  masked, keychain
SearXNG base URL       [http://localhost:8080]                       plain text, Test
Marginalia API key     [••••••••]                                    masked, keychain
Search provider        [auto (brave)] [brave] [searxng] [marginalia]
```

The backing fields are `brave_search_api_key`, `searxng_base_url`,
`marginalia_api_key` (each key also having a `_ref` keychain pointer), and
`web_search_provider: 'auto' | 'brave' | 'searxng' | 'marginalia'`, defaulting
to `'auto'` (`SearchProviderSettings` in
`src/modules/tool-engine/search-provider.ts`). The chips are rendered from
`['auto', ...WEB_SEARCH_PRIORITY]`. Therefore, the row order follows the
priority order without a duplicate list.

**The selector is separate from credentials.** If credentials selected the
provider, a user would have to **delete a Brave key to try SearXNG**. Changing a
mode must not destroy a keychain credential. One settings field prevents this
problem.

**The `auto` chip shows its resolution**, not only the word `auto`. It is labelled
`auto (brave)` from `configuredProviders(tools)[0]`, and `auto (none)` when
nothing is configured. `auto` is the default, so without this the user would
not otherwise know which index they are querying. `auto (none)` also identifies
an unconfigured installation.

Chips for unconfigured providers are **disabled**. Their `title` says what to
do. Examples are `Add a base URL above to select searxng` and `Add a key above to select
brave`. An invalid selection is unreachable through the UI rather than merely
handled downstream. The row's own label carries the no-fallback rule as a
tooltip: *"Exactly one is used — there is no fallback between them."*

**The SearXNG row has a Test button that runs a real search.** The URL persists
on each keystroke, so the button does not save it. It sends a `webSearch` call
through the same Rust path as the tool. A cheaper `HEAD` request or ping cannot
detect a disabled JSON format. Without the test, a `403` for `format=json`
would appear during a conversation as a failed tool call. The test first
validates the `http` or `https` scheme.

On the web build, it explains that the
probe requires the Tauri command. It does not show a raw bridge rejection.

The SearXNG input uses `.api-key-row` styling to match the adjacent rows. Unlike
those rows, it is plain text without masking or keychain storage (§6.2).

### 2.2 Resolution

`resolveSearchProvider()` (and its non-diagnostic twin
`resolveSearchProviderQuietly()`) applies:

```
if provider == 'auto':
    return first configured of [brave, searxng, marginalia]  (or none)
if the named provider is configured:
    return it
otherwise:
    fall back to auto-resolution      # never error on a stale selection
```

**A stale selection falls back instead of returning an error.** A user can remove a
credential while the selector still names it. The selector is a preference, not
a constraint, and a stale preference must not break search.

Two hazards this code exists to defend against, both covered by
`search-provider.test.ts`:

- **Legacy settings have no selector at all.** Zustand's `persist` merges
  shallowly. A `tools` object written before this feature replaces the default
  object. Each new key then arrives as `undefined`. TypeScript still requires
  `web_search_provider`. This behavior crashed the settings panel on first
  load.

  A nested `merge` at the `tools` level fixes the source problem.
  `normalizeSelection()` also treats unknown values as `auto`. The store version
  cannot increase for this change. LC rejects version mismatches and would
  discard the user's settings.
- **A released pin must not linger in the UI.** Resolution falls back correctly
  when a pinned provider loses its credential, but leaving the selector pointed
  at it rendered that chip as active *and* disabled. The user saw it highlighted
  while searches quietly went elsewhere. Clearing a credential now resets the
  selector to `auto` when it named that provider.

### 2.3 Priority order

`WEB_SEARCH_PRIORITY = ['brave', 'searxng', 'marginalia']` (`src/store/settings.ts`),
used only by `auto`.

Brave has the broadest general index. SearXNG aggregates mainstream engines and
requires deliberate self-hosting. Its coverage is broader than Marginalia.
Marginalia has the narrowest index and is last.

### 2.4 No provider configured

Both tools stay **exposed** and fail with `NO_PROVIDER_MESSAGE`, which names all
three options:

> No web search provider is configured. Add a Brave Search API key, a SearXNG
> base URL, or a Marginalia API key in Settings → Workspace.

LC deliberately keeps the tools exposed when no provider is configured.
[`tools/TOOL-POLICY-MODEL.md`](./tools/TOOL-POLICY-MODEL.md) §3.3 defines this
behavior. `web_access_enabled` controls Web Access exposure.
Per-tool checkboxes control pre-granting, not visibility. Exposure that depends
on unrelated settings would break this contract and its tests.

---

## 3. Model-facing contract

### 3.1 The description names the active provider

`ToolHandler.description` has type `string | (() => string)`. `materialize()`
supports the function form. Generation admission captures the resolved search
provider and the materialized structured tool payload. Calls and re-streams
reuse this snapshot. Provider changes apply to later generations.
Callers without a snapshot can materialize descriptions and resolve current
settings separately.

`describe()` in `builtin/web_search.ts` names the **active** provider
concretely and singularly. A shared base carries the result shape and the
`max_results` bounds, then one branch per provider adds its caveats. The
Marginalia branch reads:

> Search the web using Marginalia. Returns titles, URLs, and snippets for each
> result. max_results defaults to 5, hard cap 10. Marginalia indexes
> independent, text-oriented sites and has limited coverage of commercial and
> mainstream pages — **absence of a result here does not mean the information
> does not exist.** "freshness" and "extra_snippets" are not supported and will
> be ignored if supplied.

The emphasized clause addresses Marginalia's index bias (§4.1). A missing result
is common and does not prove nonexistence. Without a configured provider, the
description reports that state. It does not describe an unavailable search.

A matrix of all provider caveats would require the model to infer the active
provider. `search-description.test.ts` covers this behavior.

`describe()` resolves through `resolveSearchProviderQuietly()` rather than
`resolveSearchProvider()`. Materializing a description does not execute a
search. Emitting a diagnostic there would record resolutions that never served
a call.

### 3.2 `ignored_params`

A description states the contract. The result provides evidence. `WebSearchOutput.source`
carries the real provider, and any parameter the active provider cannot honour
is listed:

```jsonc
{ "results": [...], "source": "marginalia", "ignored_params": ["freshness"] }
```

This field makes an ignored filter *detectable*. Without it, a model can request
last-week results and receive all-time results. It has no indication of the
difference and can report them as recent.

The per-provider map is `UNSUPPORTED_PARAMS` in `search-provider.ts`. The
per-call computation is `ignoredParamsFor()`, which also handles the values
SearXNG supports conditionally (§3.4).

### 3.3 Parameter parity

This table shows parameter behavior for each backend. ✅ means that the provider
honors it. ⚠️ means that LC compensates. ❌ means that `ignored_params` reports it.

| Tool parameter | Brave | SearXNG | Marginalia |
|---|---|---|---|
| `query` | ✅ | ✅ | ✅ |
| `max_results` | ✅ `count` | ⚠️ `count` **ignored** — capped client-side | ✅ `count` |
| `freshness` presets `pd`/`pw`/`pm`/`py` | ✅ | ✅ → `time_range` (§3.4) | ❌ |
| `freshness` custom `YYYY-MM-DDtoYYYY-MM-DD` | ✅ | ❌ | ❌ |
| `extra_snippets` | ✅ | ❌ | ❌ |

The ordering is stable across every axis and tracks how each backend is built
rather than how good it is. Brave sells an API and has the parameter surface to
justify the price. SearXNG is a proxy over other engines, so it can only pass
through what they support. Marginalia is a single independent index built to
surface non-commercial pages. **It has no recency filter.** This is a provider
characteristic, not a defect
in LC's mapping.

> **Every cell in this table is a claim about shipped behavior and needs a test
> behind it.** The `freshness` custom-range row was once marked ✅. However,
> the Brave URL builder silently dropped the value. The validator checked
> `len() == 21` with dashes at offsets 15 and 18, but the real value is **22**
> bytes with dashes at 16 and 19, so the branch was dead. `ignored_params`
> stayed empty because the TypeScript layer correctly believed Brave supported
> it, and `lc_web_research` then told its sub-agent
> `[Freshness: results limited to …]`. This false claim reached the
> user-facing summary. No test exercised the URL builder. The table was also
> based on the input schema instead of the shipped code path. The builder is now
> an extracted, testable `brave_url()`
> with a byte parser that validates digits, covered by `brave_url_tests` in
> `src-tauri/src/tools/web_search.rs`.

### 3.4 SearXNG freshness mapping

All four Brave presets map 1:1 onto SearXNG's `time_range`:

| Brave | SearXNG |
|---|---|
| `pd` | `day` |
| `pw` | `week` |
| `pm` | `month` |
| `py` | `year` |

**`week` is absent from SearXNG's published API docs**, which list only
`[day, month, year]`. A live instance accepts it and rejects anything outside
`day|week|month|year` with HTTP 400. The documentation is incomplete. A future
reader might remove `week` based on that documentation.
`searxng_time_range_tests::week_is_supported_despite_being_absent_from_the_docs`
exists to stop that.

LC does not forward an unrecognized value because SearXNG returns 400 outside
its set. This would fail the complete search, not skip the filter. Only the
custom date range cannot be mapped, and it is
reported in `ignored_params`.

SearXNG applies `time_range` only to **engines that support it**, so the
strength of the effect depends on the instance's engine mix. LC cannot detect
this. It is operator configuration, not a per-call result.

The tool schema remains static and advertises all parameters. The
description and `ignored_params` carry the truth. Varying the JSON schema per
provider is possible because `materialize()` calls the `toJsonSchema()` function.
However, it would invalidate the `CACHED_SCHEMA` optimization and
change the tool contract mid-conversation. Reporting is cheaper and sufficient.

### 3.5 Native parameters LC does not use

LC deliberately exposes one parameter set across all providers rather than a
per-provider surface. The model does not need to know which backend is active.
This table records unused parameters for future changes.

| Provider | Available but unused | Note |
|---|---|---|
| Brave | `country`, `search_lang`, `safesearch`, `offset`, `result_filter` | |
| SearXNG | `categories`, `language`, `pageno`, `safesearch` | |
| Marginalia | `dc` (max results per domain), `nsfw`, `timeout` (50–250 ms query execution), `page`, `filter` | **Documented, not verified** — probing hit the `public` key's ~3 QPM limit |

`dc` is the interesting one. `lc_web_research` favours hostname diversity in
client code through deduplication, batching, and distinct-host preference.
`dc=1` would move that behavior to Marginalia. LC does not use it because it is
unverified and applies to one provider only. Provider-specific branching in the
research path costs more than it saves.

---

## 4. Provider characteristics

Measured on 2026-08-03 against live endpoints. These figures are the reason for
several design choices above. **These figures can change. Measure them again
before use.**

### 4.1 Marginalia

The API is `https://api2.marginalia-search.com/search`, documented at
`about.marginalia-search.com/article/api/`. The key goes in an `API-Key` header.

The older `api.marginalia.nu/{key}/search/{query}` endpoint still responds but
**must not be used**. Approximately one third of cold queries do not return.
A 45-second timeout confirmed that these were hangs, not slow responses. The
current endpoint returns failures promptly and explicitly.

| Property | Measured |
|---|---|
| Auth | Mandatory. No header returns `400`. An invalid key returns `401`. |
| `public` key | Valid, needs no signup, but shared globally |
| `public` rate limit | `429 QPM Limit Exceeded` in ~0.2 s. Approximately 3 queries/min are sustainable. |
| Success latency | ~0.33 s |
| Result shape | `results[]` with `url`, `title`, `description`, `quality`, `format`, `resultsFromDomain`, `details` |
| Parameters | `count` (1–100), `page`, `dc`, `nsfw`, `timeout` (50–250 ms), `filter` |

**Index bias is by design.** Marginalia deliberately indexes the small and
independent web. `openai pricing` returned a personal blog about building a
pricing calculator, not `openai.com`. `best noise cancelling headphones`
returned a Linux community page. It is strong on technical and independent
content and weak on commercial and mainstream-factual queries. This is why the
model must be told which index it is querying (§3.1).

**The rate limit controls `lc_web_research`.** Broad, focused, and `cross_check`
modes can each call `doSearch`. One `lc_web_research` call can exhaust the
`public` key budget. Therefore, Marginalia uses one broad or focused search.
`preferred_domains` selects the focused form.

`ignored_params` reports that `cross_check` was ignored. A non-public key might
have a higher limit, but LC cannot detect its tier. It uses the lower limit by
default.

### 4.2 SearXNG — self-hosted only

**There is no usable public SearXNG endpoint.** Of 18 instances tested from the
`searx.space` registry:

| Outcome | Count |
|---|---|
| `429` rate-limited on the **first** request | 11 |
| `418` (anti-bot) | 1 |
| `200` but HTML, not JSON | 2 |
| Dead or unreachable | 4 |
| **JSON working** | **0** |

Two independent restrictions prevent public use. SearXNG defaults to
`search.formats: [html]`, so an operator must add `json`. Public operators
usually do not enable it because it exposes an API. The built-in limiter also
blocks non-browser clients. Therefore, LC supports only a user-supplied SearXNG
instance.

Confirmed against a self-hosted SearXNG `2026.8.3` on the LAN:

| Property | Observed |
|---|---|
| Endpoint | `{base}/search?q=…&format=json` |
| Auth | None. The base URL is the complete configuration. |
| Result fields | `url`, `title`, and **`content`**. All 26 results contained these fields. |
| `count` parameter | **Ignored.** The instance returned 26 results when asked for 3 or 5. |
| Result templates | all `default.html` for a text query |
| `unresponsive_engines` | `[["brave","Suspended: too many requests"], …]` |
| LC's `llm-client/1.0` UA | accepted (200) |
| Trailing-slash base URL | works |

Three consequences that are easy to get wrong:

- **The snippet field is `content`**, not `description` as in Brave and
  Marginalia. Getting this wrong yields results with URLs and titles but no
  snippets. This incomplete result can appear valid.
- **`count` must not be sent.** The instance ignores it, so including it would
  imply a limit that is not honored. LC applies the limit after
  parsing instead.
- **`unresponsive_engines` is retained** because it separates "the query matched
  nothing" from "every engine failed". If all engines are rate-limited, the
  instance otherwise returns an empty result set. The result is
  indistinguishable from a genuine miss. The model then reports "no such
  information exists".

**An instance with JSON disabled returns `403` with an HTML body. HTML search on
the same host returns `200`.** Direct tests of `format=json`, `format=csv`, and
`format=rss` returned 403. The default HTML search returned 200, and
`limiter.enabled` was `false`. These results identify the format allowlist, not
bot protection. LC's error names `search.formats` in the instance's
`settings.yml`.

### 4.3 DuckDuckGo is not a provider

| Surface | Result |
|---|---|
| `html.duckduckgo.com/html/` (GET and POST) | HTTP 202, anti-bot challenge page, 0 results |
| `lite.duckduckgo.com/lite/` | HTTP 202, challenge page, 0 results |
| `api.duckduckgo.com` (Instant Answer) | Works, but returns abstracts and disambiguation, not web results |

Tests used a browser user-agent and LC's `llm-client/1.0`. There was no
difference. The response bodies contain 67 occurrences of "anomaly" and three
`<a>` tags. The `result__a` class used by scrapers no longer exists. This is
not an IP block.

The Instant Answer API responded normally from the same
address, returning `Results: 0` for `albert einstein` and `france`, and
`Results: 1` for `python programming language`. It is an encyclopedia lookup,
not a search index.

---

## 5. Licensing

**Marginalia result data is CC-BY-NC-SA 4.0.** Every response declares
`"license": "CC-BY-NC-SA 4.0"` — NonCommercial, Attribution, ShareAlike — and it
applies to the result data LC feeds the model. Free and paid *non-commercial*
keys both carry it. Only a commercial key removes the NC and attribution
requirements. **LC therefore ships no Marginalia key.** The user supplies their
own and accepts the terms attached to their own credential.

**AGPL does not reach LC.** Marginalia's search-engine software and SearXNG are
both AGPL-3.0. That licence does not bind LC. LC issues HTTP requests to a
service someone else operates, which is neither copying, modifying, nor
distributing that software. The AGPL §13 network clause binds the operator of a
modified version, not API clients. Only bundling their code into LC would engage
it.

---

## 6. Security

### 6.1 SearXNG and private addresses

Pointing the SearXNG provider at a LAN or loopback host works and weakens no
existing boundary. The configured SearXNG endpoint is a deliberate exception to
the `lc_web_fetch` SSRF blocklist. Search supports Brave, SearXNG, and Marginalia.
The blocklist in `web.rs` applies to fetched result URLs.

The following conditions explain why this exception is acceptable:

- The base URL is typed by the user into Settings. The model cannot supply,
  influence, or redirect it
- It applies only to the configured SearXNG base URL — not to `lc_web_fetch`,
  and not to any URL derived from a search result
- Result URLs returned by a SearXNG instance are still ordinary untrusted web
  content. The normal `lc_web_fetch` blocklist applies if the model later fetches
  them.

Rust still validates the scheme (`http`/`https` only) as defense in depth
against a hand-edited or imported settings file. See
[`security.md` § Scope: `lc_web_search` is not covered, by design](./security.md#scope-lc_web_search-is-not-covered-by-design).

### 6.2 Key handling

The Brave and Marginalia keys use the same pattern. LC stores the key in the OS
keychain under a reference. It uses plaintext only if the keychain write fails.
If a reference exists, `partialize` in `store/settings.ts` removes the key from
the persisted store.

**Settings export carries the refs, never the keys.** `export.ts` writes
`brave_search_api_key: ''` and `marginalia_api_key: ''` unconditionally, while
exporting `brave_search_api_key_ref`, `marginalia_api_key_ref`,
`searxng_base_url`, and `web_search_provider`. A reference is a keychain
pointer, not a credential. It is unusable when the target machine lacks the
keychain entry. Thus, settings export preserves the provider *choice* without
carrying secrets. See [`data-model.md`](./data-model.md).

LC supports a SearXNG base URL that satisfies the shared
[URL credential rule](./security.md#url-credential-rule). It uses plain text
input without keychain so the user can spot a typo. User-info or a recognized
credential parameter in a query or structured fragment makes the URL
unconfigured. The portable writer removes those credential parts from legacy
state, and settings import rejects them. A nonempty value that is not a valid
HTTP(S) URL is also unconfigured. This includes parseable `data`, `file`, and
`ftp` URLs. Settings import rejects these values, and the portable writer emits
an empty SearXNG value.

Two import-side rules keep the plaintext fallback alive. Settings import
replaces a keyed field only when the file carries the key or its keychain
reference. A file that carries neither keeps the local value. A plaintext key
without a reference exists only in the local store, and export cannot carry it. Erasing
it would destroy the only copy.

And `keychainSet` **rejects** on the web build
rather than resolving without an action. Every caller branches on
`.then(() => true, () => false)`. A successful no-op would route them past the
plaintext fallback and silently drop the entered key.

---

## 7. Diagnostics

`src/modules/tool-engine/search-diagnostics.ts` is the single normalized
boundary for every provider call from either tool. It records success, no results, provider
failure, missing configuration, and allowlisted ignored-parameter names.

It records **no query, no result content, no key, and no exact host**. It records
only the provider identity and outcome. A support report can show that search
resolution failed. It can also show a provider-call failure without carrying
the search query. See
[`support-report.md`](./support-report.md).

---

## 8. Maintenance notes

### 8.1 The export trap

`src/utils/export.ts` lists each tool field **three** times. The field appears in the
exported payload's TypeScript type, in the writer, and in the validator. Adding
a field to only some of them silently drops it from settings export/import.

Both guards run as intended. `tsc` rejects the writer before the type is
updated. Then `settings-export.test.ts` fails with *"This file is not a settings
export from LLM Client"*. The test passes after its fixture contains the new
fields.

### 8.2 Adding a provider

Use `search-provider.ts` as the integration point.

1. Add the provider to `WEB_SEARCH_PRIORITY`, `PROVIDER_LABEL`, and
   `UNSUPPORTED_PARAMS`.
2. Extend `SearchProviderSettings` and `credentialFor()`.
3. Add the branch and response parser in `web_search.rs`.
4. Add the credential row in `SettingsPage.tsx`. Reuse `KeychainKeyRow`.
5. Verify each export location in §8.1.

---

## 9. Known limitations

- **Marginalia's `timeout` parameter is untested.** Its range is 50–250 ms of
  *query execution* time. Whether the default risks truncating result sets on
  complex queries has not been measured.
- **SearXNG result quality varies with instance health.** The verified instance
  had `brave` and `startpage` suspended (rate limit / CAPTCHA) while still
  returning 26 good results from its remaining engines. Results therefore depend
  on which engines are healthy. This can explain a change in SearXNG result
  quality.

---

## 10. Tests

| File | Covers |
|---|---|
| `src/modules/tool-engine/search-provider.test.ts` | Resolution, priority, stale pins, legacy settings, ignored params |
| `src/modules/tool-engine/search-description.test.ts` | Per-provider dynamic tool descriptions |
| `src/modules/tool-engine/search-call-diagnostics.test.ts` | Resolution and call outcomes through the shipped resolver and the shipped `lc_web_search` / `lc_web_research` handlers |
| `src-tauri/src/tools/web_search.rs` — `brave_url_tests` | Presets, the custom range, junk rejection, `count`, `extra_snippets`, encoding |
| `src-tauri/src/tools/web_search.rs` — `searxng_time_range_tests` | The 1:1 preset mapping, including undocumented `week` |
| `src/platform/keychain-web.test.ts` | Web-build keychain semantics: reads miss, deletes/warm-up no-op, writes reject |
