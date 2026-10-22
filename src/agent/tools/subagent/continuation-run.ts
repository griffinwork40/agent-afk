/**
 * D8 continuation path for the `agent` tool (docs/subagent-continuation.md).
 *
 * Contract: a call carrying `continuation_chain_id` is admitted here (fail
 * closed, nothing forked on any refusal) in this order: chain lookup + owner,
 * inherited-field overrides / worktree / host (D3), workspace drift for
 * write-capable chains (D5), the chain's synchronous charge + in-flight
 * (D4), then the seed (D1): the latest child journal's fold, read directly. The admitted call is then re-run
 * through the NORMAL dispatch path (`executeOnce`) with an input rebuilt from
 * the chain's stored dispatch inputs, so config assembly, permissions,
 * DelegationBudget admission, and fork wiring are the ordinary ones. The plan
 * object rides along so the fork starts from the seeded history
 * (`continuation` fork option -> `resumeMessages`) and the terminal updates
 * THIS chain instead of minting a new one. No seed session/journal is written:
 * the continuation child resumes the parent session id like every fork and
 * journals into its own `subagents/<id>.jsonl`, which therefore holds the
 * seeded history plus its own run (the next link reads that).
 *
 * Invariant (no replay): a continuation is never re-dispatched by the
 * executor's zero-output stream-cut retry. The retry would re-enter
 * admission (a second charge and continuation count) and the dead child's
 * journal already advanced the chain, so the dispatch passes no probe and
 * the retry gate stays closed; the parent may continue the chain itself.
 *
 * Invariant (rollback): if the re-run returns or throws before the child
 * handle was wired to the chain (budget refusal, fork-construction failure,
 * cancel-between-retry), the charge and in-flight flag are rolled back. Once
 * wired, the instrumented handle's terminal clears in-flight (D9) and the
 * charge is kept (no refunds).
 *
 * @module agent/tools/subagent/continuation-run
 */

import type { ToolCall, ToolResult } from '../types.js';
import type { AgentInput } from './input-parse.js';
import type { ForkSubagentOptions } from '../../subagent/fork-types.js';
import type { ChainRecord, ContinuationRegistry, WorkspaceCheckpoint } from '../../subagent/continuation-registry.js';
import { checkContinuationOverrides, checkWorkspaceDrift } from '../../subagent/continuation-guards.js';
import { loadJournalMessages } from '../../journal/index.js';
import { SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS } from '../../subagent/constants.js';
import { actorIdentity } from './continuation-dispatch.js';

/** Admitted continuation state threaded through the normal dispatch path. */
export interface ContinuationPlan {
  chain: ChainRecord;
  allowance: number;
  /** Undo the admission charge + in-flight (construction failure only). */
  rollback: () => void;
  /** Set by wireDispatchChain once the child handle is instrumented against the chain. */
  wired: boolean;
  fork: NonNullable<ForkSubagentOptions['continuation']>;
}

interface AdmitCtx {
  depth: number;
  continuationRegistry?: ContinuationRegistry;
  parentSession: { sessionId?: string | undefined };
  parentRootSessionId?: string;
  /** Test seam: drift recapture (defaults to the real git checkpoint). Always deadline-bounded. */
  recaptureCheckpoint?: (cwd: string) => Promise<WorkspaceCheckpoint>;
}

/** Tool error for a refused continuation; the text names the reason (D10). */
export function refuseContinuation(reason: string): { error: ToolResult } {
  return { error: { content: `Agent tool continuation refused: ${reason}. Nothing was forked.`, isError: true } };
}

/** D8 runtime note prefixed to the parent's prompt. */
export function continuationNote(chain: ChainRecord, index: number, allowance: number): string {
  return `[Continuation ${index} of chain ${chain.chainId}: your previous run ended (${chain.lastEndReason ?? 'unknown'}). ` +
    `You have ${allowance} tool-use rounds for this run.]`;
}

/** Upper bound on waiting for the previous run's post-result bookkeeping (journal flush + checkpoint). */
export const SETTLING_WAIT_MS = 15_000;

/** Synchronous pre-checks (lookup, owner, D3 overrides); undefined to proceed. */
function staticRefusal(chain: ChainRecord | undefined, id: string, caller: string, parsed: AgentInput): string | undefined {
  if (chain === undefined) {
    return `unknown continuation chain "${id}" (chains are runtime-minted and in-memory only; they do not survive a restart or /resume)`;
  }
  if (chain.owner !== caller) return `continuation chain "${id}" is owned by another actor`;
  return checkContinuationOverrides(chain, parsed);
}

