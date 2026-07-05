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
import type { Surface } from './awareness/types.js';
import { appendRoutingDecision } from './routing-telemetry.js';
import { getCurrentSink } from './_lib/skill-sink-channel.js';
import { touchWorktreeOccupancy } from './worktree-occupancy.js';
import { resolveWorktreeMainRoot } from './worktree-read-root.js';
import { buildPhaseRestrictedProvider, type PhaseRole } from './tools/nesting.js';
import { applyManagerApiKeyFallback } from './tools/child-credential.js';
import { providerForModel, type BundledProviderName } from './providers/index.js';
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

/**
 * Default tool-use-iteration ceiling applied to every forked subagent.
 *
 * A subagent runs exactly one conversation turn (one `sendMessageStream`), so
 * this bounds the tool-use loop WITHIN that turn. anthropic-direct otherwise
 * defaults to `0` (unbounded — see DEFAULT_MAX_TOOL_USE_ITERATIONS), which lets
 * a runaway child spin indefinitely while its parent is suspended at
 * `await runToResult`. `50` matches openai-compatible's built-in cap so both
 * providers bound child loops identically. Hitting the cap surfaces as a
 * `tool_use_loop_capped` done (not an error), returning the child's partial
 * work. Callers may override per-fork via `config.maxToolUseIterations` (e.g.
 * `0` to opt a trusted deep-investigation child back into unbounded mode).
 */
