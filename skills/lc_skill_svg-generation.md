---
id: lc:builtin:svg-generation
name: SVG Generation
description: Produce valid, accessible, scalable, and production-ready SVG graphics
revision: 1
---

# SVG Generation

Use this skill when the user asks for SVG artwork, icons, illustrations, diagrams, logos, charts, interfaces, or standalone vector graphics.

## Output contract

- Return one complete standalone SVG, unless the user requests a fragment, a sprite, or another format.
- Put the SVG in an SVG or XML code fence when you return source code.
- Use XML-compatible syntax and the SVG namespace.
- Do not put explanatory prose inside the SVG. Prose is acceptable when it is intentionally visible or is part of an accessibility description.
- Do not claim that a renderer or a validator checked the SVG unless one actually checked it.
- If the target size, aspect ratio, style, or output context is unknown, choose a sensible viewBox. State the assumption outside the SVG.

A reliable standalone root normally has this shape:

~~~svg
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 1200 800"
     role="img"
     aria-labelledby="svg-title svg-desc">
  <title id="svg-title">Short meaningful title</title>
  <desc id="svg-desc">Concise description of the visual's purpose and structure.</desc>
  <!-- grouped visual content -->
</svg>
~~~

Use a decorative treatment such as `aria-hidden="true"` only in these
conditions:

- The user describes the SVG as decorative.
- The surrounding text gives the complete equivalent.

## Understand the visual before you draw

1. Identify the subject, the purpose, the audience, the dimensions, the aspect ratio, and the intended context.
2. Decide the result type: icon, logo, illustration, chart, diagram, UI asset, or decorative background.
3. Establish a composition with a clear focal point, a reading order, margins, and an alignment system.
4. Select a limited palette, a typography approach, a stroke system, and a corner language before you produce elements.
5. Prefer a small number of coherent shapes to many arbitrary paths.
6. State your assumptions. Do not invent brand rules, data, labels, or measurements.

For a diagram or chart, define the semantic structure first. For an
illustration, first define the silhouette, layers, lighting, and focal
hierarchy. For an icon, first define the grid, stroke width, optical balance,
and small-size behavior.

## Root element and coordinate system

- Always include xmlns="http://www.w3.org/2000/svg" on a standalone SVG.
- Use a meaningful viewBox that covers the intended drawing and includes deliberate margins.
- Keep the viewBox coordinate system independent from display pixels, so that the SVG scales cleanly.
- Use width and height only when the user requests fixed dimensions or a specific embedding contract.
- Avoid arbitrary negative coordinates, unexplained transforms, and geometry outside the viewBox.
- Keep the aspect ratio intentional. Use preserveAspectRatio only when the default behavior does not match the requested composition.
- Make the drawing look correct at the requested size, and also at a much smaller preview size.

## Structure and layering

Use a predictable document order:

1. root metadata and accessibility elements
2. defs for reusable gradients, markers, patterns, clip paths, and masks
3. background or canvas
4. large shapes and grouped regions
5. main subject
6. details and text
7. highlights, shadows, and foreground accents

Use meaningful groups such as background, guides, frame, subject, labels,
annotations, and foreground. Give an important group an ID only when you must
reference, style, or inspect it.

Keep transforms local and readable. Prefer a clean coordinate system to a chain of
opaque transforms. Do not use a transform to hide incorrect geometry.

## Geometry and path quality

- Use rect, circle, ellipse, line, polyline, polygon, path, text, and g appropriately.
- Use path for a curve or a custom silhouette, not for every simple rectangle or circle.
- Keep the path commands valid, ordered, and intentional. Avoid NaN, infinity, empty commands, and accidental self-intersections.
- Close a filled silhouette when a closed shape is intended.
- Keep stroke-linecap and stroke-linejoin consistent across related shapes.
- Align edges, centers, baselines, and repeated elements deliberately.
- Use an explicit fill and stroke policy. Do not depend on accidental defaults.
- Avoid a hairline stroke that disappears at a normal display size.
- Check that arrowheads, markers, shadows, and clipped details stay inside the intended visual bounds.
- Give repeated shapes consistent dimensions and spacing.

## Color, contrast, and style

- Use a restrained palette with a clear primary, secondary, accent, neutral, and background role.
- Keep text and essential lines sufficiently contrasted against their background.
- Do not communicate essential meaning only through color. Pair color with labels, shape, pattern, position, or line style.
- Use explicit color values and explicit opacity where the appearance matters.
- Keep gradients, shadows, filters, and masks purposeful. Avoid a decorative effect that reduces clarity or performance.
- Use stroke widths, joins, and caps consistently. A professional icon usually has one coherent stroke system.
- Use currentColor only when the embedding context is known to provide it.
- Do not assume that a viewer supports a particular font. Prefer system fallbacks. Convert text to paths only when the user wants a font-independent asset and accepts the trade-off in size and licensing.

