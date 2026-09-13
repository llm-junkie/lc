import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import type { TodoSnapshot } from '../../modules/tool-engine/todo-state';

const messageBubbleSource = readFileSync(new URL('../chat/MessageBubble.tsx', import.meta.url), 'utf8');

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
});
const globalKeys = [
  'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver',
] as const;
const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
for (const key of globalKeys) {
  originalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
const originalRaf = globalThis.requestAnimationFrame;
const originalCancelRaf = globalThis.cancelAnimationFrame;
globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
  setTimeout(() => callback(performance.now()), 0) as unknown as number);
globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalReactDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'React');
const reactModule = await import('react');
Object.defineProperty(globalThis, 'React', { configurable: true, value: reactModule });
const { act, createElement } = reactModule;
const [{ createRoot }, { TodoBody }] = await Promise.all([
  import('react-dom/client'),
  import('./TodoBody.tsx'),
]);

after(() => {
  dom.window.close();
  for (const key of globalKeys) {
    const descriptor = originalDescriptors.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCancelRaf;
  if (originalReactDescriptor) Object.defineProperty(globalThis, 'React', originalReactDescriptor);
  else delete (globalThis as Record<string, unknown>).React;
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const snapshot: TodoSnapshot = {
  sourceAssistantId: 'assistant-todo',
  sourceMessageIndex: 2,
  toolCallId: 'todo-call',
  callIndex: 0,
  completed: 1,
  blocked: 1,
  total: 3,
  todos: [
    {
      id: 1,
      title: 'Finished task',
      status: 'completed',
      completion_evidence: 'The focused test passed.',
    },
    { id: 7, title: 'Current task', status: 'in-progress', note: 'Continue here.' },
    { id: 9, title: 'Blocked task', status: 'blocked', note: 'Needs input.' },
  ],
};

test('todo preview uses the shared preview empty-state family', async () => {
  const container = document.getElementById('root')!;
  const root = createRoot(container);

  try {
    await act(async () => root.render(createElement(TodoBody, {})));
    assert.equal(container.querySelector('.todo-body-empty')?.tagName, 'DIV');
    assert.equal(container.textContent, 'No to-do list is available at this message.');
  } finally {
    await act(async () => root.unmount());
  }
});

test('todo preview renders semantic point-in-time state', async () => {
  const container = document.getElementById('root')!;
  const root = createRoot(container);

  try {
    await act(async () => root.render(createElement(TodoBody, { snapshots: [snapshot] })));
    assert.equal(container.querySelector('section')?.getAttribute('aria-label'), 'To do list');
    assert.equal(container.querySelectorAll('.todo-body-list > li').length, 3);
    assert.match(container.textContent ?? '', /1 of 3 completed/);
    assert.doesNotMatch(container.textContent ?? '', /List 1:/);
    assert.match(container.textContent ?? '', /Current task/);
    assert.match(container.textContent ?? '', /• Completion evidence: The focused test passed\./);
    assert.equal(container.querySelector('.todo-body-current'), null);
    assert.match(
      container.querySelector('.todo-body-item.is-in-progress')?.textContent ?? '',
      /Current task/,
    );
    assert.match(container.textContent ?? '', /• Note: Needs input\./);
  } finally {
    await act(async () => root.unmount());
  }
});

test('todo preview renders every ordered snapshot in the selected user turn', async () => {
  const container = document.getElementById('root')!;
  const root = createRoot(container);
  const childSnapshot: TodoSnapshot = {
    ...snapshot,
    sourceAssistantId: 'assistant-child-todo',
    sourceMessageIndex: 4,
    toolCallId: 'child-todo-call',
    completed: 0,
    blocked: 0,
    total: 2,
    todos: [
      { id: 101, title: 'First child task', status: 'in-progress' },
      { id: 102, title: 'Second child task', status: 'not-started' },
    ],
  };

  try {
    await act(async () => root.render(createElement(TodoBody, {
      snapshots: [snapshot, childSnapshot],
    })));
    assert.equal(container.querySelectorAll('.todo-body-snapshot').length, 2);
    assert.equal(container.querySelectorAll('.todo-body-list').length, 2);
    assert.match(container.textContent ?? '', /List 1: 1 of 3 completed/);
    assert.match(container.textContent ?? '', /List 2: 0 of 2 completed/);
    assert.ok((container.textContent ?? '').indexOf('Finished task')
      < (container.textContent ?? '').indexOf('First child task'));
  } finally {
    await act(async () => root.unmount());
  }
});

test('todo bubble availability is independent from the two-or-more count badge', () => {
  assert.match(
    messageBubbleSource,
    /todoCount !== undefined && onShowTodo && \([^]*className="bubble-icon-btn bubble-preview-toggle bubble-todo-toggle"/,
  );
  assert.match(
    messageBubbleSource,
    /className="bubble-icon-btn bubble-preview-toggle bubble-todo-toggle"[^]*todoCount >= 2[^]*bubble-icon-btn-badge/,
  );
});
