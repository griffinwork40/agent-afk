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
import { AbortGraph, type ChildAbortedListener } from './abort-graph.js';
import type { HookRegistry } from './hooks.js';
import { AgentSession } from './session.js';

import type { AgentConfig } from './types.js';
import type { SubagentProgressSink } from './types/session-types.js';
import { dispatchSubagentStart } from './subagent-hooks.js';
import { emitSubagentLifecycle } from './trace/emit.js';
import type { AbortOrigin, TraceWriter } from './trace/index.js';
import type { Surface } from './awareness/types.js';
import { appendRoutingDecision } from './routing-telemetry.js';
import { getCurrentSink } from './_lib/skill-sink-channel.js';
import { touchWorktreeOccupancy, startWorktreeOccupancyHeartbeat } from './worktree-occupancy.js';
import { resolveWorktreeMainRoot } from './worktree-read-root.js';
import { computeInheritedReadRoots, type ReadScopeInputs } from './subagent-read-scope.js';
import { getAfkStateDir, getAgentFrameworkDir } from '../paths.js';
import path from 'path';
import { buildPhaseRestrictedProvider } from './tools/nesting.js';
import { MODEL_CAP_BYTES } from './tools/handlers/_output-cap.js';
import { applyManagerApiKeyFallback } from './tools/child-credential.js';
import { providerForModel, type BundledProviderName } from './providers/index.js';
import {
  SubagentHandleImpl,
  type SubagentHandle,
} from './subagent/handle.js';
import { coerceCrossProviderChildModel } from './subagent/child-model-fallback.js';
import type { SubagentStatus, SubagentResult, SubagentTrace } from './subagent/result.js';

// Re-export types for public API
export type { SubagentStatus, SubagentResult, SubagentTrace, SubagentHandle };

// Contract: the default budgets and the fork-time option types moved to
// ./subagent/{constants,fork-types}.ts (#829). They are imported for internal
// use by SubagentManager below AND re-exported here unchanged, so every
// existing `from './subagent.js'` importer keeps working untouched.
import {
  DENY_ELICITATION,
  SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS,
  SUBAGENT_DEFAULT_TIMEOUT_MS,
  SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS,
  SUBAGENT_BACKGROUND_TIMEOUT_MS,
  resolveSubagentTimeoutMs,
  resolveSubagentIdleTimeoutMs,
} from './subagent/constants.js';
import { injectToolBudgetPreamble } from './subagent/budget-preamble.js';
import { resolveSoftDeadlineMs } from './providers/shared/soft-deadline.js';
import type {
  ForkParent,
  ForkSubagentOptions,
  SubagentManagerOptions,
} from './subagent/fork-types.js';

