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
 * **Context injection (SubagentStop, UserPromptSubmit, Stop, and SessionStart):** Foreground
 * subagents hand their final assistant output to the parent through the normal
 * `agent` tool result; `injectContext` is a separate hook-generated framework
 * note, not text typed by the human user. When a `SubagentStop` handler returns
 * `injectContext`, the dispatch result is propagated to the caller, which queues
 * the context string to the parent session's input stream for the parent's next
 * turn. If the parent is aborting, the injection is skipped. DAG/compose and
 * background paths are not guaranteed to inject (some intentionally leave this
 * channel dark). When multiple non-blocking handlers each return `injectContext`,
 * all non-empty values are concatenated in registration order, joined by `'\n'`,
 * and returned as a single string — so no injection is silently dropped. A
 * blocking handler still short-circuits before any accumulation occurs.
 *
 * For `UserPromptSubmit`, `injectContext` works differently: the returned string
 * is prepended to the user's prompt text before `runTurn` is called — allowing
 * hook handlers to inject per-turn system notes or policy context inline with
 * the human's message. The injection is performed by the REPL loop immediately
 * after dispatch.
 *
 * For `Stop` (main-session post-turn), `injectContext` is stashed by the REPL
 * loop and prepended to the NEXT turn's prompt text — the same next-turn
 * delivery contract as `UserPromptSubmit`, but fired from the turn-completion
 * boundary rather than the submission boundary. This is the "bounce the turn
 * back" primitive: a post-turn policy handler (e.g. the terminal-state gate)
 * can read the parsed verdict on {@link StopContext} and inject a correction
 * the next turn must address.
 *
 * For `SessionStart`, `injectContext` is delivered during session init:
 * `dispatchSessionStart` returns the merged string to `AgentSession`, which
 * queues it via `queueFrameworkContext` so it prepends to the session's FIRST
 * outbound user message. SessionStart fires before any turn exists, so there is
 * no in-flight prompt to prepend to — the queue (drained behind `initPromise`
 * in `sendMessageStreamInternal`) bridges init to the first send. Delivery is
 * scoped to the top-level (parent) session: subagent forks run the same init
 * path with the bubbled registry, so `AgentSession` skips the queue when
 * `parentSessionId` is set rather than prepending priming context to every
 * subagent's first prompt. The remaining hook events ignore `injectContext`
 * entirely.
 *
 * @module agent/hooks
 */

import { createHookRegistryImpl } from './hook-registry.js';
import type { SubagentTrace } from './subagent/result.js';
import type { GrantManager } from '../cli/slash/commands/allow-dir.js';

export type HarnessHookEvent =
  | 'SessionStart'
  | 'SessionEnd'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PreCompact'
  | 'PostToolUseFailure'
  | 'Stop'
  | 'UserPromptSubmit';

export interface HookDecision {
  /** False halts session lifecycle; undefined/true continues. */
  continue?: boolean;
  /** 'block' rejects the operation; 'approve' is explicit acceptance (same semantic as unset). */
  decision?: 'block' | 'approve';
  /** Human-readable rationale for blocking or approving. */
  reason?: string;
  /**
   * (SessionStart, SubagentStop, UserPromptSubmit, and Stop) Framework-generated context to inject.
   *
   * For **SubagentStop**: queued to the parent session's input stream after
   * dispatch completes; dropped if the parent is aborting. DAG/compose and
   * background paths may intentionally not inject. When multiple non-blocking
   * handlers each return `injectContext`, all non-empty values are concatenated
   * in registration order (joined by `'\n'`) and returned as a single string —
   * no injection is silently dropped. A blocking handler short-circuits before
   * any accumulation.
   *
   * For **UserPromptSubmit**: prepended to the user's prompt text before
   * `runTurn` is called. Allows per-turn system notes or policy context to be
   * injected inline with the human's message. Same concatenation merge policy
   * applies when multiple handlers return `injectContext`.
   *
   * For **Stop**: stashed by the REPL loop and prepended to the NEXT turn's
   * prompt text (same next-turn delivery as UserPromptSubmit, fired from the
   * post-turn boundary). Lets a post-turn policy handler bounce a correction
   * into the next turn. Same concatenation merge policy across handlers.
   *
   * For **SessionStart**: returned by `dispatchSessionStart` during init and
   * queued via `queueFrameworkContext` so it prepends to the session's FIRST
   * outbound user message (SessionStart fires before any turn exists).
   * Delivered to the top-level (parent) session ONLY — subagent forks skip it
   * (see `AgentSession.pullInitialization`). Same concatenation merge policy
   * across handlers.
   *
   * Ignored for all other hook events.
   */
  injectContext?: string;
}

