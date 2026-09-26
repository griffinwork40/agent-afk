/**
 * SubagentExecutor: provider-level handler for the Agent tool.
 *
 * Receives a ToolCall from the SessionToolDispatcher, forks a child agent
 * session via SubagentManager, runs the prompt, and returns the result as
 * a ToolResult.
 *
 * @module agent/tools/subagent-executor
 */

import { SubagentManager, SUBAGENT_BACKGROUND_TIMEOUT_MS } from '../subagent.js';
import { computeInheritedReadRoots } from '../subagent-read-scope.js';
import type { TraceSink } from '../trace/index.js';
import type { AnthropicToolDef, ToolCall, ToolResult } from './types.js';
import { resolveMaxNestingDepth } from './nesting.js';
import { buildAgentToolDef } from '../agents/index.js';
import type { RegisteredAgent } from '../agents/index.js';
import { stripEscapeSequences } from '../../utils/terminal-sanitize.js';
import { deriveOrigin, actorFromDepth, type TraceOrigin, type TraceActor } from '../session/session-identity.js';
import { parseAgentInput, type AgentInput, type AgentExecutionMode } from './subagent/input-parse.js';
import { emitTelemetry, truncate } from './subagent/failure-payload.js';
import { buildChildConfig } from './subagent/child-config.js';
import { runBackgroundBranch } from './subagent/background-branch.js'; import { cancelBackgroundJob as executeBackgroundCancel } from './subagent/background-cancel.js';
import { sendMessageToAgent as executeSendMessage } from './subagent/send-message.js'; import { getBackgroundJobHealth as executeBackgroundHealth } from './subagent/background-health.js';
import { runForegroundWithPromotion, type PromotionTrigger } from './subagent/foreground-promotion.js';
import { createIsolatedWorktree } from './handlers/worktree-managed.js';
import { lockWorktreeForBackground, teardownBackgroundWorktree } from './handlers/worktree-managed.background.js';
import { runWithStreamCutRetry, type StreamCutProbe } from '../subagent/stream-cut-retry.js';
import { debugLog } from '../../utils/debug.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { appendImageBlocks } from '../content/image-blocks.js';
import { supportsVision } from '../model-capabilities.js';
import { resolveSubagentAttachments } from './subagent/attachment-resolve.js';
import { inboundAttachmentRegistry } from '../content/attachment-registry.js';
import { appendRoutingDecision } from '../routing-telemetry.js';
import { buildAgentMaxDepthRefusal } from './skill-depth-message.js';
import { buildBudgetRefusalMessage, type SpawnReceipt } from './delegation-budget.js';
import { collectPostRunWarnings } from './subagent-executor.write-intent.js';
import { buildSubagentsLite } from './subagent-executor.lite-snapshot.js';
import {
  buildWaveUnit,
  createManifest,
  updateWaveUnit,
} from '../manifest/write.js';
import { env } from '../../config/env.js';
import { errorMessage } from '../../utils/errors.js';
import type { SubagentExecutorContext, SubagentControl } from './subagent-executor/types.js';
import type { QueuedNoteClaim, PromotedSubagentInfo } from './subagent-executor/types.js';

export { DEFAULT_MAX_NESTING_DEPTH, type ChildProviderFactoryArgs } from './nesting.js';
export type { AgentExecutionMode };
export type { SubagentExecutorContext, SubagentControl } from './subagent-executor/types.js';
export type { PromotedSubagentInfo } from './subagent/foreground-promotion.js';

export class SubagentExecutor implements SubagentControl {
  // Current worktree cwd. Seeded from ctx.cwd; updated by setCwd when the
  // session's cwd changes (born-named `afk -w` worktree created on turn 1).
  // Read when building the depth-2+ child manager/executor below.
  private currentCwd: string | undefined;

  // Monotonic per-executor counter for collision-free isolated-worktree slugs
  // (`afk/iso-<idPrefix>-<counter>-<rand>`). Combined with a random suffix so
  // concurrent `agent` calls in one turn never target the same tree.
  private isolationCounter = 0;

  constructor(private readonly ctx: SubagentExecutorContext) {
    this.currentCwd = ctx.cwd;
  }

  /**
   * Re-anchor the cwd used for forked sub-agents after a mid-session cwd change.
   * Updates the depth-2+ anchor (this.currentCwd) AND the root manager that
   * dispatches depth-1 forks, so the whole `agent`-tool tree follows the new
   * worktree instead of falling back to the host's process.cwd().
   */
  setCwd(cwd: string): void {
    this.currentCwd = cwd;
    this.ctx.subagentManager.setCwd(cwd);
  }

  /**
   * Re-point the trace writer forked sub-agents inherit, after a REPL
   * `/resume` replaced the session that owned the previous writer. Mirrors
   * {@link SubagentExecutor.setCwd}: updates this executor's context AND the
   * root manager that dispatches depth-1 forks, so the whole `agent`-tool tree
   * follows the resumed session's live writer instead of the sealed one (#731).
   */
  setTraceWriter(writer: TraceSink | undefined): void {
    this.ctx.traceWriter = writer;
    this.ctx.subagentManager.setTraceWriter(writer);
  }

