export type WorktreeDisposition = 'remove' | 'keep';
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
  // An unpromptable 'ask' resolves to the reversible disposition (keep),
  // matching the picker-cancel (Esc) and picker-error paths below — ambiguity
  // picks the reversible option, not the destructive one. This covers the
  // signal-driven and double-Ctrl+C/D exit routes where the input surface is
  // already closed by the time cleanup runs and no picker can be shown.
  if (
    deps.policy !== 'ask' ||
    !deps.isTTY ||
    deps.picker === undefined
  ) {
    return deps.policy === 'remove' ? 'remove' : 'keep';
  }

  try {
    const picked = await deps.picker({
      header: ['Keep this worktree?', ''],
      options: [KEEP_OPTION, REMOVE_OPTION],
    });
    // Cancellation is ambiguous, so choose the reversible disposition.
    if (picked === null) return 'keep';
    return picked[0] === REMOVE_OPTION ? 'remove' : 'keep';
  } catch (error) {
    deps.console.warn(
      `Could not ask how to handle the worktree (${error instanceof Error ? error.message : String(error)}); keeping it.`,
    );
    return 'keep';
  }
}
