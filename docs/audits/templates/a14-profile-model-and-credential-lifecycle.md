# A14 — Profile, model, and credential lifecycle

**Template code:** `A14` · **Version:** 1.0 · **Status:** Active

> Codes are stable identifiers. Never reuse a code, and never reassign one.
> Record `A14 v1.0` in the audit that uses this template. A major version change
> means that the invariants or the matrix changed. Audits that ran against
> different majors are not comparable.

**Siblings:** [`a03-protocol-adapters.md`](./a03-protocol-adapters.md) for wire
behavior. [`a05-state-and-persistence.md`](./a05-state-and-persistence.md) for
storage mechanics. [`a12-privacy-and-redaction.md`](./a12-privacy-and-redaction.md)
for outbound boundaries and stored-secret boundaries.

---

## Scope

**In.** `src/modules/server-profiles/`, the generation snapshot capture/cache,
and the profile-aware admission seam. This covers profile creation and
activation, model discovery and enrichment, live and cached registries,
metadata overrides, models.dev data, credential lookup and fallback, settings
projection, cross-server routing, and the generation snapshot taken when a
request starts.
It includes helper-route resolution, the bounded shared model-detail
single-flight cache, per-caller cancellation, snapshot-adjacent secret runtime
state, global profile/model mutation guards, and the per-profile generation
limiter seam.

**Out.** Provider-contract matching semantics, controls, carrier/replay rules,
and envelope parsing
([`a03-protocol-adapters.md`](./a03-protocol-adapters.md)). A14 owns the exact
profile/protocol/model inputs and immutable resolved-contract identity handed to
that layer. General persistence
serialization ([`a05-state-and-persistence.md`](./a05-state-and-persistence.md)).
Native command hardening ([`a11-security-and-sandbox.md`](./a11-security-and-sandbox.md)).
Startup graph isolation ([`a13-startup-and-recovery.md`](./a13-startup-and-recovery.md)).

## Invariants

1. **Identity is exact.** A model is identified by its owning `profileId`
   together with its `modelId`. Punctuation, case, and model IDs that contain
   colons must not collapse distinct records.
2. **Registry layers stay separate.** Detected metadata, user overrides,
   effective display metadata, and active projections have distinct ownership
   and precedence. A refresh cannot silently overwrite an override.
3. **Live and cached states are honest.** A failed refresh falls back only to a
   clearly identified compatible cache. It never presents stale data as live,
   and it never mixes in models from another profile.
4. **Active selection is valid.** Activation, deletion, import, and fallback
   preserve a valid active projection of profile and model, or expose an
   explicit unavailable state. None of them routes a request through an
   unrelated profile.
5. **Credential authority is explicit.** LC prefers data from the desktop
   encrypted key store. It uses the plaintext or browser fallback only when the
   documented backend is unavailable. That fallback is diagnosable, and LC never
   treats it as encrypted secret storage.
6. **Overrides have lifecycle semantics.** Stale, orphaned, imported, removed,
   and re-created overrides of a profile or model behave deterministically. They
   do not leak across identities.
7. **Generation snapshots are immutable and complete.** A request continues
   with the profile, model, endpoint, capability metadata, helper routes,
   system prompt, Workspace roots/configuration, tool exposure, model registry
   and detail, resolved provider contract/version, transport timeout, and
   tool-round limits captured at the start.
   Credentials remain in adjacent runtime state rather than the serializable
   snapshot. Only the generation's explicit authorization overlay may grow
   after capture.
8. **Discovery and caches are bounded.** Model lists, enrichment work, retries,
   diagnostics, and persisted cache entries have explicit limits. They also
   release stale profile data.
9. **Shared discovery does not share cancellation authority.** Concurrent
   snapshot captures may deduplicate one model-detail request. Cancelling one
   caller cannot cancel siblings; the final waiter can abort the underlying
   lookup. Only successful results enter the 32-entry, 60-second cache, and
   configuration changes invalidate it deliberately.
10. **Profile/model mutation scope is application-wide while sessions depend on
    it.** Delete, credential rotation, model load/unload, import/reset, and
    other invalidating operations cannot change the authority of a live or
    provisional generation. Ordinary navigation and target-safe conversation
    operations remain available. A per-profile concurrency limit refuses only
    later admissions for that profile and does not cancel admitted siblings.

## Check matrix

| Axis | Required variations |
|---|---|
| Profile lifecycle | Create, activate, rename, duplicate, delete the active profile, delete an inactive profile, import, export, unavailable credential |
| Model identity | The same model ID on two profiles. IDs that contain colons, slashes, and publisher prefixes. Model removal and reappearance |
| Registry layers | Detected metadata, an override, effective metadata, override removal, a stale or orphan override, conflicting fields |
| Refresh | Live success, live timeout or error, compatible cache fallback, an empty live result, and a profile switch during a refresh |
| Credentials | The encrypted desktop store, a key-store failure, the browser or dev fallback, settings export and import, diagnostics, key deletion |
| Routing | One request per profile, two and three requests on one profile, requests split across profiles, cross-server helper selection, capability and protocol changes, a configured per-profile limit, and attempted profile mutation during provisional and streaming ownership |
| Generation snapshot | Main route plus every configured helper route; Workspace roots and toggles; system prompt; tool exposure and round limits; model registry/detail; exact protocol/origin/path/model contract resolution and registry version; transport timeout; credential/runtime separation; authorization granted mid-run; and Settings/profile/model changes after capture. Frozen fields do not drift |
| Shared model detail | Two and three concurrent callers for one key, distinct keys, one caller abort, final caller abort, success reuse inside 60 seconds, expiry, failure then retry, cache invalidation, and pressure past 32 entries |
| Bounds | A large model list, repeated refresh, many overrides, repeated profile create and delete, failed enrichment and retry |
| Parity | Browser and dev against packaged desktop. Cold install. Upgrade with existing profile data |

## Domain-specific evidence rules

- **Trace one identity end to end.** Start at the settings row. Follow the exact
  profile and model key through discovery, effective metadata, routing,
  credential lookup, request creation, and persistence.
- **Mutate while several requests are running.** A settings change made after
  capture must not rewrite any request's snapshot or credential choice. An
  invalidating profile/model mutation attempted before capture handoff or while
  streaming must fail before changing shared authority.
- **Cancel one shared discovery waiter.** Prove the sibling receives the result
  and that only cancellation of the final waiter aborts underlying work. A
  single-caller cache hit does not exercise cancellation ownership.
- **Test absence as well as presence.** Cache fallback, missing overrides,
  deleted profiles, and unavailable credentials are where accidental
  cross-profile reuse appears.
- **Never infer secret safety from a type.** Inspect the actual key-store,
  export, diagnostic, and request paths. A field called `apiKey` is still
  sensitive.

## Known-load-bearing context

- [`modules.md`](../../modules.md#server-profiles-profile-lifecycle-model-data)
  holds the contracts for profile and model identity, discovery, cache,
  override, and routing.
- [`data-model.md`](../../data-model.md) holds the persisted representations of
  profile, model, cache, and credential.
- [`search-providers.md`](../../search-providers.md) holds settings-backed
  provider selection and its user-owned endpoint boundary.
