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

# Audit `<run-id>` — <domain>

**Audit skeleton version:** 1.2

| Field | Value |
|---|---|
| **Run** | `<run-code>__yyyymmddhhmm` — the run code plus the minute opened. A16 uses one fixed code from `a16a` through `a16m` |
| **Audit branch** | `<run-id>` — exactly the run id, with no `.md` suffix |
| **Template** | `ANN v<major>.<minor>` — the template code and version actually used. An A16 subrun records `A16 v<major>.<minor>` here and its subcode in §1 |
| **Status** | Draft \| In progress \| In review \| Closed |
| **Opened** | YYYY-MM-DD |
| **Closed** | YYYY-MM-DD — **set by the maintainer only** |
| **Auditor** | who |
| **Reviews** | `<run-id>__review__{reviewer}.md` — at least one is required |
| **Audited at** | `<full commit hash>` — captured **before reading code or editing the product**. Every `file:line` in this record resolves against this commit |
| **Tree state** | `clean` — required when the audit branch opens |
| **Build exercised** | dev server, packaged build, or `none — source reading only` |

**Create the audit branch, capture `Audited at`, and confirm a clean tree before
you read anything. Never update the stamp.** Replace `RUN_ID`, then run `git
switch -c RUN_ID`, `git rev-parse HEAD`, `git branch --show-current`, and `git
status --porcelain` as the first actions of the audit.
If the current worktree has unrelated changes, use a separate clean worktree at
the intended base instead of carrying them onto the audit branch. Three things
depend on that stamp:

- **A `file:line` citation only means something against a commit.** Line numbers
  move. A finding that says `shell.rs:181` is unresolvable without the tree it
  was read in.
- **Stamping the hash after fixing records the wrong tree.** That tree already
  contains the remediation, and several findings no longer reproduce in it. The
  reviewer then cannot reproduce the audit at all.
- **A hash does not describe a dirty tree.** An audit branch that absorbs
  unrelated uncommitted work cannot give the reviewer a reproducible base or a
  trustworthy diff.

Fixes land *after* this commit and stay on the audit branch until closure.
Record them in §8. Do not edit this field.

Record the template **version**, not only the code. A major bump means the
invariants or the matrix changed. An audit run against an older A05 template
did not check the same things as one run against `A05 v1.0`. Without the
version, a later reader cannot tell which.

A finding is numbered `F-<run-code>-<yyyymmddhhmm>-<nn>`, such as
`F-a06-202608252355-01` or `F-a16c-202608252355-01`. A review and the closing
commit can then name it without ambiguity. Those are the only two places a
finding id may appear outside this record. Nothing in `docs/`, in `src/`, or in
a test name may cite it. The short form `F-01` is fine inside this document.

