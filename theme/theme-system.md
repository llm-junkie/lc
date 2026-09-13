# Theme System

## Architecture overview

The app has two independent axes that combine into four visual modes:

| | Glass (default) | Solid (`:root.solid`) |
|---|---|---|
| **Dark** | `[data-theme='dark']` | `[data-theme='dark'].solid` |
| **Light** | `[data-theme='light']` (default) | `[data-theme='light'].solid` |

- **Dark/Light** is gated by `[data-theme]` on `<html>`, toggled by the theme button in the header.
- **Glass/Solid** is gated by `.solid` on `<html>`, toggled at runtime by `src/utils/useApplyMaterial.ts` based on the `materialMode` setting (`auto` / `glass` / `solid`):
  - `'auto'` — native material (Mica/Acrylic on Windows, vibrancy on macOS) where supported; solid on Linux.
  - `'glass'` — glass surfaces everywhere, with a readable fallback when blur is unavailable.
  - `'solid'` — always on, for any user who prefers the flat aesthetic.
- The resolved material is also mirrored to `data-material-active` on `<html>`
  (`mica` / `acrylic` / `vibrancy` / `css-glass` / `matte`); only a confirmed
  native value unlocks the transparent root floor in `src/index.css`.
- Under a confirmed native material, `.app` paints the `--native-floor` tint
  (the theme background at 90% opacity) instead of the opaque `--bg`. The
  built-in floor constants are gated on `data-base` (not `data-theme` — a
  custom theme is `data-theme="custom"`), and `src/themes/resolver.ts` injects
  a per-theme `--native-floor` derived from each custom theme's own `--bg`, so
  the native tint follows the theme's palette.

Both condition classes are on `<html>` at the same time. Therefore,
`:root.solid[data-theme='dark']` selects exactly one mode.

### `data-base` — gate light-only rules on this, not on `data-theme`

There is a third attribute on `<html>`, and getting it wrong is silent.

| Attribute | Value | Means |
|---|---|---|
| `data-theme` | `'light'` \| `'dark'` \| `'custom'` | which theme is active |
| `data-base` | `'light'` \| `'dark'` | which palette that theme is **built on** |

For a built-in theme the two agree. For a custom theme `data-theme` is `'custom'`
and `data-base` carries the theme file's `base`. So:

```css
/* WRONG — silently skips every light-base CUSTOM theme */
:root[data-theme='light'] .composer:hover { border-color: var(--glass-border); }

/* RIGHT */
:root[data-base='light'] .composer:hover { border-color: var(--glass-border); }
```

**Write `data-base` wherever you write `data-theme`.** Three functions do it
today and they must stay in lockstep: `ThemeProvider.applyTheme`,
`resolver.applyCustomTheme`, `resolver.applyBuiltinTheme`.

Use `data-theme` only for the built-in light theme, not a light-base custom
theme. This condition is rare. The token blocks at the top of `index.css` and
`solid.css` are the exception. They stay on `data-theme` because `resolver.ts`
injects a complete replacement block on `[data-theme="custom"]`. A custom
theme must not inherit the built-in token blocks.

Swapping one attribute selector for the other moves no specificity — both are
(0,1,0) — so re-gating an existing rule cannot disturb a cascade tie. That is
what made this safe to apply to live rules.

Background: ten override rules used `[data-theme='light']`. A light-base custom
theme then used the light palette with the **dark** theme's harder border
treatment. This affected the composer, attachment thumbnails, and preview
overlay. No error reported it because the tokens were correct and only the
rules were missing.

---

## File layout

| File | Role |
|---|---|
| `src/index.css` | All core design tokens (dark + light) and every component style rule. Loaded first. |
| `src/themes/solid.css` | Solid-mode overrides. Gated behind `:root.solid`. Loaded second so it wins cascade. |
| `src/themes/builtin.ts` | Typed light/dark fallback maps for custom-theme resolution. The light code-block token pair differs from the built-in CSS. |
| `src/themes/{types,resolver,io}.ts` | Custom theme schema, spine/full resolution, DOM application, import, and export. |
| `theme/*.spine.theme.json` | Six example/importable spine themes: `blaze`, `ink`, `slate`, `sport_y`, `vs_dark`, and `vs_light`. They are not additional built-in theme modes. |

Custom-theme exports use
`lc-theme-<theme-slug>-YYYY-MM-DD-HHmm.theme.json`, with the local 24-hour
time. The standalone Spine builder uses the same pattern with the compound
`.spine.theme.json` extension.

Solid overrides never hardcode colors — they reference `--solid-*` tokens defined at the top of `solid.css`. To change the solid palette, edit only that token block.

---

## Elevation model

The app uses four numbered elevation levels (`--bg-elev-1` through `--bg-elev-4`). In both themes, **higher elevation = brighter surface** — matching real-world physics (elevated objects catch more light).

