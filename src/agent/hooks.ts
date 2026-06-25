/**
 * Harness-owned hook infrastructure.
 *
 * Hooks fire at well-defined lifecycle points (session start/end, subagent
 * start/stop, tool use pre/post). Handlers register per-event and are
 * dispatched sequentially in registration order. A handler that returns
 * `continue: false` or `decision: 'block'` short-circuits the dispatch — any
 * remaining handlers for the event do not fire.
 *
 * Abort precedence is non-negotiable (see {@link AbortGraph} in
 * `abort-graph.ts`): if the caller's AbortSignal is aborted before dispatch
 * begins OR becomes aborted between handler awaits, dispatch throws
 * {@link AbortError} and no further handlers fire. A hook decision never
 * overrides an aborted signal.
 *
 * Handler errors fail safe: a thrown handler is treated as `decision: 'block'`
 * and surfaces to callers via {@link HookBlockedError} (in `../utils/errors`),
 * with the original error attached as `cause`. This prevents a bug in one
 * handler from silently skipping policy enforcement.
 *
 * **Context injection (SubagentStop only):** Foreground subagents hand their
 * final assistant output to the parent through the normal `agent` tool result;
 * `injectContext` is a separate hook-generated framework note, not text typed
 * by the human user. When a `SubagentStop` handler returns `injectContext`, the
 * dispatch result is propagated to the caller, which queues the context string
 * to the parent session's input stream for the parent's next turn. If the
 * parent is aborting, the injection is skipped. DAG/compose and background
 * paths are not guaranteed to inject (some intentionally leave this channel
 * dark), and multiple `injectContext` values do not merge today: hook dispatch
 * returns the last non-blocking decision. Other hook events ignore
 * `injectContext` entirely.
 *
 * @module agent/hooks
 */

import { createHookRegistryImpl } from './hook-registry.js';
import type { SubagentTrace } from './subagent/result.js';

export type HarnessHookEvent =
  | 'SessionStart'
  | 'SessionEnd'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure';

export interface HookDecision {
  /** False halts session lifecycle; undefined/true continues. */
  continue?: boolean;
  /** 'block' rejects the operation; 'approve' is explicit acceptance (same semantic as unset). */
  decision?: 'block' | 'approve';
  /** Human-readable rationale for blocking or approving. */
  reason?: string;
  /**
   * (SubagentStop only) Framework-generated context to inject into the parent
   * session's next turn. This is not human-authored user text. Queued to the
   * parent's input stream after dispatch completes; dropped if the parent is
   * aborting. DAG/compose and background paths may intentionally not inject.
   * Multiple injected contexts currently do not merge — the last non-blocking
   * hook decision wins. Ignored for all other hook events.
   */
  injectContext?: string;
}

/** Status vocabulary mirrored from {@link SubagentStatus} without a runtime import. */
export type SubagentHookStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface SessionStartContext {
  event: 'SessionStart';
  sessionId?: string;
}

export interface SessionEndContext {
  event: 'SessionEnd';
  sessionId?: string;
  reason?: string;
  /**
   * Parent session id when this SessionEnd belongs to a forked subagent
   * (set from {@link AgentConfig.parentSessionId}). Top-level sessions leave
   * this undefined. Session-scoped hooks (e.g. the memory SessionEnd writer)
   * use it to skip subagent teardowns so child sessions don't pollute
   * per-session state.
   */
  parentSessionId?: string;
  /**
   * Absolute path to this session's witness `trace.jsonl`, when a trace writer
   * is configured. Threaded from the writer because the trace directory is
   * keyed by the writer's session LABEL (a random UUID on the one-shot path),
   * which is NOT the same as {@link sessionId} — a handler cannot reconstruct
   * it from sessionId alone. Used by the run-receipt hook to read the sealed
   * trace after SessionEnd. Absent when tracing is disabled.
   */
  tracePath?: string;
}

export interface SubagentStartContext {
  event: 'SubagentStart';
  subagentId: string;
  parentSessionId?: string;
}

export interface SubagentStopContext {
  event: 'SubagentStop';
  subagentId: string;
  status: SubagentHookStatus;
  reason?: string;
  /**
   * Content of the most recent successful `run()` on this handle, or
   * `undefined` if no run ever succeeded (e.g., the subagent was cancelled
   * before any run completed, or every run threw). Only successful runs
   * populate this field — failed runs leave the prior value in place. Used
   * by hooks (e.g., the shadow-verify nudge) to inspect the child's final
   * output before the parent acts on it.
   */
  lastMessage?: string;
  /**
   * Human-readable agent-type label (sourced from `ForkSubagentOptions.idPrefix`).
   * Used by hooks to skip nudges when the child ran inside an already-verifying
   * orchestrator. Undefined when no prefix was set.
   */
  agentType?: string;
  /** Wall-clock milliseconds from `run()` entry to resolution. */
  durationMs?: number;
  /** Execution trace: tool calls made, results received, thinking presence, and token usage. */
  trace?: SubagentTrace;
}

