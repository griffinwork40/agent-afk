/**
 * Shared helper for forking a single mint phase subagent.
 *
 * Each of the four text-output phases (spec / research / plan / ship) follows
 * exactly the same three-step pattern:
 *   1. Construct a `SubagentManager` seeded with the parent context (cwd,
 *      readRoots, traceWriter, workspaceStore).
 *   2. Fork a subagent with phase-specific identifiers and optional phaseRole.
 *   3. Run the subagent to completion and hard-fail on any incomplete result.
 *
 * `forkMintPhase` encapsulates all three steps so each phase file reduces to
 * its own input-assembly and prompt-lookup logic (~180 LOC saving across the
 * four files).
 */

import { SubagentManager } from '../../../agent/subagent.js';
import { describeFailure, isIncompleteStopReason } from '../../../agent/subagent/result.js';
import { resolveCredentialForModel } from '../../../agent/auth/credential-resolver.js';
import type { AgentModelInput } from '../../../agent/types.js';
import type { TraceSink } from '../../../agent/trace/index.js';
import type { WorkspaceStore } from '../../../agent/workspace/index.js';
import type { PhaseRole } from '../../../agent/tools/nesting.js';
import type { DelegationBudget } from '../../../agent/tools/delegation-budget.js';

export interface ForkMintPhaseOptions {
  /** Human-readable phase name used in error messages, e.g. `'spec'`. */
  phaseName: string;
  /**
   * Agent type + idPrefix string, e.g. `'mint-spec'`.
   * Used for both `idPrefix` and `agentType` on the fork call.
   */
  phaseId: string;
  /** System prompt for the forked subagent. */
  systemPrompt: string;
  /** The user message sent to the subagent via `runToResult`. */
  inputMessage: string;
  /**
   * Permission boundary for the fork.
   *
   * Pass `'read-only'` for pre-approval phases (spec / research / plan) so
   * the dispatcher rejects any write or shell tool before the user approves.
   * Omit (or pass `undefined`) for phases that legitimately mutate state
   * (ship) — they inherit the default read-write surface.
   */
  phaseRole?: PhaseRole;
  /** Parent session id used to anchor the fork. */
  parentSessionId: string;
  /** Parent worktree path. Propagated to the manager's `cwd`. */
  parentCwd?: string;
  /** Mint skill ToolCall id for renderer nesting. */
  skillCallId?: string;
  /** Model to run the phase subagent on. */
  model: AgentModelInput;
  /** Read-scope inheritance from the parent session (#547). */
  parentReadRoots?: string[];
  /** Witness-layer trace writer for subagent_lifecycle events. */
  traceWriter?: TraceSink;
  /** Shared workspace for sibling-findings preamble injection. */
  workspaceStore?: WorkspaceStore;
  /** Tree-wide delegation budget forwarded to the SubagentManager. */
  delegationBudget?: DelegationBudget;
}

/**
 * Fork a mint phase subagent, run it to completion, and return its output.
 *
 * Throws on any non-succeeded, failed, or incomplete result — callers receive
 * the phase content string directly on success.
 */
export async function forkMintPhase(opts: ForkMintPhaseOptions): Promise<string> {
  const {
    phaseName,
    phaseId,
    systemPrompt,
    inputMessage,
    phaseRole,
    parentSessionId,
    parentCwd,
    skillCallId,
    model,
    parentReadRoots,
    traceWriter,
    workspaceStore,
    delegationBudget,
  } = opts;

  // `cwd` propagates the parent session's worktree so the forked subagent's
  // bash/grep tools run in the right working tree. `parentReadRoots` (#547)
  // widens the READ axis to the parent session's scope; writes stay confined
  // to cwd. See spec.ts / research.ts for the original rationale.
  const manager = new SubagentManager({
    ...(parentCwd !== undefined ? { cwd: parentCwd } : {}),
    ...(parentReadRoots !== undefined ? { parentReadRoots } : {}),
    ...(traceWriter !== undefined ? { traceWriter } : {}),
    ...(workspaceStore !== undefined ? { workspaceStore } : {}),
    ...(delegationBudget !== undefined ? { delegationBudget } : {}),
  });

  const handle = await manager.forkSubagent({
    parent: { sessionId: parentSessionId },
    config: {
      model,
      systemPrompt,
      apiKey: resolveCredentialForModel(model),
    },
    idPrefix: phaseId,
    agentType: phaseId,
    ...(phaseRole !== undefined ? { phaseRole } : {}),
    ...(skillCallId ? { parentId: skillCallId } : {}),
  });

  const result = await handle.runToResult(inputMessage);

  if (result.status !== 'succeeded' || !result.message) {
    throw new Error(`${phaseName} phase failed: ${describeFailure(result)}`);
  }
  // A `succeeded` result can still be an incomplete partial — the tool-use cap
  // fired or the stream closed without a terminal message. Its `.message.content`
  // is a truncated placeholder, not the real phase output; the result feeds the
  // next phase programmatically, so hard-fail rather than forward a partial.
  if (isIncompleteStopReason(result.stopReason)) {
    throw new Error(
      `${phaseName} phase returned an incomplete result (stopReason=${result.stopReason})`,
    );
  }

  return result.message.content;
}
