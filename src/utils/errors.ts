export class AbortError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "AbortError";
  }
}

export class TimeoutError extends Error {
  constructor(
    message: string,
    public readonly timeoutMs: number,
  ) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Thrown when a forked sub-agent's progress-aware idle watchdog fires: the
 * child produced NO observable {@code OutputEvent} for a full idle window
 * (default 8 min — see {@link import('../agent/subagent.js').SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS}),
 * distinct from the blunt wall-clock budget that bounds total turn time. The
 * watchdog aborts the SAME controller {@code withTimeout} targets, so the
 * existing timeout-abort → partial-output path in
 * {@code SubagentHandleImpl.run} applies unchanged.
 *
 * Extends {@link TimeoutError} deliberately: the {@code instanceof
 * TimeoutError} own-budget classification in `subagent/handle.ts` then treats
 * an idle-fire as a `failed` (own-budget expiry) termination — NOT a
 * `cancelled` one — with the child's `partialOutput` preserved, exactly like a
 * wall-clock timeout. {@code timeoutMs} carries the idle window that elapsed.
 */
export class IdleWatchdogError extends TimeoutError {
  constructor(message: string, idleTimeoutMs: number) {
    super(message, idleTimeoutMs);
    this.name = "IdleWatchdogError";
  }
}

/**
 * Thrown when a harness hook handler returns a blocking decision
 * ({@code continue: false} or {@code decision: 'block'}) or throws. The
 * wrapped cause — if any — is preserved on {@link HookBlockedError.cause}.
 */
export class HookBlockedError extends Error {
  public override readonly cause?: unknown;

  constructor(
    message: string,
    public readonly event: string,
    public readonly reason?: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "HookBlockedError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Thrown by a forked sub-agent's `streamToFinalMessage` when its model stream
 * ends with NO terminal assistant message AND an EMPTY streamed buffer, and the
 * run was NOT user-cancelled or cascade-aborted (e.g. the first-token/TTFB
 * timeout guillotines a connection stalled inside the provider SDK's internal
 * 429/503/529 retry-backoff). The child produced zero output, so there is
 * nothing to salvage as a partial.
 *
 * This is thrown — not returned as a synthetic-placeholder "success" — so the
 * termination classifies as `status: 'failed'` (via `run()`'s catch → the
 * non-cascade `else` branch), letting any consumer's natural `status !==
 * 'succeeded'` check catch the zero-output timeout instead of being fooled by a
 * false success. It is deliberately DISTINCT from `AbortError` (which the catch
 * would classify `'cancelled'`) and carries an actionable, non-opaque message
 * so the parent can act (retry / fall back) rather than see a bare failure.
 * `SubagentResult.stopReason` is preserved as `'stream_incomplete'` alongside
 * this error (see {@link import('../agent/subagent/result.js').STREAM_INCOMPLETE}).
 *
 * Contrast: a stream that ended with buffered partial text (real streamed
 * output) is NOT this — it stays a succeeded-partial so its work is salvaged
 * and annotated at the consumption boundary.
 */
export class StreamIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamIncompleteError";
  }
}

/**
 * Thrown by {@link consumeSdkStream} when the session's cumulative cost
 * crosses the `maxBudgetUsd` ceiling. The throw propagates through
 * `runSessionLifecycle`'s catch block, which ensures `messageQueue` is
 * completed (via `fail`) and `SessionEnd` hooks are dispatched — the same
 * teardown path used for all other terminal errors.
 */
export class BudgetExceededError extends Error {
  constructor(
    public readonly runningCostUsd: number,
    public readonly maxBudgetUsd: number,
    message?: string,
  ) {
    super(
      message ??
        `Budget ceiling reached: $${runningCostUsd.toFixed(4)} cumulative >= $${maxBudgetUsd.toFixed(4)} limit`,
    );
    this.name = "BudgetExceededError";
  }
}

/**
 * Thrown (surfaced as a loop `error` event, never a raw throw the dispatcher
 * would swallow) when a forked sub-agent accumulates
 * {@link import('../agent/tools/denial-circuit-breaker.js').DENIAL_CIRCUIT_BREAKER_THRESHOLD}
 * consecutive path-approval READ denials with no intervening successful tool
 * call. A fork cannot approve its own reads, so once it is provably spinning on
 * unrecoverable denials, continuing only burns its wall-clock budget. The
 * message names the accumulated denied paths + the grant remedy so the parent
 * orchestrator can re-dispatch with a corrected read scope. See
 * `src/agent/tools/denial-circuit-breaker.ts`.
 */
export class DenialCircuitBreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DenialCircuitBreakerError";
  }
}

/**
 * Thrown when an AgentConfig field is set that the selected provider does
 * not support (e.g. `thinking` on the OpenAI Codex backend). The field name
 * makes it easy for CLI / bridge wrappers to translate into a friendly
 * "this option only works with Claude models" message.
 */
export class UnsupportedProviderConfigError extends Error {
  constructor(
    public readonly provider: string,
    public readonly field: string,
    message?: string,
  ) {
    super(
      message ?? `${provider} provider does not support AgentConfig.${field}.`,
    );
    this.name = "UnsupportedProviderConfigError";
  }
}

