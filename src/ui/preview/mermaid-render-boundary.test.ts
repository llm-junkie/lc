/**
 * `MermaidRenderBoundary` — the render-boundary remediation, verified rather
 * than asserted.
 *
 * The original `MermaidViewer` had no boundary of its own, so a
 * render-time throw under the diagram stage reached the app root's
 * `ErrorBoundary`, which by design does not recover: it replaces the whole
 * application with a reload screen. Losing the session to a failure in a
 * diagram preview is the wrong trade.
 *
 * The claim being made is a RECOVERY claim, and this audit's own history is
 * that recovery claims which were only read rather than run turned out wrong
 * in both directions (§11's note on reviewer agreement). So the two things
 * that matter are executed here: the throw is contained, and what replaces it
 * is announced to assistive tech rather than rendering silently.
 *
 * Run with:
 *   npx tsx --test src/ui/preview/mermaid-render-boundary.test.ts
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
});
const globalKeys = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver'] as const;
const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
for (const key of globalKeys) {
  originalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalReactDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'React');
const reactModule = await import('react');
Object.defineProperty(globalThis, 'React', { configurable: true, value: reactModule });
const { createElement, act } = reactModule;
const [{ createRoot }, { MermaidRenderBoundary }] = await Promise.all([
  import('react-dom/client'),
  import('./MermaidViewer.tsx'),
]);

after(() => {
  dom.window.close();
  for (const key of globalKeys) {
    const descriptor = originalDescriptors.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  if (originalReactDescriptor) Object.defineProperty(globalThis, 'React', originalReactDescriptor);
  else delete (globalThis as Record<string, unknown>).React;
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function Boom(): never {
  throw new Error('diagram subtree exploded');
}

function mount() {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  return { host, root: createRoot(host) };
}

test('a render-time throw is contained and reported in place', () => {
  const { host, root } = mount();
  // React logs the caught error; silence it so the run stays readable.
  const realError = console.error;
  console.error = () => {};
  try {
    act(() => {
      root.render(createElement(MermaidRenderBoundary, null, createElement(Boom)));
    });
  } finally {
    console.error = realError;
  }

  const alert = host.querySelector('[role="alert"]');
  assert.ok(alert, 'the throw escaped the boundary instead of rendering a fallback');
  assert.match(alert.textContent ?? '', /Couldn.t render this diagram/);
  // The message is surfaced, not swallowed — otherwise the fallback tells the
  // user nothing they can act on or report.
  assert.match(alert.textContent ?? '', /diagram subtree exploded/);

  act(() => root.unmount());
  host.remove();
});

test('an ordinary subtree renders untouched', () => {
  const { host, root } = mount();
  act(() => {
    root.render(
      createElement(MermaidRenderBoundary, null, createElement('div', { className: 'mermaid-modal-canvas' }, 'ok')),
    );
  });
  assert.equal(host.querySelector('[role="alert"]'), null, 'the boundary fired without a throw');
  assert.ok(host.querySelector('.mermaid-modal-canvas'), 'the child did not render');
  act(() => root.unmount());
  host.remove();
});
