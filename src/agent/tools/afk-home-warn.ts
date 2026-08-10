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
 * Invariant: the warning is latched to fire at most ONCE PER DISTINCT
 * malformed value, not once per call and not once globally. These
 * derivations sit on the read/write hot path — `getReadDenylist` is
 * consulted on every typed read and `getWriteDenylist` on every
 * `write_file`/`edit_file` — so a per-call warn would emit thousands of
 * identical lines and become its own denial-of-service on the operator's
 * terminal. A single process-wide boolean over-corrected: `AFK_HOME` and
 * `AFK_STATE_DIR` are derived independently (see `write-denylist.ts`) so both
 * can be malformed in the same process, and a shared boolean let the first
 * one consume the only warning, leaving the second silent. The latch is
 * therefore a `Set` keyed on the thrown message text (which already embeds
 * which variable and what value it rejected — see below) so each distinct
 * malformed value gets its own one-time warning while an unchanged malformed
 * value still warns only once. The latch is module-scope state, which is why
 * this lives in its own module: all four call sites must share ONE latch, and
 * a per-file copy would warn once per file instead.
 *
 * @module agent/tools/afk-home-warn
 */

const warnedReasons = new Set<string>();

/**
 * Emit a warn-level line naming the rejected env value, once per distinct
 * malformed value.
 *
 * Contract: never throws (a diagnostic must not become the failure it reports),
 * never alters control flow, and returns void. The rejected value is carried in
 * the thrown message from `paths.ts` (`... got: <value>`), so it is surfaced
 * without this module re-reading the environment. That message text (which
 * already embeds the offending variable name — `AFK_HOME must be...` vs.
 * `AFK_STATE_DIR must be...`) is also the latch key: a second, independently
 * malformed variable produces a different message and warns; the same
 * malformed variable read again on a later call produces the same message and
 * stays silent.
 *
 * @param err The error thrown by `getAfkHome()` / `getAfkStateDir()`.
 */
export function warnAfkHomeRejectedOnce(err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  if (warnedReasons.has(reason)) return;
  warnedReasons.add(reason);
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
 * env var first would consume the latch for that reason string and a later
 * assertion expecting the same message to fire again would see silence.
 */
export function resetAfkHomeWarnLatchForTests(): void {
  warnedReasons.clear();
}
