/**
 * Top-level error boundary. Catches any render-time error in the app
 * tree and shows a friendly "something broke" screen instead of a
 * blank window. This is the last line of defence against the kinds
 * of crashes that previously left the Tauri webview rendering
 * nothing — a single thrown error in a child component unmounts the
 * whole tree otherwise.
 *
 * The boundary deliberately does NOT try to recover or re-render the
 * children. If something broke badly enough to throw during render,
 * the safest thing is to stop, show the error, and let the user
 * reload. A "try again" button would just re-trigger the same crash
 * in most cases.
 */
import { Component, type ReactNode } from 'react';
import { debugLog } from '../../utils/debug.ts';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    // Log to the webview console — Tauri's webview console shows up
    // in the terminal when running `tauri dev`, and in the WebView2
    // dev tools in production. Keeping the component stack makes
    // future debugging much faster.
    debugLog.error('[ErrorBoundary] Caught:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary">
        <h1 className="error-boundary-title">Something went wrong</h1>
        <p className="error-boundary-message">
          The app hit an unexpected error and had to stop. Your
          conversations and settings are safe — reloading will bring
          you back to a clean state.
        </p>
        <pre className="error-boundary-stack">{error.message}</pre>
        <button
          type="button"
          className="error-boundary-reload"
          onClick={() => window.location.reload()}
        >
          Reload app
        </button>
      </div>
    );
  }
}