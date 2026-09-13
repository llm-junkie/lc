import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  MAX_ASK_USER_CUSTOM_ANSWER_CHARS,
  type AskUserInput,
  type AskUserInteractionResult,
  type AskUserOutput,
} from '../../modules/tool-engine/ask-user.ts';
import { useOrderedOverlayLayer, useOverlayKeys } from '../../utils/overlay-stack.ts';
import {
  enqueueGenerationInteraction,
  type GenerationInteractionIdentity,
} from '../../modules/chat-pipeline/interaction-coordinator.ts';

export const ASK_USER_UI_TEXT = Object.freeze({
  title: 'Questions',
  custom: 'Custom answer',
  customPlaceholder: 'Enter your answer',
  skip: 'Skip',
  previous: 'Previous question',
  next: 'Next question',
  done: 'Done',
});

export interface AskUserModalRequest {
  input: AskUserInput;
  conversationId: string;
  conversationTitle: string;
  modelId: string;
  signal: AbortSignal;
}

type AskUserHostHandler = (request: AskUserModalRequest) => Promise<AskUserInteractionResult>;
type Resolver = (result: AskUserInteractionResult) => void;

interface PendingHostRequest {
  request: AskUserModalRequest;
  resolve: Resolver;
  timeout: ReturnType<typeof setTimeout>;
  detachAbort: () => void;
}

let hostHandler: AskUserHostHandler | null = null;
let pendingHostRequest: PendingHostRequest | null = null;

/** Register the single global ask-user modal host. */
export function registerAskUserHandler(handler: AskUserHostHandler): () => void {
  hostHandler = handler;
  const pending = pendingHostRequest;
  pendingHostRequest = null;
  if (pending) {
    clearTimeout(pending.timeout);
    pending.detachAbort();
    if (pending.request.signal.aborted) {
      pending.resolve({ decision: 'aborted' });
    } else {
      void Promise.resolve()
        .then(() => handler(pending.request))
        .then(pending.resolve)
        .catch(() => pending.resolve({ decision: 'unavailable' }));
    }
  }
  return () => {
    if (hostHandler === handler) hostHandler = null;
  };
}

/** Open the global ask-user modal or fail closed when its host is unavailable. */
function presentAskUserModal(
  input: AskUserInput,
  conversation: { id: string; title: string; modelId: string },
  signal: AbortSignal,
): Promise<AskUserInteractionResult> {
  if (signal.aborted) return Promise.resolve({ decision: 'aborted' });
  const request: AskUserModalRequest = {
    input,
    conversationId: conversation.id,
    conversationTitle: conversation.title,
    modelId: conversation.modelId,
    signal,
  };
  if (hostHandler) {
    return hostHandler(request).catch(() => ({ decision: 'unavailable' }));
  }
  if (pendingHostRequest) return Promise.resolve({ decision: 'busy' });

  return new Promise<AskUserInteractionResult>((resolve) => {
    let settled = false;
    const settle: Resolver = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(pending.timeout);
      pending.detachAbort();
      if (pendingHostRequest === pending) pendingHostRequest = null;
      resolve(result);
    };
    const onAbort = () => settle({ decision: 'aborted' });
    const pending: PendingHostRequest = {
      request,
      resolve: settle,
      timeout: setTimeout(() => settle({ decision: 'unavailable' }), 5_000),
      detachAbort: () => signal.removeEventListener('abort', onAbort),
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pendingHostRequest = pending;
  });
}

export interface AskUserInteractionContext {
  identity: GenerationInteractionIdentity;
  validateOwnership: () => boolean;
  onQueueWaitStart?: () => void;
  onQueueWaitEnd?: () => void;
}

/** Open the ask-user modal through the shared permission/ask-user FIFO. */
export function showAskUserModal(
  input: AskUserInput,
  conversation: { id: string; title: string; modelId: string },
  signal: AbortSignal,
  context?: AskUserInteractionContext,
): Promise<AskUserInteractionResult> {
  if (!context) return presentAskUserModal(input, conversation, signal);
  return enqueueGenerationInteraction<AskUserInteractionResult>({
    identity: context.identity,
    signal,
    validateOwnership: context.validateOwnership,
    present: (presentationSignal) => presentAskUserModal(input, conversation, presentationSignal),
    abortedResult: () => ({ decision: 'aborted' }),
    unavailableResult: () => ({ decision: 'unavailable' }),
    onQueueWaitStart: context.onQueueWaitStart,
    onQueueWaitEnd: context.onQueueWaitEnd,
  });
}

