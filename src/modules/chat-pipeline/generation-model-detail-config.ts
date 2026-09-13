/**
 * Monotonic ownership generation for the application model-detail cache.
 *
 * Profile mutations cannot import the cache implementation without creating a
 * server-profile/chat-pipeline module cycle. They invalidate through this
 * dependency-free counter instead. Old entries remain bounded in the cache,
 * but a later lookup cannot address them after configuration changes.
 */
let configurationGeneration = 0;

export function generationModelDetailConfigurationGeneration(): number {
  return configurationGeneration;
}

export function invalidateGenerationModelDetailConfiguration(): void {
  configurationGeneration = (configurationGeneration + 1) % Number.MAX_SAFE_INTEGER;
}
