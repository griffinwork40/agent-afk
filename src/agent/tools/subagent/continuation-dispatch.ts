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
import { captureWorkspaceCheckpoint } from '../../subagent/continuation-guards.js';
import { randomBytes } from 'node:crypto';
import type { ContinuationPlan } from './continuation-run.js';

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
  /** Runtime-counted rounds (CappedHandoff.roundsUsed / handle counter); 0 when unknown. */
  roundsUsed: number | undefined;
  journalUsable: boolean;
  endReason: string;
  capture?: (cwd: string) => WorkspaceCheckpoint;
}

/** D9: record a terminal outcome. Never throws (terminal paths must not fail on bookkeeping). */
export function recordChainTerminal(args: ChainTerminalArgs): void {
  const { registry, chain } = args;
  if (registry === undefined || chain === undefined) return;
  let checkpoint: WorkspaceCheckpoint | undefined;
  try {
    checkpoint = args.cwd !== undefined ? (args.capture ?? captureWorkspaceCheckpoint)(args.cwd) : undefined;
  } catch {
    checkpoint = undefined;
  }
  registry.recordTerminal(chain.chainId, {
    childId: args.childId,
    journalUsable: args.journalUsable,
    roundsUsed: args.roundsUsed ?? 0,
    checkpoint,
    endReason: args.endReason,
  });
}

/** True when the chain may be continued in v1 (worktree chains are refused, D3). */
function isContinuable(chain: ChainRecord): boolean {
  return chain.inputs.isolation !== 'worktree';
}

/**
 * D6: stamp chain metadata on every result; append the continuation line only
 * to incomplete/capped results of continuable chains. Mutates and returns `result`.
 */
export function annotateChainResult<R extends ToolResult>(result: R, chain: ChainRecord | undefined, always = false): R & ContinuationResultFields {
  const out = result as R & ContinuationResultFields;
  if (chain === undefined) return out;
  const continuable = isContinuable(chain);
  out.continuation = {
    chainId: chain.chainId,
    roundsCharged: chain.roundsCharged,
    maxRounds: chain.limits.maxRounds,
    continuations: chain.continuations,
    maxContinuations: chain.limits.maxContinuations,
    continuable,
  };
  if ((always || result.incomplete === true) && continuable) {
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
 * rounds come from the SubagentResult's CappedHandoff.roundsUsed only.
 * Background capped results get the continuation line appended to the
 * delivered message text.
 */
export function instrumentHandleForChain(
  handle: ChainHandle,
  terminal: Omit<ChainTerminalArgs, 'childId' | 'roundsUsed' | 'endReason' | 'journalUsable'> & {
    journalUsable: () => boolean;
    /** Continuation: undo the admission charge when the child is torn down before it ever ran. */
    rollbackIfNotStarted?: () => void;
    /** D6b: continuation results always carry the line. */
    alwaysLine?: boolean;
  },
): void {
  if (terminal.registry === undefined || terminal.chain === undefined) return;
  let done = false;
  const record = (r: import('../../subagent/result.js').SubagentResult | undefined, reason: string): void => {
    if (done) return;
    done = true;
    let usable = false;
    try { usable = terminal.journalUsable(); } catch { usable = false; }
    recordChainTerminal({ ...terminal, childId: handle.id, roundsUsed: r?.roundsUsed, journalUsable: usable, endReason: reason });
  };
  const reasonOf = (r: import('../../subagent/result.js').SubagentResult): string =>
    r.incomplete === true ? (r.incompleteReason ?? 'incomplete') : r.status;
  const h = handle as unknown as Record<string, unknown>;
  const started = { value: false };
  if (typeof handle.runToResult === 'function') wrapRun(h, handle, record, reasonOf, started);
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

function wrapRun(h: Record<string, unknown>, handle: ChainHandle, record: (r: Res | undefined, reason: string) => void, reasonOf: (r: Res) => string, started: { value: boolean }): void {
  // Forward EVERY argument: handle.streaming's runInBackground calls
  // `runToResult(prompt, sinkOverride)`; dropping the sink silences the
  // background registry's progress pipe (job log, heartbeat, transcript, touchedFiles).
  const origRun = handle.runToResult.bind(handle) as (...a: unknown[]) => Promise<import('../../subagent/result.js').SubagentResult>;
  h['runToResult'] = (...a: unknown[]) => { started.value = true; return origRun(...a).then(
    (r) => { record(r, reasonOf(r)); return r; },
    (err: unknown) => { record(undefined, 'failed'); throw err; },
  ); };
}

function wrapBackground(h: Record<string, unknown>, handle: ChainHandle, record: (r: Res | undefined, reason: string) => void, reasonOf: (r: Res) => string, chain: ChainRecord, started: { value: boolean }, always: boolean): void {
  const origBg = handle.runInBackground.bind(handle) as (p: unknown, cb?: (r: import('../../subagent/result.js').SubagentResult) => void, ...rest: unknown[]) => unknown;
  h['runInBackground'] = (p: unknown, cb?: (r: import('../../subagent/result.js').SubagentResult) => void, ...rest: unknown[]) => {
    started.value = true;
    return origBg(p, (r) => {
      record(r, reasonOf(r));
      appendLineToMessage(r, chain, always);
      cb?.(r);
    }, ...rest);
  };
}

/** Background delivery: append the continuation line to a capped result's message (D6). */
function appendLineToMessage(r: import('../../subagent/result.js').SubagentResult, chain: ChainRecord, always: boolean): void {
  if ((!always && r.incomplete !== true) || !isContinuable(chain) || r.message === undefined) return;
  r.message.content = `${r.message.content}\n\n${formatContinuationLine(chain)}`;
}

/** executeOnce entry: mint (D2) + instrument terminal hooks (D9). One call keeps executeOnce under its ceiling. */
export function wireDispatchChain(args: {
  ctx: ActorCtx & { parentRootSessionId?: string };
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
    registry: ctx.continuationRegistry, chain, cwd,
    // D9: advance the link only when the child journal holds messages.
    journalUsable: () => ((handle.session?.messageJournal as { length?: number } | undefined)?.length ?? 0) > 0,
    ...(plan !== undefined ? { rollbackIfNotStarted: plan.rollback, alwaysLine: true } : {}),
  });
  if (plan !== undefined) plan.wired = true;
  return chain;
}
