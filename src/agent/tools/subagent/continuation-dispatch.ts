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
import type { AgentInput } from './input-parse.js';
import {
  formatContinuationLine,
  type ChainRecord,
  type ContinuationRegistry,
  type WorkspaceCheckpoint,
} from '../../subagent/continuation-registry.js';
import { captureWorkspaceCheckpoint } from '../../subagent/continuation-guards.js';

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

/** TODO(continuation-d8): replaced by the continuation fork path in the next chunk. */
export function refuseUnwiredContinuation(parsed: AgentInput): ToolResult | undefined {
  if (parsed.continuation_chain_id === undefined) return undefined;
  return {
    content: 'Agent tool `continuation_chain_id` refused: continuation not yet wired in this build. ' +
      'Dispatch a fresh subagent instead.',
    isError: true,
  };
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
    owner: args.owner ?? '',
    rootSessionId: args.rootSessionId ?? args.owner ?? '',
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
export function annotateChainResult<R extends ToolResult>(result: R, chain: ChainRecord | undefined): R & ContinuationResultFields {
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
  if (result.incomplete === true && continuable) {
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
  runToResult(prompt: never): Promise<import('../../subagent/result.js').SubagentResult>;
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
  terminal: Omit<ChainTerminalArgs, 'childId' | 'roundsUsed' | 'endReason' | 'journalUsable'> & { journalUsable: () => boolean },
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
  if (typeof handle.runToResult === 'function') wrapRun(h, handle, record, reasonOf);
  if (typeof handle.runInBackground === 'function') wrapBackground(h, handle, record, reasonOf, terminal.chain);
}

type Res = import('../../subagent/result.js').SubagentResult;

function wrapRun(h: Record<string, unknown>, handle: ChainHandle, record: (r: Res | undefined, reason: string) => void, reasonOf: (r: Res) => string): void {
  const origRun = handle.runToResult.bind(handle) as (p: unknown) => Promise<import('../../subagent/result.js').SubagentResult>;
  h['runToResult'] = (p: unknown) => origRun(p).then(
    (r) => { record(r, reasonOf(r)); return r; },
    (err: unknown) => { record(undefined, 'failed'); throw err; },
  );
}

function wrapBackground(h: Record<string, unknown>, handle: ChainHandle, record: (r: Res | undefined, reason: string) => void, reasonOf: (r: Res) => string, chain: ChainRecord): void {
  const origBg = handle.runInBackground.bind(handle) as (p: unknown, cb?: (r: import('../../subagent/result.js').SubagentResult) => void, ...rest: unknown[]) => unknown;
  h['runInBackground'] = (p: unknown, cb?: (r: import('../../subagent/result.js').SubagentResult) => void, ...rest: unknown[]) =>
    origBg(p, (r) => {
      record(r, reasonOf(r));
      appendLineToMessage(r, chain);
      cb?.(r);
    }, ...rest);
}

/** Background delivery: append the continuation line to a capped result's message (D6). */
function appendLineToMessage(r: import('../../subagent/result.js').SubagentResult, chain: ChainRecord): void {
  if (r.incomplete !== true || !isContinuable(chain) || r.message === undefined) return;
  r.message.content = `${r.message.content}\n\n${formatContinuationLine(chain)}`;
}

/** executeOnce entry: mint (D2) + instrument terminal hooks (D9). One call keeps executeOnce under its ceiling. */
export function wireDispatchChain(args: {
  ctx: { continuationRegistry?: ContinuationRegistry; parentSession: { sessionId?: string | undefined }; parentRootSessionId?: string };
  parsed: AgentInput;
  handle: ChainHandle & { session?: { messageJournal?: unknown } };
  childConfig: { model?: string; cwd?: string; maxToolUseIterations?: number };
  currentCwd: string | undefined;
  writeCapable: boolean;
}): ChainRecord | undefined {
  const { ctx, parsed, handle, childConfig } = args;
  const cwd = childConfig.cwd ?? args.currentCwd;
  const chain = mintDispatchChain({
    registry: ctx.continuationRegistry,
    owner: ctx.parentSession.sessionId,
    rootSessionId: ctx.parentRootSessionId ?? ctx.parentSession.sessionId,
    parsed, model: childConfig.model, cwd, writeCapable: args.writeCapable,
    roundCap: childConfig.maxToolUseIterations,
  });
  instrumentHandleForChain(handle, {
    registry: ctx.continuationRegistry, chain, cwd,
    journalUsable: () => handle.session?.messageJournal !== undefined,
  });
  return chain;
}