/** Status vocabulary mirrored from {@link SubagentStatus} without a runtime import. */
export type SubagentHookStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface SessionStartContext {
  event: 'SessionStart';
  sessionId?: string;
  /**
   * Parent session id when this SessionStart belongs to a forked subagent
   * (set from {@link AgentConfig.parentSessionId}). Top-level sessions leave
   * this undefined. `AgentSession` delivers SessionStart `injectContext` to the
   * parent's first turn ONLY — gated on this being undefined — never to
   * subagent forks; programmatic handlers can also read it to self-skip
   * subagent starts, mirroring the {@link SessionEndContext} convention.
   */
  parentSessionId?: string;
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
  /**
   * Effective cwd for this specific tool call, when known. Dispatchers set this
   * from their current resolve base so shared hook registries can classify
   * forked subagent calls against the child's worktree rather than the parent
   * session's construction-time cwd.
   */
  cwd?: string;
  toolName: string;
  input?: unknown;
  /**
   * Live grant manager of the session EXECUTING this call — the provider that
   * built the dispatcher dispatching this hook. Injected per-call by
   * {@link SessionToolDispatcher} so path-scoped hooks (path-approval,
   * bash-restriction) resolve the ACTUAL session's grants: a forked child's own
   * cwd/readRoots/writeRoots rather than a process-global ref pinned to the
   * top-level session (the #435/#514 write-confinement gap). When absent
   * (non-dispatcher-originated dispatch, unit tests), those hooks fall back to
   * their `opts.getGrantManager()` ref, preserving prior behavior.
   */
  grantManager?: GrantManager;
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
  /**
   * Live grant manager of the executing session — see
   * {@link PreToolUseContext.grantManager}. Injected so the "Once"-grant revoke
   * in the path-approval PostToolUse hook mutates the SAME grant manager the
   * PreToolUse containment check consulted.
   */
  grantManager?: GrantManager;
}

export interface PreCompactContext {
  event: 'PreCompact';
  sessionId?: string;
  /**
   * 'manual' = /compact command or Telegram /compact. Only 'manual' is emitted today.
   * 'auto' (threshold-based) is reserved for future wiring -- see TODO in query.ts.
   */
  trigger?: 'manual' | 'auto';
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

export interface StopContext {
  event: 'Stop';
  /** Session id from the REPL session that completed the turn. */
  sessionId?: string;
  /**
   * Parent session id when this Stop fires inside a forked subagent.
   * Top-level sessions leave this undefined.
   */
  parentSessionId?: string;
  /**
   * The parsed terminal-state kind of the turn that just completed, when the
   * surface parses one (REPL only — see `terminal-state.ts`). Absent when the
   * turn emitted no recognizable verdict, or on surfaces that do not parse
   * terminal states. Inlines the cli-layer `TerminalKind` union rather than
   * importing it, keeping the agent layer free of a cli runtime dependency.
   */
  terminalState?: 'done' | 'blocked' | 'asking' | 'interrupted';
  /**
   * True when the completed turn produced at least one successful corroborating
   * tool call — a file write/edit or an executed command (see
   * `doneHasCorroboratingEvidence` in `afk-push.ts`). Only meaningful when
   * `terminalState === 'done'`. Absent on surfaces that do not compute it.
   */
  doneHasCorroboratingEvidence?: boolean;
}

export interface UserPromptSubmitContext {
  event: 'UserPromptSubmit';
  /**
   * The full text of the user's prompt at the moment it is submitted to the
   * REPL loop, after shell injection and forward-manifest stitching but before
   * `runTurn`. Handlers may inspect it for policy enforcement; the
   * `injectContext` return value prepends additional context to this text.
   */
  prompt: string;
  /**
   * Session identifier, propagated from {@link SessionStats.sessionId}.
   * Optional because early turns may not yet have one.
   */
  sessionId?: string;
}

/** Discriminated union — narrow via `switch (context.event)`. */
export type HookContext =
  | SessionStartContext
  | SessionEndContext
  | SubagentStartContext
  | SubagentStopContext
  | PreToolUseContext
  | PostToolUseContext
  | PreCompactContext
  | PostToolUseFailureContext
  | StopContext
  | UserPromptSubmitContext;

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
