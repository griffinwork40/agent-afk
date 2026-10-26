/**
 * Dispatch-side continuation wiring (docs/subagent-continuation.md, D2/D6/D9).
 *
 * Named helpers called from `executeOnce`; no logic lives inline in
 * assembleChildConfig/runTurnInner. Chains are minted for every local
 * initial `agent` dispatch (remote `host` dispatches return before the fork
 * and never mint). Worktree-isolated chains are minted so metadata names
 * them, but carry no continuation line: D3 refuses continuing them in v1.
 *
 * @module agent/tools/subagent/continuation-dispatch
 */

import type { ToolResult } from '../types.js';
import { parseAgentInput, type AgentInput } from './input-parse.js';
import { errorMessage } from '../../../utils/errors.js';
import {
  formatContinuationLine,
  type ChainRecord,
  type ContinuationRegistry,
  type WorkspaceCheckpoint,
} from '../../subagent/continuation-registry.js';
import { captureCheckpointWithin, captureWorkspaceCheckpoint } from '../../subagent/continuation-guards.js';
import { randomBytes } from 'node:crypto';
import type { ContinuationPlan } from './continuation-run.js';
import { emitSessionPhase } from '../../trace/emit.js';
import type { TraceSink } from '../../trace/writer.js';

/** Structured chain fields carried on the tool result (D6 metadata). */
export interface ContinuationResultFields {
  continuation?: {
    chainId: string;
    roundsCharged: number;
    maxRounds: number;
    continuations: number;
    maxContinuations: number;
    continuable: boolean;
  };
}

/** Parse agent input (continuation calls are routed by executeOnce to runContinuation). */
export function parseDispatchInput(input: unknown): { parsed: AgentInput } | { error: ToolResult } {
  try {
    return { parsed: parseAgentInput(input) };
  } catch (err) {
    return { error: { content: `Agent tool input validation failed: ${errorMessage(err)}`, isError: true } };
  }
}

/** Executor-context fields that determine the dispatching actor. */
export interface ActorCtx {
  depth: number;
  continuationRegistry?: ContinuationRegistry;
  parentSession: { sessionId?: string | undefined };
}

/**
 * Stable, non-empty identity of the actor issuing an `agent` call. Same value
 * at mint and at continuation for the same actor; differs across actors.
 * - depth 0 (root session): the registry's per-root token. The root's provider
 *   session id may be unassigned during its first turn, so it is never used.
 * - depth >= 1 (a subagent dispatching): that subagent's handle id, which
 *   executeOnce backfills onto the nested executor's stub parent session right
 *   after the fork, before the child runs.
 * Undefined when no identity is available: nothing can be continued then.
 */
export function actorIdentity(ctx: ActorCtx): string | undefined {
  if (ctx.depth === 0) return ctx.continuationRegistry?.rootActor;
  const id = ctx.parentSession.sessionId;
  return id !== undefined && id !== '' ? `subagent:${id}` : undefined;
}

export interface MintChainArgs {
  registry: ContinuationRegistry | undefined;
  owner: string | undefined;
  rootSessionId: string | undefined;
  parsed: AgentInput;
  model: string | undefined;
  cwd: string | undefined;
  writeCapable: boolean;
  roundCap: number | undefined;
}

