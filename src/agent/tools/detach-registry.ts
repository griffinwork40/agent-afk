/**
 * Generic detach contract for in-flight tool calls.
 *
 * Mirrors the foreground-subagent promotion contract (Ctrl+B backgrounding)
 * but for non-subagent tools — initially bash only; compose is a follow-up
 * (tracked in #2542).
 *
 * A tool handler that opts in to detachability:
 *  1. Calls {@link DetachableToolRegistry.register} early in its execution,
 *     receiving back a `DetachToken`. The token lets the handler poll
 *     {@link DetachToken.shouldDetach} and resolve its own promise early.
 *  2. When the token fires (`detachSignal` aborts), the handler:
 *       a. Stops waiting on the underlying operation (keeping the op running).
 *       b. Calls {@link DetachToken.notifyDetached} to record the detach.
 *       c. Returns the result of {@link DetachToken.detachResult} to the model.
 *       d. Later — once the real result is ready — calls
 *          {@link DetachToken.deliver} to push it through the notifier.
 *  3. On session end, {@link DetachableToolRegistry.cancelAll} fires every
 *     token's abortController, which must prompt the handler to stop the
 *     underlying operation (e.g. SIGKILL the spawned process).
 *
 * Parallel-batch invariant (Invariant:D1):
 *   When a Ctrl+B keypress lands while N > 1 detachable tool calls are running
 *   concurrently within one batch, ALL of them are detached in the same pass.
 *   Each detached token carries its own delivery channel; results arrive
 *   independently. No partial-batch detach: either the whole batch is detached
 *   or none of it is (a token that has already resolved before detachAll()
 *   reaches it is simply skipped because it deregistered itself).
 *
 * Provider parity (Invariant:D2):
 *   The registry and the token are wired through {@link ToolHandlerContext},
 *   which is shared by both the Anthropic-direct and OpenAI-compatible
 *   dispatcher paths. The detach seam therefore works identically for both
 *   providers — no provider-specific code path needed.
 *
 * AbortGraph ownership (Invariant:D3):
 *   The registry's {@link DetachableToolRegistry.cancelAll} must be called by
 *   session teardown (AbortGraph cascade). An in-flight detached process is
 *   still a child of the session: the session owns its lifetime. Detaching a
 *   bash process frees the MODEL'S turn, not the session's resource claim. The
 *   caller (session teardown) is responsible for wiring this call; the registry
 *   never self-wires onto any global signal.
 *
 * @module agent/tools/detach-registry
 */

import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result delivered to the notifier after a detached tool call completes.
 * Mirrors the shape of the existing `<background-subagent-result>` injection
 * enough for the notifier to format a model-context envelope.
 */
export interface DetachedToolResult {
  /** Stable identifier for this detached call (matches `ToolCall.id`). */
  readonly toolUseId: string;
  /** Human-readable label shown in the notification line (e.g. command summary). */
  readonly label: string;
  /** 'completed' when the operation succeeded; 'failed' on non-zero exit / error. */
  readonly status: 'completed' | 'failed';
  /** Captured output text (stdout + stderr), possibly head+tail-capped. */
  readonly output: string;
  /** Exit code when available (bash only). */
  readonly exitCode?: number;
  /** Wall-clock duration of the underlying operation in milliseconds. */
  readonly durationMs: number;
}

/**
 * Per-call handle returned by {@link DetachableToolRegistry.register}.
 * The handler holds this for the lifetime of the tool call.
 */
export interface DetachToken {
  /**
   * Unique identifier for this detached call. Matches the tool-call id passed
   * to {@link DetachableToolRegistry.register}.
   */
  readonly toolUseId: string;

  /**
   * AbortSignal that fires when Ctrl+B triggers detachment (or session ends).
   * The handler SHOULD poll this or add an 'abort' listener, then call
   * {@link DetachToken.notifyDetached} and return {@link detachResult}.
   */
  readonly detachSignal: AbortSignal;

  /**
   * Whether the handler should detach RIGHT NOW. Equivalent to checking
   * `detachSignal.aborted` but phrased as a predicate for poll-style handlers.
   */
  shouldDetach(): boolean;

  /**
   * The tool_result the handler MUST return when it detaches. Contains the
   * model-facing message explaining that the process is still running and the
   * result will be delivered later.
   */
  detachResult(label: string): { content: string };

