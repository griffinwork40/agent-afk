/**
 * Per-call {@link SubagentManager} construction for {@link ComposeExecutor}.
 * Split out of `compose-executor.ts` to keep `ComposeExecutor.execute` under
 * the 200-line function ceiling (#1865).
 *
 * @module agent/tools/compose-executor.manager
 */

import { SubagentManager } from '../subagent.js';
import type { SubagentProgressSink } from '../types/session-types.js';
import { getCurrentSink } from '../_lib/skill-sink-channel.js';
import { buildParentCredentialOpt } from './compose-executor.credential.js';
import type { ComposeExecutorContext } from './compose-executor.context.js';

/** Explicit inputs for {@link createComposeManager}. */
export interface CreateComposeManagerArgs {
  ctx: ComposeExecutorContext;
  signal: AbortSignal;
  currentCwd: string | undefined;
  nodeReadRoots: string[] | undefined;
}

/**
 * Build the ephemeral manager that forks every DAG node for one compose call.
 */
export function createComposeManager(args: CreateComposeManagerArgs): SubagentManager {
  const { ctx, signal, currentCwd, nodeReadRoots } = args;
  // Resolve the ambient sink when an event is delivered (rather than when
  // the manager is constructed), while preserving compose's historical
  // guarantee that renderer failures cannot fail a child node.
  const isolatingProgressSink: SubagentProgressSink = (event, meta) => {
    try {
      getCurrentSink()?.(event, meta);
    } catch {
      // Progress rendering is best-effort and must not affect execution.
    }
  };

  const manager = new SubagentManager({
    parentAbortSignal: signal,
    // #2844: pair credential with its source model (credentialModel, not defaultModel) so provider can't mismatch.
    // Built only when a real source model is known; see compose-executor.credential.ts.
    ...buildParentCredentialOpt(ctx.apiKey, ctx.credentialModel ?? ctx.defaultModel),
    // Keep ambient rendering failures isolated from node execution. The
    // forwarding sink resolves the ambient sink per event, so sinks
    // installed after manager construction are still observed.
    progressSink: isolatingProgressSink,
    ...(ctx.baseUrl !== undefined ? { baseUrl: ctx.baseUrl } : {}),
    // Anchor every forked DAG node to the session's worktree (re-anchored via
    // setCwd). Without this the manager's parentCwd is undefined and nodes
    // fall back to the host's process.cwd() (subagent.ts fork fallback).
    ...(currentCwd !== undefined ? { cwd: currentCwd } : {}),
    // Read-scope inheritance (#547): seed parentReadRoots so each DAG node's
    // read scope ⊇ the parent session's. See nodeReadRoots in execute().
    ...(nodeReadRoots !== undefined ? { parentReadRoots: nodeReadRoots } : {}),
    // Witness layer: manager-level writer so every DAG node fork emits
    // subagent_lifecycle events into the session trace (compose nodes never
    // set config.traceWriter). See ComposeExecutorContext.traceWriter.
    ...(ctx.traceWriter !== undefined ? { traceWriter: ctx.traceWriter } : {}),
    // Origin attribution: thread the surface into the manager so every DAG
    // node fork inherits the owning surface's origin ('cli'/'telegram'/
    // 'daemon', not 'unknown') via forkSubagent's parentSurface fill.
    // ctx.surface already drives routing telemetry (deriveOrigin).
    ...(ctx.surface !== undefined ? { surface: ctx.surface } : {}),
    ...(ctx.workspaceStore !== undefined ? { workspaceStore: ctx.workspaceStore } : {}),
  });
  // Subagent-success rollup: wire the per-call manager with the same
  // callback that the root manager receives (see bootstrap.ts and the
  // daemon/telegram surfaces) so every DAG node's token usage and USD cost
  // accumulates into the parent session's `session_sealed` telemetry.
  // The compose manager is ephemeral — created and torn down per execute()
  // call — so the callback must route to the parent session's accumulators
  // rather than a local one. `ctx.onSubagentSucceeded` is populated by
  // `setOnSubagentSucceeded()` (called once per session, after the session
  // is constructed, from the same surface-level code that wires rootManager).
  if (ctx.onSubagentSucceeded !== undefined) {
    manager.setOnSubagentSucceeded(ctx.onSubagentSucceeded);
  }
  return manager;
}
