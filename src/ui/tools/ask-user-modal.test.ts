import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><button id="prior">Prior</button><div id="root"></div></body></html>', {
  url: 'http://localhost/',
});
const globalKeys = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Node',
  'MutationObserver',
  'KeyboardEvent',
  'Event',
  'MouseEvent',
] as const;
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
const [{ createRoot }, askUserModule] = await Promise.all([
  import('react-dom/client'),
  import('./AskUserModal.tsx'),
]);
const { AskUserModal, showAskUserModal } = askUserModule;

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

const input = {
  questions: [{
    id: 4,
    question: 'Choose the format.',
    choices: [{ title: 'Markdown', description: 'Easy to edit.' }, { title: 'Plain text' }],
  }, {
    id: 9,
    question: 'Choose the length.',
    choices: [{ title: 'Short' }, { title: 'Detailed' }],
  }],
};

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim() === label
      || candidate.getAttribute('aria-label') === label
      || candidate.querySelector('.ask-user-choice-title')?.textContent?.trim() === label);
  assert.ok(found, `missing button ${label}`);
  return found;
}

async function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(AskUserModal)));
  return { container, root };
}

function conversation(id: string, title: string, modelId = 'test-model') {
  return { id, title, modelId };
}

test('unmounted host bounds one pending request and rejects a second as busy', async () => {
  const controller = new AbortController();
  const first = showAskUserModal(input, conversation('first', 'First chat'), controller.signal);
  const second = await showAskUserModal(input, conversation('second', 'Second chat'), new AbortController().signal);
  assert.deepEqual(second, { decision: 'busy' });
  controller.abort();
  assert.deepEqual(await first, { decision: 'aborted' });
});

