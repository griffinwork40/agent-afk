/**
 * One-shot operator diagnostic for a malformed `AFK_HOME` / `AFK_STATE_DIR`.
 *
 * Every credential-floor derivation site (`read-denylist`, `write-denylist`,
 * `bash-restriction-hook`) calls `getAfkHome()` / `getAfkStateDir()` inside a
 * `try` and drops only the derived entry when it throws. That fail-safe
 * direction is correct — a typo'd env var must never empty the floor, and the
 * hardcoded `homedir()`-based entries still apply. Its INVISIBILITY was the
 * defect: an operator who typo'd `AFK_HOME` ran on a silently reduced floor
 * with no diagnostic anywhere in the process.
 *
 * Invariant: the warning is latched to fire at most ONCE per process, not once
 * per call. These derivations sit on the read/write hot path — `getReadDenylist`
 * is consulted on every typed read and `getWriteDenylist` on every
 * `write_file`/`edit_file` — so a per-call warn would emit thousands of
 * identical lines and become its own denial-of-service on the operator's
 * terminal. The latch is module-scope state, which is why this lives in its own
 * module: all four call sites must share ONE latch, and a per-file copy would
 * warn once per file instead.
 *
 * @module agent/tools/afk-home-warn
 */

let warned = false;

/**
 * Emit a single warn-level line naming the rejected env value, then latch.
 *
 * Contract: never throws (a diagnostic must not become the failure it reports),
 * never alters control flow, and returns void. The rejected value is carried in
 * the thrown message from `paths.ts` (`... got: <value>`), so it is surfaced
 * without this module re-reading the environment.
 *
 * @param err The error thrown by `getAfkHome()` / `getAfkStateDir()`.
 */
export function warnAfkHomeRejectedOnce(err: unknown): void {
  if (warned) return;
  warned = true;
  const reason = err instanceof Error ? err.message : String(err);
  console.warn(
    `[afk-home] Malformed AFK home/state env var ignored while deriving the ` +
      `credential floor: ${reason}. The relocated tree is NOT protected — the ` +
      `default ~/.afk entries still apply. Fix the env var to restore coverage.`,
  );
}

/**
 * Test-only: clear the once-latch so a suite can assert the warning fires.
 *
 * Contract: production code must never call this. Without it a test asserting
 * the warn would depend on suite ordering — whichever spec touched a malformed
 * env var first would consume the single latch and every later assertion would
 * see silence.
 */
export function resetAfkHomeWarnLatchForTests(): void {
  warned = false;
}
