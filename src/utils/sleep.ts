/**
 * Shared sleep helper for product code outside the provider layer.
 *
 * The provider-layer already has `sleep` + `sleepWithAbort` in
 * `src/agent/providers/shared/sleep-with-abort.ts`.  This module re-exports
 * that shared implementation so the rest of the codebase can import from
 * `../utils/sleep` instead of reaching into the provider path.
 *
 * **Variants**
 *
 * - `sleep(ms)` — unconditional sleep, timer **ref'd** (event loop stays alive).
 *   Use for visible waits: Telegram startup probes, setup-wizard pauses,
 *   rate-limit backoff, plugin-install delays.
 *
 * - `sleep(ms, { unref: true })` — same sleep, timer **unref'd** (does not
 *   prevent process exit).  Use only for advisory sleeps that already have
 *   other ref'd work in flight.  The interactive-session close path uses
 *   `{ unref: true }` explicitly; callers that need that behaviour should
 *   pass the option rather than rolling a new inline variant.
 *
 * @module utils/sleep
 */

export { sleep } from '../agent/providers/shared/sleep-with-abort.js';
