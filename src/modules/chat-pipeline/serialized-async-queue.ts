/** Serialize UI work and convert a thrown item into a settled fallback. */
export function createSerializedAsyncQueue<Args extends unknown[], Result>(
  run: (...args: Args) => Promise<Result>,
  fallback: () => Result,
): (...args: Args) => Promise<Result> {
  let tail: Promise<void> = Promise.resolve();

  return (...args: Args) => new Promise<Result>((resolve) => {
    tail = tail.then(async () => {
      try {
        resolve(await run(...args));
      } catch {
        resolve(fallback());
      }
    });
  });
}