  /**
   * The `agent` tool definition this executor's owning provider should
   * advertise. With a non-empty named-agent registry, the definition gains
   * the `agent_type` input property and an "Available agent types" listing
   * (Claude Code advertises subagent types in its Task tool the same way).
   * Without one, returns the static schema byte-identical to the legacy
   * surface. Providers call this via optional chaining so stubbed executors
   * in tests fall back to the static def.
   */
  describeAgentTool(): AnthropicToolDef {
    return buildAgentToolDef(this.ctx.agentRegistry);
  }

  /**
   * In-flight foreground subagents that can be promoted to background, keyed
   * by `handle.id`. Each entry is registered by the foreground branch of
   * {@link execute} immediately before its run-vs-promotion race and removed
   * in that branch's `finally`. `fire()` resolves the executor's promotion
   * signal (winning the race); `ready` resolves with the created job once the
   * handoff completes, or `null` if promotion could not happen.
   *
   * Multiple concurrent `agent` calls in one tool batch each add an entry, so
   * `promoteActiveForeground()` promotes the whole in-flight set ("promote
   * all"), which is what unblocks a parent parked in `executeBatch` awaiting
   * several subagents at once.
   */
  private readonly promotionTriggers = new Map<string, PromotionTrigger>();

  // In-flight foreground handles keyed by `handle.id`. Tracked separately from
  // promotionTriggers because cancellation must work with NO background
  // registry wired: a soft-stop (ESC / Ctrl+C) cancels these to unblock a
  // parent turn parked on a subagent `await`. Populated alongside the promotion
  // trigger in execute()'s foreground branch and cleared in the same finally.
  private readonly activeForegroundHandles = new Map<string, { cancel: () => Promise<void> }>();

  // Wave manifest tracking. Set by notifyWaveStart() before a parallel batch
  // runs; cleared (set to undefined) after all units in the batch settle.
  // Maps tool-call id → unit id so executeOnce can update the right unit.
  private currentWaveId: string | undefined = undefined;
  private currentWaveCallIds: Set<string> = new Set();

  /**
   * Called by the dispatcher BEFORE a parallel batch of ≥2 agent tool calls
   * starts. Creates a wave manifest with all units in 'pending' status using
   * the tool call ids as unit ids. Fire-and-forget: never throws.
   */
  notifyWaveStart(
    calls: ReadonlyArray<ToolCall>,
    sessionId: string,
    traceLabel: string | null,
  ): void {
    if (env.AFK_WAVE_MANIFEST_DISABLED === '1') return;
    if (calls.length < 2) return;
    // Only root-level sessions write manifests (depth === 0).
    if (this.ctx.depth !== 0) return;
    try {
      const units = calls.map((call) => {
        let parsed: { prompt: string; model?: string; cwd?: string } | undefined;
        try {
          parsed = parseAgentInput(call.input);
        } catch {
          parsed = undefined;
        }
        const prompt = parsed?.prompt ?? '';
        const model = parsed?.model ?? 'sonnet';
        const cwd = parsed?.cwd ?? this.currentCwd;
        return buildWaveUnit({ id: call.id, prompt, cwd, model });
      });
      const waveId = createManifest({
        source: 'agent-tool',
        parentSessionId: sessionId,
        traceLabel,
        units,
      });
      if (waveId !== undefined) {
        this.currentWaveId = waveId;
        this.currentWaveCallIds = new Set(calls.map((c) => c.id));
      }
    } catch {
      // Fire-and-forget: manifest errors must never abort a wave.
    }
  }

  /**
   * Called by the dispatcher AFTER all units in a parallel batch have settled.
   * Clears the wave state.
   */
  notifyWaveEnd(): void {
    this.currentWaveId = undefined;
    this.currentWaveCallIds = new Set();
  }

  /**
   * Update a unit's status in the current wave manifest. No-op when no wave
   * is active or the call is not part of the current wave.
   * Fire-and-forget: never throws.
   */
  private updateCurrentWaveUnit(
    callId: string,
    status: 'running' | 'done' | 'failed',
    error?: string,
    cwd?: string,
  ): void {
    const waveId = this.currentWaveId;
    if (waveId === undefined) return;
    if (!this.currentWaveCallIds.has(callId)) return;
    const extra: { errorMessage?: string; cwd?: string } | undefined =
      error !== undefined || cwd !== undefined
        ? { ...(error !== undefined ? { errorMessage: error } : {}), ...(cwd !== undefined ? { cwd } : {}) }
        : undefined;
    updateWaveUnit(waveId, callId, status, extra);
  }

