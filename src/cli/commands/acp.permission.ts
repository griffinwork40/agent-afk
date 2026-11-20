/**
 * ACP permission bridge (profile section 6). Returns the `canUseTool` callback
 * the tool dispatcher awaits before each top-level tool call.
 *
 * @module cli/commands/acp.permission
 */
import path from 'node:path';
import type { PermissionResult } from '../../agent/types/sdk-types.js';
import type {
  AcpClientPeer, AcpPermissionGate, AcpPermissionOptions, CanUseTool, PermissionOption, ToolCallStart, ToolCallUpdate,
} from './acp.wire.js';
import { buildPendingStart, outsideTargets, permissionOptions, requiresAsk } from './acp.permission.policy.js';
import type { ChildToolOrigin } from '../../agent/tools/nesting.can-use-tool.js';
import { childPrefix } from './acp.permission.labels.js';
import { dependsOnCallerCwd, relocatesChildren } from './acp.permission.paths.js';
import { grantFits } from './acp.permission.grants.js';
import { AcpPeerClosedError } from './acp.rpc-peer.js';

export const PERMISSION_TIMEOUT_MS = 120_000;

export type DenyReason =
  | 'rejected' | 'unknown_option' | 'malformed_reply' | 'request_error'
  | 'peer_closed' | 'aborted' | 'cancelled' | 'timeout' | 'no_active_turn';

const allow = (): PermissionResult => ({ behavior: 'allow' });

/** Always a fresh, fully-formed deny. `interrupt` marks permission-originated cancellation. */
export function denyResult(reason: DenyReason): PermissionResult {
  return {
    behavior: 'deny',
    message: `Permission denied: ${reason}`,
    ...(reason === 'cancelled' ? { interrupt: true } : {}),
  };
}

type Settled = { kind: 'reply'; value: unknown } | { kind: 'deny'; reason: DenyReason };
interface PendingAsk { cancelled: boolean; child?: boolean; settle(s: Settled): void }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Resolve a reply strictly against the options WE offered; client kinds are never trusted. */
export function classifyReply(reply: unknown, offered: readonly PermissionOption[]): 'allow_once' | 'allow_always' | DenyReason {
  if (!isRecord(reply) || !isRecord(reply['outcome'])) return 'malformed_reply';
  const outcome = reply['outcome'];
  if (outcome['outcome'] === 'cancelled') return 'cancelled';
  if (outcome['outcome'] !== 'selected' || typeof outcome['optionId'] !== 'string') return 'malformed_reply';
  const option = offered.find((o) => o.optionId === outcome['optionId']);
  if (option === undefined) return 'unknown_option';
  if (option.kind === 'allow_once' || option.kind === 'allow_always') return option.kind;
  return 'rejected';
}

function peerFailureReason(err: unknown): DenyReason {
  return err instanceof AcpPeerClosedError ? 'peer_closed' : 'request_error';
}

function requestToolCall(start: ToolCallStart): ToolCallUpdate {
  return {
    toolCallId: start.toolCallId,
    title: start.title,
    ...(start.name !== undefined ? { name: start.name } : {}),
    ...(start.kind !== undefined ? { kind: start.kind } : {}),
    status: 'pending',
    ...(start.rawInput !== undefined ? { rawInput: start.rawInput } : {}),
  };
}

/**
 * Await the client's answer, racing it against the call's abort signal, the
 * 120 s timeout and cancelAll(). Settles exactly once; any loser (including a
 * late reply) is ignored, and the outbound request is withdrawn on settle.
 * The ask stays in the pending set until askClient returns, so cancelAll()
 * still reaches it during the in_progress transition.
 */