export {
  DENY_ELICITATION,
  SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS,
  SUBAGENT_DEFAULT_TIMEOUT_MS,
  SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS,
  SUBAGENT_BACKGROUND_TIMEOUT_MS,
  resolveSubagentTimeoutMs,
  resolveSubagentIdleTimeoutMs,
};
export type { ForkParent, ForkSubagentOptions, SubagentManagerOptions };


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
  // Parent session model string, retained for the #652 cross-provider child
  // model coercion in forkSubagent: coerceCrossProviderChildModel needs the
  // concrete parent model as the OpenAI/gpt substitute target, not just the
  // derived parentProvider above.
  private readonly parentModel: string | undefined;
  // Mutable so AgentSession.setCwd can re-anchor forks after a born-named
  // `afk -w` worktree is created mid-session. Read at fork time (forkSubagent),
  // so updating it makes every subsequent fork inherit the new worktree cwd.
  private parentCwd: string | undefined;
  // The parent session's effective read roots, for read-scope inheritance
  // (see ./subagent-read-scope). `undefined` = derive from parentCwd
  // (defined → confined base; undefined → unconfined parent → read-open child).
  private readonly parentReadRoots: string[] | undefined;
  // Per-cwd cache of the resolved main-repo root for worktree children (see
  // `resolveWorktreeMainRoot`). Forks overwhelmingly share one cwd, so this
  // collapses N git subprocesses to one per distinct cwd for the whole
  // manager lifetime. `undefined` value = resolved-and-there-is-none, so the
  // Map's `.has()` distinguishes "not yet resolved" from "resolved to none".
  private readonly worktreeMainRootCache = new Map<string, string | undefined>();
  // Not readonly: a REPL `/resume` swaps the session out from under this
  // long-lived manager and hands it a fresh writer via `setTraceWriter`,
  // because the outgoing session sealed the one captured here (#731).
  private parentTraceWriter: TraceWriter | undefined;
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
    this.parentModel = options.parentModel;
    this.parentCwd = options.cwd;
    this.parentReadRoots = options.parentReadRoots;
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
    // Invalidate any memoized main-root for this exact path. A worktree can be
    // deleted and recreated at the SAME path mid-session (sweep + re-create),
    // which would otherwise hand every subsequent fork a stale mainRoot from
    // the cache (#441). setCwd is rare (born-named worktree creation on turn 1),
    // so forcing one re-resolution on the next fork costs nothing.
    this.worktreeMainRootCache.delete(cwd);
  }

  /**
   * Re-point the writer inherited by future forks.
   *
   * Contract: mirrors {@link SubagentManager.setCwd} — existing in-flight
   * children keep the writer they were forked with; only forks dispatched
   * after this call inherit `writer`. Called (via the bootstrap cascade) on a
   * REPL `/resume`, where the outgoing session seals the writer this manager
   * captured at construction; without the re-point, every post-resume fork
   * would emit its lifecycle events into a sealed writer and be silently
   * dropped (#731).
   */
  setTraceWriter(writer: TraceWriter | undefined): void {
    this.parentTraceWriter = writer;
  }

  /**
   * The read-scope inputs this manager applies to its forks — the parent's
   * `readRoots` (may be undefined = derive from cwd) and `cwd`. Used to
   * propagate read scope transitively: a forked child that builds its OWN
   * manager for grandchildren computes its inherited read roots from these
   * inputs (via {@link computeInheritedReadRoots}) and passes the result as the
   * grandchild manager's `parentReadRoots`, so a read-open (or `/allow-dir`-
   * widened) scope is not silently re-narrowed one nesting level down.
   */
  getReadScopeInputs(): ReadScopeInputs {
    return { parentReadRoots: this.parentReadRoots, parentCwd: this.parentCwd };
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

    // Witness-writer resolution: explicit per-fork config wins, then the
    // manager-level writer (constructed at the surface bootstrap). This is
    // the SINGLE resolved value used by every witness touchpoint in this
    // fork path — SubagentStart dispatch, the child handle, and the
    // subagent_lifecycle 'started' emit below. Before this, those three
    // read `options.config.traceWriter` directly, so a fork relying on
    // manager-level inheritance (the `agent`-tool path — its executors
    // never set config.traceWriter) produced a child whose entire lifetime
    // was invisible in `afk trace show` even though childConfig inherited
    // the writer for the session's own events.
    const effectiveTraceWriter = options.config.traceWriter ?? this.parentTraceWriter;

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
          ...(effectiveTraceWriter ? { traceWriter: effectiveTraceWriter } : {}),
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

    // Read-scope inheritance (#416/#441 successor — see ./subagent-read-scope).
    // Invariant: a forked read-only sub-agent must be able to READ everything
    // its parent could; writes stay confined (writeRoots, below). When the
    // caller did NOT pin `readRoots` — a caller that pins (e.g. `afk farm`,
    // which deliberately confines each branch worker) is left untouched — derive
    // the child's read roots from the parent's scope:
    //   - UNCONFINED parent (top-level `afk`/`afk i` with no worktree →
    //     resolveBase undefined → reads anywhere) → read-open child.
    //   - CONFINED parent → union(child cwd, parent roots, worktree main root);
    //     the main root lexically covers sibling `.afk-worktrees/*`.
    // This replaces the prior single main-root grant that vanished silently on
    // any `git rev-parse` failure, re-confining the child to `[cwd]` (#441) and
    // hard-blocking every out-of-cwd read until a wall-clock timeout.
    const effectiveChildCwd = options.config.cwd ?? this.parentCwd;
    let inheritedReadRoots: string[] | undefined;
    if (options.config.readRoots === undefined) {
      // An UNCONFINED parent yields a read-open child regardless of the worktree
      // main root, so skip the (cached) git resolution in that case — the common
      // top-level `afk` fan-out never pays for it. For a CONFINED parent the main
      // root is best-effort; on git failure we ALSO try the parent cwd (Gap B
      // below) so a confined *worktree* parent's fork still reaches the main
      // checkout + siblings, and the child is additionally granted the AFK state
      // dir (Gap A below) so ~/.afk/state reads are not hard-denied.
      const parentUnconfined =
        this.parentReadRoots === undefined && this.parentCwd === undefined;
      let worktreeMainRoot: string | undefined;
      if (!parentUnconfined && effectiveChildCwd !== undefined) {
        worktreeMainRoot = await this.resolveMainRootForCwd(effectiveChildCwd);
        // Gap B: when the child cwd yields no distinct main root (git failure, or
        // the child cwd is not itself a linked worktree), fall back to the PARENT
        // cwd. A confined parent is frequently ITSELF a linked worktree (`afk -w`);
        // resolving from it recovers the repo root, which lexically covers the main
        // checkout AND every sibling `.afk-worktrees/*` the fork would otherwise be
        // hard-denied. Best-effort + cached; strictly additive (only ever adds a
        // read root when one is found).
        if (
          worktreeMainRoot === undefined &&
          this.parentCwd !== undefined &&
          this.parentCwd !== effectiveChildCwd
        ) {
          worktreeMainRoot = await this.resolveMainRootForCwd(this.parentCwd);
        }
      }
      inheritedReadRoots = computeInheritedReadRoots({
        parentReadRoots: this.parentReadRoots,
        parentCwd: this.parentCwd,
        childCwd: effectiveChildCwd,
        worktreeMainRoot,
        // Gap A: a CONFINED fork's cwd+repo roots do not lexically contain
        // ~/.afk/state, so skill-preflight inputs, todos, transcripts, and
        // session ledgers were hard-denied (forks cannot prompt). Grant the STATE
        // dir only — NEVER ~/.afk/config (credentials). Unconfined forks are
        // already read-open, so this is a confined-parent-only grant.
        ...(parentUnconfined ? {} : { afkStateRoot: getAfkStateDir() }),
        // Gap C (the agent-framework read grant — distinct from Gap A/Gap B
        // above): ~/.afk/agent-framework is a SIBLING of ~/.afk/state under the
        // same AFK home, and a confined fork's cwd+repo roots do not lexically
        // contain it either. It holds the framework's own artifacts (improve
        // cards/proposals/eval-cases, forge telemetry, pattern-cards, briefs),
        // so children dispatched by /orient, /harvest, /forge, /distill and the
        // improve pipeline were hard-denied the one tree their task requires —
        // 46 denials across 15 sessions (card subagent-read-denial-ab89c2bd6a6f,
        // now HISTORICAL: that slug is a hash of the denial reason string, which
        // was reworded when the read remedy moved to
        // `tools/hooks/fork-denial-remedy.ts`. Post-rewording denials accumulate
        // under a new slug; this card no longer accrues sightings).
        // Same guard as Gap A: this dir only, NEVER ~/.afk/config (credentials).
        ...(parentUnconfined
          ? {}
          : { afkFrameworkRoot: getAgentFrameworkDir() }),
      });
    }

    // #662: additive read roots from the `readRoots` agent-tool param. Compose with
    // the inherited scope so the child keeps its repo/worktree/state reach AND gains
    // the named out-of-repo dirs. Mirrors composedWriteRoots (#435). Two guards:
    //   - Invariant #1 (farm pin untouched): only compose when the caller did NOT
    //     pin `config.readRoots`. A pin ("confine to exactly these" — `afk farm`)
    //     suppresses inheritance entirely (the `=== undefined` gate above), so
    //     `inheritedReadRoots` stays undefined; composing here would silently
    //     override the pin at the childConfig literal. extraReadRoots flows through
    //     the DISTINCT `extraReadRoots` field precisely so the pin is never touched.
    //   - Invariant #2 (never confine an unconfined child): only compose when the
    //     child is (or will be) CONFINED. An unconfined child (no inherited roots
    //     AND no cwd -> resolveBase undefined -> read-open) can already read these
    //     paths; turning its read scope into a finite list would REGRESS it from
    //     read-open to confined.
    if (
      options.config.readRoots === undefined &&
      options.config.extraReadRoots !== undefined &&
      options.config.extraReadRoots.length > 0
    ) {
      const willBeConfined = inheritedReadRoots !== undefined || effectiveChildCwd !== undefined;
      if (willBeConfined) {
        const base = inheritedReadRoots ?? (effectiveChildCwd !== undefined ? [effectiveChildCwd] : []);
        inheritedReadRoots = [...new Set([...base, ...options.config.extraReadRoots.map((r) => path.resolve(r))])];
      }
    }

    // Explicit write-root pre-grant (#435): when the caller passed writeRoots on
    // the agent tool, COMPOSE them with the child's own cwd so the child never
    // loses write access to its own tree — the provider REPLACES the default
    // [cwd] write root with config.writeRoots on first init (see
    // anthropic-direct/index.ts ensureSharedRoots). Unlike the #416 read grant
    // this is never automatic: writing outside the worktree breaks isolation, so
    // it requires explicit parent intent.
    let composedWriteRoots: string[] | undefined;
    if (options.config.writeRoots !== undefined && options.config.writeRoots.length > 0) {
      const base = effectiveChildCwd !== undefined ? [effectiveChildCwd] : [];
      composedWriteRoots = [...new Set([...base, ...options.config.writeRoots])];
    }

    // #652: a Claude-family child model that this session's routing sends to the
    // openai-compatible provider (a global AFK_PROVIDER=openai-compatible force
    // or a chatgpt-oauth/openai slot) cannot run — the OpenAI/ChatGPT backend
    // serves no Claude model and hard-errors. Substitute the parent's own model
    // (the OpenAI/gpt target the session already uses) so the child runs instead
    // of dying. Applied HERE because forkSubagent is the single choke point
    // through which the agent-tool, skill, and compose paths all create their
    // child session (see the subagentToolOutputCapBytes note below), and it must
    // be threaded into EVERY model-derived field of childConfig — most critically
    // the read-only phase provider (buildPhaseRestrictedProvider re-derives the
    // provider from the model), or a read-only fork would re-trigger the bug.
    const childModelCoercion = coerceCrossProviderChildModel(
      options.config.model,
      this.parentModel,
    );
    // `?? options.config.model` keeps the type as the required AgentModelInput:
    // the helper only returns undefined when given an undefined model, and
    // options.config.model is always defined here.
    const effectiveChildModel = childModelCoercion.model ?? options.config.model;
    if (childModelCoercion.coercedFrom !== undefined) {
      process.stderr.write(
        `[afk] subagent: child model "${childModelCoercion.coercedFrom}" cannot run on this ` +
          `session's OpenAI/ChatGPT backend — running it as "${effectiveChildModel ?? ''}" instead ` +
          `(set AFK_DEFAULT_SUBAGENT_MODEL to choose a different one).\n`,
      );
    }

    // Wall-clock budget for the child's turn (see SUBAGENT_DEFAULT_TIMEOUT_MS).
    // Explicit caller values win, including `0` for unbounded and the background
    // SUBAGENT_BACKGROUND_TIMEOUT_MS the SubagentExecutor stamps — `??`
    // preserves that precedence. The default is env-tunable via
    // AFK_SUBAGENT_TIMEOUT_MS (resolveSubagentTimeoutMs); an unset/invalid env
    // value returns SUBAGENT_DEFAULT_TIMEOUT_MS, so behaviour is unchanged when
    // the var is not set.
    //
    // Settled HERE rather than inline at the handle construction below because
    // it now feeds TWO consumers that must agree: the handle's hard `withTimeout`
    // abort, and the child config's soft deadline derived from it. Reading the
    // budget twice would let them drift.
    const effectiveTimeoutMs = options.config.timeoutMs ?? resolveSubagentTimeoutMs();

    // Invariant (budget disclosure): the preamble is applied HERE, wrapping the
    // whole literal, because this is the sole path to a child AgentSession —
    // agent-tool, compose/DAG, skill forks, and in-process callers all converge
    // on forkSubagent, while `tools/subagent/child-config.ts` is reached only by
    // the agent-tool paths. It wraps rather than sits inside the literal so it
    // reads the FINAL resolved `maxToolUseIterations` — the
    // `options.config.maxToolUseIterations ?? SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS`
    // default applied further down in this same literal — not the caller's
    // pre-default value. Injecting at this provider-neutral site is also what
    // stops the two providers from drifting on it — see the module header on
    // ./subagent/budget-preamble.js.
    const childConfig: AgentConfig = injectToolBudgetPreamble({
      ...options.config,
      // Invariant (trace seal ownership): mark this session as a fork so it
      // never seals the SHARED witness trace. The whole tree shares ONE
      // TraceWriter by reference and seal() is a one-shot hard gate — after it
      // flips, write() throws and emitSubagentLifecycle swallows the rejection,
      // so the first descendant to seal silently truncates every later
      // sibling's terminal row (the "started without terminal" orphan gap).
      // Stamped here, unconditionally, for the same reason as
      // subagentToolOutputCapBytes below: this is the single choke point every
      // fork path converges through, so no fork path can forget it. A caller
      // override is intentionally NOT honored — being a fork is not optional.
      // Grandchildren re-stamp it (and would inherit it via the spread
      // regardless), which is correct: they are forks too.
      isSubagentFork: true,
      // Effective model after the cross-provider coercion above (#652). Placed
      // AFTER the spread so it overrides options.config.model; a no-op on the
      // common path where nothing was coerced.
      model: effectiveChildModel,
      resume,
      forkSession: resume ? true : options.config.forkSession,
      // Witness attribution: stamp THIS fork's own id onto its config so the
      // child's provider loop tags every `tool_call` started/completed event
      // with `subagentId: id`. Placed AFTER the `...options.config` spread so
      // the manager-assigned `id` (line ~550) always wins — it is authoritative
      // and MUST match the id on the `subagent_lifecycle.started` emit below,
      // or a trace reader could not correlate a tool call with its child. A
      // child resumes the parent's sessionId and writes into the SHARED parent
      // trace file, so without this tag the parent trace cannot say which fork
      // ran which tool (issue #612).
      subagentId: id,
      // Central output-cap signal (#661), stamped UNCONDITIONALLY on EVERY
      // fork. forkSubagent is the single choke point through which the
      // agent-tool, skill, and compose paths all create their child session
      // (subagent-executor.ts, skill-executor/fork-dispatch.ts, and
      // dag-subagent.ts all converge here), and the top-level session is always
      // built via `new AgentSession(...)` directly at the entry points — never
      // here — so this value marks "forked child" and its absence marks
      // "top-level". The provider's buildDispatcher arms the dispatcher's
      // `maxOutputBytes` backstop from this field, bounding every tool result
      // at MODEL_CAP_BYTES (100KB) via headAndTail and containing the
      // tool-output-overflow crash class (#661) for ALL forks — including
      // skill-forked descendants whose `parentSessionId` is undefined (a stub
      // parent carries no sessionId), which the prior `parentSessionId`-keyed
      // gate left uncapped. Set here (not left to the `...options.config`
      // spread) so it cannot be omitted by any fork path; a caller override is
      // intentionally NOT honored — the cap is a non-negotiable fork backstop.
      subagentToolOutputCapBytes: MODEL_CAP_BYTES,
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
        childModel: effectiveChildModel,
        configApiKey: options.config.apiKey,
        parentApiKey: this.parentApiKey,
        parentProvider: this.parentProvider,
      }),
      // Same guard for the Anthropic-semantic `baseUrl`: an OpenAI-routed
      // child resolves its endpoint from `openaiBaseUrl` / env, never from the
      // parent's Anthropic base URL. Explicit caller values still win.
      baseUrl:
        options.config.baseUrl ??
        (providerForModel(effectiveChildModel) === 'openai-compatible'
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
      // TIME sibling of the round cap above, derived from the SAME wall-clock
      // budget the hard `withTimeout` abort below is armed with. The round cap
      // bounds WORK DONE and the idle watchdog bounds SILENCE; neither bounds a
      // child that is genuinely working but slow — that child previously hit the
      // hard abort and lost everything it had learned, unsynthesized. The soft
      // deadline lands earlier, at a round boundary, and spends one tools-stripped
      // round on a real answer. `resolveSoftDeadlineMs` returns `0` (off, prior
      // behaviour exactly) for unbounded budgets and for budgets too short to
      // split. An explicit caller `softDeadlineMs` wins via `??`, including `0`
      // to opt out.
      softDeadlineMs: options.config.softDeadlineMs ?? resolveSoftDeadlineMs(effectiveTimeoutMs),
      // External constraint (anti-hang, sibling of the cap above): a fork that
      // hits an OAuth usage-limit 429 otherwise auto-pauses and silently polls
      // for reset — up to two hours (retry-layer.ts) — with no subagent-level
      // pause UI, so the parent just looks frozen. A fork has no human to wait
      // for: fail fast with the classified usage-limit error (the provider
      // still emits the `paused` event first, then surfaces the error), and
      // let the PARENT decide whether to retry, reroute to another model, or
      // surface the pause to its own operator. Callers may opt a child back
      // into auto-resume with an explicit `autoResumeOnUsageLimit: true`
      // (e.g. unattended daemon flows that prefer waiting over failing).
      autoResumeOnUsageLimit: options.config.autoResumeOnUsageLimit ?? false,
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
      // Inherited read scope (see the computation above the literal). Only set
      // when the caller left readRoots unset; otherwise the `...options.config`
      // spread's readRoots (or the provider's `[cwd]` default) stands.
      ...(inheritedReadRoots !== undefined ? { readRoots: inheritedReadRoots } : {}),
      // Explicit write-root pre-grant (#435): composed with cwd above. When
      // writeRoots is absent, composedWriteRoots is undefined and the
      // `...options.config` spread's writeRoots (or the provider's `[cwd]`
      // default) stands.
      ...(composedWriteRoots !== undefined ? { writeRoots: composedWriteRoots } : {}),
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
        ? { provider: buildPhaseRestrictedProvider('read-only', effectiveChildModel) }
        : {}),
    });

    // Occupancy touch: subagents never write presence files (top-level-only
    // by design — presence.ts), so the worktree sweep's live-session guard
    // cannot see a fork occupying a worktree. Refresh the worktree's meta
    // (pid + createdAt) instead, resetting the sweep's age clock and PID
    // liveness. Fire-and-forget: the helper swallows all errors and no-ops
    // for cwds outside `.afk-worktrees/`, so it can never delay or fail the
    // fork. Single wiring point — agent/skill/compose/farm dispatches all
    // converge here, whether cwd came per-call or via manager inheritance.
    //
    // Ordering constraint: one touch only protects the tree for the sweep's
    // MIN_EMPTY_AGE_MS (1h), after which a still-running child ages back into
    // the `empty` verdict and is force-removed mid-flight (#759). So arm a
    // heartbeat alongside the initial touch, and capture its stop handle HERE —
    // before the session is constructed — so every exit path below (settle,
    // construction throw) already has the inverse in hand and cannot orphan the
    // timer. The timer is unref()'d, so even a leaked one cannot hold the
    // process open.
    let stopOccupancyHeartbeat: () => void = () => {};
    if (childConfig.cwd !== undefined) {
      void touchWorktreeOccupancy(childConfig.cwd);
      stopOccupancyHeartbeat = startWorktreeOccupancyHeartbeat(childConfig.cwd);
    }

    // Ordering constraint: the heartbeat armed above is disarmed by the settle
    // callback installed on the handle built below, so the guarded span has to
    // run from construction all the way through `active.set`. A throw anywhere
    // in between — the parent-stream read, the sink resolve, the handle
    // constructor — would otherwise return with the interval live and no handle
    // in existence to ever cancel it, and the tree would never be reaped again.
    let session: AgentSession;
    let handle: SubagentHandleImpl<T>;
    let effectiveAgentType: string | undefined;
    let effectiveResolvedAgentType: string | undefined;
    try {
      session = new AgentSession(childConfig);
      const parentInputStreamRef = options.parent.getInputStreamRef?.();
      const parentAbortSignal = options.parent.abortSignal;
      // Resolve sink: explicit option takes precedence, then ambient from AsyncLocalStorage
      const sink = this.progressSink ?? getCurrentSink();
      // Normalize empty-string render hints to undefined so the `??` fallbacks
      // engage. A caller passing `agentType: ''` or `parentId: ''` would
      // otherwise produce an empty Agent() label / empty agentContext anchor
      // rather than the intended fallback (idPrefix / parent.sessionId).
      effectiveAgentType = options.agentType?.trim() || undefined;
      effectiveResolvedAgentType = options.resolvedAgentType?.trim() || undefined;
      const effectiveParentId = options.parentId?.trim() || undefined;
      handle = new SubagentHandleImpl<T>(
        id,
        session,
        childController,
        this.abortGraph,
        options.outputSchema,
        // Hard wall-clock backstop, settled above as `effectiveTimeoutMs` and
        // SHARED with the child config's derived soft deadline so the two cannot
        // drift. Unchanged behaviour: this still aborts a wedged child on schedule.
        effectiveTimeoutMs,
        registry,
        () => {
          // Runs on every terminal outcome of the child — success, failure,
          // timeout, and abort — so it is the settle hook the heartbeat's
          // teardown belongs on.
          stopOccupancyHeartbeat();
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
        // parent's witness." Resolved once above (per-fork config →
        // manager-level writer) so the handle's terminal lifecycle emits
        // pair with the 'started' emit below even when inheritance came
        // from the manager rather than the per-fork config.
        effectiveTraceWriter,
        // onSubagentSucceeded: propagate completion data to the parent
        // session's session_sealed rollup accumulators.
        this.onSubagentSucceededCb,
        // Progress-aware idle-watchdog window for the child's turn (see
        // SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS above). Explicit caller values win,
        // including `0` to disable the watchdog for this fork — `??` preserves that
        // precedence. The default is env-tunable via AFK_SUBAGENT_IDLE_TIMEOUT_MS
        // (resolveSubagentIdleTimeoutMs); an unset/invalid env value returns
        // SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS, so behaviour is unchanged when the var
        // is not set. Runs concurrently with the wall-clock budget above.
        options.config.idleTimeoutMs ?? resolveSubagentIdleTimeoutMs(),
      );
      this.active.set(id, handle as SubagentHandleImpl<unknown>);
    } catch (err) {
      // Construction or manager-wiring failed (invalid model, sync init
      // failure, a throwing parent-stream/sink read). Release the graph node
      // registered above so an orphan cannot accumulate across retry loops
      // (forge/farm), and disarm the occupancy heartbeat — there is no child
      // left to protect, and a live timer here would pin the worktree forever.
      stopOccupancyHeartbeat();
      this.abortGraph.dispose(id);
      throw err;
    }

    // Witness layer: subagent_lifecycle.started fires AFTER the handle is
    // wired into the manager's active map and the abort-graph. Emitting
    // earlier (e.g. before linkChild) would create a window where the
    // trace shows a started subagent that the manager doesn't know about.
    //
    // parentId fallback: the child's `options.parent.sessionId` is the
    // honest answer when present; for a top-level fork from a session
    // that hasn't initialized yet, we fall back to the manager's rootId
    // so the schema's `parentId: string` requirement stays satisfied.
    const modelString = typeof effectiveChildModel === 'string'
      ? effectiveChildModel
      : JSON.stringify(effectiveChildModel);
    void emitSubagentLifecycle(effectiveTraceWriter, {
      transition: 'started',
      subagentId: id,
      parentId: options.parent.sessionId ?? this.rootId,
      model: modelString,
      ...(childConfig.tools?.allowedTools
        ? { allowedTools: [...childConfig.tools.allowedTools] }
        : {}),
      // Observability: WHAT was this child asked to do + WHICH role. promptHead
      // is the caller-supplied prompt slice (re-clamped to 80 to honour the
      // payload contract regardless of caller input); agentType is the already-
      // computed effective render label. Both omitted when unavailable so the
      // schema's `.optional()` fields stay absent rather than empty-valued.
      ...(options.promptHead && options.promptHead.trim() !== ''
        ? { promptHead: options.promptHead.slice(0, 80) }
        : {}),
      ...(effectiveAgentType ? { agentType: effectiveAgentType } : {}),
      // resolvedAgentType: the clean registered type (set only for named
      // dispatches). Carried separately from the agentType render label so a
      // trace reader can group by real type without the label-fallback noise.
      ...(effectiveResolvedAgentType ? { resolvedAgentType: effectiveResolvedAgentType } : {}),
    });

    await appendRoutingDecision({
      event: 'subagent.dispatched',
      subagent_id: id,
      id_prefix: options.idPrefix,
      model: modelString,
      parent_session_id: options.parent.sessionId,
      // Persist the resolved registered type into routing-decisions.jsonl so
      // "which agent types get dispatched, how often" is a one-line query on
      // the durable telemetry stream (undefined is dropped at write time).
      resolved_agent_type: effectiveResolvedAgentType,
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
