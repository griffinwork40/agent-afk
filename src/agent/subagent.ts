/**
 * Lightweight subagent manager for forking child sessions.
 *
 * Subagents are implemented as regular `AgentSession` instances configured to
 * fork from a parent session's persisted conversation when available.
 *
 * Features:
 * - **Permission bubbling**: pass a `canUseTool` to the constructor and all
 *   spawned children forward their tool-permission requests up to that handler.
 * - **Transitive abort**: the manager owns an {@link AbortGraph}. Parent abort
 *   propagates to all children; child abort notifies the parent via
 *   {@link SubagentManager.onChildAborted}. A `parentAbortSignal` wires the
 *   manager's root to an external controller so aborting a parent session
 *   cascades through nested managers.
 * - **Output schemas**: sub-agents may be given a Zod schema; the final
 *   assistant message is parsed and returned as typed `output` on the result,
 *   with `schemaError` populated on mismatch.
 *
 * @module agent/subagent
 */

import type { CanUseTool } from './types/sdk-types.js';
import type { ZodType } from 'zod';
import { AbortGraph, type ChildAbortedListener } from './abort-graph.js';
import type { HookRegistry } from './hooks.js';
import { AgentSession } from './session.js';
import { DEFAULT_SESSION_TIMEOUT_MS } from './timeout.js';
import type { AgentConfig, IAgentSession } from './types.js';
import type { ElicitationRequest, ElicitationResult } from './types/sdk-types.js';
import type { SubagentProgressSink } from './types/session-types.js';
import { dispatchSubagentStart } from './subagent-hooks.js';
import { emitSubagentLifecycle } from './trace/emit.js';
import type { AbortOrigin, TraceWriter } from './trace/index.js';
import { appendRoutingDecision } from './routing-telemetry.js';
import { getCurrentSink } from './_lib/skill-sink-channel.js';
import { buildPhaseRestrictedProvider, type PhaseRole } from './tools/nesting.js';
import {
  SubagentHandleImpl,
  type SubagentHandle,
} from './subagent/handle.js';
import type { SubagentStatus, SubagentResult, SubagentTrace } from './subagent/result.js';

// Re-export types for public API
export type { SubagentStatus, SubagentResult, SubagentTrace, SubagentHandle };

// External constraint: backgrounded subagents have no surface to serve
// elicitations — auto-decline prevents silent hangs.
// Exported so it can be wired into forkSubagent's background-mode path by callers.
export const DENY_ELICITATION: NonNullable<AgentConfig['onElicitation']> = async (
  _request: ElicitationRequest,
  _options: { signal: AbortSignal },
): Promise<ElicitationResult> => ({ action: 'decline' });

export interface ForkParent {
  sessionId?: string;
  /**
   * Parent session id used to tag outgoing SubagentStart/SubagentStop
   * dispatches so consumers can correlate events. Optional — falls back
   * to `sessionId` when not set.
   */
  id?: string;
}

