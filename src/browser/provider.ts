/**
 * Pluggable backend interface for browser control.
 *
 * Invariant: this interface lives in `src/browser/` (NOT `src/agent/providers/`).
 * The latter is the LLM-provider boundary (`ModelProvider` at
 * `src/agent/provider.ts`); reusing that shape for browsers would muddy
 * the type system. We mirror the *pattern* — interface + per-backend
 * subdir + pure config — without inheriting the *type*.
 *
 * Lifecycle contract:
 *   1. One BrowserProvider per AFK process. Constructed lazily on first
 *      browser tool call from `src/browser/registry.ts`.
 *   2. The provider owns ONE browser process and N BrowserContexts —
 *      one per `AgentSession`, keyed by `sessionId`.
 *   3. A context is created lazily on first `open()` for a session.
 *   4. `close({ sessionId })` tears down that session's context but leaves
 *      the process alive for other sessions.
 *   5. SIGINT/SIGTERM/exit handlers (installed by `registry.ts`) tear down
 *      the whole process so we never leak a chromium across crashes.
 *
 * Error model:
 *   - Recoverable, semantic outcomes (ambiguous target, domain refused)
 *     are returned as discriminated unions — NEVER thrown.
 *   - Unrecoverable errors (provider crashed, OOM) are thrown; the handler
 *     wraps as `ToolResult { isError: true }`.
 *
 * @module browser/provider
 */

import type {
  ActInput,
  AmbiguousTarget,
  BlockedByPolicy,
  BrowserObservation,
  BrowserProviderState,
  CloseInput,
  ExtractInput,
  ExtractResult,
  ObserveInput,
  OpenInput,
  RenderInput,
  RenderResult,
  ScreenshotInput,
  ScreenshotResult,
} from './types.js';

/**
 * Outcome of `open()` / `act()` — either a successful observation, or one
 * of the two structured-refusal surfaces. Handlers pattern-match on the
 * `outcome` discriminator (when present) to map to the right ToolResult.
 *
 * Why a discriminated union and not exceptions: `ambiguous_target` and
 * `blocked_by_policy` are *expected* outcomes the agent can react to —
 * the agent retries with `element_id` or refines its URL respectively.
 * Exceptions would force the dispatcher's generic error envelope, losing
 * the structured retry hint.
 */
export type OpenOutcome = BrowserObservation | BlockedByPolicy;
export type ActOutcome = BrowserObservation | AmbiguousTarget | BlockedByPolicy;

/**
 * The pluggable backend. Phase 1 has exactly one implementation:
 * `PlaywrightProvider` (in `./playwright/index.ts`). Phase 4 may add
 * `CdpProvider` for remote browser services.
 */
export interface BrowserProvider {
  /** Backend identifier — `'playwright'` for the Phase 1 impl. */
  readonly name: string;

  /**
   * Navigate to a URL in the session's tab (creating the context lazily
   * on first call) and return the post-load observation.
   *
   * Returns `BlockedByPolicy` when the URL host fails the allowlist /
   * blocklist policy. Throws on unrecoverable provider errors (browser
   * crashed, OOM).
   */
  open(input: OpenInput): Promise<OpenOutcome>;

  /**
   * Re-snapshot the current page without performing an action. Useful
   * after waiting for content to load or after an action triggered an
   * in-page DOM mutation the previous observation didn't see.
   *
   * Throws if no page is open for this session.
   */
  observe(input: ObserveInput): Promise<BrowserObservation>;

  /**
   * Perform an action against a target on the current page.
   *
   * Returns:
   *   - `BrowserObservation` — action succeeded; observation reflects
   *     post-action state.
   *   - `AmbiguousTarget` — semantic target matched 2+ elements; agent
   *     retries with `element_id`.
   *   - `BlockedByPolicy` — action triggered navigation to a refused URL.
   *
   * Throws if no page is open, or on unrecoverable provider errors.
   */
  act(input: ActInput): Promise<ActOutcome>;

  /**
   * One-shot content fetch: navigate an EPHEMERAL context to `input.url`,
   * return the fully-rendered DOM, and tear the context down. Distinct from
   * `open()` in two deliberate ways:
   *
   *   - It never creates or reuses a session tab. Each call owns a throwaway
   *     BrowserContext, so concurrent renders never collide and never disturb
   *     an interactive `browser_open` tab.
   *   - It does NOT enforce the `AFK_BROWSER_ALLOWED_DOMAINS` navigation
   *     policy. `render()` is a content-fetch primitive on par with
   *     `fetch`/curl — which AFK's threat model already treats as unrestricted
   *     network access — whereas the interactive allowlist governs agent-driven
   *     navigation. The `web_scrape` markdown path depends on this parity with
   *     its plain-`fetch` branch (both reach any URL the host network can).
   *
   * Throws on navigation failure, timeout, abort, or a missing Playwright
   * install. Never returns a structured refusal.
   */
  render(input: RenderInput): Promise<RenderResult>;

  /**
   * Capture a screenshot. Writes a PNG sidecar file under the session's
   * witness directory and returns its path. Does NOT mutate the
   * observation cache — call `observe()` afterward if you also need a
   * fresh observation.
   *
   * Throws if no page is open.
   */
  screenshot(input: ScreenshotInput): Promise<ScreenshotResult>;

  /**
   * Extract structured data from the current page using a JSON Schema.
   * Phase 2 feature — Phase 1 implementations may throw a
   * `NotImplementedError`. Returns warnings as a sibling field rather
   * than a separate outcome — partial extractions are common and the
   * agent can act on them.
   *
   * Throws if no page is open.
   */
  extract(input: ExtractInput): Promise<ExtractResult>;

  /**
   * Tear down this session's BrowserContext. Idempotent. The browser
   * process itself stays alive for other sessions.
   */
  close(input: CloseInput): Promise<void>;

  /**
   * Read-only introspection for runtime-awareness (`get_runtime_state`
   * Phase 2 `browser` view). Returns `null` when no context exists for
   * the session. Never throws.
   */
  describe(sessionId: string): BrowserProviderState | null;

  /**
   * Process-level teardown. Called from `registry.closeBrowserProvider()`
   * and from the SIGINT/SIGTERM/exit handlers. Closes all sessions and
   * the underlying browser process. Idempotent.
   */
  shutdown(): Promise<void>;
}
