/**
 * {@link HookRegistry} implementation.
 *
 * Invariants enforced here:
 * - **Abort precedence** (documented in `abort-graph.ts`): if `signal.aborted`
 *   is true before dispatch, no handler fires. If the signal aborts between
 *   awaits during dispatch, the remaining handlers do not fire and dispatch
 *   throws {@link AbortError}.
 * - **Sequential dispatch**: handlers fire in registration order; later
 *   registrations run after earlier ones.
 * - **Short-circuit on block**: the first decision with `continue === false`
 *   or `decision === 'block'` wins — later handlers do not fire.
 * - **Fail-safe on handler error**: a thrown handler is treated as a block.
 *   The throw is wrapped in {@link HookBlockedError} (`cause` preserved) so
 *   a bug in one handler cannot silently skip policy enforcement.
 *
 * @module agent/hook-registry
 */

import { AbortError, HookBlockedError } from '../utils/errors.js';
import type {
  HarnessHookEvent,
  HookContext,
  HookDecision,
  HookHandler,
  HookRegistry,
  RegisterOptions,
} from './hooks.js';

/**
 * External constraint: daemon teardown via cancel() → dispatchStopAndRelease()
 * must complete in bounded time; without this race, any user-registered
 * SubagentStop hook can hang BackgroundAgentRegistry.cancelAll() forever.
 *
 * The constant defines the **per-handler** ceiling. Aggregate (whole-dispatch)
 * bounds — needed because N handlers compound to N × HOOK_HANDLER_TIMEOUT_MS
 * worst-case — are enforced at the dispatcher level (see `dispatchSubagentStop`
 * in `subagent-hooks.ts`, which wraps the full call in a single deadline race).
 */
export const HOOK_HANDLER_TIMEOUT_MS = 30_000;

/**
 * Race a handler result (sync or async) against a per-handler timeout.
 * Returns the handler's decision if it resolves within `timeoutMs`, or
 * throws {@link HookHandlerTimeoutError} so callers can distinguish timeouts
 * from deliberate blocks.
 *
 * Wraps the result in `Promise.resolve()` to handle both sync-returning
 * handlers (`() => ({ injectContext: ... })`) and async ones.
 *
 * Ordered-operation invariants (see HOT memory `ordered-operation-sequences`):
 * - `timer.unref()` so a never-settling handler does not pin the event loop.
 *   Constraint: Node.js process-exit semantics — pending timers block exit.
 * - `settled` flag so the `.then`/`.catch` callbacks no-op after the timer
 *   fires. Constraint: Promise resolution is single-shot but the resolve and
 *   reject closures retain a live reference to `handlerResult` until it
 *   settles. Without the flag, hung handlers accumulate dangling promise
 *   chains under load (forge/farm retry on misconfigured models).
 */
