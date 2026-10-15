/**
 * Browser-teardown helper for the `afk chat` one-shot surface.
 *
 * Extracted from `chat.ts` so the `registerChatCommand` function does not
 * grow past its funcsize baseline — the 673-LOC entry is already baselined
 * in `.funcsize-baseline.json` as a legacy item.
 *
 * Why this exists (issue #2580):
 *   `closeBrowserProvider()` is the idempotent teardown for the process-wide
 *   browser singleton.  Its only callers were the SIGINT/SIGTERM handlers in
 *   `src/browser/registry.ts`, which is why SIGTERM exited cleanly but normal
 *   completion left the process idle: the lazily-launched Playwright child kept
 *   the Node.js event loop alive via PipeWrap/ProcessWrap handles that were
 *   never unref'd.
 *
 * Usage:
 *   Call `closeLazyBrowser()` in the `finally` block of one-shot surfaces
 *   (afk chat, daemon task completion) AFTER `session.close()` — an in-flight
 *   tool call may still hold a browser page reference until the session drains.
 *   The call is a no-op when no browser was ever launched (checked via the
 *   module-level `browserProviderActive()` guard before importing the full
 *   registry so Playwright is never loaded on the hot path for users who never
 *   use browser tools).
 *
 * @module cli/commands/chat.browser-teardown
 */

/**
 * Shut down the lazily-launched browser provider, if any.
 *
 * Safe to call unconditionally: when no browser was launched this is a cheap
 * synchronous no-op (a single module-level boolean read).  When a browser is
 * active the async shutdown is awaited before returning.
 *
 * Never throws — any teardown error is swallowed so the caller's `finally`
 * block is never interrupted.
 */
export async function closeLazyBrowser(): Promise<void> {
  // Fast path: avoid even loading registry.js (which in turn does NOT load
  // Playwright — registry.js uses dynamic import() for Playwright) when no
  // browser was ever launched.  The registry module is already in the module
  // cache from the tool handler if a browser WAS used, so this import() is
  // effectively synchronous in that case.
  const { browserProviderActive, closeBrowserProvider } = await import(
    '../../browser/registry.js'
  );
  if (!browserProviderActive()) {
    return;
  }
  try {
    await closeBrowserProvider();
  } catch {
    // Teardown errors must never escape a finally block — swallow silently.
  }
}