  /**
   * Called by the handler AFTER it decides to detach but BEFORE it returns.
   * Transitions the token from 'running' to 'detached' state so the registry
   * knows the handler is no longer awaiting the operation.
   */
  notifyDetached(): void;

  /**
   * Called by the handler once the underlying operation actually finishes
   * (long after the tool handler has returned). Pushes the result through the
   * registry's settled notifier so the REPL can inject it into the next turn.
   */
  deliver(result: DetachedToolResult): void;
}

// ---------------------------------------------------------------------------
// Internal token implementation
// ---------------------------------------------------------------------------

interface InternalToken extends DetachToken {
  _status: 'running' | 'detached' | 'settled';
  _abort: AbortController;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * In-memory registry of in-flight detachable tool calls.
 *
 * One registry instance is created per session (alongside the
 * `BackgroundAgentRegistry`) and injected into the dispatcher. The dispatcher
 * thread the registry through `ToolHandlerContext.detachRegistry` so tool
 * handlers can opt in.
 */
export class DetachableToolRegistry extends EventEmitter {
  private readonly tokens = new Map<string, InternalToken>();

  /**
   * Register a new detachable tool call. Returns a {@link DetachToken} the
   * handler holds for the lifetime of the call.
   *
   * @param toolUseId  Stable id from the provider's tool-use block.
   */
  register(toolUseId: string): DetachToken {
    const abort = new AbortController();
    const token: InternalToken = {
      toolUseId,
      _status: 'running',
      _abort: abort,
      detachSignal: abort.signal,
      shouldDetach: () => abort.signal.aborted,
      detachResult: (label: string) => ({
        content: JSON.stringify({
          status: 'detached',
          toolUseId,
          label,
          message:
            `Command detached by user (Ctrl+B). It keeps running in the background; ` +
            `its output will be delivered into this context automatically with the next ` +
            `user message once it finishes.`,
        }),
      }),
      notifyDetached: () => {
        if (token._status === 'running') token._status = 'detached';
      },
      deliver: (result: DetachedToolResult) => {
        if (token._status !== 'settled') {
          token._status = 'settled';
          this.tokens.delete(toolUseId);
          this.emit('settled', result);
        }
      },
    };
    this.tokens.set(toolUseId, token);
    return token;
  }

  /**
   * True iff at least one detachable tool call is currently registered and
   * has not yet delivered its result. Used by the Ctrl+B handler to decide
   * whether to attempt tool detach before falling through to whole-turn detach.
   */
  hasDetachable(): boolean {
    return this.tokens.size > 0;
  }

  /**
   * Fire every registered token's abort signal (Ctrl+B path). Handlers that
   * are polling `shouldDetach()` or listening on `detachSignal` will unblock,
   * call `notifyDetached()`, and return their `detachResult`.
   *
   * Invariant:D1 — ALL running tokens are detached in one pass; no partial
   * batch. Tokens that completed before this call have already deregistered.
   */
  detachAll(): void {
    for (const token of this.tokens.values()) {
      if (token._status === 'running') {
        token._abort.abort();
      }
    }
  }

  /**
   * Cancel every in-flight token (session-end / AbortGraph cascade).
   *
   * The distinction from {@link detachAll}: this is a hard cancel signal
   * telling the handler to STOP the underlying operation, not just free the
   * turn. Handlers MUST wire the session's abort signal to stop the operation
   * on cancel; the detach signal only asks for an early return.
   *
   * For bash: the handler's existing signal listener already kills the process
   * group on session abort. detachAll uses the DETACH signal (separate); cancel
   * uses the SESSION signal (already wired). So `cancelAll` here fires the
   * detach abort to ensure any detach-polling handler also unblocks — the
   * handler's outer signal listener handles the actual kill.
   */
  cancelAll(): void {
    for (const token of this.tokens.values()) {
      // Fire the detach abort so poll-style handlers unblock. The session's
      // own AbortSignal (already held by the handler) is responsible for the
      // actual process kill.
      if (!token._abort.signal.aborted) {
        token._abort.abort();
      }
    }
    this.tokens.clear();
  }

  /** Observable surface: list of in-flight detachable tool-use ids. */
  listRunning(): string[] {
    return [...this.tokens.keys()];
  }
}