type DraftAnswer =
  | { kind: 'choice'; answer: string }
  | { kind: 'custom'; answer: string }
  | { kind: 'skipped' };

function answerIsComplete(answer: DraftAnswer | undefined): boolean {
  return answer?.kind === 'choice'
    || answer?.kind === 'skipped'
    || (answer?.kind === 'custom' && answer.answer.trim().length > 0);
}

function buildOutput(input: AskUserInput, answers: ReadonlyMap<number, DraftAnswer>): AskUserOutput {
  return {
    answers: input.questions.map((question) => {
      const answer = answers.get(question.id);
      if (!answer || answer.kind === 'skipped') return { id: question.id, skipped: true };
      return { id: question.id, answer: answer.answer.trim() };
    }),
  };
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute('hidden'));
}

function resizeCustomAnswer(element: HTMLTextAreaElement): void {
  element.style.height = '0px';
  const styles = window.getComputedStyle(element);
  const minHeight = Number.parseFloat(styles.minHeight) || 54;
  const maxHeight = Number.parseFloat(styles.maxHeight) || 109;
  const borderHeight = (Number.parseFloat(styles.borderTopWidth) || 0)
    + (Number.parseFloat(styles.borderBottomWidth) || 0);
  const contentHeight = element.scrollHeight + borderHeight;
  element.style.height = `${Math.min(maxHeight, Math.max(minHeight, contentHeight))}px`;
  element.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
}