test('choice selection advances, preserves answers, blocks passive dismissal, and submits in input order', async () => {
  const { container, root } = await mount();
  const prior = document.querySelector<HTMLButtonElement>('#prior');
  assert.ok(prior);
  prior.focus();
  let pending!: ReturnType<typeof showAskUserModal>;

  try {
    await act(async () => {
      pending = showAskUserModal(
        input,
        conversation('chat-1', 'Design discussion', 'gpt-5.6-luna'),
        new AbortController().signal,
      );
      await Promise.resolve();
    });
    const contextValues = Array.from(
      document.querySelectorAll<HTMLElement>('.ask-user-context .permission-modal-context-value'),
      (element) => element.textContent,
    );
    assert.deepEqual(contextValues, ['Design discussion', 'gpt-5.6-luna']);
    assert.equal(document.querySelector('.ask-user-question')?.textContent?.trim(),
      '(1/2) Choose the format.');
    const actions = document.querySelector('.ask-user-actions');
    const navigation = document.querySelector('.ask-user-navigation');
    assert.equal(navigation?.parentElement, actions);
    assert.equal(actions?.firstElementChild, button('Skip'));
    assert.equal(button('Done').previousElementSibling, navigation);
    assert.equal(Array.from(document.querySelectorAll('button'))
      .some((candidate) => candidate.textContent?.trim() === 'Skip all'), false);
    assert.equal(document.activeElement, button('Markdown'));
    assert.equal(button('Done').disabled, true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.querySelector<HTMLElement>('.ask-user-backdrop')?.click();
    assert.ok(document.querySelector('[role="dialog"]'));

    await act(async () => button('Markdown').click());
    assert.equal(document.querySelector('.ask-user-question')?.textContent?.trim(),
      '(2/2) Choose the length.');
    await act(async () => button('Detailed').click());
    assert.equal(document.querySelector('.ask-user-question')?.textContent?.trim(),
      '(2/2) Choose the length.');
    assert.equal(button('Done').disabled, false);
    await act(async () => button('Previous question').click());
    assert.equal(button('Markdown').getAttribute('aria-pressed'), 'true');
    await act(async () => button('Next question').click());
    await act(async () => button('Done').click());

    assert.deepEqual(await pending, {
      decision: 'submitted',
      data: { answers: [{ id: 4, answer: 'Markdown' }, { id: 9, answer: 'Detailed' }] },
    });
    await act(async () => Promise.resolve());
    assert.equal(document.activeElement, prior);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('Custom stays put while Skip advances a multi-question request', async () => {
  const { container, root } = await mount();
  const controller = new AbortController();
  let pending!: ReturnType<typeof showAskUserModal>;

  try {
    await act(async () => {
      pending = showAskUserModal(
        input,
        conversation('chat-no-auto-cycle', 'No auto cycle'),
        controller.signal,
      );
      await Promise.resolve();
    });
    await act(async () => button('Custom answer').click());
    assert.equal(document.querySelector('.ask-user-question')?.textContent?.trim(),
      '(1/2) Choose the format.');
    await act(async () => button('Skip').click());
    assert.equal(document.querySelector('.ask-user-question')?.textContent?.trim(),
      '(2/2) Choose the length.');
    await act(async () => controller.abort());
    assert.deepEqual(await pending, { decision: 'aborted' });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('accepts a trimmed custom answer and requires non-empty text', async () => {
  const { container, root } = await mount();
  const oneQuestion = { questions: [input.questions[0]] };
  let pending!: ReturnType<typeof showAskUserModal>;

  try {
    await act(async () => {
      pending = showAskUserModal(oneQuestion, conversation('chat-2', 'Custom answer'), new AbortController().signal);
      await Promise.resolve();
    });
    await act(async () => button('Custom answer').click());
    assert.equal(button('Done').disabled, true);
    const field = document.querySelector<HTMLTextAreaElement>('.ask-user-custom-input');
    assert.ok(field);
    assert.equal(field.tagName, 'TEXTAREA');
    assert.equal(field.rows, 2);
    assert.equal(field.style.height, '54px');
    assert.equal(field.style.overflowY, 'hidden');
    assert.equal(document.activeElement, field);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(field, '  Use JSON  ');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(button('Done').disabled, false);
    await act(async () => button('Done').click());
    assert.deepEqual(await pending, {
      decision: 'submitted',
      data: { answers: [{ id: 4, answer: 'Use JSON' }] },
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('grows the custom answer through five lines and scrolls longer text', async () => {
  const { container, root } = await mount();
  const controller = new AbortController();
  let pending!: ReturnType<typeof showAskUserModal>;

  try {
    await act(async () => {
      pending = showAskUserModal(
        { questions: [input.questions[0]] },
        conversation('chat-grow', 'Growing custom answer'),
        controller.signal,
      );
      await Promise.resolve();
    });
    await act(async () => button('Custom answer').click());
    const field = document.querySelector<HTMLTextAreaElement>('.ask-user-custom-input');
    assert.ok(field);
    Object.defineProperty(field, 'scrollHeight', { configurable: true, value: 160 });
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(field, 'One\nTwo\nThree\nFour\nFive\nSix');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(field.style.height, '109px');
    assert.equal(field.style.overflowY, 'auto');
    await act(async () => controller.abort());
    assert.deepEqual(await pending, { decision: 'aborted' });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('Skip resolves only the current question and enables Done', async () => {
  const { container, root } = await mount();
  const oneQuestion = { questions: [input.questions[0]] };
  let pending!: ReturnType<typeof showAskUserModal>;

  try {
    await act(async () => {
      pending = showAskUserModal(oneQuestion, conversation('chat-skip', 'Current skip'), new AbortController().signal);
      await Promise.resolve();
    });
    await act(async () => button('Skip').click());
    assert.equal(button('Done').disabled, false);
    await act(async () => button('Done').click());
    assert.deepEqual(await pending, {
      decision: 'submitted',
      data: { answers: [{ id: 4, skipped: true }] },
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('returns busy without replacing an open modal and settles abort and unmount', async () => {
  const { container, root } = await mount();
  const controller = new AbortController();
  let first!: ReturnType<typeof showAskUserModal>;
  try {
    await act(async () => {
      first = showAskUserModal(input, conversation('chat-4', 'First owner'), controller.signal);
      await Promise.resolve();
    });
    const busy = await showAskUserModal(
      input,
      conversation('chat-5', 'Second owner'),
      new AbortController().signal,
    );
    assert.deepEqual(busy, { decision: 'busy' });
    assert.equal(document.querySelector('.ask-user-context .permission-modal-context-value')?.textContent?.trim(), 'First owner');

    await act(async () => controller.abort());
    assert.deepEqual(await first, { decision: 'aborted' });

    let unmounted!: ReturnType<typeof showAskUserModal>;
    await act(async () => {
      unmounted = showAskUserModal(input, conversation('chat-6', 'Unmount owner'), new AbortController().signal);
      await Promise.resolve();
    });
    await act(async () => root.unmount());
    assert.deepEqual(await unmounted, { decision: 'unavailable' });
  } finally {
    container.remove();
  }
});

test('wraps focus in both directions', async () => {
  const { container, root } = await mount();
  const controller = new AbortController();
  let pending!: ReturnType<typeof showAskUserModal>;
  try {
    await act(async () => {
      pending = showAskUserModal(
        { questions: [input.questions[0]] },
        conversation('chat-7', 'Focus test'),
        controller.signal,
      );
      await Promise.resolve();
    });
    const first = button('Markdown');
    const last = button('Skip');
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    assert.equal(document.activeElement, last);
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    assert.equal(document.activeElement, first);
    await act(async () => controller.abort());
    assert.deepEqual(await pending, { decision: 'aborted' });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