function awaitReply(
  peer: AcpClientPeer, params: unknown, signal: AbortSignal, ask: PendingAsk,
): Promise<Settled> {
  return new Promise<Settled>((resolve) => {
    const outbound = new AbortController();
    let done = false;
    const onAbort = (): void => { ask.settle({ kind: 'deny', reason: 'aborted' }); };
    const timer = setTimeout(() => { ask.settle({ kind: 'deny', reason: 'timeout' }); }, PERMISSION_TIMEOUT_MS);
    ask.settle = (s) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      outbound.abort();
      resolve(s);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (ask.cancelled) { ask.settle({ kind: 'deny', reason: 'cancelled' }); return; }
    if (signal.aborted) { onAbort(); return; }
    try {
      peer.request('session/request_permission', params, outbound.signal).then(
        (value) => { ask.settle({ kind: 'reply', value }); },
        (err: unknown) => { ask.settle({ kind: 'deny', reason: peerFailureReason(err) }); },
      );
    } catch (err) {
      ask.settle({ kind: 'deny', reason: peerFailureReason(err) });
    }
  });
}

interface GateState {
  peer: AcpClientPeer;
  sessionId: string;
  opts: AcpPermissionOptions;
  granted: Set<string>;
  pending: Set<PendingAsk>;
  /** Sequence for child card ids, so a child id can never collide with a parent stream id. */
  childSeq: number;
  /** Child decisions still running, so the turn can wait for their cards to close. */
  childInFlight: Set<Promise<unknown>>;
  /**
   * Set once a delegation that runs children in another directory is allowed.
   * From then on a child whose origin carries no cwd has its reads that depend
   * on its own cwd (relative or absent path) asked, not auto-allowed. A child
   * whose origin names its cwd has its paths resolved against that instead.
   */
  childCwdUnknown: boolean;
}

/** Who is asking: the top-level session (stream closes the card) or a forked child (gate closes it). */
interface Asker {
  child?: { prefix: string; origin: string; cwd?: string };
}

/** Abort/cancel recheck used at every await boundary before an allow can escape. */
function interrupted(signal: AbortSignal, ask: PendingAsk): DenyReason | undefined {
  if (signal.aborted) return 'aborted';
  if (ask.cancelled) return 'cancelled';
  return undefined;
}

// Contract: profile section 6 ordering. The pending start is emitted and
// awaited BEFORE the request is sent (failure -> request_error, no orphaned
// request). Every await is followed by an abort/cancel recheck, so an
// approval that lands after cancellation can never become an allow.
async function askClient(
  st: GateState, toolName: string, input: Record<string, unknown>, signal: AbortSignal, toolUseID: string,
  who: Asker = {},
): Promise<PermissionResult> {
  if (signal.aborted) return denyResult('aborted');
  if (typeof toolUseID !== 'string' || toolUseID.length === 0) return denyResult('request_error');
  const ask: PendingAsk = { cancelled: false, child: who.child !== undefined, settle: () => { ask.cancelled = true; } };
  st.pending.add(ask);
  try {
    const outside = outsideTargets(toolName, input, st.opts.cwd, who.child?.cwd).length > 0;
    // D18: "Always allow" only for a listed tool whose every argument and location is known and inside.
    const grantable = !outside && grantFits(toolName, input, st.opts.cwd, who.child?.cwd);
    const start = buildPendingStart(toolUseID, toolName, input, st.opts.cwd, who.child?.prefix ?? '', who.child?.cwd);
    try { await st.opts.emitToolCall(start); } catch { return denyResult('request_error'); }
    const early = interrupted(signal, ask);
    if (early) return denyResult(early);
    const offered = permissionOptions(toolName, !grantable);
    const params = { sessionId: st.sessionId, toolCall: requestToolCall(start), options: offered };
    const settled = await awaitReply(st.peer, params, signal, ask);
    if (settled.kind === 'deny') return denyResult(settled.reason);
    const decision = classifyReply(settled.value, offered);
    if (decision === 'cancelled') {
      try { st.opts.onCancelled(); } catch { /* cannot change the deny below */ }
      return denyResult('cancelled');
    }
    if (decision !== 'allow_once' && decision !== 'allow_always') return denyResult(decision);
    const late = interrupted(signal, ask);
    if (late) return denyResult(late);
    try {
      await st.opts.emitToolCall({ ...start, status: 'in_progress' });
    } catch {
      return denyResult('request_error');
    }
    const after = interrupted(signal, ask);
    if (after) return denyResult(after);
    // D11: offered only for inside-cwd, non-bash, non-delegation calls; recheck anyway.
    // The dual-check here is intentional: `outside` (computed from the original
    // ask's input at the top of askClient) gates whether allow_always is stored,
    // while grantCovers (in decide) recomputes outsideTargets on the NEW call's
    // input. The two checks operate on different inputs on purpose: a grant earned
    // for an inside-cwd call must not cover a later call that targets outside.
    if (decision === 'allow_always' && grantable) st.granted.add(toolName);
    return allow();
  } finally {
    st.pending.delete(ask);
  }
}

