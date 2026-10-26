/**
 * Worktree lifecycle helpers for worktree-isolated continuation chains (#4266).
 *
 * When an isolation:"worktree" child ends and its chain is still continuable,
 * the foreground teardown hook calls `keepWorktreeForChain` instead of
 * tearing down: the worktree is git-locked with a reason naming the chain id
 * and the path is stored on the chain record so the next continuation can
 * run in the same tree.
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

import { execFileAsync as defaultExecFile } from '../../../utils/exec-file.js';
import { teardownIsolatedWorktree } from '../handlers/worktree-managed.js';
import { debugLog } from '../../../utils/debug.js';
import type { ChainRecord, ContinuationRegistry } from '../../subagent/continuation-registry.js';

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
): ((td: { repoRoot: string; worktreePath: string }) => Promise<boolean>) | undefined {
  if (isolationTeardown === undefined || chain === undefined || registry === undefined) return undefined;
  if (chain.inputs.isolation !== 'worktree') return undefined;
  return async (td) => {
    if (!isContinuable(chain)) return false;
    return keepWorktreeForChain({ ...td, chainId: chain.chainId, registry });
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
}): Promise<boolean> {
  const { repoRoot, worktreePath, chainId, registry } = args;
  try {
    await defaultExecFile('git', [
      '-C', repoRoot, 'worktree', 'lock',
      '--reason', `afk: continuation-chain ${chainId} (worktree kept between links)`,
      worktreePath,
    ]);
    registry.setIsolatedWorktreePath(chainId, worktreePath);
    debugLog(`[isolation] kept worktree ${worktreePath} for chain ${chainId}`);
    return true;
  } catch (err) {
    debugLog(`[isolation] failed to keep worktree for chain ${chainId}: ${String(err)}`);
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
}): Promise<void> {
  const { repoRoot, worktreePath, chainId, registry } = args;
  registry.clearIsolatedWorktreePath(chainId);
  try {
    // Unlock first: teardownIsolatedWorktree refuses locked trees.
    await defaultExecFile('git', [
      '-C', repoRoot, 'worktree', 'unlock', worktreePath,
    ]);
  } catch {
    // Already unlocked or tree already removed — proceed to teardown.
  }
  const outcome = await teardownIsolatedWorktree({ repoRoot, worktreePath });
  debugLog(`[isolation] released chain worktree ${worktreePath}: ${JSON.stringify(outcome)}`);
}
