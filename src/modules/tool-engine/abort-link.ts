/** Link one JS AbortSignal to the native execution group exactly once. */
export function attachGroupAbort(
  signal: AbortSignal,
  groupId: string,
  abortGroup: (args: { groupId: string }) => Promise<unknown>,
): () => void {
  let fired = false;
  const onAbort = () => {
    if (fired) return;
    fired = true;
    void abortGroup({ groupId }).catch(() => {});
  };

  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  return () => signal.removeEventListener('abort', onAbort);
}
