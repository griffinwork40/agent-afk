/**
 * One ACP prompt turn: consume the session stream, translate each event
 * through the A2 seam, send `session/update` notifications in order, then
 * yield the stop reason (profile §3, §4, §7, §10).
 *
 * @module cli/commands/acp.prompt-turn
 */

import type { OutputEvent } from '../../agent/types/session-types.js';
import { finishTurn, translateOutputEvent } from './acp.translate.js';
import type { AcpSessionHandle } from './acp.session.js';
import type {
  AcpClientPeer, SessionUpdate, StopReason, ToolCallStart, TranslatorState, TurnMetadata,
} from './acp.wire.js';
import { sanitizeDisplay } from './acp.translate.bounds.js';
import { closeOpenToolCalls, observeSentUpdate } from './acp.translate.terminal.js';

export interface ActiveTurn {
  abort: AbortController;
  cancelled: boolean;
  /** Settles once the prompt response is decided (never rejects). */
  done: Promise<void>;
}

export interface LiveSession {
  id: string;
  cwd: string;
  handle?: AcpSessionHandle;
  translator: TranslatorState;
  active?: ActiveTurn;
  closing: boolean;
  /** Canonical JSON of the wire MCP list the session was opened with (D15 reopen check). */
  wireMcp?: string;
}

/** Thrown when the turn fails for a reason other than cancellation. */
export class AcpTurnFailed extends Error {}

export interface PromptTurnDeps {
  peer: AcpClientPeer;
  log(line: string): void;
  /** How long to keep draining queued updates after cancellation. */
  cancelGraceMs?: number;
  /** Session `--max-turns` cap (0 or absent: no cap). */
  maxTurns?: number;
}

const DEFAULT_CANCEL_GRACE_MS = 2000;
const STOP = Symbol('stop');

export function sendUpdate(peer: AcpClientPeer, sessionId: string, update: SessionUpdate): Promise<void> {
  return peer.notify('session/update', sanitizeDisplay({ sessionId, update }));
}

/**
 * Mark cancellation before interruption, deny pending asks, then interrupt
 * (profile §7). Idle or already-cancelled turns are a no-op.
 */
export function cancelTurn(live: LiveSession, log: (l: string) => void): void {
  const turn = live.active;
  if (!turn || turn.cancelled) return;
  turn.cancelled = true;
  live.translator.cancelled = true;
  turn.abort.abort();
  live.handle?.session.interrupt().catch((err: unknown) => log(`[acp] interrupt failed: ${String(err)}`));
}

/**
 * Permission-gate `emitToolCall`: deduplicate against the shared translator
 * tool map. A repeated start becomes an in_progress update or a no-op.
 */
export function makeEmitToolCall(live: LiveSession, peer: AcpClientPeer) {
  return async (update: ToolCallStart): Promise<void> => {
    const known = live.translator.tools.get(update.toolCallId);
    if (known?.announced) {
      if (known.status === 'completed' || known.status === 'failed') return;
      if (update.status === 'in_progress' && known.status !== 'in_progress') {
        known.status = 'in_progress';
        await sendUpdate(peer, live.id, {
          sessionUpdate: 'tool_call_update', toolCallId: update.toolCallId, status: 'in_progress',
        });
      } else if (update.status === 'completed' || update.status === 'failed') {
        // D9: the gate closes a child-originated card itself (no stream result follows).
        known.status = update.status;
        known.content = update.content ?? [];
        await sendUpdate(peer, live.id, {
          sessionUpdate: 'tool_call_update', toolCallId: update.toolCallId, status: update.status,
          content: known.content,
        });
      }
      return;
    }
    live.translator.tools.set(update.toolCallId, {
      name: update.name ?? '',
      ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
      announced: true,
      content: update.content ?? [],
      status: update.status ?? 'pending',
    });
    await sendUpdate(peer, live.id, update);
  };
}

