import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolCallRecord } from '../../modules/tool-engine/types';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
});
const globalKeys = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver'] as const;
const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
for (const key of globalKeys) {
  originalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: dom.window[key],
  });
}
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalReactDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'React');
const reactModule = await import('react');
Object.defineProperty(globalThis, 'React', { configurable: true, value: reactModule });
const { createElement, act } = reactModule;
const [{ createRoot }, permissionModule, overlayStackModule] = await Promise.all([
  import('react-dom/client'),
  import('./ToolPermissionModal.tsx'),
  import('../../utils/overlay-stack.ts'),
]);
const { showPermissionModal, ToolPermissionModal } = permissionModule;
const { useOrderedOverlayLayer, useOverlayEscape } = overlayStackModule;

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

const call: ToolCallRecord = {
  id: 'permission-call',
  name: 'lc_list_dir',
  arguments: '{}',
  created_at: 1,
};

const directFileCall: ToolCallRecord = {
  id: 'file-permission-call',
  name: 'lc_read_file',
  arguments: JSON.stringify({
    paths: [
      'D:\\DEV\\home\\tests\\what\\letter_to_you.md',
      'D:\\DEV\\home\\tests\\what\\smart_text_compressor.md',
    ],
  }),
  created_at: 1,
};

function assertResolvedAt(result: Awaited<ReturnType<typeof showPermissionModal>>): void {
  assert.equal(typeof result.resolvedAt, 'number');
  assert.ok(result.resolvedAt! <= Date.now());
}

test('queued permission request resolves as aborted when its generation stops', async () => {
  const controller = new AbortController();
  const pending = showPermissionModal(call, [], controller.signal);

  controller.abort();

  const result = await pending;
  assert.equal(result.decision, 'aborted');
  assert.deepEqual(result.grantedDirs, []);
  assert.equal(result.shownAt, undefined);
  assertResolvedAt(result);
});

test('already-aborted permission request never remains pending', async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await showPermissionModal(call, [], controller.signal);
  assert.equal(result.decision, 'aborted');
  assert.deepEqual(result.grantedDirs, []);
  assert.equal(result.shownAt, undefined);
  assertResolvedAt(result);
});