export interface ForkSubagentOptions<T = unknown> {
  /**
   * Parent session to fork from. If it has a `sessionId`, the child resumes + forks it.
   * Optional `getInputStreamRef` unlocks `SubagentStop` context injection; optional
   * `abortSignal` makes that injection respect parent abort (skip when aborted).
   * Optional `hookRegistry` is the production wiring path for subagent-lifecycle
   * hooks: when neither `config.hookRegistry` nor the manager's registry is set
   * (the common case — the registry is built after the manager), the parent's
   * registry is used to dispatch SubagentStart/SubagentStop and is threaded into
   * the child config. This is why the shadow-verify nudge reaches the parent.
   */
  parent: Pick<IAgentSession, 'sessionId'> &
    Partial<Pick<IAgentSession, 'getInputStreamRef' | 'abortSignal' | 'hookRegistry'>>;
  /** Child config. `resume`/`forkSession` are managed by this module. */
  config: AgentConfig;
  /** Optional prefix to help identify subagents in logs. */
  idPrefix?: string;
  /**
   * Optional Zod schema for validating structured output. When provided,
   * {@link SubagentHandle.runToResult} attempts to extract JSON from the final
   * assistant message and parse it through the schema.
   */
  outputSchema?: ZodType<T>;
  /**
   * Optional display label used by the CLI renderer to title the synthesized
   * `Agent(<label>)` tool-lane entry for this subagent. When omitted, the
   * renderer falls back to `idPrefix`. Use to give compose-spawned nodes
   * human-readable labels (e.g. `"diagnose [1/3]"`) without polluting
   * `idPrefix` — which is also threaded into routing telemetry.
   */
  agentType?: string;
  /**
   * Optional parent identifier for the renderer's nesting machinery. When
   * provided, overrides the default of `parent.sessionId`. Used by the
   * `compose` tool to pass its own `tool_use_id` so spawned subagents render
   * nested under the compose tool-lane entry rather than as top-level
   * siblings. Does not affect execution — purely a rendering hint.
   */
  parentId?: string;
  /**
   * When true, overrides `config.onElicitation` with `DENY_ELICITATION` so
   * background subagents never stall on an interactive permission prompt.
   * Propagates transitively: a bg parent's DENY_ELICITATION is inherited by
   * grandchildren via the `...options.config` spread in `childConfig` unless
   * overridden by a deeper `denyElicitations: true`.
   */
  denyElicitations?: boolean;

  /**
   * Enforce a per-phase permission boundary on the forked subagent.
   *
   * - `'read-only'`: construct a provider whose `permissions.allowedTools`
   *   is restricted to {@link READ_ONLY_PHASE_TOOLS} (read_file, glob, grep,
   *   list_directory, memory_search). The dispatcher rejects any other tool
   *   call with `'not in the configured allowlist'` — enforced at the
   *   provider's `SessionToolDispatcher.checkToolPermission` gate, not at
   *   the telemetry layer. Required posture for skill phases that must not
   *   mutate the repo before user approval (e.g. mint spec/research/plan).
   * - `'read-write'` (default when omitted): no enforcement; the child
   *   inherits the host's default permissive surface.
   *
   * Contract: mutually exclusive with `config.provider`. The manager
   * throws synchronously if both are supplied — a caller's explicit
   * provider would silently override the phase-restricted one, which
   * is the exact failure mode this option exists to prevent.
   *
   * See `src/agent/tools/nesting.ts buildPhaseRestrictedProvider` for
   * the construction and `src/agent/tool-category.ts READ_ONLY_PHASE_TOOLS`
   * for the canonical allowlist.
   */
  phaseRole?: PhaseRole;
}

export interface SubagentManagerOptions {
  /**
   * Parent permission handler forwarded to all spawned children.
   * When a child has no explicit `canUseTool` of its own, tool-permission
   * requests bubble up to this callback.
   */
  canUseTool?: CanUseTool;
  /**
   * External abort signal. When it fires, the manager aborts its root
   * (cascading to all subagents). Use to wire a parent session's
   * {@link IAgentSession.abortSignal} into nested managers.
   */
  parentAbortSignal?: AbortSignal;
  /**
   * Harness hook registry. When provided, `forkSubagent` dispatches
   * `SubagentStart` before creating the child session (block => throw);
   * `cancel()` dispatches `SubagentStop` before tearing the child down
   * (non-blocking). If the caller does not set `config.hookRegistry` on
   * the fork, this registry is threaded into the child's config so the
   * child session dispatches SessionStart/SessionEnd against the same
   * registry.
   */
  hookRegistry?: HookRegistry;
  /**
   * Optional sink for streaming subagent progress events. When set, all
   * forked subagents will forward their OutputEvent stream to this sink.
   * Falls back to the ambient sink from AsyncLocalStorage if not provided.
   */
  progressSink?: SubagentProgressSink;
  /**
   * API key (or OAuth token) inherited by all forked children whose
   * `config.apiKey` is missing or empty. Mirrors the hookRegistry /
   * permissionBubbler auto-fill pattern in {@link SubagentManager.forkSubagent}.
   */
  apiKey?: string;
  /**
   * Local-server base URL inherited by all forked children whose
   * `config.baseUrl` is missing. Ensures subagents spawned by the `agent`
   * tool hit the same local server as the parent rather than silently
   * falling back to api.anthropic.com.
   */
  baseUrl?: string;
  /**
   * Working directory inherited by all forked children whose `config.cwd`
   * is unset. Without this, subagents forked from a session running in an
   * `afk interactive -w` worktree fall back to the Node host's
   * `process.cwd()` and run their bash/grep tool calls in the main repo —
   * defeating worktree isolation across sibling sessions. Typically set
   * by callers that hold a parent {@link IAgentSession} to the parent's
   * `config.cwd`.
   */
  cwd?: string;
  /**
   * Witness-layer trace writer threaded into the manager's {@link AbortGraph}
   * so cascade aborts emit `abort` events. When omitted, AbortGraph runs
   * without trace emission — useful for tests and harnesses that don't need
   * the witness layer. Forked children inherit the writer via their
   * `config.traceWriter` (callers thread it through `forkSubagent` options).
   */
  traceWriter?: TraceWriter;
  /**
   * Optional callback invoked after each forked subagent reaches
   * `succeeded` status. Receives the subagent's token usage and optional
   * USD cost so a parent session can accumulate them into the
   * `session_sealed` rollup without a direct reference to `AgentSession`.
   *
   * Intended wiring: `AgentSession.recordSubagentCompletion` bound to the
   * session instance. The callback fires synchronously on the
   * `SubagentHandleImpl.run()` success path before `onTerminal()`.
   */
  onSubagentSucceeded?: (
    usage: import('./subagent/result.js').SubagentTrace['usage'],
    costUsd: number | undefined,
  ) => void;
}

