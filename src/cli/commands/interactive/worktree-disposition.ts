/**
 * Contract: the lock decision is carried in the disposition itself, not
 * inferred from `'keep'`, because locking and preserving have very different
 * lifetimes.
 *   - `'remove'`        — delete the worktree, then the branch.
 *   - `'keep-locked'`   — preserve AND `git worktree lock`. `worktree-sweep.ts`
 *                         classifies a locked tree before every age/owner check
 *                         and then no-ops on it, so this is PERMANENT: no sweep,
 *                         boot-prune, or cron will ever reclaim it. Reserved for
 *                         a choice a human actually made.
 *   - `'keep-unlocked'` — preserve without locking. The sweep stays free to
 *                         reclaim it on its normal schedule, so this is a grace
 *                         window, NOT durable retention. Used for the unattended
 *                         backstop, where nobody was asked anything.
 */
export type WorktreeDisposition = 'remove' | 'keep-locked' | 'keep-unlocked';
export type WorktreeExitPolicy = 'ask' | 'keep' | 'remove';

interface PolicySources {
  cli?: string;
  env?: string;
  config?: string;
  isTTY: boolean;
  console: Pick<Console, 'warn'>;
}

export function resolveWorktreeExitPolicy(sources: PolicySources): WorktreeExitPolicy {
  const fallback: WorktreeExitPolicy = sources.isTTY ? 'ask' : 'remove';
  const source = sources.cli !== undefined
    ? 'CLI flag'
    : sources.env !== undefined
      ? 'AFK_WORKTREE_ON_EXIT'
      : 'interactive.worktreeOnExit';
  const value = sources.cli ?? sources.env ?? sources.config;
  if (value === undefined) return fallback;
  if (value === 'ask' || value === 'keep' || value === 'remove') return value;
  sources.console.warn(
    `Ignoring unrecognised ${source} worktree exit policy ${JSON.stringify(value)}; expected ask, keep, or remove.`,
  );
  return fallback;
}

export interface WorktreeDispositionDeps {
  picker?: (opts: {
    header: readonly string[];
    options: readonly string[];
  }) => Promise<readonly string[] | null>;
  isTTY: boolean;
  policy: WorktreeExitPolicy;
  turnCount: number;
  hasWorktree: boolean;
  console: Pick<Console, 'warn'>;
}

const KEEP_OPTION = 'Keep worktree and cd into it on exit';
const REMOVE_OPTION = 'Delete worktree and branch';

export async function resolveWorktreeDisposition(
  deps: WorktreeDispositionDeps,
): Promise<WorktreeDisposition> {
  // Zero-turn or no worktree: nothing to preserve, so remove unconditionally.
  // (The `force: true` flag at interactive.ts independently short-circuits
  // zero-turn sessions; disposition is moot here, but 'remove' is semantically
  // correct so the resolved value never contradicts the force override.)
  if (deps.turnCount <= 0 || !deps.hasWorktree) {
    return 'remove';
  }
  // Explicit keep/remove is honoured regardless of TTY or picker availability.
  // An unpromptable 'ask' resolves to a reversible disposition (keep), matching
  // the picker-cancel (Esc) and picker-error paths below — ambiguity picks the
  // reversible option, not the destructive one. This covers the signal-driven
  // and double-Ctrl+C/D exit routes where the input surface is already closed
  // by the time cleanup runs and no picker can be shown.
  if (
    deps.policy !== 'ask' ||
    !deps.isTTY ||
    deps.picker === undefined
  ) {
    if (deps.policy === 'remove') return 'remove';
    // Invariant: locking makes a worktree permanently unreclaimable (see
    // WorktreeDisposition), so only a decision a human actually made earns the
    // lock. An explicit `keep` policy is such a decision. Reaching this branch
    // with an unpromptable 'ask' is not — nobody was asked, because the input
    // surface was already gone (SIGTERM/SIGHUP/Ctrl+C×2) or never existed
    // (non-TTY). Those preserve for a grace window and stay sweep-eligible;
    // locking them would leak one dead worktree per abnormal exit, forever.
    return deps.policy === 'keep' ? 'keep-locked' : 'keep-unlocked';
  }

  try {
    const picked = await deps.picker({
      header: ['Keep this worktree?', ''],
      options: [KEEP_OPTION, REMOVE_OPTION],
    });
    // Cancellation is ambiguous, so choose the reversible disposition. Unlike
    // the unpromptable branch above, the user was present and declined to
    // delete, so this is a real decision and earns the lock.
    if (picked === null) return 'keep-locked';
    return picked[0] === REMOVE_OPTION ? 'remove' : 'keep-locked';
  } catch (error) {
    deps.console.warn(
      `Could not ask how to handle the worktree (${error instanceof Error ? error.message : String(error)}); keeping it.`,
    );
    // The user was present; a widget failure is our bug, so retain durably
    // rather than letting the sweep clean up after our own crash.
    return 'keep-locked';
  }
}