### Dark theme elevation

```
#0d0d10  ── bg (page floor, darkest)
#18181b  ── elev-1 (+11)  sidebar, settings, side panels
#1f1f23  ── elev-2 (+8)   chat bubbles, settings sections, chips, code bg
#27272a  ── elev-3 (+8)   hover states, elevated panels
rgba(45,45,58,0.84) ── elev-4   composer focus
```

### Light theme elevation

```
#e4e4e8  ── bg (page floor, darkest of the light set)
#ededf2  ── elev-1        sidebar, settings, side panels
#f5f5f9  ── elev-2        chat bubbles, settings sections, chips, code bg
#fbfbff  ── elev-3        hover states, elevated panels
rgba(255,255,255,0.76) ── elev-4       composer focus (translucent white)
```

**Why light does not start at pure white:** elevated surfaces still need luminance headroom. Starting at `#e4e4e8` leaves visible steps through `#fbfbff` before the translucent white focus surface.

### Solid palette mapping

The solid palette mirrors the core elevation structure:

| Solid token | Maps to | Role |
|---|---|---|
| `--solid-bg-3` | `--bg-elev-2` | Toolbar surface. Sole consumer is the TPS pill |
| `--solid-bg-2` | `--bg-elev-3` | Composer hover, preview overlay, sidebar footer |
| `--solid-bg-1` | above `--bg-elev-3` | Composer focus, attachment thumb focus |

Dark solid values (`--solid-bg-3` → `-2` → `-1`): `#212125` → `#2e2e33` → `#36363c`  
Light solid values: `#e4e4e8` → `#efeff3` → `#fbfbff`

---

## Glass tokens (light theme)

These are rgba white tints overlaid on the page. They work correctly on any page background — darker bg just makes them look more opaque, which is fine:

| Token | Light value | Usage |
|---|---|---|
| `--glass-bg` | `transparent` | Composer idle state |
| `--glass-bg-hover` | `rgba(255,255,255,0.45)` | Composer hover |
| `--glass-bg-focus` | `var(--bg-elev-4)` | Composer focus (delegates to elev-4) |
| `--glass-bg-strong` | `rgba(255,255,255,0.52)` | Preview overlay inner, pinned composer |
| `--glass-border` | `rgba(0,0,0,0.08)` | Light-theme glass border (darker glass needs a visible edge) |

---

## Solid mode overrides — what gets replaced

These are the surfaces that use `backdrop-filter` in glass mode and get solid replacements:

| Surface | Glass source | Solid source |
|---|---|---|
| User bubble bg + border | `--user-bubble-gradient` + `--user-bubble-border` | `--solid-user-bubble` + `--solid-user-bubble-border` |
| Assistant bubble border | `--border` | `--solid-border-2` (stronger, since no blur defines the edge) |
| Bubble file row | `--bubble-file-bg` / `--bubble-file-hover-bg` | `--solid-bg-bubble-file` / `--solid-bg-2` |
| Composer hover | `--glass-bg-hover` | `--solid-bg-2` |
| Composer focus | `--bg-elev-4` | `--solid-bg-1` |
| Composer pinned | `--glass-bg-hover` | `--solid-bg-2` + `--solid-border-1` |
| Composer action buttons | transparent + blur | `--solid-bg-2` |
| Preview overlay inner | `--glass-bg-strong` | `--solid-bg-2` |
| Attachment thumbs (focused) | `--bg-elev-4` | `--solid-bg-1` |
| Attachment thumbs (pinned) | `--bg-elev-4` | `--solid-bg-1` |
| Sidebar footer | gradient + blur | `--solid-bg-2` |
| TPS pill | `--accent-soft` (no blur) | `--solid-bg-3` |
| Mermaid modal backdrop | `rgba(0,0,0,0.72)` + 2px blur | `--solid-bg-overlay` mixed to 85% (bumped opacity to compensate for no blur) |
| Excalidraw modal backdrop | `rgba(0,0,0,0.72)` + 2px blur | same rule as Mermaid — the two viewers are one family |

### What is NOT overridden

Intentionally translucent surfaces that read correctly without blur:

- Modal dim layers (`--overlay-bg`)
- Lightbox backdrop + footnote pill
- Text preview backdrop
- Link-open confirmation overlay
- Colored chips (tag-reasoning, tag-vision, tag-tools)
- Profile variant chips (lmstudio, openai)
- Tool call status indicators

---

## Text colors

| Token | Dark | Light |
|---|---|---|
| `--text` | `#fafafa` | `#18181b` |
| `--text-muted` | `#a1a1aa` | `#5e5e67` |
| `--text-faint` | `#71717a` | `#8a8a93` |

`--text-muted` and `--text-faint` were darkened for the lowered light page bg to maintain readability (~5:1 and ~2.5:1 contrast respectively).