function turnLive(st: GateState): boolean {
  try { return st.opts.turnActive === undefined || st.opts.turnActive() === true; } catch { return false; }
}

/**
 * A remembered grant covers this call only when the tool is on the grant list,
 * every argument is one that entry knows and every location is inside the cwd
 * (D11, D18). The generic outside scan is checked too, so either can refuse.
 */
function grantCovers(st: GateState, name: string, input: Record<string, unknown>, callerCwd?: string): boolean {
  return name.length > 0 && st.granted.has(name) && grantFits(name, input, st.opts.cwd, callerCwd)
    && outsideTargets(name, input, st.opts.cwd, callerCwd).length === 0;
}

async function decide(
  st: GateState, toolName: string, rawInput: unknown, signal: AbortSignal, toolUseID: string, who: Asker = {},
): Promise<PermissionResult> {
  if (st.opts.skip === true) return allow();
  const name = typeof toolName === 'string' ? toolName : '';
  const input = isRecord(rawInput) ? rawInput : {};
  const callerCwd = who.child?.cwd;
  const relocated = who.child !== undefined && callerCwd === undefined && st.childCwdUnknown && dependsOnCallerCwd(input);
  if (!relocated && !requiresAsk(name, input, st.opts.cwd, callerCwd)) return allow();
  if (!relocated && grantCovers(st, name, input, callerCwd)) {
    // A child's granted call has no stream card to move; it just runs (D13).
    return who.child ? (signal.aborted ? denyResult('aborted') : allow()) : runGranted(st, name, input, signal, toolUseID);
  }
  if (!who.child) {
    const verdict = await askClient(st, name, input, signal, toolUseID);
    if (verdict.behavior === 'allow' && relocatesChildren(name, input, st.opts.cwd)) st.childCwdUnknown = true;
    return verdict;
  }
  if (!turnLive(st)) return denyResult('no_active_turn');
  const cardId = `child-${++st.childSeq}-${toolUseID}`;
  const child = who.child;
  const run = (async () => {
    const result = wellFormed(await askClient(st, name, input, signal, toolUseID.length > 0 ? cardId : '', who));
    // D19: a child that delegates into another directory relocates its own children too.
    if (result.behavior === 'allow' && relocatesChildren(name, input, child.cwd ?? st.opts.cwd)) st.childCwdUnknown = true;
    await closeChildCard(st, cardId, name, input, result, child);
    return result;
  })();
  st.childInFlight.add(run);
  try { return await run; } finally { st.childInFlight.delete(run); }
}

/**
 * D9: the parent stream never carries a child's result, so the gate closes the
 * card itself. Deny -> failed with the reason; allow -> completed, saying where
 * the call runs and where its result is reported. Display failure cannot change
 * the decision already made.
 */
async function closeChildCard(
  st: GateState, cardId: string, name: string, input: Record<string, unknown>,
  result: PermissionResult, child: NonNullable<Asker['child']>,
): Promise<void> {
  const text = result.behavior === 'deny' ? result.message
    : `Approved. Runs inside ${child.origin}; its result is reported by the delegating tool call.`;
  try {
    await st.opts.emitToolCall({
      ...buildPendingStart(cardId, name, input, st.opts.cwd, child.prefix, child.cwd),
      status: result.behavior === 'deny' ? 'failed' : 'completed',
      content: [{ type: 'content', content: { type: 'text', text } }],
    });
  } catch { /* the card may stay open in the client; the decision stands */ }
}

