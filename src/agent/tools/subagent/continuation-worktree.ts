/**
 * Worktree lifecycle helpers for worktree-isolated continuation chains (#4266).
 *
 * When an isolation:"worktree" child ends and its chain is still continuable,
 * the foreground teardown hook calls `keepWorktreeForChain` instead of
 * tearing down: the worktree is git-locked with a reason naming the chain id
 * and the path is stored on the chain record so the next continuation can
 * run in the same tree.
 *
 * Only foreground runs keep their tree. A background or promoted run tears it
 * down at the job's end, so such a chain is not offered as continuable.
 * After `ContinuationRegistry.dispose()` (session end or reset) no tree is
 * kept: the hook and a lock that races dispose both fall back to teardown.
 *
 * When the chain can no longer be continued (limits exhausted, evicted from
 * the 256-chain cap, or session end), `releaseChainWorktree` unlocks the
 * tree and hands it back to the normal teardown sweep (remove if clean,
 * preserve-and-relock if dirty / commits-ahead).
 *
 * Both functions are best-effort (never throw): teardown runs inside finally
 * blocks where a throw would mask the real result.
 *
 * @module agent/tools/subagent/continuation-worktree
 */

import { basename, dirname } from 'node:path';
import { execFileAsync as defaultExecFile } from '../../../utils/exec-file.js';
import { teardownIsolatedWorktree } from '../handlers/worktree-managed.js';
import { debugLog } from '../../../utils/debug.js';
import { SUBAGENT_DRAIN_TIMEOUT_MS } from '../../subagent/constants.js';
import { emitSessionPhase } from '../../trace/emit.js';
import type { TraceSink } from '../../trace/writer.js';
import type { ChainRecord, ContinuationRegistry } from '../../subagent/continuation-registry.js';

/**
 * Derive the repo root from a chain worktree path.
 * AFK worktrees always live at `<repoRoot>/.afk-worktrees/<slug>`, so the
 * repo root is two dirname levels up. Returns `undefined` when the path does
 * not conform to that layout (the `.afk-worktrees` segment is absent), so
 * callers can fail-safe instead of operating on the wrong directory.
 */
export function repoRootFromWorktreePath(worktreePath: string): string | undefined {
  const afkDir = dirname(worktreePath);
  if (basename(afkDir) !== '.afk-worktrees') return undefined;
  return dirname(afkDir);
}

/**
 * Build the `onIsolationTeardown` hook for `runForegroundWithPromotion` when
 * the dispatch is a worktree-isolated chain. Returns the hook when both an
 * isolation teardown descriptor and a registry are present AND the chain was
 * minted with `isolation: "worktree"`; returns `undefined` otherwise.
 *
 * Extracted from `executeOnce` to satisfy the 200-line function ceiling.
 *
 * Contract: the returned hook never throws (callers pass it to a finally
 * block). Returns `true` when the worktree was kept (skip normal teardown);
 * `false` when the chain is no longer continuable (proceed with teardown).
 */
export function buildIsolationTeardownHook(
  isolationTeardown: { repoRoot: string; worktreePath: string } | undefined,
  chain: ChainRecord | undefined,
  registry: ContinuationRegistry | undefined,
  isContinuable: (c: ChainRecord) => boolean,
  traceWriter?: TraceSink | undefined,
): ((td: { repoRoot: string; worktreePath: string }) => Promise<boolean>) | undefined {
  if (isolationTeardown === undefined || chain === undefined || registry === undefined) return undefined;
  if (chain.inputs.isolation !== 'worktree') return undefined;
  return async (td) => {
    if (!isContinuable(chain) || chain.worktreeReleaseRequested === true) return false;
    return keepWorktreeForChain({ ...td, chainId: chain.chainId, registry, traceWriter });
  };
}

/**
 * Lock the isolated worktree for a still-continuable chain and store its path
 * on the chain record. Called by the foreground teardown hook when the chain
 * can be continued. Returns true when the worktree was kept (caller must skip
 * its normal teardown); false when locking failed and teardown should proceed.
 * Never throws.
 */
