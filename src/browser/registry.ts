/**
 * Process-wide singleton registry for the BrowserProvider.
 *
 * Constructs a `PlaywrightProvider` lazily on the first `getBrowserProvider()`
 * call. The lazy `import('./playwright/index.js')` boundary ensures Playwright
 * is never loaded into the hot path for users who never call a browser tool.
 *
 * Lifecycle:
 *   1. `getBrowserProvider()` — lazily constructs, coalesces concurrent calls.
 *   2. `closeBrowserProvider()` — tears down the provider if active. Idempotent.
 *   3. SIGINT / SIGTERM / exit signal handlers — installed exactly once per
 *      process (guarded by `signalHandlersInstalled`). Each handler calls
 *      `closeBrowserProvider()` and then re-exits with the appropriate code.
 *
 * Test-only:
 *   `__resetBrowserRegistryForTests()` — resets all module-scope state without
 *   calling shutdown. Exported from this file but intentionally NOT re-exported
 *   via `src/browser/index.ts` to keep it out of production imports.
 *
 * @module browser/registry
 */

import { loadBrowserConfig } from './config.js';
import type { BrowserProvider } from './provider.js';
import type { LoadBrowserConfigOptions } from './config.js';

// ---------------------------------------------------------------------------
// Module-scope singleton state
// ---------------------------------------------------------------------------

let provider: BrowserProvider | null = null;

// Coalesces concurrent getBrowserProvider() calls so only one PlaywrightProvider
// is ever constructed even when multiple callers race at startup.
let constructing: Promise<BrowserProvider> | null = null;

// Guards signal-handler installation so we install exactly once per process.
let signalHandlersInstalled = false;

// ---------------------------------------------------------------------------
// Signal handler references (kept so we can remove them on teardown)
// ---------------------------------------------------------------------------

function handleSignalSIGINT(): void {
  void Promise.resolve(closeBrowserProvider()).then(() => {
    process.exit(130); // 128 + SIGINT(2)
  });
}

function handleSignalSIGTERM(): void {
  void Promise.resolve(closeBrowserProvider()).then(() => {
    process.exit(143); // 128 + SIGTERM(15)
  });
}

function handleProcessExit(): void {
  // `exit` fires synchronously — we can only call synchronous cleanup here.
  // Provider shutdown is async; the best we can do is clear the reference so
  // the GC can reclaim it. The launcher.shutdown() in closeBrowserProvider()
  // will be a no-op if the process exits before it resolves.
  provider = null;
}

// ---------------------------------------------------------------------------
// Signal handler installation / removal
// ---------------------------------------------------------------------------

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  process.on('SIGINT', handleSignalSIGINT);
  process.on('SIGTERM', handleSignalSIGTERM);
  process.on('exit', handleProcessExit);
  signalHandlersInstalled = true;
}

function removeSignalHandlers(): void {
  if (!signalHandlersInstalled) return;
  process.removeListener('SIGINT', handleSignalSIGINT);
  process.removeListener('SIGTERM', handleSignalSIGTERM);
  process.removeListener('exit', handleProcessExit);
  signalHandlersInstalled = false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get (or lazily construct) the process-wide BrowserProvider.
 *
 * Contract:
 *   - If a provider already exists, returns it synchronously via a resolved
 *     promise.
 *   - If construction is in progress, returns the in-flight promise (coalesce).
 *   - Otherwise, kicks off construction:
 *       1. Lazy `await import('./playwright/index.js')` — keeps Playwright out
 *          of the module graph for users who never call a browser tool.
 *       2. `loadBrowserConfig(opts)` — resolves env + JSON config.
 *       3. `new PlaywrightProvider(config)` — synchronous, no chromium yet.
 *       4. Installs SIGINT/SIGTERM/exit handlers exactly once.
 *
 * @param opts  Optional config overrides (surface, env, readFileSync).
 *              Forwarded verbatim to `loadBrowserConfig()`.
 */
export async function getBrowserProvider(opts?: LoadBrowserConfigOptions): Promise<BrowserProvider> {
  if (provider !== null) {
    return provider;
  }

  if (constructing !== null) {
    return constructing;
  }

  // Invariant: we set `constructing` before any await so that concurrent
  // callers that arrive while we are in-flight return the same promise
  // rather than starting a second construction chain.
  constructing = (async (): Promise<BrowserProvider> => {
    const { PlaywrightProvider } = await import('./playwright/index.js');
    const config = loadBrowserConfig(opts);
    const newProvider = new PlaywrightProvider(config);
    installSignalHandlers();
    provider = newProvider;
    constructing = null;
    return newProvider;
  })();

  return constructing;
}

/**
 * Tear down the provider if any. Idempotent — safe to call when no provider
 * has been constructed.
 *
 * Invariant: removes signal handlers after shutdown so a future test or
 * re-initialisation starts with a clean handler slate.
 */
export async function closeBrowserProvider(): Promise<void> {
  if (provider === null) {
    return;
  }
  const current = provider;
  provider = null;
  constructing = null;
  removeSignalHandlers();
  await current.shutdown();
}

/**
 * Read-only: returns `true` iff a provider has been constructed and not yet
 * shut down. Never triggers construction.
 */
export function browserProviderActive(): boolean {
  return provider !== null;
}

/**
 * Get the active provider WITHOUT constructing one if absent.
 * Returns `null` when no provider exists yet.
 *
 * Used by runtime-awareness code so `describe()` can read state without
 * triggering a chromium launch.
 */
export function peekBrowserProvider(): BrowserProvider | null {
  return provider;
}

/**
 * Test-only: synchronously clear all singleton state without calling shutdown.
 *
 * Invariant: this function is intentionally NOT re-exported from
 * `src/browser/index.ts`. It exists solely for vitest isolation — each test
 * that constructs a provider via `getBrowserProvider()` should call this in
 * `afterEach` or `beforeEach` to reset to a clean slate. The test harness is
 * responsible for its own provider teardown.
 */
export function __resetBrowserRegistryForTests(): void {
  provider = null;
  constructing = null;
  removeSignalHandlers();
}