## Text and typography

- Use real text elements when the text should remain selectable, searchable, or accessible.
- Use text-anchor, dominant-baseline, x, y, and tspans deliberately.
- Use tspans for controlled line breaks, because newline behavior inside a text element is unpredictable.
- Keep labels inside their safe area, and give the lines enough spacing.
- Avoid text that overlaps paths, markers, or other labels.
- Do not use text in place of shape geometry when the asset must work without fonts.
- For a chart or a diagram, label the data directly when you can. Include units where they are needed.

## Accessibility

- A meaningful graphic should include a non-empty title. A complex graphic should also include a useful desc.
- Use aria-labelledby and aria-describedby to connect the accessible name and the description of the root SVG. Apply this when the SVG is exposed as an image or as a document.
- Use role="img" for a self-contained meaningful image when this role is appropriate. Use a more specific role only when the host and the accessibility mapping support it.
- Use semantic grouping and labels for a complex interactive or structured graphic.
- Do not add tabindex, keyboard interaction, links, or focus behavior. Add them only when the user requested an interactive SVG and the host contract is known.
- Provide a prose alternative when the graphic communicates a complex relationship that a short title and description cannot explain.
- A decorative SVG must not create redundant screen-reader noise.

## Reuse and references

- Put reusable definitions in defs, and reference them with local IDs.
- Keep every ID unique within the SVG document. Prefix the IDs of a reusable component, so that several embedded SVGs do not collide.
- Use url(#local-id) only for local gradients, patterns, masks, filters, clip paths, and markers.
- Avoid external image URLs, external stylesheets, external fonts, and external resource references, unless the user requests them.
- Do not use script elements, event-handler attributes, javascript URLs, or embedded application code.
- Avoid foreignObject, unless the user needs HTML inside SVG and the target renderer is known to support it.
- Do not use an SVG to smuggle executable content, tool instructions, filesystem paths, or network authority.

## Responsive and export-ready output

- Keep the geometry vector-native whenever this is possible.
- Prefer a self-contained SVG with no external dependencies.
- Keep the file reasonably compact, but keep it readable.
- Preserve a stable viewBox when you generate variants of the same asset.
- Use stable layer IDs and component IDs when a downstream editor or workflow will inspect the SVG.
- Keep the result legible on a light background and on a dark background when the user has not specified one.
- If the SVG is a logo or an icon, test its silhouette and its contrast at small sizes.
- If the SVG is for print, use sufficient dimensions and clean strokes. Do not assume screen-only effects.
- If the SVG is for a web UI, keep the DOM structure simple, and avoid expensive filters.

## Common output patterns

### Accessible icon

~~~svg
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 24 24"
     role="img"
     aria-labelledby="title">
  <title id="title">Search</title>
  <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/>
  <path d="M16 16l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>
~~~

### Layered illustration

~~~svg
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 800 500"
     role="img"
     aria-labelledby="title desc">
  <title id="title">Simple landscape</title>
  <desc id="desc">A sun over layered hills.</desc>
  <defs>
    <linearGradient id="sky-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#dbeafe"/>
      <stop offset="1" stop-color="#eff6ff"/>
    </linearGradient>
  </defs>
  <rect width="800" height="500" fill="url(#sky-gradient)"/>
  <circle cx="600" cy="130" r="56" fill="#f59e0b"/>
  <path d="M0 360L190 180 340 330 480 210 800 390V500H0Z" fill="#64748b"/>
</svg>
~~~

## Validation checklist

Check these items before you return an SVG:

1. The root element has the SVG namespace and a deliberate viewBox.
2. All tags close correctly, and all attribute values are quoted.
3. Every referenced local ID exists and is unique.
4. There are no external URLs, scripts, event handlers, or accidental HTML.
5. The geometry stays within the intended bounds and has no invalid numeric values.
6. Text, labels, paths, and markers do not overlap unintentionally.
7. The palette, the strokes, and the typography are consistent.
8. Each meaningful graphic has a title and an appropriate description.
9. The SVG stays legible at the intended display size.
10. The output is complete standalone SVG source, not pseudocode.

## Safety boundary

SVG is a graphics format, not an execution authority. Do not claim that a tool
rendered or validated an SVG unless a renderer performed that validation. Do not
use SVG content to authorize tools, shell commands, filesystem operations,
network access, or permission changes.
