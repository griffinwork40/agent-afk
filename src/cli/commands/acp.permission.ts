/**
 * ACP permission bridge (profile section 6). Returns the `canUseTool` callback
 * the tool dispatcher awaits before each top-level tool call.
 *
 * @module cli/commands/acp.permission
 */
import type { PermissionResult } from '../../agent/types/sdk-types.js';
import type {
  AcpClientPeer, AcpPermissionGate, AcpPermissionOptions, PermissionOption, ToolCallStart, ToolCallUpdate,
} from './acp.wire.js';
import { buildPendingStart, permissionOptions, requiresAsk } from './acp.permission.policy.js';

export const PERMISSION_TIMEOUT_MS = 120_000;

export type DenyReason =
  | 'rejected' | 'unknown_option' | 'malformed_reply' | 'request_error'
  | 'peer_closed' | 'aborted' | 'cancelled' | 'timeout';

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
interface PendingAsk { cancelled: boolean; settle(s: Settled): void }

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
  const message = err instanceof Error ? err.message : '';
  return message.startsWith('ACP peer closed') ? 'peer_closed' : 'request_error';
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
): Promise<PermissionResult> {
  if (signal.aborted) return denyResult('aborted');
  if (typeof toolUseID !== 'string' || toolUseID.length === 0) return denyResult('request_error');
  const ask: PendingAsk = { cancelled: false, settle: () => { ask.cancelled = true; } };
  st.pending.add(ask);
  try {
    const start = buildPendingStart(toolUseID, toolName, input);
    try { await st.opts.emitToolCall(start); } catch { return denyResult('request_error'); }
    const early = interrupted(signal, ask);
    if (early) return denyResult(early);
    const offered = permissionOptions(toolName);
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
    if (decision === 'allow_always') st.granted.add(toolName);
    return allow();
  } finally {
    st.pending.delete(ask);
  }
}

async function decide(
  st: GateState, toolName: string, rawInput: unknown, signal: AbortSignal, toolUseID: string,
): Promise<PermissionResult> {
  if (st.opts.skip === true) return allow();
  const name = typeof toolName === 'string' ? toolName : '';
  const input = isRecord(rawInput) ? rawInput : {};
  if (!requiresAsk(name, input)) return allow();
  if (name.length > 0 && st.granted.has(name)) return runGranted(st, name, input, signal, toolUseID);
  return askClient(st, name, input, signal, toolUseID);
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
    await st.opts.emitToolCall({ ...buildPendingStart(toolUseID, toolName, input), status: 'in_progress' });
  } catch {
    return denyResult('request_error');
  }
  return signal.aborted ? denyResult('aborted') : allow();
}

function wouldAsk(st: GateState, toolName: string, input: Record<string, unknown>): boolean {
  if (st.opts.skip === true) return false;
  if (typeof toolName !== 'string' || toolName.length === 0) return true;
  return requiresAsk(toolName, isRecord(input) ? input : {}) && !st.granted.has(toolName);
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
  const st: GateState = { peer, sessionId, opts, granted: new Set(), pending: new Set() };
  return {
    canUseTool: async (toolName, input, options) => {
      try {
        // Runtime callers can violate the type; a missing signal cannot be honoured, so deny.
        const signal: unknown = (options as { signal?: unknown } | undefined)?.signal;
        if (!isRecord(signal) || typeof signal['aborted'] !== 'boolean') return denyResult('aborted');
        return wellFormed(await decide(st, toolName, input, signal as unknown as AbortSignal, options.toolUseID));
      } catch {
        return denyResult('request_error');
      }
    },
    wouldAsk: (toolName, input) => {
      try { return wouldAsk(st, toolName, input); } catch { return true; }
    },
    cancelAll: () => {
      for (const ask of [...st.pending]) {
        ask.cancelled = true;
        ask.settle({ kind: 'deny', reason: 'cancelled' });
      }
    },
  };
}
