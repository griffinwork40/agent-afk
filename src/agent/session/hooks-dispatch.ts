/**
 * Session-lifecycle hook dispatch helpers.
 *
 * `dispatchSessionStart` is blocking — a blocked `SessionStart` throws
 * {@link HookBlockedError}, which `AgentSession` propagates to callers so
 * session init fails cleanly without the SDK ever being invoked.
 *
 * `dispatchSessionEnd` is non-blocking by design. Teardown hooks that
 * return a block decision or throw are swallowed and logged — the session
 * is already closing; refusing to close would leak resources. The error
 * surfaces via the optional `onError` callback so operators can surface it
 * out-of-band.
 *
 * `dispatchStopHook` fires at the end of every top-level turn on every
 * surface (REPL, Telegram, daemon/cron, one-shot chat). It is non-blocking:
 * a `HookBlockedError` is caught and logged (block does NOT force REPL
 * continuation — that is PR 2). The returned `injectContext` is queued for
 * the next user message on surfaces that have one; on one-shot surfaces it
 * is dropped with a `stop_inject_dropped` trace event.
 *
 * Abort precedence: helpers forward the caller's {@link AbortSignal} to
 * the registry. Abort beats a block decision even mid-dispatch; see
 * `hook-registry.ts` for the invariant.
 *
 * @module agent/session/hooks-dispatch
 */

import { debugLog } from '../../utils/debug.js';
import { AbortError, HookBlockedError, ensureError} from '../../utils/errors.js';
import type {
  HookDecision,
  HookRegistry,
  SessionEndContext,
  SessionStartContext,
  StopContext,
} from '../hooks.js';
import { emitHookDecision, emitSessionPhase } from '../trace/emit.js';
import type { HookEventName, TraceSink } from '../trace/index.js';
import { HookHandlerTimeoutError } from '../hook-registry.js';

export interface SessionHookDispatchOptions {
  /** Abort signal forwarded to the registry; aborted signal short-circuits. */
  signal?: AbortSignal;
  /**
   * Optional observer invoked when a non-blocking dispatch (SessionEnd)
   * swallows a block or error. Lets operators surface teardown policy
   * failures out-of-band.
   */
  onError?: (err: Error) => void;
  /** Witness-layer trace writer. When provided, every dispatch emits a
   *  `hook_decision` event with the decision outcome. */
  traceWriter?: TraceSink;
}

async function emitSessionHookDecision(
  writer: TraceSink | undefined,
  hookEvent: HookEventName,
  outcome:
    | { kind: 'decision'; decision: HookDecision }
    | { kind: 'blocked'; err: HookBlockedError },
): Promise<void> {
  if (!writer) return;
  if (outcome.kind === 'blocked') {
    await emitHookDecision(writer, {
      hookEvent,
      decision: 'block',
      ...(outcome.err.reason !== undefined ? { reason: outcome.err.reason } : {}),
    });
    return;
  }
  const decision = outcome.decision;
  await emitHookDecision(writer, {
    hookEvent,
    decision: decision.decision,
    ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    ...(decision.injectContext !== undefined
      ? { injectedContextBytes: Buffer.byteLength(decision.injectContext, 'utf8') }
      : {}),
  });
}

/**
 * Dispatch the SessionStart hook chain during session init.
 *
 * Blocking: a blocked SessionStart throws {@link HookBlockedError} (propagated
 * by `AgentSession` so init fails cleanly without invoking the SDK).
 *
 * Returns the merged `injectContext` string — concatenated across all
 * non-blocking handlers by the registry — or `undefined` when no handler
 * injected context. SessionStart fires before any turn exists, so there is no
 * in-flight prompt to prepend to (unlike UserPromptSubmit/Stop); the caller
 * queues the returned string via `queueFrameworkContext` so it rides the
 * session's FIRST outbound user message.
 */
export async function dispatchSessionStart(
  registry: HookRegistry | undefined,
  context: SessionStartContext,
  options: SessionHookDispatchOptions = {},
): Promise<string | undefined> {
  if (!registry) return undefined;
  try {
    const decision = await registry.dispatch(context, options.signal);
    await emitSessionHookDecision(options.traceWriter, 'SessionStart', { kind: 'decision', decision });
    return decision.injectContext;
  } catch (err) {
    if (err instanceof HookBlockedError) {
      await emitSessionHookDecision(options.traceWriter, 'SessionStart', { kind: 'blocked', err });
    }
    throw err;
  }
}

