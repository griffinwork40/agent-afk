/**
 * Subagent-lifecycle and tool-use hook dispatch helpers.
 *
 * `SubagentStart` and `PreToolUse` are blocking — a block decision throws
 * {@link HookBlockedError}, which prevents the subagent from being created
 * or the tool call from proceeding.
 *
 * `SubagentStop` and `PostToolUse` are non-blocking by contract. A subagent
 * being torn down shouldn't be held open by a policy handler, and a tool
 * that has already run can't be un-run; observers report via `onError`.
 *
 * `dispatchSubagentStop` returns the {@link HookDecision} from dispatch,
 * allowing callers to inspect `injectContext` and queue it to the parent's
 * input stream if present. Errors and block decisions are swallowed and
 * reported via `onError` (preserving non-blocking semantics), but the decision
 * object is still returned.
 *
 * Abort precedence matches `hook-registry.ts`: a signal abort beats any
 * block decision, and mid-dispatch abort short-circuits remaining handlers.
 *
 * @module agent/subagent-hooks
 */

import { debugLog } from '../utils/debug.js';
import { AbortError, HookBlockedError } from '../utils/errors.js';
import type {
  HookDecision,
  HookRegistry,
  PostToolUseContext,
  PreToolUseContext,
  SubagentStartContext,
  SubagentStopContext,
} from './hooks.js';
import { HOOK_HANDLER_TIMEOUT_MS, HookHandlerTimeoutError } from './hook-registry.js';
import { emitHookDecision } from './trace/emit.js';
import type { HookEventName, TraceWriter } from './trace/index.js';

export interface SubagentHookDispatchOptions {
  signal?: AbortSignal;
  onError?: (err: Error) => void;
  /** Witness-layer trace writer. When provided, every hook dispatch
   *  emits a `hook_decision` event with the decision outcome. */
  traceWriter?: TraceWriter;
}

/**
 * Emit a `hook_decision` trace event from a dispatch helper after the
 * registry returns (or throws). Centralizes the payload construction
 * so all four helpers below stay readable.
 *
 * Block decisions throw {@link HookBlockedError}; this helper records
 * the block before re-throwing in the caller's catch path. Approve
 * and undefined-decision outcomes record the {@link HookDecision} as
 * the registry returned it.
 */
