/**
 * SubagentExecutor: provider-level handler for the Agent tool.
 *
 * Receives a ToolCall from the SessionToolDispatcher, forks a child agent
 * session via SubagentManager, runs the prompt, and returns the result as
 * a ToolResult.
 *
 * @module agent/tools/subagent-executor
 */

import type { TraceSink } from '../trace/index.js';
import type { AnthropicToolDef, ToolCall, ToolResult } from './types.js';
import { buildAgentToolDef } from '../agents/index.js';
import type { AgentExecutionMode } from './subagent/input-parse.js';
import type { BuildChildConfigArgs } from './subagent/child-config.js';
import { cancelBackgroundJob as executeBackgroundCancel } from './subagent/background-cancel.js';
import { sendMessageToAgent as executeSendMessage } from './subagent/send-message.js';
import { getBackgroundJobHealth as executeBackgroundHealth } from './subagent/background-health.js';
import { type PromotionTrigger } from './subagent/foreground-promotion.js';
import { runWithStreamCutRetry, type StreamCutProbe } from '../subagent/stream-cut-retry.js';
import { debugLog } from '../../utils/debug.js';
import { buildSubagentsLite } from './subagent-executor.lite-snapshot.js';
import { WaveManifestTracker } from './subagent-executor.wave-manifest.js';
import type { SubagentExecutorContext, SubagentControl } from './subagent-executor/types.js';
import type { QueuedNoteClaim, PromotedSubagentInfo } from './subagent-executor/types.js';
import { executeOnce as executeOnceImpl } from './subagent-executor.execute-once.js';

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
  // Wrapped in a ref object so executeOnce (subagent-executor.execute-once.ts)
  // can increment it without accessing the class directly.
  private readonly isolationCounterRef = { value: 0 };

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

  // Wave-manifest tracking delegated to WaveManifestTracker
  // (./subagent-executor.wave-manifest.ts). Public surface is unchanged.
  private readonly waveTracker = new WaveManifestTracker();

  /**
   * Called by the dispatcher BEFORE a parallel batch of ≥2 agent tool calls
   * starts. Creates a wave manifest with all units in 'pending' status.
   * Fire-and-forget: never throws.
   */
  notifyWaveStart(
    calls: ReadonlyArray<ToolCall>,
    sessionId: string,
    traceLabel: string | null,
  ): void {
    this.waveTracker.notifyWaveStart(calls, sessionId, traceLabel, this.ctx.depth, this.currentCwd);
  }

  /**
   * Called by the dispatcher AFTER all units in a parallel batch have settled.
   * Clears the wave state.
   */
  notifyWaveEnd(): void {
    this.waveTracker.notifyWaveEnd();
  }

  private updateCurrentWaveUnit(
    callId: string,
    status: 'running' | 'done' | 'failed',
    error?: string,
    cwd?: string,
  ): void {
    this.waveTracker.updateUnit(callId, status, error, cwd);
  }

  /**
   * Executor-context fields `buildChildConfig` inherits unchanged. Extracted
   * from `executeOnce` (function-size ceiling). `parentRootSessionId` (#2442)
   * falls back to this executor's live parent id, which IS the root at depth 0,
   * so depth-1 forks seed the root id their own descendants inherit.
   */
  private inheritedChildConfigArgs(): Partial<BuildChildConfigArgs> {
    const c = this.ctx;
    const rootSessionId = c.parentRootSessionId ?? c.parentSession.sessionId;
    return {
      ...(c.surface !== undefined ? { surface: c.surface } : {}),
      ...(c.allowedTools !== undefined ? { allowedTools: c.allowedTools } : {}),
      ...(c.readOnlyBash !== undefined ? { readOnlyBash: c.readOnlyBash } : {}),
      ...(c.agentRegistry !== undefined ? { agentRegistry: c.agentRegistry } : {}),
      ...(c.parentModel !== undefined ? { parentModel: c.parentModel } : {}),
      ...(c.traceWriter !== undefined ? { traceWriter: c.traceWriter } : {}),
      ...(c.workspaceStore !== undefined ? { workspaceStore: c.workspaceStore } : {}),
      ...(c.delegationBudget !== undefined ? { delegationBudget: c.delegationBudget } : {}),
      ...(rootSessionId !== undefined ? { parentRootSessionId: rootSessionId } : {}),
    };
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
    // Delegate to sibling module (subagent-executor.execute-once.ts) — extracted
    // for the file-size ceiling (#3481). All class-level state is passed
    // explicitly so the free function is testable without a full class instance.
    return executeOnceImpl(call, {
      ctx: this.ctx,
      currentCwd: this.currentCwd,
      isolationCounterRef: this.isolationCounterRef,
      waveTracker: this.waveTracker,
      promotionTriggers: this.promotionTriggers,
      activeForegroundHandles: this.activeForegroundHandles,
      cancelGeneration: this.cancelGeneration,
      inheritedChildConfigArgs: () => this.inheritedChildConfigArgs(),
      updateCurrentWaveUnit: (id, status, error, cwd) =>
        this.updateCurrentWaveUnit(id, status, error, cwd),
    }, probe, retryCancelGeneration);
  }
}