/** D2: mint a chain for an initial local dispatch. Undefined when no registry is wired. */
export function mintDispatchChain(args: MintChainArgs): ChainRecord | undefined {
  const { registry, parsed } = args;
  if (registry === undefined || parsed.host !== undefined) return undefined;
  return registry.createChain({
    // No identity: an unmatchable per-chain owner (never '', so id-less actors never collide).
    owner: args.owner ?? `unattributed_${randomBytes(12).toString('hex')}`,
    rootSessionId: args.rootSessionId !== '' ? args.rootSessionId : undefined,
    roundCap: args.roundCap ?? 0,
    inputs: {
      ...(parsed.agent_type !== undefined ? { agent_type: parsed.agent_type } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
      ...(parsed.readRoots !== undefined ? { readRoots: [...parsed.readRoots] } : {}),
      ...(parsed.writeRoots !== undefined ? { writeRoots: [...parsed.writeRoots] } : {}),
      ...(parsed.isolation !== undefined ? { isolation: parsed.isolation } : {}),
      writeCapable: args.writeCapable,
    },
  });
}

export interface ChainTerminalArgs {
  registry: ContinuationRegistry | undefined;
  chain: ChainRecord | undefined;
  childId: string;
  /** Child's runtime-resolved cwd (never model text). */
  cwd: string | undefined;
  /** Runtime-counted rounds (handle counter, floored by CappedHandoff.roundsUsed); 0 when unknown. */
  roundsUsed: number | undefined;
  journalUsable: boolean;
  endReason: string;
  capture?: (cwd: string) => Promise<WorkspaceCheckpoint>;
  /** Witness trace for `continuation_settle_degraded` (settling only). */
  traceWriter?: TraceSink | undefined;
}

/**
 * D9: record a terminal outcome. Never throws (terminal paths must not fail on
 * bookkeeping). The D5 workspace checkpoint is captured (async git) only for
 * write-capable chains: read-only chains never compare it, so they skip git.
 * The capture is bounded by CHECKPOINT_CAPTURE_DEADLINE_MS; a capture that
 * throws or outlives the deadline stores an `unavailable` checkpoint (drift
 * fails closed), so a git that never exits cannot wedge settling.
 * Returns the stored checkpoint.
 */
export async function recordChainTerminal(args: ChainTerminalArgs): Promise<WorkspaceCheckpoint | undefined> {
  const { registry, chain } = args;
  if (registry === undefined || chain === undefined) return undefined;
  const checkpoint = args.cwd !== undefined && chain.inputs.writeCapable
    ? await captureCheckpointWithin(args.cwd, args.capture ?? captureWorkspaceCheckpoint)
    : undefined;
  registry.recordTerminal(chain.chainId, {
    childId: args.childId,
    journalUsable: args.journalUsable,
    roundsUsed: args.roundsUsed ?? 0,
    checkpoint,
    endReason: args.endReason,
  });
  return checkpoint;
}

/**
 * True when a continuation would be admitted on limits and isolation: worktree
 * chains are refused in v1 (D3), and an exhausted continuation count (incl.
 * MAX_CONTINUATIONS=0) or aggregate round budget would be refused (D4), so
 * the result line must not invite one.
 */
function isContinuable(chain: ChainRecord): boolean {
  return chain.inputs.isolation !== 'worktree' &&
    chain.continuations < chain.limits.maxContinuations &&
    chain.roundsCharged < chain.limits.maxRounds;
}

/** D6 structured chain metadata (snapshot of the chain's current state). */
function chainMetadata(chain: ChainRecord): NonNullable<ContinuationResultFields['continuation']> {
  return {
    chainId: chain.chainId,
    roundsCharged: chain.roundsCharged,
    maxRounds: chain.limits.maxRounds,
    continuations: chain.continuations,
    maxContinuations: chain.limits.maxContinuations,
    continuable: isContinuable(chain),
  };
}

/**
 * Handles whose foreground run was promoted to background. Their delivered
 * result (via the background registry) carries the line instead, and the
 * promotion payload (JSON text) is never annotated.
 */
const promotedHandles = new WeakMap<object, () => void>();
const promotedState = new WeakMap<object, boolean>();

/**
 * Promotion hook (foreground -> background): mark the handle so the run's
 * terminal stamps the DELIVERED result, and so annotateChainResult leaves the
 * promotion payload's JSON text untouched.
 */
export function markChainPromoted(handle: object): void {
  const onPromoted = promotedHandles.get(handle);
  if (onPromoted !== undefined) onPromoted();
}

/**
 * D6: stamp chain metadata on every result; append the continuation line only
 * to incomplete/capped results of continuable chains. Mutates and returns `result`.
 * When `handle` was promoted, the result is the promotion payload (JSON): only
 * the structured field is set, the text is never touched.
 */
export function annotateChainResult<R extends ToolResult>(result: R, chain: ChainRecord | undefined, always = false, handle?: object): R & ContinuationResultFields {
  const out = result as R & ContinuationResultFields;
  if (chain === undefined) return out;
  out.continuation = chainMetadata(chain);
  if (handle !== undefined && promotedState.get(handle) === true) return out;
  if ((always || result.incomplete === true) && out.continuation.continuable) {
    out.content = `${result.content}\n\n${formatContinuationLine(chain)}`;
  }
  return out;
}


/** End reason string for the registry from a tool result. */
export function endReasonOf(result: ToolResult): string {
  if (result.incomplete === true) return result.incompleteReason ?? 'incomplete';
  return result.isError === true ? 'failed' : 'completed';
}

type ChainHandle = {
  readonly id: string;
  runToResult(prompt: never, ...rest: never[]): Promise<import('../../subagent/result.js').SubagentResult>;
  runInBackground(prompt: never, onResult?: (r: import('../../subagent/result.js').SubagentResult) => void, ...rest: never[]): unknown;
};

/**
 * D9 + D6 (background): wrap the handle's run entry points on THIS instance so
 * every terminal outcome (foreground, promoted, background; success, capped,
 * failure, abort/rejection) records into the chain exactly once. Runtime
 * rounds come from the handle's runtime round counter (provider progress
 * events), floored by CappedHandoff.roundsUsed.
 * Background capped results get the continuation line appended to the
 * delivered message text.
 */
export function instrumentHandleForChain(
  handle: ChainHandle,
  terminal: Omit<ChainTerminalArgs, 'childId' | 'roundsUsed' | 'endReason' | 'journalUsable'> & {
    journalUsable: () => boolean;
    /**
     * Drain the child's async journal queue before the terminal is recorded
     * (and in-flight cleared). Runs AFTER the result is delivered, inside the
     * chain's settling promise; a continuation admission awaits settling, so
     * it folds the complete journal. Bounded by JOURNAL_FLUSH_TIMEOUT_MS; on
     * timeout/failure the link does not advance (previous link kept).
     */
    flushJournal?: () => Promise<void>;
    /** Continuation: undo the admission charge when the child is torn down before it ever ran. */
    rollbackIfNotStarted?: () => void;
    /** D6b: continuation results always carry the line. */
    alwaysLine?: boolean;
  },
): void {
  if (terminal.registry === undefined || terminal.chain === undefined) return;
  let done = false;
  const { registry, chain } = terminal;
  // Exactly once per run. The D4 charge lands synchronously (so the result
  // delivered right after carries the final rounds); the journal flush + D5
  // checkpoint + terminal record run AFTER delivery as the chain's `settling`
  // promise (bounded, never rejects). In-flight stays true until it settles;
  // a continuation admission awaits it.
  const record: RecordFn = (r, reason) => {
    if (done) return;
    done = true;
    const rounds = runtimeRounds(handle, r);
    registry.chargeInitialRounds(chain.chainId, rounds);
    registry.setSettling(chain.chainId, settleTerminal(terminal, handle.id, rounds, r === undefined && reason === 'not_started', reason));
  };
  const reasonOf = (r: import('../../subagent/result.js').SubagentResult): string =>
    r.needsInput !== undefined ? 'asking'
    : r.incomplete === true ? (r.incompleteReason ?? 'incomplete')
    : r.status;
  const h = handle as unknown as Record<string, unknown>;
  const started = { value: false };
  // Promotion: stamp the delivered result (now or, if the run already
  // settled, immediately on the recorded result).
  const delivered: { result?: Res; promoted: boolean } = { promoted: false };
  promotedHandles.set(handle, () => {
    delivered.promoted = true;
    promotedState.set(handle, true);
    if (delivered.result !== undefined) stampDeliveredResult(delivered.result, terminal.chain!, terminal.alwaysLine === true);
  });
  const recordRun: RecordFn = (r, reason) => {
    record(r, reason);
    if (r === undefined) return;
    delivered.result = r;
    if (delivered.promoted) stampDeliveredResult(r, terminal.chain!, terminal.alwaysLine === true);
  };
  if (typeof handle.runToResult === 'function') wrapRun(h, handle, recordRun, reasonOf, started);
  if (typeof handle.runInBackground === 'function') wrapBackground(h, handle, record, reasonOf, terminal.chain, started, terminal.alwaysLine === true);
  wrapTeardownBeforeStart(h, started, () => {
    if (done) return;
    if (terminal.rollbackIfNotStarted !== undefined) { done = true; terminal.rollbackIfNotStarted(); return; }
    record(undefined, 'not_started');
  });
}

/**
 * Stuck-chain fix: dispatch exits after the fork but before the run
 * (attachment-expansion error, no background registry, background job cap,
 * register error) all tear the handle down; a teardown before any run entry
 * point fired clears in-flight (initial: terminal record; continuation: rollback).
 */
function wrapTeardownBeforeStart(h: Record<string, unknown>, started: { value: boolean }, onUnstarted: () => void): void {
  const orig = h['teardown'];
  if (typeof orig !== 'function') return;
  const bound = (orig as (...a: unknown[]) => Promise<void>).bind(h);
  h['teardown'] = (...a: unknown[]) => {
    if (!started.value) onUnstarted();
    return bound(...a);
  };
}

type Res = import('../../subagent/result.js').SubagentResult;

/**
 * D4: runtime-counted rounds for the terminal. The handle's own counter (fed by
 * provider progress events on every run, capped or not) is authoritative; the
 * capped result's `roundsUsed` is a floor. Never model-reported.
 */
function runtimeRounds(handle: ChainHandle, r: Res | undefined): number {
  const counted = (handle as { _runtimeRoundsUsed?: unknown })._runtimeRoundsUsed;
  return Math.max(typeof counted === 'number' ? counted : 0, r?.roundsUsed ?? 0);
}
type RecordFn = (r: Res | undefined, reason: string) => void;

/** Why a chain's settling ended degraded (trace `continuation_settle_degraded`). */
export type SettleDegradedReason = 'flush_timeout' | 'checkpoint_unavailable' | 'error';

/** Record a degraded settle on the witness trace. Fire-and-forget; never throws. */
function emitSettleDegraded(w: TraceSink | undefined, chainId: string, childId: string, reason: SettleDegradedReason): void {
  void emitSessionPhase(w, { phase: 'continuation_settle_degraded', metadata: { chainId, childId, reason } });
}

/**
 * Post-delivery terminal bookkeeping: drain the child journal (bounded by
 * JOURNAL_FLUSH_TIMEOUT_MS; on timeout/failure the link does not advance),
 * capture the checkpoint (bounded by CHECKPOINT_CAPTURE_DEADLINE_MS), record
 * the terminal. Never rejects; any unexpected failure still clears in-flight
 * without advancing the link. Every degraded outcome (flush timeout/failure,
 * unavailable checkpoint, catch-all) emits a `continuation_settle_degraded`
 * session_phase so the chain's state change is never silent.
 */
async function settleTerminal(
  terminal: Omit<ChainTerminalArgs, 'childId' | 'roundsUsed' | 'endReason' | 'journalUsable'> & { journalUsable: () => boolean; flushJournal?: () => Promise<void> },
  childId: string, roundsUsed: number, notStarted: boolean, endReason: string,
): Promise<void> {
  const chainId = terminal.chain?.chainId;
  if (chainId === undefined) return;
  try {
    const flushed = notStarted ? true : await flushWithin(terminal.flushJournal, JOURNAL_FLUSH_TIMEOUT_MS);
    if (!flushed) emitSettleDegraded(terminal.traceWriter, chainId, childId, 'flush_timeout');
    let usable = false;
    try { usable = flushed && terminal.journalUsable(); } catch { usable = false; }
    const checkpoint = await recordChainTerminal({ ...terminal, childId, roundsUsed, journalUsable: usable, endReason });
    if (checkpoint?.unavailable === true) emitSettleDegraded(terminal.traceWriter, chainId, childId, 'checkpoint_unavailable');
  } catch {
    terminal.registry?.recordTerminal(chainId, { childId, journalUsable: false, roundsUsed, checkpoint: undefined, endReason });
    emitSettleDegraded(terminal.traceWriter, chainId, childId, 'error');
  }
}

/** Upper bound on waiting for the child's journal queue to drain at a terminal. */
export const JOURNAL_FLUSH_TIMEOUT_MS = 5_000;

/** True when `flush` resolved within `ms`; false on timeout or rejection. Never throws. */
async function flushWithin(flush: (() => Promise<void>) | undefined, ms: number): Promise<boolean> {
  if (flush === undefined) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      flush().then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function wrapRun(h: Record<string, unknown>, handle: ChainHandle, record: RecordFn, reasonOf: (r: Res) => string, started: { value: boolean }): void {
  // Forward EVERY argument: handle.streaming's runInBackground calls
  // `runToResult(prompt, sinkOverride)`; dropping the sink silences the
  // background registry's progress pipe (job log, heartbeat, transcript, touchedFiles).
  const origRun = handle.runToResult.bind(handle) as (...a: unknown[]) => Promise<import('../../subagent/result.js').SubagentResult>;
  // The result is returned at once; terminal bookkeeping settles after (record).
  h['runToResult'] = (...a: unknown[]) => { started.value = true; return origRun(...a).then(
    (r) => { record(r, reasonOf(r)); return r; },
    (err: unknown) => { record(undefined, 'failed'); throw err; },
  ); };
}

function wrapBackground(h: Record<string, unknown>, handle: ChainHandle, record: RecordFn, reasonOf: (r: Res) => string, chain: ChainRecord, started: { value: boolean }, always: boolean): void {
  const origBg = handle.runInBackground.bind(handle) as (p: unknown, cb?: (r: import('../../subagent/result.js').SubagentResult) => void, ...rest: unknown[]) => unknown;
  h['runInBackground'] = (p: unknown, cb?: (r: import('../../subagent/result.js').SubagentResult) => void, ...rest: unknown[]) => {
    started.value = true;
    return origBg(p, (r) => {
      // Deliver at once: the D4 charge is already applied synchronously, so the
      // line/metadata are final; journal flush + checkpoint settle after.
      record(r, reasonOf(r));
      stampDeliveredResult(r, chain, always);
      cb?.(r);
    }, ...rest);
  };
}

/**
 * Background / promoted delivery (D6): stamp the structured chain metadata on
 * the delivered SubagentResult, and append the continuation line to a capped
 * (or continuation) result's message text. Idempotent per result.
 */
function stampDeliveredResult(r: Res, chain: ChainRecord, always: boolean): void {
  const out = r as Res & ContinuationResultFields;
  const alreadyStamped = out.continuation !== undefined;
  out.continuation = chainMetadata(chain);
  if (alreadyStamped) return;
  if ((!always && r.incomplete !== true) || !isContinuable(chain) || typeof r.message?.content !== 'string') return;
  r.message.content = `${r.message.content}\n\n${formatContinuationLine(chain)}`;
}

/** executeOnce entry: mint (D2) + instrument terminal hooks (D9). One call keeps executeOnce under its ceiling. */
export function wireDispatchChain(args: {
  ctx: ActorCtx & { parentRootSessionId?: string; traceWriter?: TraceSink | undefined };
  parsed: AgentInput;
  handle: ChainHandle & { session?: { messageJournal?: unknown } };
  childConfig: { model?: string; cwd?: string; maxToolUseIterations?: number };
  currentCwd: string | undefined;
  writeCapable: boolean;
  /** Continuation: reuse the admitted chain (never mint a new one) and mark it wired. */
  plan?: ContinuationPlan | undefined;
}): ChainRecord | undefined {
  const { ctx, parsed, handle, childConfig, plan } = args;
  const cwd = childConfig.cwd ?? args.currentCwd;
  const chain = plan !== undefined ? plan.chain : mintDispatchChain({
    registry: ctx.continuationRegistry,
    owner: actorIdentity(ctx),
    rootSessionId: ctx.parentRootSessionId ?? ctx.parentSession.sessionId,
    parsed, model: childConfig.model, cwd, writeCapable: args.writeCapable,
    roundCap: childConfig.maxToolUseIterations,
  });
  instrumentHandleForChain(handle, {
    registry: ctx.continuationRegistry, chain, cwd, traceWriter: ctx.traceWriter,
    // D9: advance the link only when the child journal holds messages.
    journalUsable: () => ((handle.session?.messageJournal as { length?: number } | undefined)?.length ?? 0) > 0,
    flushJournal: async () => { await (handle.session?.messageJournal as { flush?: () => Promise<void> } | undefined)?.flush?.(); },
    ...(plan !== undefined ? { rollbackIfNotStarted: plan.rollback, alwaysLine: true } : {}),
  });
  if (plan !== undefined) plan.wired = true;
  return chain;
}