export async function dispatchSessionEnd(
  registry: HookRegistry | undefined,
  context: SessionEndContext,
  options: SessionHookDispatchOptions = {},
): Promise<void> {
  if (!registry) return;
  try {
    const decision = await registry.dispatch(context, options.signal);
    await emitSessionHookDecision(options.traceWriter, 'SessionEnd', { kind: 'decision', decision });
  } catch (err) {
    if (err instanceof HookBlockedError) {
      await emitSessionHookDecision(options.traceWriter, 'SessionEnd', { kind: 'blocked', err });
    }
    // Non-blocking by contract. Abort is still observed but swallowed —
    // the session is already closing; re-throwing would leak resources.
    if (err instanceof HookBlockedError || err instanceof AbortError) {
      debugLog(`SessionEnd hook swallowed ${err.name}: ${err.message}`);
      options.onError?.(err);
      return;
    }
    debugLog(`SessionEnd hook unexpected error: ${String(err)}`);
    options.onError?.(ensureError(err));
  }
}

/** Per-handler timeout for the post-turn Stop notification (5s). Matches the
 *  REPL's own STOP_HOOK_HANDLER_TIMEOUT_MS — Stop fires every turn, so a
 *  notification hook must not stall it for the full registry default (30s). */
const STOP_HOOK_HANDLER_TIMEOUT_MS = 5_000;

export interface StopHookDispatchOptions extends SessionHookDispatchOptions {
  /**
   * Whether the calling surface has a next user message to deliver
   * injectContext on. REPL and Telegram (per-chat session) supply `true`;
   * one-shot surfaces (daemon/cron task, `afk chat`) supply `false` — they
   * have no subsequent prompt, so injectContext must be dropped.
   */
  hasNextTurn: boolean;
  /** Surface name for the `stop_inject_dropped` trace event. */
  surface?: string;
}

export interface StopHookDispatchResult {
  /** Merged injectContext from non-blocking Stop handlers, or undefined. */
  injectContext?: string;
  /** Whether a HookBlockedError was caught (block is logged, not thrown). */
  wasBlocked?: boolean;
  /** The blocking handler's reason, when it gave one. */
  blockedReason?: string;
  /** Whether the handler timed out (timeout is logged, not thrown). */
  wasTimeout?: boolean;
}

/**
 * Dispatch the Stop hook chain at the end of a top-level turn.
 *
 * Fires on EVERY top-level surface (REPL, Telegram, daemon/cron, one-shot
 * chat). Subagent sessions are excluded by the caller (`parentSessionId`
 * guard in turn-stream-runner.ts) — they get SubagentStop.
 *
 * Non-blocking by design: a `HookBlockedError` is caught and logged, and
 * the `wasBlocked` flag is returned so REPL can render its dim notice line.
 * A block does NOT force same-turn continuation today (PR 2 adds that).
 *
 * `AbortError` propagates — abort precedence is non-negotiable.
 *
 * `injectContext` delivery: returned to the caller when `hasNextTurn` is
 * true; dropped with a `stop_inject_dropped` trace event when false (one-shot
 * surfaces have no next prompt). Callers on surfaces with a next turn must
 * stash the returned string and prepend it to the next user message.
 */
export async function dispatchStopHook(
  registry: HookRegistry | undefined,
  context: StopContext,
  options: StopHookDispatchOptions,
): Promise<StopHookDispatchResult> {
  if (!registry) return {};
  try {
    const decision = await registry.dispatch(
      context,
      options.signal,
      STOP_HOOK_HANDLER_TIMEOUT_MS,
    );
    await emitSessionHookDecision(options.traceWriter, 'Stop', { kind: 'decision', decision });

    const raw = decision.injectContext;
    const injectContext = raw && raw.trim().length > 0 ? raw : undefined;

    if (injectContext !== undefined && !options.hasNextTurn) {
      // One-shot surface: drop the injection and record the gap.
      void emitSessionPhase(options.traceWriter, {
        phase: 'stop_inject_dropped',
        metadata: {
          injectContextBytes: Buffer.byteLength(injectContext, 'utf8'),
          ...(options.surface !== undefined ? { surface: options.surface } : {}),
        },
      });
      debugLog('[stop hook] injectContext dropped — no next turn on this surface', {
        sessionId: context.sessionId,
        injectContextBytes: Buffer.byteLength(injectContext, 'utf8'),
      });
      return {};
    }

    return injectContext !== undefined ? { injectContext } : {};
  } catch (err) {
    if (err instanceof AbortError) throw err;
    if (err instanceof HookHandlerTimeoutError) {
      debugLog('[stop hook] handler timed out', { sessionId: context.sessionId });
      return { wasTimeout: true };
    }
    if (err instanceof HookBlockedError) {
      await emitSessionHookDecision(options.traceWriter, 'Stop', { kind: 'blocked', err });
      debugLog('[stop hook] blocked: ' + (err.reason ?? 'no reason given'), {
        sessionId: context.sessionId,
      });
      return { wasBlocked: true, ...(err.reason !== undefined ? { blockedReason: err.reason } : {}) };
    }
    debugLog('[stop hook] unexpected error: ' + String(err), { sessionId: context.sessionId });
    return {};
  }
}
