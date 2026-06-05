/**
 * Side-channel for "AFK wants the parent shell to cd here on exit."
 *
 * Why this exists:
 *   A child process (afk) cannot change its parent shell's cwd — that's a
 *   POSIX hard rule. The standard workaround, used by nvm/direnv/fnm/pyenv,
 *   is a thin shell wrapper function on the user side that reads a
 *   marker file the child wrote, then cd's the shell into the recorded
 *   path after the child exits.
 *
 * Contract:
 *   - `clearCdIntent()` runs once at CLI startup so a stale marker from a
 *     previous run can never hijack a later invocation.
 *   - `recordCdIntent(path)` is called when AFK preserves a worktree
 *     (dirty exit). After AFK exits, the shell wrapper installed via
 *     `afk shell-init` reads + deletes the marker and `cd`s.
 *   - Clean exits (worktree removed) write nothing — there's no directory
 *     to cd into.
 *
 * Both operations are best-effort: writing into `~/.afk/state/` is not
 * load-bearing, so transient fs failures are swallowed.
 *
 * @module utils/cd-on-exit
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { env } from '../config/env.js';
import { getAfkStateDir } from '../paths.js';

/**
 * Absolute path to the marker file. Lives under
 * `$AFK_HOME/state/last-cwd` (default `~/.afk/state/last-cwd`).
 *
 * Exported so the `afk shell-init` command can splice the literal path
 * into the generated wrapper without re-deriving it.
 */
export function getCdIntentPath(): string {
  return join(getAfkStateDir(), 'last-cwd');
}

/**
 * Remove the marker file if it exists. Called early in CLI bootstrap so
 * that an `afk` invocation never auto-cds the user based on data left
 * over from a prior session. Idempotent and silent on missing-file.
 */
export function clearCdIntent(): void {
  try {
    rmSync(getCdIntentPath(), { force: true });
  } catch {
    /* best-effort — never block CLI startup */
  }
}

/**
 * Write `target` as the desired post-exit cwd. The shell wrapper
 * installed via `afk shell-init` reads this immediately after the
 * binary exits, deletes the marker, and `cd`s the parent shell.
 *
 * Without the wrapper this file is harmless — the next `afk`
 * invocation clears it via {@link clearCdIntent}.
 *
 * Rejects relative paths and paths containing control characters
 * (`\n`, `\r`, `\0`). Relative paths would be resolved by the shell
 * against the wrapper's cwd (not AFK's), silently landing the user
 * in the wrong directory. A newline produces a multi-line marker;
 * `$(cat marker)` returns only the first line, also silently
 * landing the user in the wrong directory.
 *
 * Writes are atomic: a temp file is written then renamed into place
 * (POSIX `rename(2)` is atomic on the same filesystem) so a partial
 * write or SIGKILL can never leave a zero-byte marker that would
 * make the wrapper `cd ""` — a silent no-op that would also leave
 * the marker behind forever.
 *
 * @param target absolute filesystem path the parent shell should cd to
 * @throws if `target` is not absolute or contains `\n`, `\r`, or `\0`
 */
export function recordCdIntent(target: string): void {
  // Validation runs BEFORE the try/catch so calling code learns of
  // contract violations (vs. genuine I/O failures, which stay silent).
  if (!isAbsolute(target)) {
    throw new Error(
      `recordCdIntent: target must be an absolute path, got ${JSON.stringify(target)}`,
    );
  }
  if (/[\n\r\0]/.test(target)) {
    throw new Error(
      `recordCdIntent: target must not contain newline/CR/NUL, got ${JSON.stringify(target)}`,
    );
  }
  try {
    const file = getCdIntentPath();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // Atomic write: write to a sibling temp file, then rename into place.
    // POSIX guarantees rename(2) is atomic when both paths are on the
    // same filesystem (which they are — both under $AFK_HOME/state/).
    // This rules out the partial-write footgun where a SIGKILL during
    // writeFileSync leaves a zero-byte marker that the wrapper reads as
    // `cd ""` (silent no-op) and never garbage-collects.
    // Suffix uses pid + cryptographic randomness rather than Date.now():
    // ms-resolution timestamps can collide if two cleanup paths within the
    // same process race (same pid + same ms), leaving an orphan tmp file
    // when one rename loses to the other. 6 bytes → 2^48 entropy is
    // overkill but the cost is identical and the failure mode is silent.
    const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
    try {
      // No trailing newline — the wrapper reads with `cat` and compares
      // against `-d`, which tolerates either form. Match what `pwd` would
      // output for symmetry with manual inspection.
      writeFileSync(tmp, target, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, file);
    } catch (err) {
      // Best-effort cleanup of the temp file if the rename failed.
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore — temp file may not exist */
      }
      throw err;
    }
  } catch {
    /* best-effort — cd-on-exit is convenience, not correctness */
  }
}

/**
 * Env var the shell wrapper sets so AFK can detect whether the user has
 * opted into auto-cd. Used by exit-summary code to suppress the
 * "install the wrapper" hint when the wrapper is already active.
 */
export const SHELL_WRAPPER_ENV_VAR = 'AFK_SHELL_WRAPPER';

/**
 * Returns true when the parent shell has the `afk` wrapper function
 * installed and active (it sets {@link SHELL_WRAPPER_ENV_VAR} before
 * invoking the binary).
 */
export function shellWrapperActive(): boolean {
  const v = env.AFK_SHELL_WRAPPER;
  return v === '1' || v === 'true';
}