export const SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS = 50;

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
   * Required display label used by the CLI renderer to title the synthesized
   * `Agent(<label>)` tool-lane entry for this subagent. Use to give
   * compose-spawned nodes human-readable labels (e.g. `"diagnose [1/3]"`)
   * without polluting `idPrefix` — which is also threaded into routing
   * telemetry.
   *
   * Invariant: every `forkSubagent` callsite must supply an explicit label.
   * The type is `required` (not optional) so future omissions are caught at
   * compile time rather than silently falling back to the raw `idPrefix` at
   * render time. Callers that have no better label than `idPrefix` should
   * pass `agentType: idPrefix` explicitly to document that choice.
   *
   * Runtime: empty strings are normalized to `undefined` before use, so
   * `forkSubagent` still falls back to `idPrefix` if the caller passes `''`.
   * See `SubagentManager.forkSubagent` (this file, `effectiveAgentType`).
   */
  agentType: string;
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
   * The model the parent session runs — i.e. the model {@link apiKey} was
   * resolved for. The manager derives the parent's *provider* from it (via
   * `providerForModel`) exactly once, and uses that to gate the fork-time
   * credential fallback: a parent credential is inherited only by a
   * same-provider child, so an Anthropic key never reaches an OpenAI child and
   * an OpenAI key never reaches an Anthropic child. When omitted, the fallback
   * degrades to key-shape inference (forward guard only) — pass this wherever
   * `apiKey` is provided to get both-direction protection. See
   * `applyManagerApiKeyFallback` in ./tools/child-credential.ts.
   */
  parentModel?: string;
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
   * Witness-layer trace writer. Threaded into the manager's {@link AbortGraph}
   * so cascade aborts emit `abort` events, AND auto-inherited by every forked
   * child whose `config.traceWriter` is unset — so all worker sessions write
   * into the same trace file without per-call plumbing. When omitted, AbortGraph
   * runs without trace emission and child sessions emit no traces (useful for
   * tests and harnesses that don't need the witness layer).
   */
  traceWriter?: TraceWriter;
  /**
   * Execution surface inherited by all forked children whose `config.surface`
   * is unset. Governs the `origin` field (`cli` / `telegram` / `daemon`) in
   * every child session's trace events. Set by each top-level entrypoint (farm
   * → `'cli'`, daemon → `'daemon'`, telegram → `'telegram'`) so worker sessions
   * report the correct origin without per-call plumbing.
   */
  surface?: Surface;
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
  // Derived once from options.parentModel (constructor). Source of truth for
  // the both-direction cross-provider credential gate in forkSubagent —
  // avoids guessing the parent's provider from the key's shape at fork time.
  private readonly parentProvider: BundledProviderName | undefined;
  // Mutable so AgentSession.setCwd can re-anchor forks after a born-named
  // `afk -w` worktree is created mid-session. Read at fork time (forkSubagent),
  // so updating it makes every subsequent fork inherit the new worktree cwd.
  private parentCwd: string | undefined;
  // Per-cwd cache of the resolved main-repo root for worktree children (see
  // `resolveWorktreeMainRoot`). Forks overwhelmingly share one cwd, so this
  // collapses N git subprocesses to one per distinct cwd for the whole
  // manager lifetime. `undefined` value = resolved-and-there-is-none, so the
  // Map's `.has()` distinguishes "not yet resolved" from "resolved to none".
  private readonly worktreeMainRootCache = new Map<string, string | undefined>();
  private readonly parentTraceWriter: TraceWriter | undefined;
  private readonly parentSurface: Surface | undefined;
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
    this.parentProvider =
      options.parentModel !== undefined ? providerForModel(options.parentModel) : undefined;
    this.parentCwd = options.cwd;
    this.parentTraceWriter = options.traceWriter;
    this.parentSurface = options.surface;
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
   * Re-anchor the cwd inherited by future forks. Called (transitively, via the
   * provider's `setCwd`) when the session's working directory changes — most
   * importantly when a born-named `afk -w` worktree is created on turn 1, after
   * this manager was constructed in the launch dir. Existing in-flight children
   * are unaffected; only forks dispatched after this call inherit `cwd`.
   */
  setCwd(cwd: string): void {
    this.parentCwd = cwd;
  }

  /**
   * Resolve (and memoize) the main-repo root for a worktree `cwd`. Returns the
   * main repository root when `cwd` is inside a linked git worktree distinct
   * from the main worktree, else undefined. Best-effort — never throws.
   *
   * Cached per cwd so a fan-out of subagents sharing one worktree pays a single
   * `git rev-parse`, not one per fork.
   */
  private async resolveMainRootForCwd(cwd: string): Promise<string | undefined> {
    if (this.worktreeMainRootCache.has(cwd)) {
      return this.worktreeMainRootCache.get(cwd);
    }
    const mainRoot = await resolveWorktreeMainRoot(cwd);
    this.worktreeMainRootCache.set(cwd, mainRoot);
    return mainRoot;
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

    // Worktree read-root grant: when the child runs in a linked git worktree
    // and the caller did not pin its own read roots, add the MAIN repo root as
    // a READ root (never a write root — writes stay confined to the worktree).
    // Without this, a subagent is confined to `[cwd]` and cannot read main-repo
    // absolute paths that pervade its context (system prompt, skill prompts,
    // parent messages), yet it cannot approve them interactively either — the
    // path-approval hook auto-denies forked children. See ./worktree-read-root.
    // A caller that pins `readRoots` (e.g. `afk farm`, which deliberately
    // confines each branch worker) is left untouched.
    const effectiveChildCwd = options.config.cwd ?? this.parentCwd;
    let worktreeReadRoots: string[] | undefined;
    if (options.config.readRoots === undefined && effectiveChildCwd !== undefined) {
      const mainRoot = await this.resolveMainRootForCwd(effectiveChildCwd);
      if (mainRoot !== undefined && mainRoot !== effectiveChildCwd) {
        worktreeReadRoots = [effectiveChildCwd, mainRoot];
      }
    }

    const childConfig: AgentConfig = {
      ...options.config,
      resume,
      forkSession: resume ? true : options.config.forkSession,
      abortSignal: childController.signal,
      // Invariant (cross-provider credential anti-leak): the parent-credential
      // fallback below must never hand a credential across the provider
      // boundary — an Anthropic `sk-ant-…` key to an OpenAI child, nor an
      // OpenAI key to an Anthropic child. Upstream executors
      // (subagent-executor.ts, skill-executor.ts, compose-executor.ts)
      // deliberately clear `apiKey` / `baseUrl` for cross-provider children; a
      // provider-blind `|| this.parentApiKey` here silently undid that (both
      // auth resolvers treat an explicit config key as Tier-1 — see
      // openai-compatible/auth.ts — so the wrong token went out as a Bearer to
      // a foreign endpoint). `applyManagerApiKeyFallback` gates on
      // `this.parentProvider` (derived once from parentModel): explicit caller
      // keys and same-provider inheritance are preserved; only cross-provider
      // combinations resolve to undefined.
      apiKey: applyManagerApiKeyFallback({
        childModel: options.config.model,
        configApiKey: options.config.apiKey,
        parentApiKey: this.parentApiKey,
        parentProvider: this.parentProvider,
      }),
      // Same guard for the Anthropic-semantic `baseUrl`: an OpenAI-routed
      // child resolves its endpoint from `openaiBaseUrl` / env, never from the
      // parent's Anthropic base URL. Explicit caller values still win.
      baseUrl:
        options.config.baseUrl ??
        (providerForModel(options.config.model) === 'openai-compatible'
          ? undefined
          : this.parentBaseUrl),
      // External constraint: a forked sub-agent has no human relationship of its
      // own — it returns findings (including Blocked/Asking) to its PARENT, which
      // owns the operator surface. Mark every fork non-interactive by default so
      // the provider strips `ask_question` from the child toolset; otherwise the
      // child could call it and reach the REPL/Telegram human via the
      // process-wide elicitation router, interleaved into the parent's turn with
      // no attribution. A caller may opt a fork back in with
      // `isNonInteractive: false`.
      isNonInteractive: options.config.isNonInteractive ?? true,
      // External constraint (anti-hang): a forked child's tool-use loop is
      // otherwise unbounded on anthropic-direct (DEFAULT_MAX_TOOL_USE_ITERATIONS
      // = 0 = no cap), so a runaway child could spin forever while the parent is
      // suspended at `await runToResult`. Give every fork a positive default
      // ceiling (parity with openai-compatible's built-in 50-round cap); the
      // caller's explicit `options.config.maxToolUseIterations` (already carried
      // by the `...options.config` spread above) wins when set, including `0` to
      // opt back into unbounded. Hitting the cap surfaces as a
      // `tool_use_loop_capped` done, returning the child's partial work.
      maxToolUseIterations:
        options.config.maxToolUseIterations ?? SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS,
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
      // Worktree read-root grant (see the computation above the literal). Only
      // set when the child runs in a linked worktree AND the caller left
      // readRoots unset; otherwise the `...options.config` spread's readRoots
      // (or the provider's `[cwd]` default) stands.
      ...(worktreeReadRoots !== undefined ? { readRoots: worktreeReadRoots } : {}),
      // Invariant: a forked child's trace origin comes from its inherited
      // parent surface, not from any actor-role value (see session-identity.ts).
      // Inherit traceWriter + surface from the manager so every worker session
      // (e.g. farm branch workers) writes into the same trace file and reports
      // the correct origin ('cli'/'daemon'/'telegram') without per-call plumbing.
      // Guard: explicit values on options.config win (the ...options.config
      // spread at line 392 already set them); these only fill the gap when
      // the per-fork config omits them — matching the cwd inheritance pattern.
      ...(options.config.traceWriter === undefined && this.parentTraceWriter !== undefined
        ? { traceWriter: this.parentTraceWriter }
        : {}),
      ...(options.config.surface === undefined && this.parentSurface !== undefined
        ? { surface: this.parentSurface }
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

    // Occupancy touch: subagents never write presence files (top-level-only
    // by design — presence.ts), so the worktree sweep's live-session guard
    // cannot see a fork occupying a worktree. Refresh the worktree's meta
    // (pid + createdAt) instead, resetting the sweep's age clock and PID
    // liveness. Fire-and-forget: the helper swallows all errors and no-ops
    // for cwds outside `.afk-worktrees/`, so it can never delay or fail the
    // fork. Single wiring point — agent/skill/compose/farm dispatches all
    // converge here, whether cwd came per-call or via manager inheritance.
    if (childConfig.cwd !== undefined) {
      void touchWorktreeOccupancy(childConfig.cwd);
    }

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
