/** Generate a unique ID. Uses crypto.randomUUID when available, falls back to a timestamp-based string. */
export const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