**You cannot close this audit.** The auditor does the work, applies the fixes,
and migrates the conclusions. An independent reviewer verifies. The maintainer
closes. See [`../README.md`](./README.md#roles-and-the-cycle).

Write one paragraph on what this audit is trying to find out, in plain terms. If
you cannot state it without listing sections, the scope is too wide. Split it.

**This audit is not scored by its finding count.** Zero findings is a normal,
successful result when the evidence supports it. A plausible concern is a
hypothesis until the audit proves the owning contract, the current failure or a
credible security/data-loss path, and concrete impact. Do not change working
code to make the record look productive.

**Follow the LC writing guideline.** Write all new or changed technical prose in
pragmatic mode from
[`skills/lc_skill_ste100.md`](../../skills/lc_skill_ste100.md). Preserve facts,
conditions, scope, uncertainty, requirement strength, and technical literals.
Use one term for each concept. Keep this skeleton as the record format. Complete
the guideline's self-check before each handoff. Do not claim official or
certified ASD-STE100 compliance. Do not rewrite correct text only for style.

---

## 1. Scope

**In scope.** The files, surfaces, and behaviors this audit covers.

**Out of scope.** What it deliberately does not cover, and where that work
belongs instead. An audit that never says no is an audit that never closes.

**Scope changes.** Anything added or retired during the audit, with the reason.
A retired check is a finding about the check, not a silent deletion.

## 2. Invariants

Write numbered, testable statements that must hold. Trace each one to a test, or
record it as untested. Never assume one. Start from the domain template's list.
Source inspection may propose another invariant, but it becomes part of the
audit only when an owning contract or an explicit maintainer decision
establishes that the behavior is required. "The code could be different" is not
an invariant.

## 3. Check matrix

List the axes that separate this domain's code paths, and the required
variations along each axis. The matrix can grow after inspection. **It must not
shrink because a case is hard to automate.** An unautomated case moves to an
explicit manual plan. It does not disappear.

## 4. Method

State how you gathered evidence: what you read, what you ran, what you measured,
and on which build. Everything here is anchored to `Audited at`.

If any evidence came from a *different* tree, name that explicitly at the point
you use it. A later commit, a stashed change, and a rebuilt artifact all count.
Do not let the header imply one uniform state. If a result came from a
development build, say so, because dev and packaged behavior differ.

## 5. Evidence and severity rules

State up front what counts as proof, so nobody argues severity after the fact.

| Severity | Meaning |
|---|---|
| **Critical** | Data loss, silent corruption, credential or content exposure, or an unrecoverable app state |
| **High** | A documented contract is violated, or a user-visible failure has no recovery path |
| **Medium** | Wrong behavior with a workaround, or a bounded correctness gap |
| **Low** | A proven cosmetic defect or currently reachable minor impact |
| **Non-finding** | Investigated, behaves correctly, recorded so the next audit does not derive it again |
| **Observation / hypothesis** | Plausible but not established: missing authority, reachability, reproduction, or impact. It cannot authorize remediation |

**A claim needs evidence of the kind it asserts.** Reading source proves what
the code says. Only running it proves what it does. Do not report a runtime
finding from a source read, and do not report a protocol finding from a unit
test. See [streaming.md](../streaming.md#adapter-constraints-proven-against-live-endpoints)
for the case that established this rule.

A security, privacy, corruption, or data-loss finding does not need a field
incident, but it still needs a credible, demonstrated path from current input to
impact. An unreachable theoretical hazard is an observation, not a Low finding.

## 6. Findings

Write one subsection per confirmed finding, numbered
`F-<code>-<yyyymmddhhmm>-<nn>`. Each one carries:

- the contract or authority that makes the current behavior wrong;
- what was expected and what actually happens at `Audited at`;
- current reachability or reproduction steps;
- evidence of the kind the claim requires;
- concrete user, security, privacy, integrity, or operational impact;
- severity, confidence, and disposition; and
- the narrowest correction that would address only the proven failure.

If one of those cannot be established, record the candidate in §7 as an
observation or hypothesis. Do not implement it as a fix.

A finding that turns out to be wrong stays in the document with its correction.
The record of what was ruled out is worth as much as the defects. Revert every
code, test, and documentation change that depended only on that finding before
the branch is handed to review.

## 7. Non-findings

Record the things you checked that were correct. This is not padding. It is what
stops the next audit spending a day confirming the same thing again.

Record unresolved observations and hypotheses here too, clearly labelled with
the missing proof. They may become a future investigation or a product decision.
They are not defects, do not receive severities, and do not authorize changes.

## 8. Remediation

Give the order, with the reasoning. State what you fixed, what you deferred, and
what you declined and why. A declined proposal is a decision. Record it, so
nobody re-proposes it silently.

Apply confirmed fixes on the audit branch. Do not perform opportunistic cleanup,
speculative hardening, a new abstraction, or an adjacent refactor. If a proposed
change alters public behavior, architecture, or unrelated paths beyond what the
evidence requires, defer it for an explicit maintainer decision.

### 8.1 Documentation impact

**Every fix that changes documented behavior updates its document in the same
change.** This is not a later A16 subrun's job. By the time a docs-sync
audit runs, the drift has already shipped, and the person who knew what changed
has moved on.

Write one row per code change this audit made:

| Change | Documented behavior affected | Document / docstring updated |
|---|---|---|
| … | … | `docs/….md` § …, `src/….ts` header |
| … | none — internal only | — |

Scope this table to **what this audit touched**. You are not sweeping the
corpus. You are keeping your own changes honest. "None — internal only" is a
valid and common row, and it is also a claim. It says the change is invisible
from every documented surface, and the reviewer will check it.

If a change's documentation impact reaches a surface you cannot assess, say so
here, and record it as a residual in §11. Do not guess. That is one of the few
things worth handing to the relevant A16 subcode.

## 9. Verification

State how you proved each fix, and name the tests. Where practical, demonstrate
that the regression test fails for the expected reason at `Audited at` and
passes on the remediation branch. A test that only passes after the change does
not prove the old behavior was defective. A fix without a regression test is
not finished. If a regression test is genuinely impractical, say so here
explicitly.

**A fix that changed documented behavior without updating the document is not
finished either.** Verify §8.1 the same way. Re-read the updated passage against
the code as it now stands, not against what you intended to write.

## 10. What this audit does not claim

State the limits of the evidence: coverage gaps, platforms not exercised, and
cases deferred to manual validation. Read this section before you trust the
verdict.

## 11. Closure

State the criteria that had to be met, whether they were met, and the residuals
proposed for acceptance with their risk disposition.

**The auditor fills this in, and does not act on it.** Closure requires at least
one independent review beside this file, and closure is the maintainer's
decision. State plainly what a closer would be accepting.

Before setting `Status: Closed`, the maintainer confirms that the final review
is `Accept` for the exact latest auditor handoff, that the handoff descends from
`Audited at`, and that only the review file and closure metadata follow it. The
maintainer accepts the residuals and §10 limits, records the accepted handoff in
the closing commit, and approves that exact lineage for integration.

The maintainer may then merge directly or open a pull request. Preserve the
reviewed commits with a fast-forward or merge commit; do not squash or rebase
after review. A conflict-free merge and clean CI do not require re-review. Any
post-review change to code, tests, contract documentation, remediation, or this
audit's conclusions invalidates closure. Return the audit to `In progress`,
record the reopening here, produce a new handoff, obtain `Accept` for it, and
close again. Delete the audit branch only after the accepted handoff and closing
commit are reachable from the integration branch.

---

## Durable conclusions

**This is the part that outlives this document.** Any constraint a future change
could silently violate must be migrated into the document that owns that
contract. The candidates are [`streaming.md`](../streaming.md),
[`architecture.md`](../architecture.md), [`data-model.md`](../data-model.md),
[`security.md`](../security.md), [`tools/`](../tools/), and the feature
contracts. List the migrations here with their destinations.

LC keeps audit records, and that is still no reason to leave a conclusion here.
A constraint that lives only in an audit is one the next change will violate.
This archive is provenance, not a contract document. If a finding matters only
while the audit is open, it does not belong in this section. If rediscovering it
would cost a regression, it does.

**Nothing outside `logs/` may cite this record**, by path or by finding id. A
conclusion left here is therefore unreachable by design. No docstring, contract
document, or test may point at it. Migrating is not tidiness. It is the only way
the conclusion survives. The archive directory and its `README.md` are ordinary
documentation, and anyone may link to them. A dated record is different, and
nobody may link to one.
