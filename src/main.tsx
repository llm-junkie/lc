import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './themes/solid.css'
import { loadStartupSurface } from './startup/startup-bootstrap.ts'
import { createBrowserStartupController } from './startup/startup-runtime.ts'
import {
  isPackagedTauriRuntime,
  manualSafeStartRequested,
} from './startup/startup-platform.ts'
import type {
  StartupDiagnosticSnapshot,
  StartupFailureCode,
} from './startup/startup-state'
import type { StartupLifecycle } from './startup/startup-runtime'

/**
 * Theme CSS is loaded statically above. The actual material gating
 * happens at runtime from `utils/useApplyMaterial.ts`, based on the
 * user's `materialMode` setting (`'auto'` / `'glass'` / `'solid'`).
 *
 * Why static import instead of dynamic-per-OS:
 *   - The rules are all namespaced under `:root.solid { ... }`, so the
 *     CSS itself is a no-op until the class is set. There's nothing
 *     to "load" conditionally — the rules just don't match.
 *   - It keeps the runtime toggle instantaneous: changing the setting
 *     flips a class, no async chunk fetch, no flash.
 *   - One canonical chunk instead of Vite-managed conditional imports.
 *
 * Load order matters: `index.css` is the glassmorphic default, and
 * `solid.css` is imported second so its rules win in the cascade. (In
 * practice, since the solid rules are gated by `.solid`, they only
 * apply when the class is present, so the cascade order is mostly
 * belt-and-suspenders for the rules that mix with theme selectors.)
 */

/**
 * Last-resort recovery surface that lives inside the entry chunk, so it is
 * available even when every dynamic chunk — including the failure shell —
 * cannot be imported. It depends on nothing beyond React: even the entry
 * stylesheet may be unavailable, so it carries a few inline styles only.
 * (docs/security.md Safe Start recovery boundary.)
 */
function InlineStartupFallback({
  code,
  lastCompletedPhase,
}: {
  code: StartupFailureCode
  lastCompletedPhase?: StartupDiagnosticSnapshot['lastCompletedPhase']
}) {
  return (
    <main style={{ boxSizing: 'border-box', minHeight: '100vh', padding: '40px 20px', background: '#eef2f7', color: '#172033', fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ maxWidth: '620px', margin: '0 auto', padding: '28px', border: '1px solid #cbd5e1', borderRadius: '14px', background: '#fff' }}>
        <div style={{ display: 'inline-block', padding: '4px 9px', borderRadius: '999px', background: '#e2e8f0', color: '#334155', fontSize: '12px', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase' }}>
          Startup stopped
        </div>
        <h1 style={{ margin: '12px 0 8px', fontSize: '26px', lineHeight: 1.2 }}>
          LC could not load its recovery interface
        </h1>
        <p style={{ margin: '0 0 16px', color: '#475569' }}>
          No private exception details are shown. Close LC and relaunch it. After two consecutive
          incomplete launches, LC normally opens Safe Start.
        </p>
        <dl style={{ margin: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, .8fr) 1.2fr', gap: '12px', padding: '11px 13px', border: '1px solid #dbe3ed', borderRadius: '8px', background: '#f8fafc' }}>
            <dt style={{ margin: 0, color: '#64748b' }}>Failure code</dt>
            <dd style={{ margin: 0, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', overflowWrap: 'anywhere' }}>{code}</dd>
          </div>
          {lastCompletedPhase !== undefined && lastCompletedPhase !== 'unknown' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, .8fr) 1.2fr', gap: '12px', padding: '11px 13px', border: '1px solid #dbe3ed', borderRadius: '8px', background: '#f8fafc', marginTop: '6px' }}>
              <dt style={{ margin: 0, color: '#64748b' }}>Last completed phase</dt>
              <dd style={{ margin: 0, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', overflowWrap: 'anywhere' }}>{lastCompletedPhase}</dd>
            </div>
          )}
        </dl>
      </div>
    </main>
  )
}

/**
 * The single React root for the entry page, shared by the normal bootstrap
 * render and the recovery fallback, so a recovery render after a failed
 * mount reuses the same root instead of calling createRoot twice on one
 * container (React logs a warning for that). A fresh root's first render
 * replaces the host's existing children.
 */
let entryRoot: { host: Element; root: ReturnType<typeof createRoot> } | undefined

function entryRootFor(host: Element): ReturnType<typeof createRoot> {
  if (entryRoot !== undefined && entryRoot.host === host) return entryRoot.root
  const root = createRoot(host)
  entryRoot = { host, root }
  return root
}

/**
 * Renders the inline fallback when every other render path has failed, so a
 * rejection or a missing mount point can never leave a visible blank window.
 * Mounts on `#root`, or on `document.body` when `#root` is absent. Never
 * throws: this is the last surface the webview can show.
 */
function renderRecoveryFallback(
  code: StartupFailureCode,
  startup?: StartupLifecycle,
): void {
  const host = document.getElementById('root') ?? document.body
  if (!host) return
  try {
    entryRootFor(host).render(
      <InlineStartupFallback
        code={code}
        lastCompletedPhase={startup?.snapshot().lastCompletedPhase}
      />,
    )
  } catch {
    // The webview is already broken; there is nothing further to render.
  }
}

async function bootstrap() {
  let startup: StartupLifecycle | undefined
  try {
    startup = createBrowserStartupController({
      packagedTauri: isPackagedTauriRuntime(),
      manualSafeStart: await manualSafeStartRequested(),
    })
    const surface = await loadStartupSurface(startup, {
      loadNormal: () => import('./App.tsx'),
      loadSafeStart: async () => {
        await import('./safe-start/safe-start.css')
        return import('./safe-start/SafeStartShell.tsx')
      },
      loadStartupFailure: async () => {
        await import('./safe-start/safe-start.css')
        return import('./safe-start/StartupFailureShell.tsx')
      },
      // Cannot fail: this component is compiled into the entry chunk itself.
      loadInlineFallback: async () =>
        ({ default: InlineStartupFallback }) as unknown as typeof import('./safe-start/StartupFailureShell.tsx'),
    })
    const rootElement = document.getElementById('root')
    if (!rootElement) {
      startup.failure('shell-mount-failed')
      renderRecoveryFallback('startup-interface-unavailable', startup)
      return
    }
    const root = entryRootFor(rootElement)

    if (surface.mode === 'safe-start') {
      const SafeStartShell = surface.module.default
      root.render(<SafeStartShell startup={startup} />)
      return
    }
    if (surface.mode === 'startup-failure') {
      const StartupFailureShell = surface.module.default
      root.render(<StartupFailureShell code={surface.code} />)
      return
    }

    const App = surface.module.default
    root.render(
      <StrictMode>
        <App startup={startup} />
      </StrictMode>,
    )
  } catch {
    // bootstrap() must never leave a blank window: any rejection or throw on
    // the paths above — controller creation, the loader chain, or the mount —
    // lands on the inline entry-chunk fallback, carrying the last completed
    // phase when the controller was already created. A throw inside a
    // rendered surface is not caught here: React schedules render work, so it
    // surfaces after bootstrap() has returned, and no error boundary covers
    // the recovery surfaces.
    renderRecoveryFallback('startup-interface-unavailable', startup)
  }
}

void bootstrap()