---

## Border tokens

Both themes use the same border token names with appropriate values:

| Token | Dark | Light |
|---|---|---|
| `--border` | `#33333a` | `#d6d6d6` |
| `--border-strong` | `#37373f` | `#c3c3c3` |
| `--solid-border-1` | `#2a2a30` | `#e4e4e7` |
| `--solid-border-2` | `#3a3a42` | `#d4d4d8` |

Solid mode has its own border pair because opaque surfaces need different edge contrast from glass surfaces.

---

## Semantic colors (shared across modes)

These are not theme-dependent and unchanged in solid mode:

| Token | Dark | Light |
|---|---|---|
| `--accent` | `#818cf8` | `#4f46e5` |
| `--accent-hover` | `#a5b4fc` | `#4338ca` |
| `--danger` | `#f87171` | `#dc2626` |
| `--success` | `#4ade80` | `#16a34a` |
| `--warning` | `#fbbf24` | `#d97706` |

---

## Adding or changing themes

For an importable user theme, create a version-1 `ThemeFile` JSON in `spine`
or `full` mode. Import it through Settings. Spine themes inherit from the
built-in `light` or `dark` base. Full themes provide complete glass and solid
maps.

### The spine contract — what a theme file must respect

Import checks required spine keys and supported color forms for its required
and known optional fields. It does not check elevation order or contrast. The
resolver derives omitted tokens from the supplied values and the base map.
A structurally valid spine can therefore produce an unusable UI. Follow these
visual rules:

**1. `--bg` → `--bg-elev-1` → `-2` → `-3` must get progressively BRIGHTER.**
This holds in both built-in themes and it is not a stylistic preference — see
"why elevation direction matters" below. Built-in light runs
`#e4e4e8 → #ededf2 → #f5f5f9 → #fbfbff`. Dark also runs from dark to lighter.
Invert it and every elevated surface reads as recessed, because the shadows say
"raised" while the luminance says "sunken".

**Leave headroom.** If `--bg` is already near-white there is nowhere for the
elevations to go. Aim to start `--bg` around 8–10% off white (light) or off
black (dark), as the built-ins do.

**2. Supply `--border` unless you are sure of the derivation.** When omitted it
is computed as `--bg-elev-1` shifted 16 steps darker (light) or 20 lighter
(dark). That is tuned for the built-in ladders. Against a very bright
`--bg-elev-1` it produces a border with almost no contrast, and borders are what
define toggles, inputs, and card edges. Built-in light uses an explicit
`#d6d6d6`.

A quick sanity check on any spine: the elevation values ascend, and
`--border` against `--bg` lands near the built-in ratio (~1.15) rather than
below it.

**3. A spine may override ANY glass token, not only the ones in `ThemeSpine`.**
`resolveSpine` copies each supplied key over the base map before derivation.
`validateSpine` checks six required keys and four optional keys. It does not
reject other keys. Therefore, the following example works although the
TypeScript type does not list it:

```json
"--code-block-bg": "#f8f8f8",
"--code-block-fg": "#333333"
```

Overrides land in the **glass** map, which the solid block inherits, so they
apply in both modes. `theme/vs_light.spine.theme.json` uses this to pin the code
block to match its chosen Prism theme.

### A LIGHT spine must set `--code-block-bg` and `--code-block-fg`

**This is required, not polish.** A light spine that omits them usually gets a
**dark** code block. Two facts combine:

- The custom-theme fallback maps in `src/themes/builtin.ts` use
  `#0d1117` / `#c9d1d9` for `--code-block-bg` / `--code-block-fg` with either
  base. A light spine inherits that dark pair unless it supplies an override.
  The built-in light CSS differs: `src/index.css` uses `#f5f2f0` / `#1f2328`.
  Do not infer the custom light-spine defaults from the built-in light CSS.
- LC renders its own `<pre>` with **no class** (`markdown.tsx`, the `codePre`
  element) — the `language-*` class sits on the `<code>` child. So
  `pre[class*="language-"]`, the selector most Prism themes use to paint the
  block background, **never matches here.** Only a Prism theme that *also*
  backgrounds `code[class*="language-"]` will cover the token.

The selected Prism theme determines whether an unpinned light spine looks
correct. Some themes paint `code`, and others paint only `pre`. Set the two
tokens to remove this dependency.

Dark spines don't need them: the inherited default is already dark, and a dark
`codeTheme` is dark either way. Setting them anyway is harmless and several
shipped themes do.

To check a specific Prism theme before relying on it:

```bash
grep -A3 'code\[class\*="language-"\]' node_modules/prism-themes/themes/prism-<name>.css | grep background
```

Or ask the running app, which answers for real rather than by inspection —
if `codeBg` comes back transparent, that theme paints `pre` only and the token
is what you are seeing:

```js
(() => { const pre = document.querySelector('.md pre'), code = pre && pre.querySelector('code');
  return { preBg: pre && getComputedStyle(pre).backgroundColor,
           codeBg: code && getComputedStyle(code).backgroundColor,
           token: getComputedStyle(document.documentElement).getPropertyValue('--code-block-bg') }; })()
```

Match the two tokens to the palette of the `codeTheme` you chose.
`vs_light.spine.theme.json` pairs `github` with `#f8f8f8` / `#333333`.

`theme/spine-builder.html` is the intended authoring path and is shipped as a
Tauri resource. Hand-written JSON does not provide its guidance.

For a new built-in mode:

1. Update the selectors in `index.css` and `solid.css`.
2. Mirror the token maps in `src/themes/builtin.ts`.
3. Extend the built-in theme types and controls.
4. Verify muted and faint text contrast.

## Adding a new glassmorphic surface

1. In `index.css`, style it using `--glass-bg-*`, `--glass-border`, etc.
2. In `solid.css`, add a `:root.solid .your-new-surface` rule that replaces `backdrop-filter` with `none` and sets `background` to a `--solid-bg-*` token.
3. Never hardcode a color in the solid override — always use a `--solid-*` token.
4. If the rule is light-only, gate it on `[data-base='light']`, not `[data-theme='light']` — see the `data-base` section above.

`npm run build` runs `scripts/check-solid-css.mjs` and will fail the build if you skip step 2. It checks four things:

| | Catches |
|---|---|
| **A** dead selectors | a class used in `solid.css` that exists in no `index.css` rule and no `.ts`/`.tsx` source — i.e. `index.css` renamed something and `solid.css` did not follow |
| **B** unclaimed glass | a `backdrop-filter` in `index.css` with no `backdrop-filter: none` anywhere in `solid.css` |
| **C** partial override | a `solid.css` rule that paints an opaque fill over an element but leaves its blur standing — invisible, and still costs a backdrop root every frame |
| **D** unclaimed translucent surface | a `--bg-elev-*` / `--glass-bg*` fill that resolves translucent and that `solid.css` never repaints. This is the surface that is *translucent without being blurred*, which A–C cannot see |

If a surface is deliberately left unclaimed — an intentionally translucent dim layer, a colored status chip — mark its rule with `/* solid-exempt: <reason> */` rather than weakening the check. Exemptions are counted in the guard's pass line so they stay visible.

---

## Design rationale: why elevation direction matters

Before 2026-06-23, the light theme had inverted elevation. `elev-2` was
darker than the page background, and `elev-3` was darker still. Each elevated
surface was darker than the background. This was opposite to real lighting,
where elevated objects catch more light.

This created conflicting depth cues. CSS shadows indicated elevation, but
luminance indicated recession. The user had to resolve this conflict during
each scroll, which caused eye fatigue.

The fix reorders all `--bg-elev-*` tokens so **higher = brighter** in both themes, matching the dark theme's accidental correctness. Shadows and luminance now agree.

---

## Code block themes (Prism.js)

Code syntax-highlighting uses [Prism.js](https://prismjs.com/) via `rehype-prism-plus`. The theme is configurable via the `codeTheme` setting in the settings store (`src/store/settings.ts`).

### Included themes

`system` follows the app theme and selects `one-dark` or `one-light`. The remaining selectable IDs are the keys in `CodeTheme` and `CSS_MAP`:

```text
one-dark, one-light, a11y-dark, atom-dark,
base16-ateliersulphurpool.light, cb, coldark-cold, coldark-dark,
coy-without-shadows, darcula, dracula, duotone-dark, duotone-earth,
duotone-forest, duotone-light, duotone-sea, duotone-space, github,
gruvbox-dark, gruvbox-light, holi-theme, hopscotch, lucario,
material-dark, material-light, material-oceanic, night-owl, nord,
pojoaque, shades-of-purple, solarized-dark-atom, synthwave84, vs,
vsc-dark-plus, xonokai, z-touch
```

All themes are from the [`prism-themes`](https://github.com/PrismJS/prism-themes) package. Additional themes in `node_modules/prism-themes/themes/` can be added by:

1. Adding the ID to the `CodeTheme` type in `src/store/settings.ts`
2. Adding a `?url` import in `src/utils/useCodeTheme.ts`
3. Adding the entry to the `CSS_MAP` record

### How it works

The `useCodeTheme()` hook in `App.tsx` creates a
`<link id="lc-prism-theme">` element. It sets `href` to the Vite-resolved CSS
bundle for the selected theme. When `codeTheme` is `'system'`, selection follows
the resolved `data-base`: light selects one-light; other values select one-dark.
A `MutationObserver` watches both `data-base` and `data-theme`. This also catches
switches between custom themes whose `data-theme` remains `custom`.