export async function keepWorktreeForChain(args: {
  repoRoot: string;
  worktreePath: string;
  chainId: string;
  registry: ContinuationRegistry;
  traceWriter?: TraceSink | undefined;
}): Promise<boolean> {
  const { repoRoot, worktreePath, chainId, registry } = args;
  try {
    await defaultExecFile('git', [
      '-C', repoRoot, 'worktree', 'lock',
      '--reason', `afk: continuation-chain ${chainId} (worktree kept between links)`,
      worktreePath,
    ]);
    const chain = registry.get(chainId);
    if (chain === undefined || chain.worktreeReleaseRequested === true) {
      // Chain evicted or session ended during locking: undo it, tear down normally.
      await defaultExecFile('git', ['-C', repoRoot, 'worktree', 'unlock', worktreePath]).catch(() => undefined);
      traceWorktree(args, 'keep', 'cancelled');
      return false;
    }
    registry.setIsolatedWorktreePath(chainId, worktreePath);
    debugLog(`[isolation] kept worktree ${worktreePath} for chain ${chainId}`);
    traceWorktree(args, 'keep', 'kept');
    return true;
  } catch (err) {
    debugLog(`[isolation] failed to keep worktree for chain ${chainId}: ${String(err)}`);
    traceWorktree(args, 'keep', 'lock_failed');
    return false;
  }
}

/**
 * Release the worktree locked for a chain and hand it back to the normal
 * teardown sweep: unlock, then remove (clean) or preserve-and-relock (dirty /
 * commits-ahead / ignored-local-state). Called when the chain can no longer be
 * continued (limits exhausted, evicted, or session end). Never throws.
 */
export async function releaseChainWorktree(args: {
  repoRoot: string;
  worktreePath: string;
  chainId: string;
  registry: ContinuationRegistry;
  traceWriter?: TraceSink | undefined;
}): Promise<void> {
  const { repoRoot, worktreePath, chainId, registry } = args;
  registry.clearIsolatedWorktreePath(chainId);
  // Prefer nested teardown first, but a hung link must not hold the lock forever.
  const waitStarted = Date.now();
  const nestedTeardown = registry.pendingLinkTeardown(chainId);
  const waitOutcome = nestedTeardown === undefined ? 'not_needed' : await waitForLinkTeardown(nestedTeardown);
  const waitMs = Math.max(0, Date.now() - waitStarted);
  const waitMetadata = { waitMs, waitOutcome };
  // Emit before git teardown as well, so a timeout remains visible even if git stalls.
  traceWorktree(args, 'release_wait', waitOutcome, waitMetadata);
  try {
    // Unlock first: teardownIsolatedWorktree refuses locked trees.
    await defaultExecFile('git', [
      '-C', repoRoot, 'worktree', 'unlock', worktreePath,
    ]);
  } catch {
    // Already unlocked or tree already removed — proceed to teardown.
  }
  try {
    const outcome = await teardownIsolatedWorktree({ repoRoot, worktreePath });
    debugLog(`[isolation] released chain worktree ${worktreePath}: ${JSON.stringify(outcome)}`);
    traceWorktree(args, 'release', outcome.removed ? 'removed' : outcome.preserved ? 'preserved' : 'failed', {
      ...waitMetadata,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    });
  } catch {
    traceWorktree(args, 'release', 'failed', waitMetadata);
  }
}

/** Bound the wait without cancelling the link's own teardown; always clear the timer. */
async function waitForLinkTeardown(done: Promise<void>): Promise<'settled' | 'timed_out' | 'failed'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      done.then(() => 'settled' as const, () => 'failed' as const),
      new Promise<'timed_out'>((resolve) => {
        timer = setTimeout(() => resolve('timed_out'), SUBAGENT_DRAIN_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort witness rows, like continuation_settle_degraded. No raw error text. */
function traceWorktree(
  args: { chainId: string; worktreePath: string; traceWriter?: TraceSink | undefined },
  operation: 'keep' | 'release_wait' | 'release',
  outcome: string,
  metadata: Record<string, string | number | boolean> = {},
): void {
  void emitSessionPhase(args.traceWriter, {
    phase: 'continuation_worktree',
    metadata: { chainId: args.chainId, worktreePath: args.worktreePath, operation, outcome, ...metadata },
  });
}
