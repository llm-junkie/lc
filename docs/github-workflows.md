# GitHub workflows

LC uses GitHub-hosted runners for validation, dependency monitoring, security scanning, and desktop packaging.

`.node-version` specifies Node 26. Local version managers and Node-based
workflows use that file. `package.json` also declares Node 26 as the supported
major. npm does not enforce this declaration locally because `.npmrc` does not
enable `engine-strict`.

## Workflow map

| Workflow | Trigger | Purpose |
|---|---|---|
| `CI` | Manual | Runs the documentation, import, test-registry, license, lint, and frontend-build checks.<br>Runs the frontend and Rust suites on Linux, Windows, and macOS.<br>Runs Clippy on all three platforms and Rust formatting on Linux.<br>The `push` and `pull_request` triggers are commented out. |
| `Dependency security` | Manual | Reports npm production advisories and runs RustSec against `Cargo.lock`.<br>The pull-request and weekly triggers are commented out.<br>Therefore, the dependency-review job does not run for the current `workflow_dispatch` event. |
| `CodeQL` | Manual | Scans TypeScript, JavaScript, and Rust when the repository is public.<br>The push, pull-request, and weekly triggers are commented out. |
| `Build artifacts` (`pre-release.yml`) | Manual | Runs source gates and both test suites on Linux, Windows, and macOS.<br>Builds four installer and portable artifact sets.<br>Does not create a GitHub release. |
| `Desktop release` | Manual, on a selected `v*` tag reference | Verifies the tag, manifests, and dependency-license policy.<br>Builds four platform artifact sets and attaches them to a draft GitHub release.<br>Runs no tests.<br>The release procedure requires a completed `Build artifacts` run.<br>The workflow does not verify that run. |

Dependabot checks npm, Cargo, and GitHub Actions every Monday at 06:00, 06:30,
and 07:00 respectively, in the Europe/Brussels timezone. The npm and Cargo
groups contain minor and patch updates. Their major updates remain separate for
deliberate review. The GitHub Actions group contains every update. Therefore,
action major updates can use the same grouped pull request.

## Creating a desktop release

1. Set the same version in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
2. Run `npm run release:check`, `npm run check:docs-sync`, and the normal CI commands locally.
3. Commit and push the version change.
4. In GitHub Actions, select `Build artifacts` for the release commit.
5. Require the source checks, three-platform tests, and four build jobs to pass.
6. Tag the exact passing commit with a matching tag, such as `v1.0.0` or `v1.0.0-beta.1`.
7. Push the tag.
8. In GitHub Actions, select `Desktop release`.
9. Under **Use workflow from**, select the tag. If you select a branch, the version check fails.
10. Wait for the Linux x64, Windows x64, macOS Apple Silicon, and macOS Intel package jobs.
11. Download and test every installer from the generated **draft** release.
12. Add platform signing and notarization before you publish binaries to end users.

The workflow never publishes automatically. A failed matrix job leaves the release in draft form for inspection or deletion.

The root `build.cmd` and `build.sh` wrappers provide local builds for the
current host. They clean the tree's disposable outputs and use `npm ci`. They
also validate the release license policy without writing artifacts. Then they
run `npm run tauri:build`. This production command generates the ignored
license inventory and enables bundling with `tauri.release.conf.json`.

It does
not replace the four-platform release matrix or its provenance steps. Use
`--no-pause` when you call either wrapper non-interactively.

Validation, security, and release-preflight jobs track `ubuntu-latest`. The
actual Linux release build intentionally remains on Ubuntu 22.04. Linux
binaries inherit a minimum glibc requirement from their build environment.
Tauri v2's older supported baseline gives the packages a wider runtime
compatibility range.

## Private-to-public behavior

The workflow source uses `github.event.repository.private == false` for CodeQL,
dependency review, and artifact attestations. CodeQL and release attestations
skip while LC is private. They run after the repository becomes public and a
maintainer starts their manual workflows. Dependency review also requires a
pull-request event. Its trigger is commented out, so the job remains inactive
in a public repository.

Manual CI, npm audits, RustSec audits, and draft packaging have no
public-repository condition. Dependabot checks three ecosystems every Monday.

## Recommended repository rules

The validation workflows are currently manual-only. Requiring their checks
would block a pull request until someone starts CI for that exact commit. If
pull-request CI is re-enabled, protect `main` and require these job names:

- `Release license policy`
- `Frontend checks`
- `Frontend tests (ubuntu-latest)`
- `Frontend tests (windows-latest)`
- `Frontend tests (macos-latest)`
- `Rust (ubuntu-latest)`
- `Rust (windows-latest)`
- `Rust (macos-latest)`

After the repository becomes public, re-enable the pull-request triggers. Then
require the two CodeQL analysis checks and `Dependency review`. Allow only the
maintainer to create tags. A tag alone does not start a release. The manual
`Desktop release` workflow can create or update its draft.
