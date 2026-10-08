/**
 * Mute the Anthropic SDK's per-request `thinking.type=enabled is deprecated`
 * console warning.
 *
 * Contract: `@anthropic-ai/sdk` `messages.create` calls `console.warn`
 * synchronously, before returning its promise, whenever the model is in
 * `MODELS_TO_WARN_WITH_THINKING_ENABLED` (claude-opus-4-6,
 * claude-mythos-preview) and `thinking.type === 'enabled'`. Manual extended
 * thinking on those models is a deliberate operator choice (the request is
 * valid and served), so the warning is pure noise that prints every turn and
 * corrupts the REPL. `console.warn` is swapped only for the synchronous
 * duration of `fn()` and restored in `finally`; JS is single-threaded, so no
 * other caller can observe the swap, and every other warning passes through.
 */
const DEPRECATION_MARKER = "'thinking.type=enabled' is deprecated";

export function isSdkThinkingDeprecationWarning(args: readonly unknown[]): boolean {
  const first = args[0];
  return typeof first === 'string' && first.startsWith('Using Claude with ') && first.includes(DEPRECATION_MARKER);
}

export function withoutSdkThinkingDeprecationWarning<T>(fn: () => T): T {
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    if (isSdkThinkingDeprecationWarning(args)) return;
    original.apply(console, args);
  };
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}
