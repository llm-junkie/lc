/**
 * Toast / notification host. Subscribes to `useToasts` and renders a
 * stack of dismissible notifications. Lives once at the App root.
 */

import { useToasts } from '../../utils/toast.ts';
import { cn } from '../../utils/cn.ts';

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="toaster" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className={cn('toast', `toast-${t.kind}`)} role={t.kind === 'error' ? 'alert' : 'status'}>
          <div className="toast-body">
            {t.title && <div className="toast-title">{t.title}</div>}
            <div className="toast-msg">{t.message}</div>
          </div>
          <button
            className="toast-close"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
            type="button"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
