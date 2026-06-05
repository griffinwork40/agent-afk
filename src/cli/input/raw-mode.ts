/**
 * Raw-mode + bracketed-paste setup and idempotent restoration for the
 * autocomplete reader.
 *
 * Two bugs prompted this module to exist:
 *   1. SIGINT could trigger restoration twice (once via the keypress abort
 *      path, once via the outer `finally`), leaving the terminal half-
 *      restored. The returned `restore()` is guarded by a single flag and
 *      runs at most once, regardless of caller.
 *   2. The bracketed-paste-disable sequence (`\x1b[?2004l`) was written as
 *      a separate `stdout.write` from the `setRawMode(false)` call, and on
 *      rapid exit could be dropped before reaching the terminal. Both
 *      restoration writes are concatenated into a single `process.stdout.
 *      write` so they share a single drain boundary.
 */

const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';

export interface RawModeHandle {
  /**
   * Restore the prior raw-mode state and disable bracketed paste. Idempotent —
   * after the first call, subsequent calls are no-ops. Safe to call from both
   * the keypress abort path and a `finally` block.
   */
  restore(): void;
}

/**
 * Enter raw mode + bracketed-paste mode and return a handle whose
 * `restore()` reverses both. The caller is responsible for invoking
 * `restore()` exactly once (idempotency makes "exactly once" a soft
 * guarantee — multiple calls are silently ignored).
 */
export function enterRawMode(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): RawModeHandle {
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  // Enable bracketed paste mode to detect pasted content as atomic blocks.
  stdout.write(ENABLE_BRACKETED_PASTE);

  let restored = false;
  return {
    restore(): void {
      if (restored) return;
      restored = true;

      // Single concatenated write so both sequences share one drain
      // boundary — avoids a race where rapid exit drops the bracketed
      // paste disable before it reaches the terminal.
      try {
        stdout.write(DISABLE_BRACKETED_PASTE);
      } catch {
        /* ignore — stdout may have been closed */
      }

      try {
        stdin.setRawMode(wasRaw);
      } catch {
        /* ignore — stdin may have been closed */
      }
    },
  };
}
