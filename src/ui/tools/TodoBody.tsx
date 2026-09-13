import type { TodoSnapshot } from '../../modules/tool-engine/todo-state';

interface Props {
  snapshots?: readonly TodoSnapshot[];
}

const STATUS_LABELS = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  blocked: 'Blocked',
  completed: 'Completed',
} as const;

export const TODO_UI_TEXT = Object.freeze({
  empty: 'No to-do list is available at this message.',
  copyEmpty: 'No to-do list is available.',
  region: 'To do list',
  show: 'Show to do list',
  list: 'List',
  summaryCompleted: 'completed',
  summaryBlocked: 'blocked',
  note: 'Note',
  completionEvidence: 'Completion evidence',
  ...STATUS_LABELS,
});

export function TodoBody({ snapshots }: Props) {
  if (!snapshots?.length) {
    return <div className="todo-body-empty">{TODO_UI_TEXT.empty}</div>;
  }

  return (
    <section className="todo-body" aria-label={TODO_UI_TEXT.region}>
      {snapshots.map((snapshot, index) => (
        <div className="todo-body-snapshot" key={snapshot.toolCallId}>
          <div className="todo-body-summary">
            <span>
              {snapshots.length > 1 && `${TODO_UI_TEXT.list} ${index + 1}: `}
            </span>
            <span>
              {snapshot.completed} of {snapshot.total} {TODO_UI_TEXT.summaryCompleted}
            </span>
            {snapshot.blocked > 0 && <span>{snapshot.blocked} {TODO_UI_TEXT.summaryBlocked}</span>}
          </div>
          <ol className="todo-body-list">
            {snapshot.todos.map((todo) => (
              <li className={`todo-body-item is-${todo.status}`} key={todo.id}>
                <span className="todo-body-marker" aria-hidden>
                  {todo.status === 'completed' ? '✓' : todo.status === 'blocked' ? '!' : todo.status === 'in-progress' ? (
                    <svg viewBox="0 0 18 18">
                      <path d="M3 9h11M10 5l4 4-4 4" />
                    </svg>
                  ) : (
                    <span className="todo-body-open-marker" />
                  )}
                </span>
                <span className="sr-only">{TODO_UI_TEXT[todo.status]}</span>
                <div className="todo-body-item-text">
                  <div>
                    <span className="todo-body-id">{todo.id}</span>
                    <span className="todo-body-title">{todo.title}</span>
                  </div>
                  {todo.note && (
                    <p className="todo-body-note">
                      • {TODO_UI_TEXT.note}: {todo.note}
                    </p>
                  )}
                  {todo.completion_evidence && (
                    <p className="todo-body-note">
                      • {TODO_UI_TEXT.completionEvidence}: {todo.completion_evidence}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}