export class SubagentManager {
  private readonly active = new Map<string, SubagentHandleImpl<unknown>>();
  private readonly parentCanUseTool: CanUseTool | undefined;
  private readonly hookRegistry: HookRegistry | undefined;
  private readonly progressSink: SubagentProgressSink | undefined;
  private readonly parentApiKey: string | undefined;
  private readonly parentBaseUrl: string | undefined;
  private readonly parentCwd: string | undefined;
  private readonly abortGraph: AbortGraph;
  private readonly rootId: string;
  private readonly rootController: AbortController;
  private counter = 0;
  private onSubagentSucceededCb:
    | ((usage: import('./subagent/result.js').SubagentTrace['usage'], costUsd: number | undefined) => void)
    | undefined;

  constructor(options: SubagentManagerOptions = {}) {
    this.parentCanUseTool = options.canUseTool;
    this.hookRegistry = options.hookRegistry;
    this.progressSink = options.progressSink;
    this.parentApiKey = options.apiKey;
    this.parentBaseUrl = options.baseUrl;
    this.parentCwd = options.cwd;
    this.onSubagentSucceededCb = options.onSubagentSucceeded;
    // Witness layer: AbortGraph receives the writer at construction so
    // cascades fire `abort` events without per-call plumbing.
    this.abortGraph = new AbortGraph(options.traceWriter);
    this.rootId = `manager-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.rootController = new AbortController();
    this.abortGraph.register(this.rootId, this.rootController);

    if (options.parentAbortSignal) {
      const parentSignal = options.parentAbortSignal;
      if (parentSignal.aborted) {
        this.rootController.abort(parentSignal.reason);
      } else {
        parentSignal.addEventListener(
          'abort',
          () => {
            if (!this.rootController.signal.aborted) {
              this.rootController.abort(parentSignal.reason);
            }
          },
          { once: true },
        );
      }
    }
  }

  list(): Array<Pick<SubagentHandle, 'id' | 'status'>> {
    return [...this.active.values()].map((h) => ({ id: h.id, status: h.status }));
  }

  get(id: string): SubagentHandle | undefined {
    return this.active.get(id);
  }

  /** Subscribe to aborts of any subagent under this manager. */
  onChildAborted(listener: ChildAbortedListener): () => void {
    return this.abortGraph.onChildAborted(this.rootId, listener);
  }

  /**
   * Wire a callback that fires after each subagent this manager forks
   * reaches `succeeded` status. Intended to be called once — immediately
   * after the parent {@link AgentSession} is constructed — so the session
   * can accumulate subagent token data into the `session_sealed` rollup.
   *
   * Late-binding is necessary because {@link SubagentManager} is typically
   * constructed before the session (e.g. in `bootstrap.ts`) to avoid a
   * circular reference. Calling this more than once replaces the prior
   * callback silently.
   */
  setOnSubagentSucceeded(
    cb: (usage: import('./subagent/result.js').SubagentTrace['usage'], costUsd: number | undefined) => void,
  ): void {
    this.onSubagentSucceededCb = cb;
  }

  /**
   * Abort the entire managed tree.
   *
   * @param reason   Forwarded to every cascade victim's AbortController. Read
   *                 by handlers via `signal.reason`. Stringified into the
   *                 `abort` trace event's `reason` field.
   * @param origin   Witness-layer classification of who initiated the abort.
   *                 Defaults to `'user_signal'`. Pass `'timeout'`, `'budget'`,
   *                 etc. when the caller has richer context than the reason
   *                 string conveys.
   */
  abortAll(reason?: unknown, origin: AbortOrigin = 'user_signal'): void {
    this.abortGraph.abort(this.rootId, reason, origin);
  }

  /**
   * Fork a new subagent session.
   *
   * If the parent session has a `sessionId`, the child is created with
   * `resume=<parentSessionId>` and `forkSession=true`, producing an independent
   * conversation that begins from the parent's persisted state.
   *
   * When a `hookRegistry` is resolvable — from `config.hookRegistry`, the
   * manager, OR the forking parent session (`options.parent.hookRegistry`) —
   * `SubagentStart` is dispatched *before* the child session is created. A
   * blocked hook throws `HookBlockedError` and no session / handle is created.
   */
  async forkSubagent<T = unknown>(options: ForkSubagentOptions<T>): Promise<SubagentHandle<T>> {
    // Contract: phaseRole and config.provider are mutually exclusive. The
    // manager owns provider construction when phaseRole is set; a caller
    // explicitly supplying their own provider would silently override the
    // phase-restricted one — the exact failure mode this option exists to
    // prevent. Throw synchronously BEFORE any side-effect (SubagentStart
    // hook, abort-graph registration, AgentSession ctor).
    if (
      options.phaseRole !== undefined &&
      options.phaseRole !== 'read-write' &&
      options.config.provider !== undefined
    ) {
      throw new Error(
        `SubagentManager.forkSubagent: phaseRole "${options.phaseRole}" is mutually ` +
          `exclusive with config.provider. Remove one — either let the manager ` +
          `construct the phase-restricted provider, or use config.provider with ` +
          `phaseRole: "read-write" (default).`,
      );
    }

    const id = `${options.idPrefix ?? 'subagent'}-${Date.now()}-${++this.counter}`;
    const resume = options.parent.sessionId;
    // Registry resolution (highest → lowest precedence):
    //   1. explicit per-fork override (config.hookRegistry)
    //   2. manager-level registry (this.hookRegistry)
    //   3. the forking parent session's registry (options.parent.hookRegistry)
    // Production almost always lands on (3): entry points build the registry
    // AFTER the manager/executors, so neither (1) nor (2) is set — but the
    // parent session exposes it at fork time. Without (3), SubagentStart/Stop
    // (incl. the shadow-verify nudge) would silently never fire.
    const registry =
      options.config.hookRegistry ?? this.hookRegistry ?? options.parent.hookRegistry;

    // SubagentStart fires BEFORE session creation so a block truly prevents
    // the child from existing. Abort precedence is honored via rootController.
    if (registry) {
      await dispatchSubagentStart(
        registry,
        {
          event: 'SubagentStart',
          subagentId: id,
          parentSessionId: options.parent.sessionId,
        },
        {
          signal: this.rootController.signal,
          ...(options.config.traceWriter ? { traceWriter: options.config.traceWriter } : {}),
        },
      );
    }

    const childController = new AbortController();
    // External constraint: AbortGraph nodes registered before child construction
    // must be released if construction fails — otherwise graph accumulates orphan
    // nodes across forge/farm runs that retry on misconfigured models.
    // The try/catch below disposes the node on any synchronous construction error.
    this.abortGraph.register(id, childController);
    this.abortGraph.linkChild(this.rootId, id);

    const childConfig: AgentConfig = {
      ...options.config,
      resume,
      forkSession: resume ? true : options.config.forkSession,
      abortSignal: childController.signal,
      apiKey: options.config.apiKey || this.parentApiKey,
      baseUrl: options.config.baseUrl ?? this.parentBaseUrl,
      // External constraint: a forked sub-agent has no human relationship of its
      // own — it returns findings (including Blocked/Asking) to its PARENT, which
      // owns the operator surface. Mark every fork non-interactive by default so
      // the provider strips `ask_question` from the child toolset; otherwise the
      // child could call it and reach the REPL/Telegram human via the
      // process-wide elicitation router, interleaved into the parent's turn with
      // no attribution. A caller may opt a fork back in with
      // `isNonInteractive: false`.
      isNonInteractive: options.config.isNonInteractive ?? true,
      // Awareness metadata: surface parent identity + phase role into the
      // child's config so the get_runtime_state tool's `self` view can report
      // the topology fields. Caller-supplied values on options.config win on
      // collision, matching the spread-then-override pattern used throughout
      // this block. `depth`/`maxDepth` are threaded by SubagentExecutor right
      // before this call — they live on the executor context, not on the
      // manager, so we leave them to the caller here.
      ...(options.config.parentSessionId === undefined && options.parent.sessionId !== undefined
        ? { parentSessionId: options.parent.sessionId }
        : {}),
      ...(options.config.phaseRole === undefined && options.phaseRole !== undefined
        ? { phaseRole: options.phaseRole }
        : {}),
      // Inherit the manager's cwd when the caller didn't override.
      // Required for `afk interactive -w` worktree isolation to extend
      // into forked subagents (otherwise child bash/grep falls back to
      // process.cwd() and operates on the wrong working tree).
      ...(options.config.cwd === undefined && this.parentCwd !== undefined
        ? { cwd: this.parentCwd }
        : {}),
      // Child session inherits the SAME resolved registry (see `registry`
      // above) so its own SessionStart/SessionEnd/PreToolUse fire against it.
      // Session-scoped hooks (memory writer, plan-mode gate) self-skip
      // subagents via the `parentSessionId` guard in their handlers.
      hookRegistry: registry,
      permissionBubbler:
        options.config.permissionBubbler ??
        (this.parentCanUseTool !== undefined && options.config.canUseTool === undefined
          ? { canUseTool: this.parentCanUseTool }
          : undefined),
      // External constraint: close the MCP elicitation path too. A
      // non-interactive sub-agent must not serve `onElicitation` to the
      // operator, so deny by default (install DENY_ELICITATION) unless a caller
      // explicitly opts back in with `denyElicitations: false` (no in-tree
      // caller does). This unifies the three elicitation channels — ask_question
      // (stripped via isNonInteractive above), path-approval (auto-denied via the
      // parentSessionId guard in path-approval-hook.ts), and MCP onElicitation
      // (here) — so every fork is uniformly non-interactive. When opted out, the
      // `...options.config` spread above still propagates any parent-configured
      // handler transitively.
      ...(options.denyElicitations === false ? {} : { onElicitation: DENY_ELICITATION }),
      // Phase role enforcement: when phaseRole === 'read-only', construct a
      // provider whose permissions.allowedTools is restricted to
      // READ_ONLY_PHASE_TOOLS. This is the ONLY wiring that reaches the
      // dispatcher's permission gate (checkToolPermission). Setting
      // childConfig.tools.allowedTools would be a no-op — that field is
      // telemetry-only (emitSubagentLifecycle at line ~407 below). The
      // mutual-exclusion check above ensures we don't clobber a caller's
      // explicit provider here.
      ...(options.phaseRole === 'read-only'
        ? { provider: buildPhaseRestrictedProvider('read-only', options.config.model) }
        : {}),
    };

    let session: AgentSession;
    try {
      session = new AgentSession(childConfig);
    } catch (err) {
      // Construction failed (e.g. invalid model, sync init failure).
      // Release the graph node that was registered above to prevent an orphan
      // accumulating on repeated retries (e.g. forge/farm retry loops).
      this.abortGraph.dispose(id);
      throw err;
    }
    const parentInputStreamRef = options.parent.getInputStreamRef?.();
    const parentAbortSignal = options.parent.abortSignal;
    // Resolve sink: explicit option takes precedence, then ambient from AsyncLocalStorage
    const sink = this.progressSink ?? getCurrentSink();
    // Normalize empty-string render hints to undefined so the `??` fallbacks
    // engage. A caller passing `agentType: ''` or `parentId: ''` would
    // otherwise produce an empty Agent() label / empty agentContext anchor
    // rather than the intended fallback (idPrefix / parent.sessionId).
    const effectiveAgentType = options.agentType?.trim() || undefined;
    const effectiveParentId = options.parentId?.trim() || undefined;
    const handle = new SubagentHandleImpl<T>(
      id,
      session,
      childController,
      this.abortGraph,
      options.outputSchema,
      options.config.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
      registry,
      () => {
        this.active.delete(id);
        this.abortGraph.dispose(id);
      },
      parentInputStreamRef,
      parentAbortSignal,
      // agentType: explicit override → idPrefix fallback. Lets callers
      // (e.g. compose) supply a render-only label without altering idPrefix
      // which is also used for routing telemetry.
      effectiveAgentType ?? options.idPrefix,
      sink,
      // parentId: explicit override → parent session id fallback. Lets
      // callers (e.g. compose) anchor the renderer's nesting at the compose
      // tool_use_id rather than at the orchestrator session id.
      effectiveParentId ?? options.parent.sessionId,
      // traceWriter: child shares the parent's writer so its SubagentStop
      // hook decision lands in the same trace file. Contract:
      // docs/philosophy/afk-contract.md — "a child sub-agent inherits its
      // parent's witness." Inheritance is config-driven via childConfig.
      options.config.traceWriter,
      // onSubagentSucceeded: propagate completion data to the parent
      // session's session_sealed rollup accumulators.
      this.onSubagentSucceededCb,
    );
    this.active.set(id, handle as SubagentHandleImpl<unknown>);

    // Witness layer: subagent_lifecycle.started fires AFTER the handle is
    // wired into the manager's active map and the abort-graph. Emitting
    // earlier (e.g. before linkChild) would create a window where the
    // trace shows a started subagent that the manager doesn't know about.
    //
    // parentId fallback: the child's `options.parent.sessionId` is the
    // honest answer when present; for a top-level fork from a session
    // that hasn't initialized yet, we fall back to the manager's rootId
    // so the schema's `parentId: string` requirement stays satisfied.
    const modelString = typeof options.config.model === 'string'
      ? options.config.model
      : JSON.stringify(options.config.model);
    void emitSubagentLifecycle(options.config.traceWriter, {
      transition: 'started',
      subagentId: id,
      parentId: options.parent.sessionId ?? this.rootId,
      model: modelString,
      ...(childConfig.tools?.allowedTools
        ? { allowedTools: [...childConfig.tools.allowedTools] }
        : {}),
    });

    await appendRoutingDecision({
      event: 'subagent.dispatched',
      subagent_id: id,
      id_prefix: options.idPrefix,
      model: modelString,
      parent_session_id: options.parent.sessionId,
    });

    return handle;
  }

  /** Cancel and remove a tracked subagent. Returns false if not found. */
  async kill(id: string): Promise<boolean> {
    const handle = this.active.get(id);
    if (!handle) return false;
    await handle.cancel();
    return true;
  }

  /** Cancel all running subagents. */
  async killAll(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((h) => h.cancel()));
  }

  /**
   * Tear down every still-active subagent (release sessions + fire
   * SubagentStop) without flagging them as aborted. Handles that already
   * completed a run have self-removed from the active map via `onTerminal`,
   * so those must be torn down per-handle by the caller — this method covers
   * forks that were never run or were still running at cleanup time.
   *
   * Companion to {@link killAll}: `killAll` treats the fleet as being
   * interrupted; `teardownAll` treats it as having finished.
   */
  async teardownAll(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((h) => h.teardown()));
  }
}