  supportsBackgroundJobs(): boolean { return this.ctx.backgroundRegistry !== undefined; }
  hasPromotableForeground(): boolean { return this.supportsBackgroundJobs() && this.promotionTriggers.size > 0; }
  async cancelBackgroundJob(call: ToolCall): Promise<ToolResult> { return executeBackgroundCancel(this.ctx.backgroundRegistry, call); }
  async sendMessageToAgent(call: ToolCall): Promise<ToolResult> { return executeSendMessage(this.ctx.backgroundRegistry, call, this.ctx.parentSession.sessionId); }
  getBackgroundJobHealth(call: ToolCall): ToolResult { return executeBackgroundHealth(this.ctx.backgroundRegistry, call, this.ctx.parentSession.sessionId); }
  hasActiveForeground(): boolean { return this.activeForegroundHandles.size > 0; }

  /**
   * Monotonic cancellation counter. Bumped on every `cancelActiveForeground()`
   * so an in-flight `execute()` can detect "a cancel happened while I was
   * between stream-cut retry attempts" — a window in which the handle maps are
   * empty and the cancel would otherwise be invisible. See `execute()`.
   */
  private cancelGeneration = 0;

  async cancelActiveForeground(): Promise<number> {
    // Bump BEFORE the empty-map early return: a cancel that arrives while an
    // `agent` call sits between retry attempts finds nothing to cancel, and
    // suppressing the pending re-fork is the only way to honour it.
    this.cancelGeneration += 1;
    // Snapshot first: cancel() resolves the run, whose finally removes the entry
    // from the map while we iterate. handle.cancel() is idempotent and aborts
    // the child session; its runToResult settles (buildResultFromError with any
    // partialOutput), the Promise.race in execute() picks the 'result' branch,
    // and the parent receives a structured failure tool_result — unblocking the
    // suspended turn. We do NOT delete entries here; the run's own finally does
    // so idempotently.
    const handles = [...this.activeForegroundHandles.values()];
    if (handles.length === 0) return 0;
    await Promise.all(handles.map((h) => h.cancel().catch(() => { /* best-effort */ })));
    return handles.length;
  }

  async promoteActiveForeground(queuedNote?: QueuedNoteClaim): Promise<PromotedSubagentInfo[]> {
    // Snapshot first: firing a trigger may settle and remove its entry from
    // the map (via execute()'s finally) while we iterate.
    const triggers = [...this.promotionTriggers.values()];
    // The SAME claim ticket goes to every trigger: the first promotion that
    // actually reaches the registry claims it, so N subagents backgrounded by
    // one keypress deliver the user's queued text exactly once.
    triggers.forEach((t) => t.fire(queuedNote));
    const settled = await Promise.all(triggers.map((t) => t.ready));
    return settled.filter((j): j is PromotedSubagentInfo => j !== null);
  }

  /**
   * Read-only snapshot of active subagents + background jobs for the
   * `get_runtime_state` tool's `subagents` view. Pulls fresh from the
   * manager + registry on every call so live counts are visible.
   *
   * Lite shape only — does not expose `SubagentHandle` references or raw
   * `BackgroundJob` objects (which would leak handle internals like the
   * progress sink). Background `startedAt` is converted from epoch-ms to
   * ISO 8601 to match the rest of the snapshot's timestamp convention.
   */
  getSubagentsLite(): ReturnType<typeof buildSubagentsLite> {
    return buildSubagentsLite(
      this.ctx.subagentManager,
      this.ctx.backgroundRegistry,
      this.ctx.parentSession.sessionId,
    );
  }

  /**
   * Dispatch the `agent` tool, re-forking once if the child's model stream is
   * cut mid-flight with nothing to salvage.
   *
   * Contract: every attempt runs the FULL {@link executeOnce} body, so each
   * re-dispatch parses input and forks a brand-new child (fresh session, fresh
   * trace, fresh worktree when isolating). That is required for a retry to mean
   * anything — a spent `SubagentHandle` cannot be re-run. Attempt-scoped
   * telemetry and trace events are emitted per attempt by design: the failed
   * first attempt stays visible in `afk trace show` rather than being silently
   * swallowed by the rescue.
   *
   * Only the ZERO-OUTPUT cut is retried, and only for a READ-ONLY child — see
   * {@link isZeroOutputStreamCut} (buffered partials and tool-budget caps are
   * excluded) and the `canRedispatch` gate below (side effects and cancellation).
   */
  async execute(call: ToolCall): Promise<ToolResult> {
    // Invariant: default to NOT side-effect-free. `executeOnce` flips this only
    // once it has actually resolved the child's write capability; every earlier
    // return path (input validation, depth ceiling, fork failure) therefore
    // leaves retry disabled rather than guessing.
    const probe: StreamCutProbe = { sideEffectFree: false };
    // Cancellation cannot be observed through `activeForegroundHandles` between
    // attempts — attempt 1's finally has already emptied it and attempt 2 has
    // not registered yet, so `cancelActiveForeground()` would find nothing to
    // cancel and never abort `call.signal`. Snapshot the cancel generation
    // instead and refuse to re-fork if it moved. A counter (not a boolean) keeps
    // this correct when several `agent` calls are in flight concurrently.
    const cancelGenerationAtStart = this.cancelGeneration;
    return runWithStreamCutRetry({
      dispatch: (attempt) =>
        this.executeOnce(call, probe, attempt > 0 ? cancelGenerationAtStart : undefined),
      signal: call.signal,
      canRedispatch: () =>
        probe.sideEffectFree && this.cancelGeneration === cancelGenerationAtStart,
      onRedispatch: (attempt) => {
        debugLog(
          `subagent-executor: read-only child stream cut with zero output; ` +
            `re-dispatching a fresh fork (attempt ${attempt + 1})`,
        );
      },
    });
  }