function withHandlerTimeout(
  handlerResult: HookDecision | Promise<HookDecision>,
  timeoutMs: number,
  event: string,
): Promise<HookDecision> {
  return new Promise<HookDecision>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new HookHandlerTimeoutError(event, timeoutMs));
    }, timeoutMs);
    // Don't pin the Node.js event loop while waiting on a hung handler.
    timer.unref();

    Promise.resolve(handlerResult).then(
      (decision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(decision);
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

/** Sentinel so callers can distinguish a timeout from a deliberate block. */
export class HookHandlerTimeoutError extends Error {
  /**
   * Machine-readable discriminator. Survives ESM/CJS dual-package hazard
   * where `instanceof` checks against re-imported class identities fail.
   */
  readonly code = 'HOOK_HANDLER_TIMEOUT' as const;

  constructor(
    public readonly hookEvent: string,
    public readonly timeoutMs: number,
  ) {
    super(`hook handler timed out after ${timeoutMs}ms during ${hookEvent}`);
    this.name = 'HookHandlerTimeoutError';
  }
}

/**
 * Internal wrapper threading per-handler registration options through dispatch.
 * The public {@link HookRegistry.register} accepts a plain `HookHandler` and an
 * optional {@link RegisterOptions}; we store both as one entry so the dispatch
 * loop can decide whether to apply the timeout race per-handler.
 */
interface RegisteredHandler {
  handler: HookHandler;
  options: RegisterOptions;
}

class HookRegistryImpl implements HookRegistry {
  private readonly handlers = new Map<HarnessHookEvent, RegisteredHandler[]>();

  register(
    event: HarnessHookEvent,
    handler: HookHandler,
    options: RegisterOptions = {},
  ): () => void {
    let list = this.handlers.get(event);
    if (!list) {
      list = [];
      this.handlers.set(event, list);
    }
    const entry: RegisteredHandler = { handler, options };
    list.push(entry);
    return () => {
      const current = this.handlers.get(event);
      if (!current) return;
      const idx = current.indexOf(entry);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  count(event: HarnessHookEvent): number {
    return this.handlers.get(event)?.length ?? 0;
  }

  async dispatch(
    context: HookContext,
    signal?: AbortSignal,
    handlerTimeoutMs: number = HOOK_HANDLER_TIMEOUT_MS,
  ): Promise<HookDecision> {
    assertNotAborted(signal, context.event);

    const list = this.handlers.get(context.event);
    if (!list || list.length === 0) return {};

    // Snapshot to avoid mutation during dispatch affecting this call.
    const snapshot = list.slice();

    let lastDecision: HookDecision = {};

    for (const entry of snapshot) {
      assertNotAborted(signal, context.event);

      let decision: HookDecision;
      try {
        // Forward the turn/dispatch signal as the second handler argument so
        // longRunning handlers (e.g. path-approval awaiting an elicitation
        // prompt) can cancel on session/turn teardown — `assertNotAborted`
        // only gates BETWEEN handlers, not during a single in-flight await.
        const handlerResult = entry.handler(context, signal);
        // External constraint: every handler must be bounded so a hung handler
        // cannot stall the dispatch loop. Callers can pass `Infinity` to opt
        // out explicitly (e.g. inside tests with fake timers), but the default
        // is the documented HOOK_HANDLER_TIMEOUT_MS ceiling.
        //
        // `longRunning` opts out for handlers that legitimately await human
        // input (e.g. path-approval calling elicitationRouter.route(), which
        // waits indefinitely and relies on the forwarded `signal` for teardown
        // rather than a timer). The opt-out is per-handler at registration
        // time so a hung policy hook cannot mask it ad-hoc.
        const applyTimeout =
          !entry.options.longRunning &&
          handlerTimeoutMs > 0 &&
          Number.isFinite(handlerTimeoutMs);
        decision = applyTimeout
          ? await withHandlerTimeout(handlerResult, handlerTimeoutMs, context.event)
          : await handlerResult;
      } catch (err) {
        if (err instanceof HookHandlerTimeoutError) {
          // Timeout: re-throw as-is so dispatchSubagentStop can catch it
          // separately from a deliberate block. Observability for the timeout
          // is owned by the call site (dispatchSubagentStop emits the
          // production-visible warn), not by the inner race.
          throw err;
        }
        throw new HookBlockedError(
          `hook handler threw during ${context.event}`,
          context.event,
          err instanceof Error ? err.message : String(err),
          { cause: err },
        );
      }

      // Re-check abort after each async handler — the signal could have
      // fired during the await. Documented as the "abort mid-dispatch"
      // invariant.
      assertNotAborted(signal, context.event);

      if (isBlocking(decision)) {
        throw new HookBlockedError(
          `hook handler blocked ${context.event}${decision.reason ? `: ${decision.reason}` : ''}`,
          context.event,
          decision.reason,
        );
      }

      // Invariant: merge policy for non-blocking decisions.
      // - injectContext: concatenated across all non-blocking handlers in
      //   registration order, joined by '\n'. Empty/absent values are skipped
      //   so there are no leading, trailing, or duplicate separators.
      // - All other decision fields: last-handler-wins (same as before), so
      //   callers reading `reason`, `decision`, `continue` see the final value.
      // - Blocking short-circuit (isBlocking check above) fires BEFORE this
      //   accumulation, so a blocking handler never contributes to the merge.
      const mergedInjectContext = [lastDecision.injectContext, decision.injectContext]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('\n');
      lastDecision = {
        ...lastDecision,
        ...decision,
        ...(mergedInjectContext.length > 0 ? { injectContext: mergedInjectContext } : {}),
      };
    }

    return lastDecision;
  }
}

function isBlocking(decision: HookDecision): boolean {
  return decision.continue === false || decision.decision === 'block';
}

function assertNotAborted(signal: AbortSignal | undefined, event: string): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    const message = `aborted during ${event}${reason ? `: ${String(reason)}` : ''}`;
    throw new AbortError(message);
  }
}

export function createHookRegistryImpl(): HookRegistry {
  return new HookRegistryImpl();
}