export interface PreToolUseContext {
  event: 'PreToolUse';
  sessionId?: string;
  subagentId?: string;
  /**
   * Parent session id when the tool call originates inside a forked subagent
   * (set from {@link AgentConfig.parentSessionId}). Top-level sessions leave
   * this undefined. Session-scoped gates (e.g. the plan-mode gate, a
   * conversation-level affordance) use it to skip subagent tool calls.
   */
  parentSessionId?: string;
  toolName: string;
  input?: unknown;
}

export interface PostToolUseContext {
  event: 'PostToolUse';
  sessionId?: string;
  subagentId?: string;
  /**
   * Parent session id when the tool call originates inside a forked subagent
   * (set from {@link AgentConfig.parentSessionId}). Top-level sessions leave
   * this undefined. Symmetric with {@link PostToolUseFailureContext} so hook
   * authors can treat both events uniformly for subagent correlation.
   */
  parentSessionId?: string;
  toolName: string;
  /**
   * Tool-call input passed through from {@link PreToolUseContext}. Carried
   * verbatim so hooks that need to correlate Pre/PostToolUse for the same
   * call (e.g. the path-approval hook's "Once" cleanup) can recompute the
   * resolved path identically.
   */
  input?: unknown;
  output?: unknown;
}

export interface PostToolUseFailureContext {
  event: 'PostToolUseFailure';
  sessionId?: string;
  subagentId?: string;
  /**
   * Parent session id when the tool call originates inside a forked subagent
   * (set from {@link AgentConfig.parentSessionId}). Top-level sessions leave
   * this undefined.
   */
  parentSessionId?: string;
  toolName: string;
  /** Tool-call input, carried verbatim from the originating call. */
  input?: unknown;
  /** The error message string from the thrown handler. */
  error: string;
}

/** Discriminated union — narrow via `switch (context.event)`. */
export type HookContext =
  | SessionStartContext
  | SessionEndContext
  | SubagentStartContext
  | SubagentStopContext
  | PreToolUseContext
  | PostToolUseContext
  | PostToolUseFailureContext;

/**
 * A hook handler. `signal` is the turn/dispatch {@link AbortSignal} forwarded
 * by `dispatch()`; handlers that await human input (see `longRunning` below)
 * MUST observe it so session/turn teardown can cancel the wait. Synchronous
 * and short-lived handlers can ignore it.
 */
export type HookHandler = (
  context: HookContext,
  signal?: AbortSignal,
) => HookDecision | Promise<HookDecision>;

/**
 * Per-handler registration options.
 *
 * `longRunning` opts the handler out of the per-handler timeout enforced by
 * `dispatch()`. Use ONLY for handlers that legitimately need to await human
 * input (e.g. the path-approval hook calling `elicitationRouter.route()`,
 * which waits indefinitely for an operator who may be away from keyboard).
 * The default 30s per-handler timeout exists to bound hung policy handlers —
 * opting out of it means YOU own teardown: observe the turn `AbortSignal`
 * (passed as the second handler argument) so session/turn abort can still
 * cancel the wait. There is no time-based auto-decline.
 */
export interface RegisterOptions {
  longRunning?: boolean;
}

export interface HookRegistry {
  /** Register a handler for an event. Returns an unsubscribe function. */
  register(event: HarnessHookEvent, handler: HookHandler, options?: RegisterOptions): () => void;
  /**
   * Dispatch a context through the handlers registered for its event.
   * Throws {@link AbortError} if `signal` aborts before or during dispatch.
   * Throws {@link HookBlockedError} on `decision: 'block'`, `continue: false`,
   * or handler error. Resolves to the last non-blocking decision (or an
   * empty decision if no handlers registered). For SubagentStop, callers
   * inspect the returned decision for `injectContext` and queue it to the
   * parent's input stream.
   *
   * `handlerTimeoutMs` — when set, each individual handler is raced against
   * a deadline. A handler that exceeds the deadline throws a timeout error
   * (observable via debugLog); the dispatch helper's catch path decides
   * whether to swallow or re-throw based on blocking semantics.
   */
  dispatch(
    context: HookContext,
    signal?: AbortSignal,
    handlerTimeoutMs?: number,
  ): Promise<HookDecision>;
  /** Number of handlers registered for an event (useful for tests/debugging). */
  count(event: HarnessHookEvent): number;
}

export function createHookRegistry(): HookRegistry {
  return createHookRegistryImpl();
}

/**
 * Resolve the hook registry a provider threads into its per-query dispatcher.
 * Precedence: the query-scoped session registry (`AgentConfig.hookRegistry`,
 * supplied per `provider.query({ config })` — the production path) wins over a
 * constructor-time registry (legacy / test convenience). `undefined` only when
 * neither is set.
 *
 * Single canonical merge point for every provider — do not re-implement the
 * precedence inline. `SessionToolDispatcherOptions.hookRegistry` is a required
 * key, so building a dispatcher without threading this result is a compile
 * error (the c6892c6 plan-mode write-gate regression, made structural).
 */
export function resolveSessionHookRegistry(
  queryScoped: HookRegistry | undefined,
  constructorScoped: HookRegistry | undefined,
): HookRegistry | undefined {
  return queryScoped ?? constructorScoped;
}
