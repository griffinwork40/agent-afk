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
  if (
    deps.policy !== 'ask' ||
    !deps.isTTY ||
    deps.picker === undefined ||
    deps.turnCount <= 0 ||
    !deps.hasWorktree
  ) {
    return deps.policy === 'keep' ? 'keep' : 'remove';
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
