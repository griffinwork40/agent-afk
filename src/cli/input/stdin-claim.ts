/**
 * Invariant: process.stdin has exactly one active consumer at a time.
 *
 * When the TerminalCompositor is armed it owns a raw-mode keypress listener
 * on process.stdin and consumes every keystroke into its internal input
 * buffer. A parallel consumer — such as `rl.question()` on a `terminal:
 * false` readline interface, or `readWithAutocompleteTty`'s own keypress
 * loop — ALSO receives every keystroke. This dual-consumption produces the
 * PR #511 phantom-turn bug: both consumers resolve, the answer fills the
 * compositor input buffer with `queued = true`, and the next
 * `surface.readLine()` idle-flush fires the stale buffer as an unsolicited
 * user turn.
 *
 * This module promotes that invariant from a comment to a type. Callers
 * that consume stdin in a conflicting way must acquire a StdinClaimHandle
 * before doing so. An attempt to acquire while another holder is active
 * throws immediately, naming both holders so the conflict is immediately
 * diagnosable.
 *
 * ## Holders
 *  - TerminalCompositor.arm()        — acquires 'TerminalCompositor.arm'
 *  - readWithAutocompleteTty         — acquires 'reader.readWithAutocomplete'
 *  - telegram setup-wizard prompt()  — acquires via withStdinClaim(...)
 *
 * ## Non-TTY paths
 * Non-TTY code paths (CI, piped input, daemons) that do not attach a stdin
 * listener are exempt; callers gate the acquire behind `process.stdin.isTTY`
 * or simply use `withStdinClaim` knowing the hold is brief and releases in
 * `finally`.
 *
 * ## Test isolation
 * Call `__resetStdinClaimForTests()` in `beforeEach` to start each test
 * with a clean singleton — prevents cross-test state leaks.
 */

// ─── Module-private singleton state ──────────────────────────────────────────
// Invariant: only one StdinClaimHandle may be live at any time. All
// acquires/releases funnel through this single mutable reference so there
// is no race between concurrent callers (Node.js is single-threaded; the
// check-then-set is atomic within a synchronous turn).

let currentHolder: { name: string; handle: StdinClaimHandle } | null = null;

// ─── Public types ─────────────────────────────────────────────────────────────

/** Opaque token returned by {@link acquireStdinClaim}. Call `.release()` when done. */
export interface StdinClaimHandle {
  /** Idempotent — second call is a no-op. */
  release(): void;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Acquire the process-wide stdin claim under `holderName`.
 *
 * @throws {Error} if another claim is already held — the error message
 *   names both the current holder and the requested holder so the
 *   conflict is immediately diagnosable.
 */
export function acquireStdinClaim(holderName: string): StdinClaimHandle {
  if (currentHolder !== null) {
    throw new Error(
      `stdin claim conflict: '${currentHolder.name}' already holds the claim, ` +
        `'${holderName}' cannot acquire it concurrently.`,
    );
  }

  // Build the handle before assigning currentHolder so a reentrant
  // acquireStdinClaim() inside the constructor (hypothetical, but
  // defensive) observes currentHolder === null and throws correctly.
  let released = false;
  const handle: StdinClaimHandle = {
    release(): void {
      if (released) return; // idempotent
      released = true;
      // Only clear the global if this handle is still the current one.
      // A __resetStdinClaimForTests() call may have already cleared it.
      if (currentHolder?.handle === handle) {
        currentHolder = null;
      }
    },
  };

  currentHolder = { name: holderName, handle };
  return handle;
}

/**
 * Acquire the claim, run `fn`, then release in a `finally` block.
 * The release runs even when `fn` throws.
 */
export async function withStdinClaim<T>(
  holderName: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const handle = acquireStdinClaim(holderName);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}

/**
 * Return the name of the current stdin claim holder, or `null` if the
 * claim is free. Intended for diagnostics and tests.
 */
export function currentStdinClaimHolder(): string | null {
  return currentHolder?.name ?? null;
}

/**
 * Forcibly clear the singleton state. Call this in `beforeEach` to
 * prevent cross-test contamination. Must not be called from production
 * code paths.
 */
export function __resetStdinClaimForTests(): void {
  currentHolder = null;
}