export function AskUserModal() {
  const [request, setRequest] = useState<AskUserModalRequest | null>(null);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Map<number, DraftAnswer>>(() => new Map());
  const resolverRef = useRef<Resolver | null>(null);
  const detachAbortRef = useRef<(() => void) | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const initialControlRef = useRef<HTMLButtonElement | null>(null);
  const customAnswerRef = useRef<HTMLTextAreaElement | null>(null);
  const focusCustomAnswerRef = useRef(false);

  useOverlayKeys({ Escape: () => {} }, Boolean(request));
  const orderedLayerRef = useOrderedOverlayLayer(Boolean(request));

  const settle = useCallback((result: AskUserInteractionResult) => {
    const resolve = resolverRef.current;
    if (!resolve) return;
    detachAbortRef.current?.();
    detachAbortRef.current = null;
    resolverRef.current = null;
    resolve(result);
    setRequest(null);
    setAnswers(new Map());
    setQuestionIndex(0);
    const prior = previousFocusRef.current;
    previousFocusRef.current = null;
    queueMicrotask(() => prior?.focus());
  }, []);

  useEffect(() => {
    const unregister = registerAskUserHandler((nextRequest) => {
      if (resolverRef.current) return Promise.resolve({ decision: 'busy' });
      return new Promise<AskUserInteractionResult>((resolve) => {
        const onAbort = () => settle({ decision: 'aborted' });
        resolverRef.current = resolve;
        previousFocusRef.current = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
        if (nextRequest.signal.aborted) {
          onAbort();
          return;
        }
        nextRequest.signal.addEventListener('abort', onAbort, { once: true });
        detachAbortRef.current = () => nextRequest.signal.removeEventListener('abort', onAbort);
        setAnswers(new Map());
        setQuestionIndex(0);
        setRequest(nextRequest);
      });
    });
    return () => {
      unregister();
      if (resolverRef.current) settle({ decision: 'unavailable' });
      detachAbortRef.current?.();
      detachAbortRef.current = null;
    };
  }, [settle]);

  useEffect(() => {
    if (!request) return;
    initialControlRef.current?.focus();
  }, [questionIndex, request]);

  const currentQuestion = request?.input.questions[questionIndex];
  const currentAnswer = currentQuestion ? answers.get(currentQuestion.id) : undefined;
  const complete = useMemo(() => request?.input.questions.every((question) =>
    answerIsComplete(answers.get(question.id))) ?? false, [answers, request]);

  const setCurrentAnswer = useCallback((answer: DraftAnswer) => {
    if (!currentQuestion) return;
    setAnswers((current) => {
      const next = new Map(current);
      next.set(currentQuestion.id, answer);
      return next;
    });
  }, [currentQuestion]);

  useLayoutEffect(() => {
    const element = customAnswerRef.current;
    if (!element) return;
    resizeCustomAnswer(element);
    if (focusCustomAnswerRef.current) {
      focusCustomAnswerRef.current = false;
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    }
  }, [currentAnswer]);

  const onDialogKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !cardRef.current) return;
    const focusable = focusableElements(cardRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  if (!request || !currentQuestion) return null;

  const submit = () => settle({ decision: 'submitted', data: buildOutput(request.input, answers) });
  const advanceToNextQuestion = () => {
    if (request.input.questions.length > 1
      && questionIndex < request.input.questions.length - 1) {
      setQuestionIndex((current) => current + 1);
    }
  };

  return createPortal(
    <div
      ref={orderedLayerRef}
      className="modal-backdrop ask-user-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ask-user-modal-title"
      aria-describedby="ask-user-question"
      onKeyDown={onDialogKeyDown}
    >
      <div className="modal-card ask-user-modal" ref={cardRef}>
        <header className="ask-user-header">
          <h3 id="ask-user-modal-title">{ASK_USER_UI_TEXT.title}</h3>
        </header>

        <div className="permission-modal-context ask-user-context" aria-label="Request context">
          <p>
            Chat:{' '}
            <strong className="permission-modal-context-value" title={request.conversationTitle}>
              {request.conversationTitle || 'Untitled conversation'}
            </strong>
          </p>
          <p>
            Model:{' '}
            <strong className="permission-modal-context-value" title={request.modelId}>
              {request.modelId}
            </strong>
          </p>
        </div>

        <p id="ask-user-question" className="ask-user-question" aria-live="polite">
          ({questionIndex + 1}/{request.input.questions.length}) {currentQuestion.question}
        </p>

        <div className="ask-user-choices" role="group" aria-label="Answer choices">
          {currentQuestion.choices.map((choice, index) => {
            const selected = currentAnswer?.kind === 'choice' && currentAnswer.answer === choice.title;
            return (
              <button
                key={choice.title}
                ref={index === 0 ? initialControlRef : undefined}
                type="button"
                className={`ask-user-choice${selected ? ' is-selected' : ''}`}
                aria-pressed={selected}
                onClick={() => {
                  setCurrentAnswer({ kind: 'choice', answer: choice.title });
                  advanceToNextQuestion();
                }}
              >
                <span className="ask-user-choice-title">{choice.title}</span>
                {choice.description && (
                  <span className="ask-user-choice-description">{choice.description}</span>
                )}
              </button>
            );
          })}

          <button
            type="button"
            className={`ask-user-choice ask-user-custom-choice${currentAnswer?.kind === 'custom' ? ' is-selected' : ''}`}
            aria-pressed={currentAnswer?.kind === 'custom'}
            onClick={() => {
              focusCustomAnswerRef.current = true;
              setCurrentAnswer({
                kind: 'custom',
                answer: currentAnswer?.kind === 'custom' ? currentAnswer.answer : '',
              });
            }}
          >
            <span className="ask-user-choice-title">{ASK_USER_UI_TEXT.custom}</span>
          </button>

          {currentAnswer?.kind === 'custom' && (
            <textarea
              ref={customAnswerRef}
              className="ask-user-custom-input"
              aria-label={ASK_USER_UI_TEXT.custom}
              placeholder={ASK_USER_UI_TEXT.customPlaceholder}
              rows={2}
              maxLength={MAX_ASK_USER_CUSTOM_ANSWER_CHARS}
              value={currentAnswer.answer}
              onChange={(event) => setCurrentAnswer({ kind: 'custom', answer: event.target.value })}
            />
          )}
        </div>

        <div className="ask-user-actions">
          <button
            type="button"
            className="permission-modal-btn ask-user-skip"
            onClick={() => {
              setCurrentAnswer({ kind: 'skipped' });
              advanceToNextQuestion();
            }}
          >
            {ASK_USER_UI_TEXT.skip}
          </button>
          <div className="ask-user-navigation">
            <button
              type="button"
              className="icon-btn"
              aria-label={ASK_USER_UI_TEXT.previous}
              title={questionIndex === 0 ? 'This is the first question' : ASK_USER_UI_TEXT.previous}
              disabled={questionIndex === 0}
              onClick={() => setQuestionIndex((index) => Math.max(0, index - 1))}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="14 6 8 12 14 18" />
              </svg>
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={ASK_USER_UI_TEXT.next}
              title={questionIndex === request.input.questions.length - 1
                ? 'This is the last question'
                : ASK_USER_UI_TEXT.next}
              disabled={questionIndex === request.input.questions.length - 1}
              onClick={() => setQuestionIndex((index) => Math.min(request.input.questions.length - 1, index + 1))}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="10 6 16 12 10 18" />
              </svg>
            </button>
          </div>
          <button
            type="button"
            className="permission-modal-btn permission-modal-btn-primary"
            disabled={!complete}
            onClick={submit}
          >
            {ASK_USER_UI_TEXT.done}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
