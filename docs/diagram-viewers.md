# Diagram viewers

LC renders Mermaid, SVG, and Excalidraw code blocks in full-viewport preview
modals. The Mermaid and SVG viewers share the same pan/zoom panel and export
contract.

## Export behavior

- SVG and PNG exports use a 4x scale.
- SVG remains vector-based. Its physical width and height are scaled while
  its viewBox preserves the original diagram coordinates.
- PNG is rasterized to a 4x canvas. For very large diagrams, Mermaid can
  reduce the scale to stay within its 8192-pixel safety limit.
- Normal clicks include a background that matches the active light or dark
  theme.
- Hold Shift while clicking SVG or PNG to omit the background and preserve
  transparency.
- The export button tooltips show the shortcut. Tauri builds use the native
  save dialog through the shared `saveBlobFile` helper. The helper converts
  text to UTF-8 Blob bytes and uses `write_blob_file` for both text and binary
  exports. The browser fallback starts an anchor download.
- Filenames use `lc-mermaid-diagram-YYYY-MM-DD-HHmm.*`,
  `lc-svg-diagram-YYYY-MM-DD-HHmm.*`, or
  `lc-excalidraw-diagram-YYYY-MM-DD-HHmm.*`, with the local 24-hour time and
  the selected `svg` or `png` extension.

## Mermaid

Mermaid uses the current resolved application theme. It renders SVG text
instead of HTML foreignObject labels so standalone exports remain portable.
SVG exports include explicit dimensions, font-family information, and a
background rectangle that matches the theme. PNG is rasterized from the same
normalized SVG. Therefore, the two formats remain visually consistent.

Shift-click transparent Mermaid exports omit the synthetic background
rectangle and skip the canvas fill before rasterization.

## SVG

Fenced `svg` code blocks open in the same viewer panel as Mermaid. LC sanitizes
the source before injection. It then normalizes the source for the shared SVG
and PNG export buttons. For invalid SVG, the panel shows the source and parser
error.

## Excalidraw

The embedded viewer uses the exact `@excalidraw/excalidraw@0.18.1` version. Its
SVG exporter preserves vector geometry and text. The PNG exporter renders the
scene to a 4x canvas. LC loads the package ESM entry point and `index.css` on
demand. Production fonts are self-hosted under `public/excalidraw-assets`.

When the modal opens, Excalidraw receives `initialData.scrollToContent: true`.
It fits the complete restored scene after it measures the modal. The user can
then zoom and pan. During that one-time fit, a `Fitting diagram…` status hides
the canvas. This status prevents display at an intermediate zoom level.

The export app state follows the viewer's active theme. Normal exports include
the scene background. Shift-click sets exportBackground to false. As a result,
SVG and PNG exports have a transparent background.
