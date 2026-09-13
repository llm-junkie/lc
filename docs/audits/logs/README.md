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

# Audit log

This directory holds completed and in-progress audit runs. Each run carries the
independent review or reviews it requires. LC **keeps** these records. They are
the provenance trail for how a conclusion was reached, and for who checked it.

Keeping a record does not replace migration. Every durable conclusion still
belongs in the document that owns that contract. See
[`../README.md`](../README.md) for the lifecycle, the roles, and the closure
rules.

## Naming

```
a06__202608252355.md                          the run: code + minute opened
a06__202608252355__review__qwen3.6max.md      one file per independent reviewer
a16c__202608070914.md                         an A16c run: subcode + minute opened
a16c__202608070914__review__qwen3.6max.md     its own review
```

Use `yyyymmddhhmm`, in local time, 24-hour, and zero-padded. The code and the
timestamp are the whole identity. There are no sequential audit numbers, and no
suffixes. A review carries the **audit's** timestamp, not its own, so it always
sorts next to what it reviews.

`A16` is the only family template. Its records use one fixed lowercase subcode
from `a16a` through `a16m`. The letter identifies the semantic documentation
scope. It is part of the run code, not an ad hoc suffix. A bare `a16__...`
record is invalid.

A finding inside a standard run is `F-a06-202608252355-nn`. In an A16 subrun,
use `F-a16c-202608070914-nn`. Review findings use the same run code with the
`R-` prefix.

## Branch and reviewed commit

Every run uses a branch named exactly for the run id, without `.md`:

```
record:  a06__202608252355.md
branch:  a06__202608252355

record:  a16c__202608070914.md
branch:  a16c__202608070914
```

The auditor creates it before reading code and keeps the record, remediation,
reviews, corrections, and closure on it. The branch is not merged until a
reviewer accepts an exact auditor handoff commit and the maintainer closes the
run.

A branch name is mutable. Each review therefore records the full handoff commit
hash it checked and compares it with the audit's `Audited at` base. Corrections
produce a new handoff hash and a new review round. Acceptance of one hash never
means acceptance of whatever the branch points to later.

Closure means the maintainer approves that exact accepted lineage for
integration. They may merge directly or open a pull request, but they preserve
the reviewed commits with a fast-forward or merge commit. A squash, rebase, or
post-review product change invalidates the recorded handoff. Any such change
returns the run to audit and review before it can close again. Delete the branch
only after the accepted handoff and closing commit are reachable from the
integration branch.

## Nothing outside this directory may cite a record in it

Do not cite a record by path, by link, by run id, or by finding id. This applies
to a contract document, a docstring, a comment, and a test name. Records here
reference each other freely. The outside world references the **directory**,
never a record.

The temporary audit branch named for the run id and the standalone closing
commit message are the two operational exceptions. Neither is a contract
citation. Delete the branch after integration; keep the closing commit as the
durable history entry.

A record is an audit file or a review file. **This README is not a record.** It
is ordinary documentation, LC never prunes it, and anyone can link to it from
anywhere in `docs/`, like any other page.

That rule is what lets someone supersede or prune a record without breaking
anything. If you want to cite a finding, the conclusion has not been migrated
yet. Move it into the document that owns that contract, and cite that document
instead. See [`../README.md`](../README.md#the-archive-is-a-leaf).

## Reading one

Read the audit's §1 for scope, and its §10 for what it does not claim, before
you read its findings. Both sections bound what the verdict is worth. Then read
the review, because the review is where someone tested the audit's own claims,
tried to disprove its findings, and checked the necessity and minimality of its
changes at an exact commit.

An audit with no review beside it is **not closed**, whatever its status line
says.