async function emitHookDecisionFromOutcome(
  writer: TraceWriter | undefined,
  hookEvent: HookEventName,
  ctx: { toolName?: string },
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
      ...(hookEvent === 'PreToolUse' && ctx.toolName !== undefined
        ? { blockedTool: ctx.toolName }
        : {}),
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

export async function dispatchSubagentStart(
  registry: HookRegistry | undefined,
  context: SubagentStartContext,
  options: SubagentHookDispatchOptions = {},
): Promise<void> {
  if (!registry) return;
  try {
    const decision = await registry.dispatch(context, options.signal);
    await emitHookDecisionFromOutcome(options.traceWriter, 'SubagentStart', {}, { kind: 'decision', decision });
  } catch (err) {
    if (err instanceof HookBlockedError) {
      await emitHookDecisionFromOutcome(options.traceWriter, 'SubagentStart', {}, { kind: 'blocked', err });
    }
    throw err;
  }
}

/**
 * Race a dispatch call against an aggregate timeout. Required because
 * the registry's `handlerTimeoutMs` bounds each handler individually, so
 * N handlers compound to N × HOOK_HANDLER_TIMEOUT_MS worst-case. The
 * external constraint (BackgroundAgentRegistry.cancelAll() must complete
 * in bounded time) demands a whole-dispatch ceiling.
 *
 * Ordered-operation invariants:
 * - `timer.unref()` so a never-settling dispatch does not pin the event loop.
 * - `settled` flag so the resolve path doesn't fire after the timeout race
 *   already rejected (and vice versa).
 */
function withAggregateTimeout<T>(
  inner: Promise<T>,
  timeoutMs: number,
  event: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new HookHandlerTimeoutError(event, timeoutMs));
    }, timeoutMs);
    timer.unref();

    inner.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function dispatchSubagentStop(
  registry: HookRegistry | undefined,
  context: SubagentStopContext,
  options: SubagentHookDispatchOptions = {},
): Promise<HookDecision> {
  if (!registry) return {};
  try {
    // External constraint: daemon teardown via cancel() → dispatchStopAndRelease()
    // must complete in bounded time; without this race, any user-registered
    // SubagentStop hook can hang BackgroundAgentRegistry.cancelAll() forever.
    //
    // Two-layer bound:
    //   - Per-handler:   registry.dispatch(...) passes HOOK_HANDLER_TIMEOUT_MS
    //   - Aggregate:     withAggregateTimeout wraps the whole call
    // Without the aggregate, N handlers compound to N × HOOK_HANDLER_TIMEOUT_MS.
    const decision = await withAggregateTimeout(
      registry.dispatch(context, options.signal, HOOK_HANDLER_TIMEOUT_MS),
      HOOK_HANDLER_TIMEOUT_MS,
      'SubagentStop',
    );
    await emitHookDecisionFromOutcome(options.traceWriter, 'SubagentStop', {}, { kind: 'decision', decision });
    return decision;
  } catch (err) {
    if (err instanceof HookHandlerTimeoutError) {
      // Production-visible: timeout is a real operational signal — daemons
      // running headless without AFK_DEBUG=1 must still surface a 30s
      // teardown stall. `console.warn` (not `debugLog`) so it's always
      // discoverable. The `onError` callback is the structured-logging
      // path for callers that wire one up.
      console.warn(
        `[afk] SubagentStop hook timed out after ${HOOK_HANDLER_TIMEOUT_MS}ms ` +
          `(subagentId=${context.subagentId}): ${err.message}`,
      );
      options.onError?.(err);
      return {};
    }
    if (err instanceof HookBlockedError) {
      await emitHookDecisionFromOutcome(options.traceWriter, 'SubagentStop', {}, { kind: 'blocked', err });
    }
    if (err instanceof HookBlockedError || err instanceof AbortError) {
      debugLog(`SubagentStop hook swallowed ${err.name}: ${err.message}`);
      options.onError?.(err);
      return {};
    }
    debugLog(`SubagentStop hook unexpected error: ${String(err)}`);
    options.onError?.(err instanceof Error ? err : new Error(String(err)));
    return {};
  }
}

export async function dispatchPreToolUse(
  registry: HookRegistry | undefined,
  context: PreToolUseContext,
  options: SubagentHookDispatchOptions = {},
): Promise<void> {
  if (!registry) return;
  try {
    const decision = await registry.dispatch(context, options.signal);
    await emitHookDecisionFromOutcome(
      options.traceWriter,
      'PreToolUse',
      { toolName: context.toolName },
      { kind: 'decision', decision },
    );
  } catch (err) {
    if (err instanceof HookBlockedError) {
      await emitHookDecisionFromOutcome(
        options.traceWriter,
        'PreToolUse',
        { toolName: context.toolName },
        { kind: 'blocked', err },
      );
    }
    throw err;
  }
}

export async function dispatchPostToolUse(
  registry: HookRegistry | undefined,
  context: PostToolUseContext,
  options: SubagentHookDispatchOptions = {},
): Promise<void> {
  if (!registry) return;
  try {
    const decision = await registry.dispatch(context, options.signal);
    await emitHookDecisionFromOutcome(
      options.traceWriter,
      'PostToolUse',
      { toolName: context.toolName },
      { kind: 'decision', decision },
    );
  } catch (err) {
    if (err instanceof HookBlockedError) {
      await emitHookDecisionFromOutcome(
        options.traceWriter,
        'PostToolUse',
        { toolName: context.toolName },
        { kind: 'blocked', err },
      );
    }
    if (err instanceof HookBlockedError || err instanceof AbortError) {
      debugLog(`PostToolUse hook swallowed ${err.name}: ${err.message}`);
      options.onError?.(err);
      return;
    }
    debugLog(`PostToolUse hook unexpected error: ${String(err)}`);
    options.onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}
