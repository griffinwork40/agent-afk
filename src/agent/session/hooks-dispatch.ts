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
 * Abort precedence: helpers forward the caller's {@link AbortSignal} to
 * the registry. Abort beats a block decision even mid-dispatch; see
 * `hook-registry.ts` for the invariant.
 *
 * @module agent/session/hooks-dispatch
 */

import { debugLog } from '../../utils/debug.js';
import { AbortError, HookBlockedError } from '../../utils/errors.js';
import type {
  HookDecision,
  HookRegistry,
  SessionEndContext,
  SessionStartContext,
} from '../hooks.js';
import { emitHookDecision } from '../trace/emit.js';
import type { HookEventName, TraceWriter } from '../trace/index.js';

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
  traceWriter?: TraceWriter;
}

async function emitSessionHookDecision(
  writer: TraceWriter | undefined,
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
    options.onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}
