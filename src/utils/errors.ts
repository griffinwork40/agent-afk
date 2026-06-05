export class ClaudeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

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

export class ShellError extends Error {
  constructor(
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly code: number,
    public readonly interrupted: boolean,
  ) {
    super("Shell command failed");
    this.name = "ShellError";
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof AbortError || (e instanceof Error && e.name === "AbortError");
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

export function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
