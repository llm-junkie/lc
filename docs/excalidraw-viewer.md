# Excalidraw viewer compatibility

The embedded viewer is pinned to the exact `@excalidraw/excalidraw@0.18.1`
version.

This is not a general Excalidraw editor. It renders LLM-generated scenes in a
constrained LC modal. The modal uses view-only mode, a reduced menu, theme
syncing, and the built-in zoom controls. The exact dependency protects the
embedded layout and export behavior from unreviewed upstream changes. Version
0.18.1 is the latest 0.18.x release. It includes the release-line Mermaid
security patch.

Excalidraw loads only when the modal opens. The viewer dynamically imports the
package's ESM entry point and its exported `index.css`. During the build,
`scripts/copy-excalidraw-assets.mjs` copies the package's production fonts to
`public/excalidraw-assets/fonts/`. The viewer sets
`window.EXCALIDRAW_ASSET_PATH` to `/excalidraw-assets/` so font loading does
not depend on the external CDN. The font directory is gitignored.

Each build regenerates the font directory from
`node_modules/@excalidraw/excalidraw/dist/prod/fonts/`.
The licence templates in
`scripts/generate-third-party-licenses.mjs` produce `LICENSES.md` beside those
fonts for production frontend artifacts. The generated file is not tracked.
Locale JSON files are deliberately not copied. No LC code path sets an
Excalidraw locale, so the default language applies.

Nothing fetches `locales/`
at runtime.

The viewer sets Excalidraw's built-in `initialData.scrollToContent` flag.
Excalidraw fits the complete restored scene after it measures the modal. During
this one-time fit, a `Fitting diagram…` status hides the canvas. The status
prevents visible changes to the saved zoom. The user can then adjust zoom and
pan.

When changing the pinned version, test the exact package after a clean
`npm install`. Verify the modal at normal and narrow LC sizes, including:

- menu opening and menu-item visibility
- zoom controls at the bottom-left
- light/dark theme changes
- SVG/PNG export, including Shift-click transparency

## Dependency audit status (2026-08-02)

A clean install with `@excalidraw/excalidraw@0.18.1` reports nine transitive
findings. The 2026-08-02 snapshot contained one high and eight moderate
findings. The 2026-08-15 measurement contained seven moderate and two high
findings because npm later raised `nanoid` to high. The count and dependency
chain are unchanged. The findings form one dependency chain, not nine
independent Excalidraw defects:

- Excalidraw pins `nanoid@3.3.3`.
- `@excalidraw/mermaid-to-excalidraw@2.2.2` pins `nanoid@4.0.2` and declares
  `@mermaid-js/parser@^0.6.3`.
- That old parser resolves through `langium@3.3.1` and `chevrotain@11.0.3` to
  vulnerable `lodash-es@4.17.21` copies. This is the source of the
  high-severity `lodash-es` entry and most of the derived moderate entries.

As of this review, `0.18.1` is the latest published Excalidraw package. npm's
only automatic remediation is `@excalidraw/excalidraw@0.17.6`. Do not use
`npm audit fix --force`. It would silently replace the pinned viewer with an
older release and remove much of its current dependency tree.

LC retains `0.18.1`. LC monitors Excalidraw for a release that refreshes these
dependencies. npm `overrides` could force patched
transitive versions without downgrading Excalidraw. However, this would create
an upstream-unsupported combination.

Before accepting such a change, run a clean install. Then run `npm audit`. Run
the full build. Run the test suite. Run the
viewer interaction and export checks above.

Observed usage reduces the immediate exposure but does not remove the audit
finding. Excalidraw calls `nanoid` with its default size or the integer `40`.
The converter calls it with the default size. The advisory concerns non-integer
sizes. The converter's emitted modules do not directly import their declared
old parser.

The 2026-09-04 lockfile inspection resolves root `mermaid@11.17.2`. Its parser
is `@mermaid-js/parser@1.2.1` under `node_modules/mermaid/node_modules/`.
The root `@mermaid-js/parser@0.6.3` belongs to the older converter dependency
chain. This lockfile inspection does not establish runtime import reachability
or renew the earlier advisory measurements. Recheck runtime imports before
accepting an exposure claim about either parser chain.

## Export behavior

The viewer's SVG and PNG buttons export at 4x. SVG remains vector-based.
PNG is rendered to a 4x canvas. Both exports follow the viewer's active
light/dark theme.

Normal clicks include the scene background. Hold Shift while clicking either
button to set Excalidraw's `exportBackground` to false and preserve a
transparent background. The button tooltips document this shortcut.

The shared export contract for SVG, Mermaid, and Excalidraw is documented in
[`diagram-viewers.md`](./diagram-viewers.md).