/** True when `p` settled within `ms`. Never rejects. */
async function settledWithin(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Checks run while holding the admission reservation (D4/D5); undefined to
 * proceed. A parent that continues right after receiving the result finds the
 * previous run still settling (journal flush + checkpoint run after delivery):
 * wait for it (bounded), then check in-flight, drift, and the resumable link.
 */
async function reservedRefusal(chain: ChainRecord, id: string, recapture?: (cwd: string) => Promise<WorkspaceCheckpoint>): Promise<string | undefined> {
  const settling = chain.settling;
  if (settling !== undefined && !(await settledWithin(settling, SETTLING_WAIT_MS))) {
    return `the previous run on continuation chain "${id}" is still finishing its bookkeeping (journal flush / workspace checkpoint); retry the continuation shortly`;
  }
  if (chain.inFlight) return `a run on continuation chain "${id}" is still in flight`;
  // Bounded (CHECKPOINT_CAPTURE_DEADLINE_MS): a hung git refuses as unavailable, never wedges `admitting`.
  const drift = await checkWorkspaceDrift(chain, recapture);
  if (drift !== undefined) return drift;
  if (chain.latestChildId === undefined) {
    return 'the chain has no resumable child journal (message journaling disabled, or the previous run wrote none)';
  }
  return undefined;
}

/** Rebuild the dispatch input from the chain's stored inputs (D2: inherited, not overridable). */
function continuationInput(parsed: AgentInput, chain: ChainRecord, prompt: string, allowance: number): Record<string, unknown> {
  const s = chain.inputs;
  return {
    prompt,
    mode: parsed.mode,
    max_tool_use_iterations: allowance,
    ...(parsed.max_turns_explicit ? { max_turns: parsed.max_turns } : {}),
    ...(s.agent_type !== undefined ? { agent_type: s.agent_type } : {}),
    ...(s.model !== undefined ? { model: s.model } : {}),
    ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
    ...(s.readRoots !== undefined ? { readRoots: [...s.readRoots] } : {}),
    ...(s.writeRoots !== undefined ? { writeRoots: [...s.writeRoots] } : {}),
    ...(parsed.id_prefix !== undefined ? { id_prefix: parsed.id_prefix } : {}),
    ...(parsed.progress_events !== undefined ? { progress_events: parsed.progress_events } : {}),
    ...(parsed.attachments !== undefined ? { attachments: parsed.attachments } : {}),
  };
}

/** Admission (check + charge + in-flight) and seed. Fail closed: nothing is forked on refusal (incl. a missing/empty child fold). */
export async function admitContinuationCall(parsed: AgentInput, ctx: AdmitCtx): Promise<{ plan: ContinuationPlan; input: Record<string, unknown> } | { error: ToolResult }> {
  const id = parsed.continuation_chain_id ?? '';
  const registry = ctx.continuationRegistry;
  if (registry === undefined) return refuseContinuation('continuation is not available in this session');
  const caller = actorIdentity(ctx);
  if (caller === undefined) return refuseContinuation('the calling actor has no identity yet, so it cannot own a continuation chain');
  const chain = registry.get(id);
  const pre = staticRefusal(chain, id, caller, parsed);
  if (pre !== undefined || chain === undefined) return refuseContinuation(pre ?? 'unknown chain');
  // Reserve synchronously BEFORE any await (settling wait, drift git I/O): a
  // concurrent second call is refused at once, with no git work.
  if (chain.inFlight && chain.settling === undefined) return refuseContinuation(`a run on continuation chain "${id}" is still in flight`);
  const reservation = registry.reserveAdmission(id);
  if (!reservation.ok) return refuseContinuation(reservation.reason);
  let admitted: ReturnType<ContinuationRegistry['admitContinuation']>;
  try {
    const held = await reservedRefusal(chain, id, ctx.recaptureCheckpoint);
    if (held !== undefined) return refuseContinuation(held);
    const requested = parsed.max_tool_use_iterations_explicit ? parsed.max_tool_use_iterations : undefined;
    admitted = registry.admitContinuation(id, caller, requested, SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS, true);
  } finally {
    reservation.release(); // admission (if any) set in-flight synchronously, which now guards the chain
  }
  if (!admitted.ok) return refuseContinuation(admitted.reason);
  const previous = chain.latestChildId ?? '';
  let messages: ReturnType<typeof loadJournalMessages> = null;
  try {
    // Root id may have been unassigned at mint (root's first turn): resolve it now.
    const rootSessionId = chain.rootSessionId ?? ctx.parentRootSessionId ?? ctx.parentSession.sessionId;
    messages = rootSessionId !== undefined && rootSessionId !== '' ? loadJournalMessages(rootSessionId, { subagentId: previous }) : null;
  } catch {
    messages = null;
  }
  if (messages === null) {
    admitted.rollback();
    return refuseContinuation(`could not seed from the previous child journal "${previous}" (journaling disabled, or the journal is missing or empty)`);
  }
  const plan: ContinuationPlan = {
    chain, allowance: admitted.allowance, rollback: admitted.rollback, wired: false,
    fork: { messages, chainId: chain.chainId, continuationOf: previous, continuationIndex: admitted.index },
  };
  const prompt = `${continuationNote(chain, admitted.index, admitted.allowance)}\n\n${parsed.prompt}`;
  return { plan, input: continuationInput(parsed, chain, prompt, admitted.allowance) };
}

/**
 * executeOnce entry for a continuation call: admit + seed, then re-run the
 * normal dispatch with the rebuilt input and the plan. Rolls back when the
 * re-run never wired a child to the chain.
 */
export async function runContinuation(
  call: ToolCall,
  parsed: AgentInput,
  ctx: AdmitCtx,
  dispatch: (call: ToolCall, plan: ContinuationPlan) => Promise<ToolResult>,
): Promise<ToolResult> {
  const admitted = await admitContinuationCall(parsed, ctx);
  if ('error' in admitted) return admitted.error;
  const { plan, input } = admitted;
  try {
    return await dispatch({ ...call, input }, plan);
  } finally {
    if (!plan.wired) plan.rollback();
  }
}
