/** Windows kill cleanup: inherited MSYS2 pipes must not keep libuv alive (#2742). */
import type { ChildProcess } from 'node:child_process';
import { killProcessGroup } from '../../../utils/kill-process-group.js';

export const BASH_KILL_PIPE_GRACE_MS = 5_000;

/** Foreground callers already settle immediately; release orphan-held pipes too. */
export function killBashProcess(
  proc: ChildProcess,
  platform: NodeJS.Platform = process.platform,
  kill: typeof killProcessGroup = killProcessGroup,
): void {
  if (proc.pid !== undefined) kill(proc.pid);
  if (platform !== 'win32') return;
  // Do not require exit: taskkill can fail, or the root may already have exited.
  // Normal close drains output and cancels cleanup. Otherwise bound the lifetime
  // of stdout/stderr even if an MSYS2 descendant is invisible to taskkill /T.
  const cleanup = () => {
    proc.removeListener('close', cancel);
    proc.stdout?.destroy();
    proc.stderr?.destroy();
  };
  const timer = setTimeout(cleanup, BASH_KILL_PIPE_GRACE_MS).unref();
  function cancel(): void {
    clearTimeout(timer);
  }
  proc.once('close', cancel);
}