test('mounted permission modal dismisses and resolves aborted when generation stops', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const controller = new AbortController();
  let pending!: Promise<Awaited<ReturnType<typeof showPermissionModal>>>;

  try {
    await act(async () => {
      root.render(createElement(ToolPermissionModal));
    });
    await act(async () => {
      pending = showPermissionModal(call, ['D:\\workspace'], controller.signal);
      await Promise.resolve();
    });
    assert.ok(document.querySelector('[role="dialog"]'));

    await act(async () => {
      controller.abort();
      await Promise.resolve();
    });
    const result = await pending;
    assert.equal(result.decision, 'aborted');
    assert.deepEqual(result.grantedDirs, []);
    assert.equal(typeof result.shownAt, 'number');
    assertResolvedAt(result);
    assert.ok(result.shownAt! <= result.resolvedAt!);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('mounted permission modal timestamps the displayed decision', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let pending!: Promise<Awaited<ReturnType<typeof showPermissionModal>>>;

  try {
    await act(async () => {
      root.render(createElement(ToolPermissionModal));
    });
    await act(async () => {
      pending = showPermissionModal(call, ['D:\\workspace']);
      await Promise.resolve();
    });

    const allowOnce = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Allow once');
    assert.ok(allowOnce);
    await act(async () => {
      allowOnce.click();
      await Promise.resolve();
    });

    const result = await pending;
    assert.equal(result.decision, 'allow_once');
    assert.deepEqual(result.grantedDirs, ['D:\\workspace']);
    assert.equal(typeof result.shownAt, 'number');
    assertResolvedAt(result);
    assert.ok(result.shownAt! <= result.resolvedAt!);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('permission modal shows the chat, model ID, and tool name in the body', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const controller = new AbortController();
  let pending!: Promise<Awaited<ReturnType<typeof showPermissionModal>>>;

  try {
    await act(async () => {
      root.render(createElement(ToolPermissionModal));
    });
    await act(async () => {
      pending = showPermissionModal(call, [], controller.signal, {
        identity: {
          interactionId: 'permission-interaction',
          conversationId: 'conversation-id',
          conversationTitle: 'LC - Test 04',
          generationId: 'generation-id',
          assistantMessageId: 'assistant-id',
          toolCallId: call.id,
          kind: 'permission',
          requestedAt: Date.now(),
        },
        modelId: 'gpt-5.6-luna',
        validateOwnership: () => true,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const header = document.querySelector<HTMLElement>('.permission-modal-header');
    assert.equal(header?.textContent?.trim(), 'Permission required');

    const contextValues = Array.from(
      document.querySelectorAll<HTMLElement>('.permission-modal-context-value'),
      (element) => element.textContent,
    );
    assert.deepEqual(contextValues, ['LC - Test 04', 'gpt-5.6-luna']);

    const request = document.querySelector<HTMLElement>('.permission-modal-request');
    assert.equal(
      request?.textContent?.replace(/\s+/g, ' ').trim(),
      'The model is requesting permission to call lc_list_dir.',
    );
    assert.equal(request?.querySelector('strong')?.textContent, 'lc_list_dir');
    assert.equal(
      request?.querySelector('strong')?.classList.contains('permission-modal-tool-name'),
      true,
    );
    assert.equal(
      document.querySelector<HTMLDetailsElement>('.permission-modal-details')?.open,
      false,
    );
    assert.equal(document.querySelector('.permission-modal-files'), null);

    const deny = document.querySelector<HTMLButtonElement>('.permission-modal-btn-deny');
    assert.ok(deny);
    await act(async () => deny.click());
    assert.equal((await pending).decision, 'deny');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('permission modal lists direct file targets below their directory scopes', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let pending!: Promise<Awaited<ReturnType<typeof showPermissionModal>>>;

  try {
    await act(async () => {
      root.render(createElement(ToolPermissionModal));
    });
    await act(async () => {
      pending = showPermissionModal(directFileCall, ['D:\\DEV\\home\\tests\\what']);
      await Promise.resolve();
    });

    const sections = Array.from(document.querySelectorAll<HTMLElement>('.permission-modal-paths'));
    assert.equal(sections.length, 2);
    assert.equal(sections[0].classList.contains('permission-modal-directories'), true);
    assert.equal(sections[1].classList.contains('permission-modal-files'), true);
    assert.deepEqual(
      sections.map((section) => section.querySelector('.permission-modal-paths-label')?.textContent),
      ['Directory:', 'File:'],
    );
    assert.deepEqual(
      Array.from(
        sections[1].querySelectorAll('code'),
        (element) => element.textContent,
      ),
      [
        'D:\\DEV\\home\\tests\\what\\letter_to_you.md',
        'D:\\DEV\\home\\tests\\what\\smart_text_compressor.md',
      ],
    );

    const deny = document.querySelector<HTMLButtonElement>('.permission-modal-btn-deny');
    assert.ok(deny);
    await act(async () => deny.click());
    assert.equal((await pending).decision, 'deny');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('permission prompt owns Escape and follows later-opened top-tier layers', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let pending!: Promise<Awaited<ReturnType<typeof showPermissionModal>>>;
  let behindEscapes = 0;
  let laterEscapes = 0;

  function OrderedLayer({
    active,
    className,
    onEscape,
  }: {
    active: boolean;
    className: string;
    onEscape: () => void;
  }) {
    useOverlayEscape(onEscape, active);
    const layerRef = useOrderedOverlayLayer(active);
    return active ? createElement('div', { className, ref: layerRef }) : null;
  }

  function Harness({ later }: { later: boolean }) {
    return createElement(reactModule.Fragment, null,
      createElement(OrderedLayer, {
        active: true,
        className: 'ordered-behind',
        onEscape: () => { behindEscapes += 1; },
      }),
      createElement(ToolPermissionModal),
      createElement(OrderedLayer, {
        active: later,
        className: 'ordered-later',
        onEscape: () => { laterEscapes += 1; },
      }),
    );
  }

  try {
    await act(async () => root.render(createElement(Harness, { later: false })));
    await act(async () => {
      pending = showPermissionModal(call, []);
      await Promise.resolve();
    });

    const behind = document.querySelector<HTMLElement>('.ordered-behind');
    const permission = document.querySelector<HTMLElement>('.tool-permission-backdrop');
    assert.ok(behind);
    assert.ok(permission);
    assert.ok(Number(permission.style.zIndex) > Number(behind.style.zIndex));

    await act(async () => {
      window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(behindEscapes, 0);

    await act(async () => root.render(createElement(Harness, { later: true })));
    const later = document.querySelector<HTMLElement>('.ordered-later');
    assert.ok(later);
    assert.ok(Number(later.style.zIndex) > Number(permission.style.zIndex));
    await act(async () => {
      window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(laterEscapes, 1);
    assert.equal(behindEscapes, 0);

    const deny = document.querySelector<HTMLButtonElement>('.permission-modal-btn-deny');
    assert.ok(deny);
    await act(async () => deny.click());
    assert.equal((await pending).decision, 'deny');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('mounted permission modal releases a pending request when its host unmounts', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let pending!: Promise<Awaited<ReturnType<typeof showPermissionModal>>>;

  try {
    await act(async () => {
      root.render(createElement(ToolPermissionModal));
    });
    await act(async () => {
      pending = showPermissionModal(call, []);
      await Promise.resolve();
    });
    assert.ok(document.querySelector('[role="dialog"]'));

    await act(async () => root.unmount());
    const result = await pending;
    assert.equal(result.decision, 'unavailable');
    assert.deepEqual(result.grantedDirs, []);
    assert.equal(typeof result.shownAt, 'number');
    assertResolvedAt(result);
    assert.ok(result.shownAt! <= result.resolvedAt!);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    container.remove();
  }
});