/**
 * Remembered grant: no question, but the client still sees the call move to
 * in_progress before it runs (profile section 5/6), deduplicated by A1.
 */
async function runGranted(
  st: GateState, toolName: string, input: Record<string, unknown>, signal: AbortSignal, toolUseID: string,
): Promise<PermissionResult> {
  if (signal.aborted) return denyResult('aborted');
  if (typeof toolUseID !== 'string' || toolUseID.length === 0) return denyResult('request_error');
  try {
    await st.opts.emitToolCall({ ...buildPendingStart(toolUseID, toolName, input, st.opts.cwd), status: 'in_progress' });
  } catch {
    return denyResult('request_error');
  }
  return signal.aborted ? denyResult('aborted') : allow();
}

function wouldAsk(st: GateState, toolName: string, input: Record<string, unknown>): boolean {
  if (st.opts.skip === true) return false;
  if (typeof toolName !== 'string' || toolName.length === 0) return true;
  const record = isRecord(input) ? input : {};
  return requiresAsk(toolName, record, st.opts.cwd) && !grantCovers(st, toolName, record);
}

/** Never rejects and never returns anything but an explicit allow or a named deny. */
function wellFormed(result: unknown): PermissionResult {
  if (isRecord(result) && result['behavior'] === 'allow' && Object.keys(result).length === 1) return allow();
  if (isRecord(result) && result['behavior'] === 'deny' && typeof result['message'] === 'string') {
    return result as PermissionResult;
  }
  return denyResult('request_error');
}

export function createAcpPermissionGate(
  peer: AcpClientPeer, sessionId: string, opts: AcpPermissionOptions,
): AcpPermissionGate {
  const st: GateState = {
    peer, sessionId, opts, granted: new Set(), pending: new Set(), childSeq: 0, childInFlight: new Set(),
    childCwdUnknown: false,
  };
  const gated = (who: Asker): CanUseTool => async (toolName, input, options) => {
    try {
      // Runtime callers can violate the type; a missing signal cannot be honoured, so deny.
      const signal: unknown = (options as { signal?: unknown } | undefined)?.signal;
      if (!isRecord(signal) || typeof signal['aborted'] !== 'boolean') return denyResult('aborted');
      const id: unknown = (options as { toolUseID?: unknown } | undefined)?.toolUseID;
      return wellFormed(await decide(st, toolName, input, signal as unknown as AbortSignal,
        typeof id === 'string' ? id : '', who));
    } catch {
      return denyResult('request_error');
    }
  };
  return {
    canUseTool: gated({}),
    // D9: one labelled callback per forked child; same policy, grants and client.
    forChild: (origin: ChildToolOrigin | undefined) => {
      const prefix = childPrefix(origin);
      const cwd = typeof origin?.cwd === 'string' && path.isAbsolute(origin.cwd) ? path.resolve(origin.cwd) : undefined;
      return gated({ child: { prefix, origin: prefix.slice(1, -1), ...(cwd !== undefined ? { cwd } : {}) } });
    },
    wouldAsk: (toolName, input) => {
      try { return wouldAsk(st, toolName, input); } catch { return true; }
    },
    // D9: a turn that ends normally denies every ask still pending, with a named
    // reason. Child asks (background subagents) are the common case; a top-level
    // ask pending at turn-end has no current production path but is denied here
    // defensively so the behaviour is well-defined if that changes.
    endTurn: async () => {
      for (const ask of [...st.pending]) {
        ask.cancelled = true;
        ask.settle({ kind: 'deny', reason: 'no_active_turn' });
      }
      await Promise.allSettled([...st.childInFlight]);
    },
    cancelAll: () => {
      for (const ask of [...st.pending]) {
        ask.cancelled = true;
        ask.settle({ kind: 'deny', reason: 'cancelled' });
      }
    },
  };
}
