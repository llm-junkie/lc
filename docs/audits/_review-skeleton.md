<!--
  Copyright 2026 LC Contributors

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->

# Review of `<run-id>` — <domain>

**Review skeleton version:** 1.2

| Field | Value |
|---|---|
| **Audit reviewed** | `<run-id>.md` |
| **Audit branch** | `<run-id>` — exactly the run id, with no `.md` suffix |
| **Template** | `ANN v<major>.<minor>` — the same pair the audit recorded. For A16, also verify the fixed subcode in audit §1 |
| **Reviewer** | who — **must not be the auditor** |
| **Reviewed** | YYYY-MM-DD |
| **Audit's `Audited at`** | the hash the audit recorded. Verify that it resolves, and that it predates the fixes |
| **Auditor handoff commit(s)** | `<full commit hash> — recommendation` for every review round. A later hash invalidates an earlier acceptance |
| **Review tree state** | `clean` at the exact handoff commit |
| **Recommendation** | Accept \| Accept with corrections \| Reject |

File this as `logs/<run-id>__review__{reviewer}.md`, beside the audit. It carries
the **audit's** timestamp, not the time you reviewed it.

For an A16 subrun, verify that the run code matches the fixed subcode in audit
§1. Reject a renamed or narrowed semantic scope. Also reject an A16 audit that
claims the verdict of another audit template or repeats that template's full
matrix without a documentation claim that requires the evidence.

Commit only this review file to the audit branch. The commit that adds the
review is not the auditor handoff you reviewed; record that earlier, immutable
handoff hash in the table above.

**You cannot close this audit, and you cannot edit the audit record.** Your
output is this file, and it is a recommendation the maintainer acts on. If the
audit needs changes, say precisely what. The auditor makes them, and a follow-up
review confirms them.

Write one paragraph on whether the audit's verdict is supportable on its own
evidence, and on what you had to correct to say so.

**A review is not scored by the number of defects it adds.** Zero product
findings and zero review findings are valid successful outcomes. At LC's current
maturity, false positives and unnecessary remediation are primary review risks.
Try to disprove each finding before you search for anything the auditor missed.

**Follow the LC writing guideline.** Write all new or changed technical prose in
pragmatic mode from
[`skills/lc_skill_ste100.md`](../../skills/lc_skill_ste100.md). Preserve facts,
conditions, scope, uncertainty, requirement strength, and technical literals.
Use one term for each concept. Keep this skeleton as the record format. Complete
the guideline's self-check before each review commit. Do not claim official or
certified ASD-STE100 compliance.

Check the auditor's changed prose for ambiguity and inconsistent terms. Report
a writing defect only when it changes meaning, weakens evidence, or makes an
instruction unsafe or unclear. Do not request style-only rewrites. Do not change
correct text only to make the review look productive.

---

## 1. What a review is

An audit is a claim that someone checked a subsystem. A review is a claim that
the **checking** was sound. Those two claims need different evidence.

Re-reading the audit and agreeing with it is not a review. It inherits every
mistake the auditor made. The whole value is in the places where you go back to
the source and get a different answer.

**Four failure modes actually occur.** They are listed here in the order of how
often they slip through.

1. **The concern became a fix before it became a finding.** The auditor found
   code that looked risky, inferred a desired design, changed the code, and
   wrote a test that asserts the new design. That proves only that the new code
   matches the new test. *Identify the owning contract, reproduce the failure at
   `Audited at`, and where practical run the regression test against that base.*
   If the old behavior was not wrong, the finding is wrong even when the branch
   is internally consistent.
2. **The number came from the document.** The auditor read a figure out of the
   documentation, then confirmed that the documentation contains that figure. It
   is circular, and it reads exactly like verification. *Re-derive every number
   from source or from measurement first, and compare afterwards.*

   A real case: an audit recorded "`sandbox-bridge.ts` interface: 14 methods,
   matching the block in `modules.md`". The interface had 17 methods, and the
   doc block was the thing that was wrong.
