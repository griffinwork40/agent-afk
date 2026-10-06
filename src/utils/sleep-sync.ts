/**
 * Shared synchronous sleep helper.
 *
 * Blocks the current thread for `ms` milliseconds without a busy loop or
 * spin-wait. Uses `Atomics.wait` on a private `SharedArrayBuffer` — the only
 * standard portable way to synchronously delay in a Node.js context.
 *
 * Node.js permits `Atomics.wait` on the main thread (unlike browsers, which
 * require a Worker). Available since Node.js ≥ 9; no flags needed in Node ≥ 22.
 *
 * @module utils/sleep-sync
 */

/**
 * Block the current thread for `ms` milliseconds.
 *
 * @param ms - Duration in milliseconds. Values ≤ 0 return immediately.
 */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
