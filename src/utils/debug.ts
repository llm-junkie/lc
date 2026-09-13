/**
 * Dev-only logging wrapper. In production builds Vite inlines
 * `import.meta.env.DEV` to `false`, and dead-code elimination
 * strips the entire guarded block — zero runtime cost.
 *
 * In Node.js (tests), `import.meta.env` is undefined, so we
 * guard with optional chaining + fallback to `false`.
 */
const DEV: boolean = (() => {
  try {
    return (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV ?? false;
  } catch {
    return false;
  }
})();

const masterSwitch = false; // Set to true to enable debug logging in dev builds.

export const debugLog = {
  log: (...args: unknown[]) => { if (DEV && masterSwitch) console.log(...args); },
  warn: (...args: unknown[]) => { if (DEV && masterSwitch) console.warn(...args); },
  error: (...args: unknown[]) => { if (DEV && masterSwitch) console.error(...args); },
};