3. **The sweep was narrower than the declared scope.** The audit says it covers
   X and Y, then greps only X. The verification step inherits the same
   narrowing, so it reports clean. *Take the scope statement from §1 of the
   audit, and run each check again against the full declared surface.*

   A real case: an audit declared docstrings in `src/` and `src-tauri/src/` in
   scope. It fixed six citations in `src-tauri/src`, verified "0 matches"
   against `src-tauri/src` only, and left two live in `src/`.
4. **The checker was trusted.** A scripted result is evidence only if the script
   is evidence. *Run the auditor's scripts yourself, against inputs whose answer
   you know independently.*

## 2. Scope of this review

**Verified independently.** What you re-derived from source, re-measured, or
re-ran. This is not what you read and agreed with.

**Findings challenged.** For every product finding, state how you tried to
disprove it, which living contract makes the audited behavior wrong, whether it
reproduced at `Audited at`, and what concrete impact you confirmed.

**Accepted from the audit without independent check.** Be explicit, and be
honest. A review that claims to have re-derived everything is not credible on
anything.

**Not reviewable here.** Claims that need a runtime, a packaged build, live
credentials, or a platform you do not have.

**Anchor and branch check.** Do this before anything else. Confirm that the
audit's `Audited at` hash and every auditor handoff hash exist, using `git
cat-file -e <hash>`. Confirm that the handoff descends from the base, that the
audit branch name matches the run id, and that the review worktree is clean at
the exact handoff commit. Inspect the complete `Audited at...handoff` diff. Do
not review a moving branch name and do not let a later commit inherit an earlier
acceptance.

An audit whose hash postdates its own remediation cannot be reproduced. Its
`file:line` citations point into the fixed tree, so the findings read as already
resolved. Say plainly which commit you re-derived at. If it is not the audit's
commit, line numbers will have moved.

## 3. Scope conformance

Ask whether the audit's actual work matches the scope it declared.

| Declared in scope (audit §1) | Actually swept | Verdict |
|---|---|---|
| … | … | ✅ / ⚠️ narrower / ❌ not swept |

State the method. For each declared surface, give the command or the read that
proves you covered it. This table is where failure mode 3 dies.

## 4. Invariant tracing

For each invariant the audit lists in its §2, ask two questions. Is it traced to
evidence? Does that evidence support it?

| # | Invariant | Audit's evidence | Holds? |
|---|---|---|---|
| 1 | … | … | ✅ / ⚠️ weak / ❌ unsupported |

"Weak" means the evidence is of the wrong kind for the claim. A source read
standing in for a runtime result is weak. So is a unit test standing in for a
protocol result.

## 5. Re-derived claims

This section is the core of the review. Record every number, count, cap,
version, and path you checked yourself, and what you got.

| Audit claim | Audit's value | Re-derived value | Method | Agrees? |
|---|---|---|---|---|
| … | … | … | `grep -c …` / measured / read `file:line` | ✅ / ❌ |

If the audit is large, sample deliberately instead of exhaustively, and **say
how you sampled**. Bias the sample toward numbers the auditor could have read
out of a document instead of measuring.

## 6. Checker verification

Skip this section only when the audit ran no scripts.

For each script, record what it claims to check, whether you ran it, which
known-good and known-bad inputs you fed it, and whether its algorithm is right.
An anchor checker that has never been tested against a heading with trailing
punctuation has not been tested.

| Script | Re-run | Validated against | Sound? |
|---|---|---|---|
| … | yes/no | … | ✅ / ❌ |

## 7. Findings about the audit

Write one subsection each, numbered `R-<code>-<yyyymmddhhmm>-<nn>`. These are
defects in the audit, not in the product.

Each one carries what the audit claims, what is actually true with `file:line`
evidence, which failure mode from §1 it is, and what the auditor must do.

Before writing review findings, challenge the audit's product findings:

| Product finding | Owning contract | Reproduced at `Audited at`? | Concrete impact | Confirmed? |
|---|---|---|---|---|
| … | … | ✅ / ❌ | … | ✅ / ❌ |

A plausible concern is not a confirmed defect. An unreachable theoretical
hazard, an improvement opportunity, or a preference for a different design does
not become a finding because the auditor already implemented it.

Severity here is about the **audit's reliability**:

| Severity | Meaning |
|---|---|
| **High** | A finding is wrong, a defect was missed inside the declared scope, or a fix does not do what the record says it does |
| **Medium** | A claim is unsupported or circular, or the sweep was narrower than declared |
| **Low** | Metadata, numbering, or presentation. Wrong without misleading |

## 8. Product findings the audit missed

Record defects in the code or the docs that the audit should have caught within
its own scope. These are the audit's misses. They are not new scope.

Anything genuinely **outside** the audit's scope goes in §11 as a suggestion,
not here. A review that widens the scope retroactively cannot be answered.

## 9. Archive leakage

Ask whether the audit's own work introduced a reference **into** `logs/` from
outside it. Check the migrations and the fixes it applied. A fix that repoints a
docstring at a finding id is a violation. So is a contract document that now
cites the record instead of carrying the conclusion. Both are violations even
though the citation resolves today.

Grep for the run id and for the finding prefix `F-<code>-<yyyymmddhhmm>` across
`docs/`, `src/`, and `src-tauri/src/`. A path grep alone will not catch a bare
finding id in a comment or in a `describe()` name.

| Checked | Inbound references to a record |
|---|---|
| `docs/` outside `logs/` | … |
| `src/`, `src-tauri/src/` | … |

Zero is the only passing result. A link to `logs/` itself, or to its
`README.md`, is not leakage. Those are ordinary documentation. See
[`../README.md`](./README.md#the-archive-is-a-leaf).

## 10. Fix verification

For every fix the audit reports as applied, ask whether it was necessary,
whether it is minimal, whether its regression evidence distinguishes the base
from the handoff, whether unrelated behavior survived, and whether its
documentation followed. Check the tree, not the audit's description of the
tree.

| Finding | Fix necessary? | Minimal to proven failure? | Fails at base / passes at handoff? | Unrelated behavior checked? | Docs updated (§8.1) | Complete? |
|---|---|---|---|---|---|---|
| … | ✅ / ❌ | ✅ / ❌ | ✅ / ❌ / not practical | … | ✅ / ❌ / n/a | ✅ / ⚠️ partial |

"Partial" is the common outcome, and it is the one worth hunting. See failure
mode 3.

Necessity and minimality are real checks. Reject speculative hardening,
opportunistic refactoring, new abstractions unsupported by the finding, and
tests or documentation that encode a design the audit never established. If a
finding was withdrawn, verify that no code, test, or documentation change based
only on it remains in the handoff diff.

**The docs column is a real check, not a formality.** Every audit that changes
code owes one §8.1 row per change. Test two things:

- **A claimed doc update describes the code as it now stands.** Read the passage
  against the current source, not against the finding's description of it. An
  auditor who half-fixed the code and fully updated the prose has produced a
  document that is now wrong in the confident direction.
- **Every "none — internal only" row is true.** That claim says the change is
  invisible from every documented surface. Grep the changed symbol, constant, or
  behavior across `docs/` before you accept it. This is where drift enters,
  because it is the row nobody checks.

You are checking **only the surfaces this audit touched**. A document that was
already stale before the audit is not this audit's defect. Note it in §11 as an
out-of-scope suggestion for the relevant A16 subcode.

## 11. What this review does not claim

State your own limits, in the same spirit the audit states its own. Record what
you could not run, what you did not sample, and what you took on trust. A
reviewer who lists nothing here has not finished thinking.

Suggestions outside the audit's scope belong here too. Mark them clearly as out
of scope, so nobody mistakes them for blockers.

---

## Recommendation

Give one of these:

- **Accept.** The verdict is supportable on the evidence recorded. The residuals
  are correctly identified. It is ready for the maintainer to close.
- **Accept with corrections.** The audit is sound, and specific edits are
  required first. List them concretely enough to apply without another
  conversation.
- **Reject.** The verdict is not supportable. A finding is wrong, a declared
  scope was not swept, a fix does not do what the record claims, or the branch
  contains unnecessary or speculative remediation. State what must be run again
  or removed, not merely written again.

An `Accept` recommendation applies only to the exact handoff commit recorded in
this review. Any later auditor change requires another recorded review round.

Then state plainly **what the maintainer is accepting if they close on this
review.** That sentence carries the risk, so it belongs to the reviewer, not to
the auditor.