  private async executeOnce(
    call: ToolCall,
    probe?: StreamCutProbe,
    retryCancelGeneration?: number,
  ): Promise<ToolResult> {
    // If signal is already aborted, return immediately
    if (call.signal.aborted) {
      return { content: 'Agent tool call aborted', isError: true };
    }

    let parsed: AgentInput;
    try {
      parsed = parseAgentInput(call.input);
    } catch (err) {
      const message = errorMessage(err);
      return {
        content: `Agent tool input validation failed: ${message}`,
        isError: true,
      };
    }

    // Named-agent resolution. A miss fails fast with the available list
    // (mirrors skill-executor.ts's "Skill not found. Available skills: …")
    // rather than silently dispatching an unrestricted generic child under
    // a name the caller believed carried constraints.
    let namedAgent: RegisteredAgent | undefined;
    if (parsed.agent_type !== undefined) {
      namedAgent = this.ctx.agentRegistry?.get(parsed.agent_type);
      if (namedAgent === undefined) {
        const available = [...(this.ctx.agentRegistry?.keys() ?? [])].sort().join(', ');
        return {
          content:
            `Agent type "${parsed.agent_type}" not found. ` +
            `Available agent types: ${available.length > 0 ? available : '(none)'}`,
          isError: true,
        };
      }
    }

    // Nested-dispatch scope gate. When THIS executor belongs to an agent that
    // declared a scoped `Agent(x)` grant (e.g. research-agent's
    // `Agent(git-investigator)`), it may dispatch ONLY those agent types.
    // Reject any out-of-scope type AND any bare/no-type dispatch (which would
    // otherwise fork an unrestricted general-purpose grandchild inheriting the
    // parent's unrestricted cage — the escalation this gate closes). An empty
    // allowlist (`[]`, from an `Agent()` deny-all grant) matches nothing and so
    // rejects every dispatch. Top-level executors and inherit-all/bare-`Agent`
    // agents leave the allowlist unset (`undefined`), so their dispatch is
    // unchanged. The guard is on presence, not length — see nestedAgentAllowlist.
    const nestedScope = this.ctx.nestedAgentAllowlist;
    if (nestedScope !== undefined) {
      const requested = parsed.agent_type;
      if (requested === undefined || !nestedScope.includes(requested)) {
        return {
          content:
            nestedScope.length === 0
              ? 'This agent is not permitted to dispatch any nested agents ' +
                '(its definition granted the dispatch tool but named zero allowed ' +
                'types, e.g. `Agent()`). Complete the task with your own tools.'
              : `This agent may only dispatch the following agent type(s): ${nestedScope.join(', ')}. ` +
                (requested === undefined
                  ? 'A bare dispatch with no agent_type is not permitted here — ' +
                    'set agent_type to one of the allowed types, or complete the task with your own tools.'
                  : `agent_type "${requested}" is out of scope.`),
          isError: true,
        };
      }
    }

    // Invariant: `ctx.depth` is required (see SubagentExecutorContext.depth
    // jsdoc) — top-level callers pass explicit `0` so the child's `depth + 1`
    // arithmetic in buildChildConfig produces a confident nesting position. A
    // future change that loosens the type back to optional would re-introduce
    // the silent misconfig fallback the Phase 1 awareness contract is designed
    // to avoid.
    const depth = this.ctx.depth;
    const maxDepth = this.ctx.maxDepth ?? resolveMaxNestingDepth();

    // Session identity for routing-decision rows. Only emitted when this
    // executor was wired with a `surface` (the new top-level wiring); legacy/
    // un-threaded contexts omit both fields, preserving back-compat. `actor`
    // comes from `depth` (>0 ⟺ this executor is owned by a subagent).
    const identity: { origin?: TraceOrigin; actor?: TraceActor } =
      this.ctx.surface !== undefined
        ? { origin: deriveOrigin(this.ctx.surface), actor: actorFromDepth(depth) }
        : {};

    // Depth cap, mirroring the `skill` tool's guard (skill-executor.ts). Before
    // this existed the cap was enforced only by child-config.ts NOT wiring
    // nested executors into the child it builds (`depth < maxDepth`), which
    // made the two tools stop one generation apart: a depth-3 child (wired by
    // its depth-2 parent, which passed that gate) still held a live `agent`
    // tool and could fork a depth-4 leaf, whereas `skill` already refused at
    // depth 3. The leaf then answered "Agent tool is not available in this
    // session configuration" from the dispatcher — a config-shaped message for
    // what is really a depth wall, with no recovery hint. Refusing here makes
    // `maxDepth` mean one thing for both tools and hands back the actionable
    // "work inline" clause instead.
    if (depth >= maxDepth) {
      void appendRoutingDecision({
        ...identity,
        event: 'delegation.skipped',
        parent_session_id: this.ctx.parentSession.sessionId,
        reason: 'max_depth',
        depth,
        ...(parsed.agent_type !== undefined ? { requested_name: parsed.agent_type } : {}),
      }).catch(() => {});
      return {
        content: buildAgentMaxDepthRefusal(depth, maxDepth),
        isError: true,
      };
    }

    // Delegation budget: per-agent child cap, tree-wide concurrent/total caps.
    // Item 1: record the spawn atomically with the admission check — BEFORE the
    // first await — so concurrent parallel `agent` calls cannot all pass canSpawn
    // before any reaches recordSpawn. The SpawnReceipt is stored below; call
    // receipt.rollback() on fork failure (undoes all counters) and receipt.release()
    // on normal completion (decrements only concurrent).
    let budgetReceipt: SpawnReceipt | undefined;
    if (this.ctx.delegationBudget) {
      const check = this.ctx.delegationBudget.canSpawn(this.ctx.parentSession.sessionId ?? '');
      if (!check.allowed) {
        void appendRoutingDecision({ ...identity, event: 'delegation.skipped', parent_session_id: this.ctx.parentSession.sessionId, reason: check.reason ?? 'budget', depth, ...(parsed.agent_type !== undefined ? { requested_name: parsed.agent_type } : {}) }).catch(() => {});
        return { content: buildBudgetRefusalMessage(check), isError: true };
      }
      // Admitted: charge the slot now, synchronously, before any await.
      budgetReceipt = this.ctx.delegationBudget.recordSpawn(this.ctx.parentSession.sessionId ?? '');
    }

    // Transitive read-scope propagation (see ../subagent-read-scope): compute
    // THIS child's inherited read roots from the manager that will fork it, so
    // the nested manager the child builds for its OWN grandchildren starts from
    // the child's scope — not a cwd-only proxy that would silently re-confine a
    // read-open (or /allow-dir-widened) child one nesting level down.
    // `getReadScopeInputs` is a required method on the real SubagentManager (the
    // `subagentManager: SubagentManager` type enforces it exists — deleting it
    // would fail tsc here); the `?.()` guards only the runtime VALUE so the many
    // `as any`-cast test doubles that predate this method fall back to "no
    // explicit parent scope" (→ cwd-derivation) instead of throwing. Production
    // always takes the real branch.
    const childScopeInputs = this.ctx.subagentManager.getReadScopeInputs?.() ?? {
      parentReadRoots: undefined,
      parentCwd: undefined,
    };
    const childInheritedReadRoots = computeInheritedReadRoots({
      parentReadRoots: childScopeInputs.parentReadRoots,
      parentCwd: childScopeInputs.parentCwd,
      childCwd: parsed.cwd ?? this.currentCwd,
    });

    // Build the child config + nested-dispatch wiring. All context this needs
    // is passed explicitly; the recursive child executor is injected as a
    // factory so child-config.ts never imports this class at runtime.
    const { childConfig, childParentSession, childManager, childWriteCapable, childSideEffectFree } = buildChildConfig({
      parsed,
      namedAgent,
      depth,
      maxDepth,
      currentCwd: this.currentCwd,
      ...(childInheritedReadRoots !== undefined ? { childInheritedReadRoots } : {}),
      signal: call.signal,
      defaultConfig: this.ctx.defaultConfig,
      ...(this.ctx.resolveApiKeyForModel !== undefined
        ? { resolveApiKeyForModel: this.ctx.resolveApiKeyForModel }
        : {}),
      defaultSubagentModel: this.ctx.defaultSubagentModel,
      ...(this.ctx.childProviderFactory !== undefined
        ? { childProviderFactory: this.ctx.childProviderFactory }
        : {}),
      ...(this.ctx.childSkillExecutorFactory !== undefined
        ? { childSkillExecutorFactory: this.ctx.childSkillExecutorFactory }
        : {}),
      ...(this.ctx.surface !== undefined ? { surface: this.ctx.surface } : {}),
      ...(this.ctx.allowedTools !== undefined ? { allowedTools: this.ctx.allowedTools } : {}),
      ...(this.ctx.readOnlyBash !== undefined ? { readOnlyBash: this.ctx.readOnlyBash } : {}),
      ...(this.ctx.agentRegistry !== undefined ? { agentRegistry: this.ctx.agentRegistry } : {}),
      ...(this.ctx.parentModel !== undefined ? { parentModel: this.ctx.parentModel } : {}),
      ...(this.ctx.traceWriter !== undefined ? { traceWriter: this.ctx.traceWriter } : {}), ...(this.ctx.workspaceStore !== undefined ? { workspaceStore: this.ctx.workspaceStore } : {}),
      ...(this.ctx.delegationBudget !== undefined ? { delegationBudget: this.ctx.delegationBudget } : {}),
      createChildExecutor: (childCtx) => new SubagentExecutor(childCtx),
    });

    // Stream-cut retry eligibility (see `execute()`): a re-dispatch re-runs the
    // whole prompt, so it is only safe when the child cannot mutate anything.
    // This is stricter than `!childWriteCapable`: non-file tools can mutate
    // remote or persistent state too, so the entire surface must be pure-read.
    if (probe !== undefined) probe.sideEffectFree = childSideEffectFree;

    // isolation:"worktree" — fork the child inside a fresh managed git worktree
    // so its writes/tests never collide with siblings sharing the parent tree.
    // Read-only children skip (nothing to isolate). Foreground: torn down in
    // the finally. Background: locked at creation so the sweep cannot race-reap
    // it, then unlocked + torn down in markTerminal(). Dirty / commits-ahead
    // trees are preserved and locked, never destroyed.
    let isolationTeardown: { repoRoot: string; worktreePath: string } | undefined;
    if (parsed.isolation === 'worktree') {
      if (!childWriteCapable) {
        debugLog(`[isolation] skipped worktree for read-only ${parsed.agent_type ?? 'generic'}`);
      } else {
        const anchorCwd = this.currentCwd ?? process.cwd();
        try {
          const iso = await createIsolatedWorktree({
            cwd: anchorCwd,
            slugHint: `iso-${parsed.id_prefix}-${++this.isolationCounter}-${Math.random().toString(36).slice(2, 8)}`,
          });
          childConfig.cwd = iso.path;
          isolationTeardown = { repoRoot: iso.repoRoot, worktreePath: iso.path };
          // Background: lock so sweep cannot race-reap; markTerminal() unlocks.
          if (parsed.mode === 'background') await lockWorktreeForBackground(iso.repoRoot, iso.path);
        } catch (err) {
          // Fail loud: never silently fall back to the shared tree — that
          // reintroduces the cross-contamination bug isolation exists to
          // prevent (parallel siblings clobbering each other's edits/tests).
          const message = errorMessage(err);
          // Item 2: rollback ALL budget counters on worktree-creation failure
          // (the child never ran). Without rollback, the failure permanently
          // inflates total and concurrentChildrenByAgent, exhausting lifetime caps.
          budgetReceipt?.rollback();
          budgetReceipt = undefined;
          return {
            content:
              `Failed to create isolated worktree for the subagent: ${message}. ` +
              `isolation:"worktree" requires the dispatching session to run inside a git repository.`,
            isError: true,
          };
        }
      }
    }

    // Background dispatches get a wider wall-clock budget than the foreground
    // default the manager applies (SUBAGENT_DEFAULT_TIMEOUT_MS): they don't
    // park the parent turn, and the tool description invites "long
    // investigations". Still bounded — a wedged detached child must not burn
    // tokens forever. Guarded so an explicit caller-supplied budget (via
    // AgentConfig.timeoutMs on SDK-level dispatch paths) always wins.
    if (parsed.mode === 'background' && childConfig.timeoutMs === undefined) {
      childConfig.timeoutMs = SUBAGENT_BACKGROUND_TIMEOUT_MS;
    }

    let handle: Awaited<ReturnType<SubagentManager['forkSubagent']>>;
    try {
      handle = await this.ctx.subagentManager.forkSubagent({
        parent: this.ctx.parentSession,
        parentId: call.id,
        config: childConfig,
        idPrefix: parsed.id_prefix,
        // Derive a human-readable render label. If the caller supplied a
        // meaningful id_prefix (not the default 'agent-tool'), use it.
        // Otherwise fall back to the first 40 chars of the prompt — the
        // most informative hint available at the raw agent dispatch site.
        //
        // External constraint: this string flows unsanitized through the TUI
        // tree-connector path (`formatToolLine` uses a regex with the `s`
        // flag that passes embedded newlines through). Strip ANSI escapes
        // and collapse interior newlines BEFORE slicing, so the rendered
        // line cannot be split mid-glyph or injected with control codes.
        // Named dispatches render as Agent(<type>) — the registry name is
        // trusted display input (already validated at registration). Unnamed
        // dispatches keep the id_prefix / prompt-slice derivation.
        agentType: namedAgent !== undefined
          ? namedAgent.name
          : (parsed.id_prefix && parsed.id_prefix !== 'agent-tool')
            ? stripEscapeSequences(parsed.id_prefix).replace(/[\r\n]+/g, ' ').trim() || 'agent'
            : stripEscapeSequences(parsed.prompt).replace(/[\r\n]+/g, ' ').slice(0, 40).trim() || 'agent',
        // resolvedAgentType: the clean, enumerable counterpart to the agentType
        // render label above — set ONLY when the dispatch named an agent_type
        // that resolved to a registry entry. Absent for bare/id_prefix/prompt
        // dispatches, so telemetry can distinguish a real named-agent dispatch
        // from a render-label fallback (which agentType alone cannot).
        ...(namedAgent !== undefined ? { resolvedAgentType: namedAgent.name } : {}),
        // Forensic prompt slice for the `subagent_lifecycle.started` event: sanitized
        // like agentType but kept at 80 chars (the emit in subagent.ts re-clamps to
        // 80 and drops it when blank), so real CLI/daemon dispatches carry WHAT the
        // child was asked to do — not just the render label.
        promptHead: stripEscapeSequences(parsed.prompt).replace(/[\r\n]+/g, ' ').slice(0, 80).trim(),
        // A forked sub-agent has no human relationship of its own: it returns
        // findings (including Blocked/Asking) to its PARENT, which owns the
        // operator surface. Deny MCP elicitation for BOTH foreground and
        // background forks — together with the isNonInteractive default in
        // subagent.ts this makes every sub-agent uniformly non-interactive.
        // (Previously only background denied; foreground leaked elicitations to
        // the REPL/Telegram human via the process-wide elicitation router.)
        denyElicitations: true, progressEvents: parsed.progress_events,
      });
      // Backfill: give the depth-1 child executor a real parentId so any
      // depth-2 forks it spawns carry handle.id as their parentId.
      if (childParentSession !== undefined) {
        childParentSession.sessionId = handle.id;
      }
      // Wave manifest: unit transitioned to 'running' once fork returns a handle.
      this.updateCurrentWaveUnit(call.id, 'running', undefined, isolationTeardown !== undefined ? childConfig.cwd : undefined);
      // Cancellation can land while a retry's fresh fork awaits hooks/read
      // scope resolution, before either foreground map contains the handle.
      if (retryCancelGeneration !== undefined && this.cancelGeneration !== retryCancelGeneration) {
        await childManager?.teardownAll();
        // Trace integrity: forkSubagent has ALREADY emitted a
        // subagent_lifecycle 'started' row for this handle, so this path must
        // close it with a terminal row or the trace carries an unmatched
        // 'started'. cancel() — not teardown(): teardown() fires the stop hook
        // but emits NO lifecycle transition.
        //
        // External constraint governing the write order: the 'cancelled' row
        // must land BEFORE the abort-graph cascade, so cascade aborts read as
        // descending from this cancel and a child's own 'failed' emit cannot
        // race ahead of it. That ordering is implemented and justified once
        // inside cancel(); delegating to it keeps this call site from drifting
        // out of sync. cancel() also writes through the same resolved trace
        // writer that produced 'started', which an emit from here could not
        // reach. Safe on a never-run handle: inFlight is null, so cancel()
        // skips session.interrupt().
        await handle.cancel();
        // Item 2: rollback ALL counters — the handle was forked but the child
        // never ran (cancelled between retry attempts). Rollback undoes total
        // and concurrentChildrenByAgent in addition to concurrent.
        budgetReceipt?.rollback();
        budgetReceipt = undefined;
        // Background: unlock + tear down the isolated worktree that will never
        // be registered (no registry entry → no markTerminal → no onCleanup).
        if (isolationTeardown && parsed.mode === 'background') {
          await teardownBackgroundWorktree(isolationTeardown).catch((e: unknown) =>
            debugLog(`[isolation] background worktree teardown failed after cancel: ${String(e)}`));
        }
        return { content: 'Agent tool call aborted', isError: true };
      }
    } catch (err) {
      const message = errorMessage(err);
      // Item 2: fork failed — rollback ALL budget counters (concurrent + total +
      // concurrentChildrenByAgent) because the child never ran.
      budgetReceipt?.rollback();
      budgetReceipt = undefined;
      // Wave manifest: unit failed because fork threw before returning a handle.
      this.updateCurrentWaveUnit(call.id, 'failed', message);
      void emitTelemetry({
        ...identity,
        event: 'subagent.failed',
        subagent_id: 'unknown',
        id_prefix: parsed.id_prefix,
        parent_session_id: this.ctx.parentSession.sessionId,
        status: 'failed',
        error_message: truncate(message),
        depth,
      });
      // Background: unlock + tear down the isolated worktree that will never
      // be registered (no registry entry → no markTerminal → no onCleanup).
      if (isolationTeardown && parsed.mode === 'background') {
        await teardownBackgroundWorktree(isolationTeardown).catch((e: unknown) =>
          debugLog(`[isolation] background worktree teardown failed after fork error: ${String(e)}`));
      }
      return {
        content: `Failed to fork subagent: ${message}`,
        isError: true,
      };
    }

    // Background-mode branch: register the (not-yet-run) handle and return a
    // synthetic pointer immediately, never awaiting runToResult. See
    // background-branch.ts for the abort/lifetime invariants moved with it.
    if (parsed.mode === 'background') {
      // Invariant: no post-run warnings for background — attachments aren't resolved
      // until the foreground path, and the child hasn't run yet.
      //
      // Manifest settlement (#1083): capture waveId and callId NOW, before
      // notifyWaveEnd() can clear this.currentWaveId. The onSettled closure
      // outlives the wave and writes the terminal status when the background
      // job finishes, preventing false resumption offers for completed work.
      const capturedWaveId = this.currentWaveId;
      const capturedCallId = call.id;
      return runBackgroundBranch({
        handle,
        registry: this.ctx.backgroundRegistry,
        prompt: parsed.prompt,
        model: childConfig.model,
        parentSessionId: this.ctx.parentSession.sessionId,
        // Intentional: updateWaveUnit (not updateCurrentWaveUnit) — the wave
        // may have ended before a background job settles (#1083).
        // Item 1 fix: onSettled handles ONLY the wave-manifest concern (needs
        // isError). budgetRelease is passed separately and wired through
        // register({ onSettled: budgetRelease }) in background-branch.ts so
        // the registry's markTerminal() fires it after cleanup — immune to the
        // registry 'settled' event ordering race.
        onSettled: capturedWaveId !== undefined
          ? (isError) => { updateWaveUnit(capturedWaveId, capturedCallId, isError ? 'failed' : 'done'); }
          : undefined,
        // Item 2: use release() not rollback() — the fork succeeded, so only
        // concurrent should decrement when the background job settles; total
        // and concurrentChildrenByAgent correctly reflect a real spawn.
        budgetRelease: budgetReceipt?.release,
        onCleanup: isolationTeardown
          ? async () => {
              const result = await teardownBackgroundWorktree(isolationTeardown);
              debugLog(`background worktree teardown: ${JSON.stringify(result)}`);
            } : undefined,
        isolationTeardown,
      });
    }

    // Invariant: assemble multimodal content only after every label, promptHead,
    // background hand-off, and other string-derived artifact above has consumed
    // parsed.prompt. This keeps image bytes out of metadata and preserves the
    // bare-string no-attachment path exactly.
    let childPrompt: string | ContentBlockParam[] = parsed.prompt;
    if (parsed.attachments !== undefined) {
      let attachments;
      try {
        attachments = await resolveSubagentAttachments({
          paths: parsed.attachments,
          resolveBase:
            childScopeInputs.parentCwd ??
            this.currentCwd ??
            childScopeInputs.parentReadRoots?.[0],
          readRoots: childScopeInputs.parentReadRoots,
          sessionId: this.ctx.parentSession.sessionId,
          registry: this.ctx.inboundAttachmentRegistry ?? inboundAttachmentRegistry,
        });
      } catch (err) {
        // Item 5: attachment resolution aborted — release the budget slot before
        // tearing down the handle. The fork succeeded (child existed) so use
        // release() not rollback() — total and concurrentChildrenByAgent correctly reflect
        // a real spawn even though it never ran a prompt.
        budgetReceipt?.release();
        budgetReceipt = undefined;
        await handle.teardown().catch(() => undefined);
        return {
          content: `Agent tool attachment resolution failed: ${errorMessage(err)}`,
          isError: true,
        };
      }
      const blocks: ContentBlockParam[] = [{ type: 'text', text: parsed.prompt }];
      appendImageBlocks(blocks, attachments);
      childPrompt = blocks;
    }

    // Foreground branch: race the run against a user-triggered promotion
    // (Ctrl+B), shape success/failure, and clean up in a finally. The
    // executor's two in-flight maps are handed in so the SubagentControl seam
    // (promote/cancel) still observes and mutates the same live entries.
    //
    // Item 4: budgetRelease (receipt.release) is threaded into
    // runForegroundWithPromotion so that on promotion, adoptRunning passes it
    // as onSettled to the registry. A `promotionTookBudget` ref is flipped
    // synchronously when adoption succeeds, so the post-call release below is
    // skipped only on that path. The fork succeeded so always use release(),
    // never rollback() — the child ran (or at least existed).
    const budgetRelease = budgetReceipt?.release;
    const promotionTookBudget = { value: false };
    const result = await runForegroundWithPromotion({
      handle,
      signal: call.signal,
      prompt: childPrompt,
      backgroundPrompt: parsed.prompt,
      idPrefix: parsed.id_prefix,
      model: childConfig.model,
      ...(this.ctx.parentModel !== undefined ? { parentModel: this.ctx.parentModel } : {}),
      childManager,
      identity,
      ...(this.ctx.traceWriter !== undefined ? { traceWriter: this.ctx.traceWriter } : {}),
      depth,
      parentSessionId: this.ctx.parentSession.sessionId,
      registry: this.ctx.backgroundRegistry,
      promotionTriggers: this.promotionTriggers,
      activeForegroundHandles: this.activeForegroundHandles,
      ...(isolationTeardown !== undefined ? { isolationTeardown } : {}),
      ...(budgetRelease !== undefined ? { budgetRelease, promotionTookBudget } : {}),
    });
    // Budget: foreground child finished — release the slot, unless the
    // promotion path deferred it to the registry's onSettled hook (Item 4).
    if (!promotionTookBudget.value) budgetRelease?.();
    const warn = collectPostRunWarnings(childConfig.model, parsed.attachments !== undefined, namedAgent?.name, parsed.prompt, childWriteCapable, supportsVision);
    if (warn && !result.isError) result.content = warn + result.content;
    // Wave manifest: update unit to 'done' or 'failed' after the foreground run.
    if (result.isError === true) {
      this.updateCurrentWaveUnit(call.id, 'failed', typeof result.content === 'string' ? result.content.slice(0, 500) : undefined);
    } else {
      this.updateCurrentWaveUnit(call.id, 'done');
    }
    return result;
  }
}