function stopAfter(signal: AbortSignal): { promise: Promise<typeof STOP>; dispose(): void } {
  let onAbort: () => void = () => {};
  const promise = new Promise<typeof STOP>((resolve) => {
    if (signal.aborted) { resolve(STOP); return; }
    onAbort = () => resolve(STOP);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return { promise, dispose: () => signal.removeEventListener('abort', onAbort) };
}

function graceTimer(ms: number): { promise: Promise<typeof STOP>; dispose(): void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<typeof STOP>((resolve) => { timer = setTimeout(() => resolve(STOP), ms); });
  return { promise, dispose: () => clearTimeout(timer) };
}

async function consumeStream(
  live: LiveSession, turn: ActiveTurn, text: string, deps: PromptTurnDeps,
): Promise<TurnMetadata | undefined> {
  const handle = live.handle;
  if (!handle) throw new AcpTurnFailed('session has no handle');
  const it = handle.session.sendMessageStream(text)[Symbol.asyncIterator]();
  let stop = stopAfter(turn.abort.signal);
  let inGrace = false;
  let meta: TurnMetadata | undefined;
  try {
    let next = it.next();
    next.catch(() => undefined); // a stream abandoned after cancel must not reject unhandled
    for (;;) {
      const r: IteratorResult<OutputEvent> | typeof STOP = await Promise.race([next, stop.promise]);
      if (r === STOP) {
        if (inGrace) break;
        inGrace = true;
        stop.dispose();
        stop = graceTimer(deps.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
        continue;
      }
      if (r.done) break;
      const ev = r.value;
      if (ev.type === 'error') {
        if (turn.cancelled) break;
        deps.log(`[acp] session error: ${ev.error.stack ?? ev.error.message}`);
        throw new AcpTurnFailed('stream error');
      }
      if (ev.type === 'done') meta = ev.metadata;
      for (const u of translateOutputEvent(ev, live.translator, { cwd: live.cwd })) {
        observeSentUpdate(live.translator, u);
        await sendUpdate(deps.peer, live.id, u);
      }
      next = it.next();
      next.catch(() => undefined);
    }
  } catch (err) {
    if (!turn.cancelled) throw err;
  } finally {
    stop.dispose();
    if (turn.cancelled) void Promise.resolve(it.return?.()).catch(() => undefined);
  }
  return meta;
}

/**
 * Profile §3: the session's turn cap is reached. Read from the session's own
 * completed-turn count (the same count the shared runner's pre-turn guard,
 * `assertCanSend` in src/agent/session/turn-stream-runner.ts, compares with
 * `maxTurns`), so the cap is answered before that guard throws and the
 * session stays open.
 */
function maxTurnsReached(live: LiveSession, maxTurns: number | undefined): boolean {
  if (!maxTurns || maxTurns <= 0) return false;
  const count = live.handle?.session.getTurnCount?.();
  return typeof count === 'number' && count >= maxTurns;
}

/** Close every announced, non-terminal tool call before the prompt response. */
async function sendClosingUpdates(live: LiveSession, deps: PromptTurnDeps, mustSucceed: boolean): Promise<void> {
  try {
    for (const u of closeOpenToolCalls(live.translator)) await sendUpdate(deps.peer, live.id, u);
  } catch (err) {
    if (mustSucceed) throw err;
    deps.log(`[acp] closing tool calls failed: ${String(err)}`);
  }
}

/**
 * Run one prompt turn. Resolves with the stop reason; throws
 * {@link AcpTurnFailed} (or the underlying error) for internal failures.
 * Cancellation always wins: a cancelled turn resolves `cancelled`. On every
 * exit path, announced tool calls are made terminal before the response.
 */
export async function runPromptTurn(
  live: LiveSession, text: string, deps: PromptTurnDeps,
): Promise<StopReason> {
  if (maxTurnsReached(live, deps.maxTurns)) return 'max_turn_requests';
  let settle: () => void = () => {};
  const turn: ActiveTurn = {
    abort: new AbortController(),
    cancelled: false,
    done: new Promise<void>((r) => { settle = r; }),
  };
  live.translator.cancelled = false;
  live.active = turn;
  try {
    let meta: TurnMetadata | undefined;
    try {
      meta = await consumeStream(live, turn, text, deps);
    } catch (err) {
      if (!turn.cancelled) {
        await sendClosingUpdates(live, deps, false);
        throw err;
      }
    }
    await sendClosingUpdates(live, deps, !turn.cancelled);
    let finished;
    try {
      finished = finishTurn(live.translator, meta);
    } catch (err) {
      if (!turn.cancelled) throw err;
      deps.log(`[acp] finishTurn failed after cancel: ${String(err)}`);
      return 'cancelled';
    }
    try {
      for (const u of finished.updates) await sendUpdate(deps.peer, live.id, u);
    } catch (err) {
      if (!turn.cancelled) throw err;
    }
    return turn.cancelled ? 'cancelled' : finished.stopReason;
  } finally {
    if (live.active === turn) live.active = undefined;
    settle();
  }
}
