import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'React', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of keys.slice(0, 6)) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key as keyof typeof dom.window] });
}

let readInventory: () => Promise<string | null>;
Object.defineProperty(dom.window, '__TAURI_INTERNALS__', {
  value: {
    invoke: async (command: string) => {
      assert.equal(command, 'read_third_party_licenses');
      return readInventory();
    },
  },
});
const react = await import('react');
Object.defineProperty(globalThis, 'React', { configurable: true, value: react });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
const { act, createElement } = react;
const { createRoot } = await import('react-dom/client');
const { AboutModal } = await import('./AboutModal.tsx');

after(() => {
  dom.window.close();
  for (const key of keys) {
    const descriptor = descriptors.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

function button(label: string): HTMLButtonElement {
  const element = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  assert.ok(element, `missing button: ${label}`);
  return element;
}

async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let closeCount = 0;
  const render = async (open = true) => {
    await act(async () => root.render(createElement(AboutModal, { open, onClose: () => { closeCount++; } })));
  };
  await render();
  return {
    render,
    closed: () => closeCount,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test('About opens the bundled inventory, renders notice links, and Escape returns before closing', async () => {
  readInventory = async () => `# Third-party licenses

## Production dependency inventory

| Package | Notice |
| --- | --- |
| Example 1.0 | [L001](#l001) |

<a id="l001"></a>

### L001 — MIT License

\`\`\`text
Copyright Example Authors
Full license text
\`\`\`
`;
  const view = await mount();
  try {
    await act(async () => button('Third-party licenses').click());
    assert.equal(document.querySelector('[role="dialog"] h2')?.textContent, 'Third-party licenses');
    assert.match(document.querySelector('table')?.textContent ?? '', /Example 1\.0/);
    assert.match(document.querySelector('pre')?.textContent ?? '', /Copyright Example Authors\nFull license text/);
    assert.equal(document.activeElement, button('Back to About'));

    const notice = document.getElementById('third-party-l001');
    assert.ok(notice);
    let scrolled = false;
    notice.scrollIntoView = () => { scrolled = true; };
    await act(async () => document.querySelector<HTMLAnchorElement>('a[href="#l001"]')!.click());
    assert.ok(scrolled);
    assert.equal(dom.window.location.hash, '');

    await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })));
    assert.equal(document.querySelector('[role="dialog"] h2')?.textContent, 'LC');
    assert.equal(view.closed(), 0);
    await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })));
    assert.equal(view.closed(), 1);
  } finally {
    await view.cleanup();
  }
});

test('About explains missing inventory and allows retry after a read error', async () => {
  readInventory = async () => null;
  const view = await mount();
  try {
    await act(async () => button('Third-party licenses').click());
    assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /unavailable in this build/);
    await act(async () => button('Back to About').click());
    readInventory = async () => { throw new Error('unreadable resource'); };
    await act(async () => button('Third-party licenses').click());
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Could not read/);
    await act(async () => button('Back to About').click());
    readInventory = async () => '# Third-party licenses\n\nRecovered license text';
    await act(async () => button('Third-party licenses').click());
    assert.match(document.body.textContent ?? '', /Recovered license text/);
  } finally {
    await view.cleanup();
  }
});

test('closing About while the inventory loads resets the view and ignores the late result', async () => {
  let resolveInventory!: (text: string) => void;
  readInventory = () => new Promise((resolve) => { resolveInventory = resolve; });
  const view = await mount();
  try {
    await act(async () => button('Third-party licenses').click());
    assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /Loading/);
    await view.render(false);
    await act(async () => resolveInventory('# Third-party licenses\n\nLate inventory'));
    await view.render();
    assert.equal(document.querySelector('[role="dialog"] h2')?.textContent, 'LC');
    assert.doesNotMatch(document.body.textContent ?? '', /Late inventory/);
  } finally {
    await view.cleanup();
  }
});
