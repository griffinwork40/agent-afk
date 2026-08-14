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
import { computeInheritedReadRoots, type ReadScopeInputs } from '../subagent-read-scope.js';
import { BackgroundAgentRegistry } from '../background-registry.js';
import type { ModelProvider } from '../provider.js';
import type { AgentModelInput, IAgentSession } from '../types.js';
import type { AgentConfig } from '../types/config-types.js';
import type { AnthropicToolDef, ToolCall, ToolResult } from './types.js';
import {
  resolveMaxNestingDepth,
  type ChildProviderFactoryArgs,
} from './nesting.js';
import { buildAgentToolDef } from '../agents/index.js';
import type { AgentRegistry, RegisteredAgent } from '../agents/index.js';
import type { SkillExecutor } from './skill-executor.js';
import { stripEscapeSequences } from '../../utils/terminal-sanitize.js';
import type { Surface } from '../awareness/types.js';
import type { TraceSink } from '../trace/index.js';
import { deriveOrigin, actorFromDepth, type TraceOrigin, type TraceActor } from '../session/session-identity.js';
import { parseAgentInput, type AgentInput, type AgentExecutionMode } from './subagent/input-parse.js';
import { emitTelemetry, truncate } from './subagent/failure-payload.js';
import { buildChildConfig } from './subagent/child-config.js';
import { runBackgroundBranch } from './subagent/background-branch.js';
import { runForegroundWithPromotion, type PromotionTrigger } from './subagent/foreground-promotion.js';
import type { QueuedNoteClaim } from './subagent/queued-note.js';
import { createIsolatedWorktree } from './handlers/worktree-managed.js';
import { runWithStreamCutRetry, type StreamCutProbe } from '../subagent/stream-cut-retry.js';
import { debugLog } from '../../utils/debug.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { appendImageBlocks } from '../content/image-blocks.js';
import { supportsVision } from '../model-capabilities.js';
import { resolveSubagentAttachments } from './subagent/attachment-resolve.js';
import { inboundAttachmentRegistry, type InboundAttachmentReader } from '../content/attachment-registry.js';
import { appendRoutingDecision } from '../routing-telemetry.js';
import { buildAgentMaxDepthRefusal } from './skill-depth-message.js';
import { collectPostRunWarnings } from './subagent-executor.write-intent.js';

export { DEFAULT_MAX_NESTING_DEPTH, type ChildProviderFactoryArgs } from './nesting.js';
export type { AgentExecutionMode };

export interface SubagentExecutorContext {
  subagentManager: SubagentManager;
  parentSession: Pick<IAgentSession, 'sessionId' | 'getInputStreamRef' | 'abortSignal'> &
    // Optional: when the parent exposes its hook registry, forked children
    // dispatch SubagentStart/Stop (incl. the shadow-verify nudge) against it
    // and inherit it. Nested stub parents omit it, so depth-2+ forks stay
    // unhooked (no nudges injected into intermediate subagents).
    Partial<Pick<IAgentSession, 'hookRegistry'>>;
  /**
   * `systemPrompt` is the raw base prompt (pre-assembly), intentionally
   * excluding TOOL_SYSTEM_PROMPT and ROUTING_DIRECTIVE — subagents are task
   * workers that must not inherit routing directives. See ComposeExecutorContext.
   */
  defaultConfig: Pick<AgentConfig, 'apiKey' | 'systemPrompt' | 'baseUrl' | 'openaiBaseUrl' | 'skillDispatchName'>;
  /**
   * User-facing surface of the session that owns this executor (cli/telegram/
   * daemon). Set at top-level wiring sites; inherited by nested child executors.
   * Recorded as `origin` on the routing-decision rows this executor emits.
   * Optional/back-compat: when unset, rows omit `origin`/`actor`. The `actor`
   * role itself is derived from {@link SubagentExecutorContext.depth}, not from
   * a separate field.
   */
  surface?: Surface;
  /**
   * Per-model credential resolver. When provided, the executor calls this
   * with the child's effective model string to resolve the appropriate API
   * key at fork time — rather than forwarding the parent's pre-captured
   * `defaultConfig.apiKey` verbatim.
   *
   * This fixes the "Anthropic child starves when parent is OpenAI-routed"
   * bug: `getApiKey()` captures a single credential keyed to the *main*
   * model at bootstrap. When the main model is OpenAI-routed, that credential
   * is an OpenAI key (or undefined), but child subagents default to `'sonnet'`
   * (Anthropic-routed) and need a keychain/env Anthropic credential instead.
   *
   * The resolver must implement the cross-provider credential anti-leak
   * invariant: Anthropic credentials must never reach OpenAI-routed
   * children (commits 263e25e2 / d17fb890 / dc58d5e0). The canonical
   * implementation is `getApiKeyForModel` from `src/cli/shared-helpers.ts`,
   * which gates on `providerForModel(model)` and routes to the correct
   * credential chain. The existing `childIsOpenAI ? undefined : apiKey`
   * guard below is ALSO preserved as a defense-in-depth layer.
   *
   * Optional for backward compat: when absent, the executor falls back to
   * `defaultConfig.apiKey` (the pre-6xx behavior).
   */
  resolveApiKeyForModel?: (model: string) => string | undefined;
  /**
   * Default model when a dispatched `agent` tool call omits `model`. Sourced
   * from `AFK_DEFAULT_SUBAGENT_MODEL`; falls back to `'sonnet'` when unset.
   * Intentionally decoupled from the parent session — a high-tier parent
   * (e.g. opus) should not silently dispatch high-tier subagents.
   */
  defaultSubagentModel?: AgentModelInput;
  childProviderFactory?: (args: ChildProviderFactoryArgs) => ModelProvider;
  childSkillExecutorFactory?: (
    depth: number,
    maxDepth: number,
    signal: AbortSignal,
    inheritedCwd?: string,
    inheritedReadScope?: ReadScopeInputs,
    skillDispatchName?: string,
  ) => SkillExecutor;
  /**
   * Nesting depth this executor sits at. **Required** — pass explicit `0`
   * at top-level wiring sites (CLI, telegram, threads) and `parent.depth + 1`
   * when constructing a child executor.
   *
   * Contract: an undefined value used to silently coerce to `0`, which
   * conflated "top-level wiring (intended)" with "misconfigured construction
   * (bug)". Making it required surfaces the second case as a TypeScript
   * compile error so the awareness layer's "depth for a top-level session is
   * null" snapshot rule (see {@link RuntimeSelf.depth}) is not undermined by
   * a silent fallback inside the fork-depth math at execute() below.
   *
   * The snapshot's `depth: null` reporting for top-level sessions is sourced
   * from `AgentConfig.depth === undefined`, not from this field — they are
   * intentionally decoupled: the runtime internally treats top-level as
   * depth 0 for nesting math, while the model-facing snapshot reports null.
   */
  depth: number;
  maxDepth?: number;
  /**
   * Optional registry for background-mode dispatches. When undefined, an
   * `agent` tool call with `mode: 'background'` falls back to a synthesized
   * error rather than silently downgrading to foreground — the operator
   * needs to see that background dispatch is not configured in this surface
   * (e.g. one-shot CLI, daemon turn).
   */
  backgroundRegistry?: BackgroundAgentRegistry;
  /**
   * Worktree cwd inherited from the parent session. Forwarded to the
   * per-depth child {@link SubagentManager} and to the recursive child
   * {@link SubagentExecutor} so depth ≥ 2 forks (a depth-1 subagent calling
   * the `agent` tool) keep operating in the worktree instead of falling
   * back to the Node host's `process.cwd()`.
   *
   * Invariant: depth-1 forks already inherit cwd because the parent's root
   * SubagentManager was constructed with it (see bootstrap.ts:158,
   * chat.ts:376). The bug this field fixes is silent at depth ≥ 2 — the
   * child manager constructed below was not receiving cwd, so its forks'
   * bash/grep/read_file fell back to the host repo. Same shape as the
   * SkillExecutorContext.cwd fix; see skill-executor.ts.
   *
   * Optional: surfaces without a worktree (telegram, threads without an
   * explicit cwd) leave this unset and the legacy `process.cwd()` fallback
   * applies.
   */
  cwd?: string;
  /**
   * Witness-layer trace writer inherited from the owning surface. Forwarded
   * into the per-call child {@link SubagentManager} built by
   * `buildChildConfig` so depth ≥ 2 `agent` forks (a depth-1 subagent calling
   * the `agent` tool) emit `subagent_lifecycle` events into the same trace
   * file as the root session. Depth-1 forks are covered separately by the
   * root manager's own manager-level writer (bootstrap/chat/telegram wiring);
   * this field closes the same gap for the nested managers, mirroring how
   * `cwd` chains through every depth.
   */
  traceWriter?: TraceSink;
  /**
   * Tool allowlist to propagate to grandchild providers when this executor
   * is itself a read-only skill's child. Forwarded into `childProviderFactory`
   * so the read-only constraint survives `agent` fan-out (depth ≥ 2).
   * When undefined, `childProviderFactory` defaults to `CHILD_ALLOWED_TOOLS`.
   */
  allowedTools?: string[];
  /**
   * When true, the mutating-bash gate is forwarded to grandchild providers.
   * Set together with `allowedTools` for read-only skill fan-out propagation.
   */
  readOnlyBash?: boolean;
  /**
   * Nested-dispatch allowlist for the agent that OWNS this executor. Set when
   * the dispatching agent declared a scoped `Agent(x)` grant (e.g.
   * research-agent's `Agent(git-investigator)`, surfaced by resolve.ts as
   * `nestedAgentTypes`). When present, {@link SubagentExecutor.execute} rejects
   * any `agent_type` not in the list — and any bare/no-type dispatch — before a
   * fork happens. An EMPTY array `[]` is a deny-all (from an `Agent()` grant):
   * the check is on presence, not length, so `[]` matches nothing and rejects
   * every dispatch. `undefined` = no restriction (top-level executors, or an
   * inherit-all / bare-`Agent` agent).
   *
   * Why this is the safety boundary: a dispatched child's own grandchild
   * executor inherits the parent CAGE ({@link allowedTools}), NOT the child's
   * definition (see the childExecutor wiring below). At top level that cage is
   * unrestricted, so a read-only agent granted the `agent` tool could otherwise
   * spawn an unrestricted `general-purpose` (or bare) grandchild with full
   * bash/write. This allowlist scopes the child to exactly the leaf agents its
   * definition named — each of which is self-caged by its own definition.
   */
  nestedAgentAllowlist?: readonly string[];
  /**
   * Session-wide named-agent registry (see `agent/agents/`). When present,
   * the `agent` tool accepts an `agent_type` (alias `subagent_type`) input
   * that dispatches the named definition: its body becomes the child's
   * system prompt, its resolved tool allowlist is mechanically enforced at
   * the child provider's permission gate, and its `model`/`maxTurns` act as
   * defaults under explicit per-call values. Threaded by reference through
   * nested executors so depth ≥ 2 dispatches resolve the same registry.
   * When absent, `agent_type` inputs fail with an "available: (none)" error
   * and the legacy dispatch path is byte-identical.
   */
  agentRegistry?: AgentRegistry;
  /** Read-only session attachment lookup; paths are loaded only at dispatch. */
  inboundAttachmentRegistry?: InboundAttachmentReader;
  /**
   * The dispatching session's own model. Used to resolve a named agent's
   * `model: inherit` (and the omitted-model default for NAMED dispatches,
   * Claude Code parity). Distinct from `defaultSubagentModel`, which is the
   * cost-policy default for UNNAMED dispatches and stays authoritative for
   * them. When unset, `inherit` falls back to the policy default chain.
   */
  parentModel?: AgentModelInput;
}

/** Identity of a subagent that was promoted from foreground to background. */
export interface PromotedSubagentInfo {
  jobId: string;
  label: string;
}

/**
 * Narrow control seam exposed to the keyboard / REPL layer for user-triggered
 * promotion of a running foreground subagent to a detached background job
 * (Ctrl+B). Deliberately minimal — one query + one command — so the keyboard
 * never reaches into `SubagentHandle`, the manager's active map, or abort
 * internals. The composition root (bootstrap) injects the executor as a
 * `SubagentControl` into the turn handler's handles bag; the keyboard layer
 * depends only on this interface.
 *
 * Invariant: the only sanctioned cross-layer dependency from `src/cli/**`
 * onto subagent control is this interface. See the architectural boundary
 * test that forbids `src/cli/**` from importing `SubagentHandleImpl`, reading
 * `.active`, or calling `.promote(`.
 */
export interface SubagentControl {
  /**
   * True iff at least one foreground subagent dispatched by this executor is
   * currently running AND can be promoted (a `BackgroundAgentRegistry` is
   * wired). The keyboard uses this to decide whether Ctrl+B promotes the
   * in-flight subagent(s) or falls back to whole-turn backgrounding.
   */
  hasPromotableForeground(): boolean;
  /**
   * Promote every in-flight foreground subagent to a detached background job.
   * Resolves once each promotion has been handed to the registry. Entries that
   * could not be promoted (the subagent completed in the same tick, or the
   * background-job cap was hit) are omitted from the returned array.
   *
   * `queuedNote` optionally carries the REPL user's typed-ahead messages so they
   * reach the parent's still-running turn on the same keypress that backgrounded
   * the subagent (riding the synthetic promotion `tool_result`). The ticket is
   * shared across every trigger, so the note is folded in at most once. The
   * caller MUST re-read `queuedNote.claimed` after this resolves and keep its
   * message queued when it is still `false` — an unclaimed note means nothing
   * was promoted and the text has nowhere to ride.
   */
  promoteActiveForeground(queuedNote?: QueuedNoteClaim): Promise<PromotedSubagentInfo[]>;
  /**
   * True iff at least one foreground subagent dispatched by this executor is
   * currently in flight. Unlike {@link hasPromotableForeground} this does NOT
   * require a `BackgroundAgentRegistry` — cancellation is always available. The
   * keyboard layer reads this to decide whether a soft-stop (ESC / first Ctrl+C)
   * must cancel in-flight subagents to unblock a turn suspended on a subagent
   * `await`.
   */
  hasActiveForeground(): boolean;
  /**
   * Cancel every in-flight foreground subagent dispatched by this executor.
   * Each cancellation resolves the subagent's suspended `runToResult` (as a
   * failed result carrying any streamed partial output), which lets the parent
   * turn's tool-use loop unblock and observe the pending soft-stop so the turn
   * ends cleanly instead of hanging for the subagent's entire lifetime (up to
   * the 2h usage-limit cap). Returns the number of subagents cancelled; a no-op
   * returning 0 when none are in flight.
   */
  cancelActiveForeground(): Promise<number>;
}

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

  hasPromotableForeground(): boolean {
    return this.ctx.backgroundRegistry !== undefined && this.promotionTriggers.size > 0;
  }

  hasActiveForeground(): boolean {
    return this.activeForegroundHandles.size > 0;
  }

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
  getSubagentsLite(): {
    active: Array<{
      id: string;
      status: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    }>;
    backgroundJobs: Array<{
      jobId: string;
      status: 'running' | 'completed' | 'failed' | 'cancelled';
      startedAt: string;
      label: string | null;
    }>;
  } {
    const active = this.ctx.subagentManager
      .list()
      .map((h) => ({ id: h.id, status: h.status }));
    const backgroundJobs = this.ctx.backgroundRegistry
      ? this.ctx.backgroundRegistry.list().map((j) => ({
          jobId: j.jobId,
          status: j.status,
          startedAt: new Date(j.startedAt).toISOString(),
          label: j.label.length > 0 ? j.label : null,
        }))
      : [];
    return { active, backgroundJobs };
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
      return {
        content: 'Agent tool call aborted',
        isError: true,
      };
    }

    let parsed: AgentInput;
    try {
      parsed = parseAgentInput(call.input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
      ...(this.ctx.traceWriter !== undefined ? { traceWriter: this.ctx.traceWriter } : {}),
      createChildExecutor: (childCtx) => new SubagentExecutor(childCtx),
    });

    // Stream-cut retry eligibility (see `execute()`): a re-dispatch re-runs the
    // whole prompt, so it is only safe when the child cannot mutate anything.
    // This is stricter than `!childWriteCapable`: non-file tools can mutate
    // remote or persistent state too, so the entire surface must be pure-read.
    if (probe !== undefined) probe.sideEffectFree = childSideEffectFree;

    // isolation:"worktree" — fork the child inside a fresh managed git worktree
    // so its writes/tests never collide with siblings sharing the parent tree.
    // Skipped (no-op) for read-only children, which have nothing to isolate.
    // Torn down in the foreground finally — a dirty / commits-ahead tree is
    // preserved and locked, never destroyed. Forbidden with mode:'background'
    // at parse time (a detached child would outlive the teardown that reclaims
    // its worktree — proposal Open Q1). Only the direct child's cwd is
    // isolated; deeper (grandchild) fan-out anchors at the parent tree for now.
    let isolationTeardown: { repoRoot: string; worktreePath: string } | undefined;
    if (parsed.isolation === 'worktree') {
      if (!childWriteCapable) {
        debugLog(
          `[isolation] skipped worktree for read-only dispatch ` +
            `(agent_type=${parsed.agent_type ?? 'generic'}) — nothing to isolate`,
        );
      } else {
        const anchorCwd = this.currentCwd ?? process.cwd();
        try {
          const iso = await createIsolatedWorktree({
            cwd: anchorCwd,
            slugHint: `iso-${parsed.id_prefix}-${++this.isolationCounter}-${Math.random().toString(36).slice(2, 8)}`,
          });
          childConfig.cwd = iso.path;
          isolationTeardown = { repoRoot: iso.repoRoot, worktreePath: iso.path };
        } catch (err) {
          // Fail loud: never silently fall back to the shared tree — that
          // reintroduces the cross-contamination bug isolation exists to
          // prevent (parallel siblings clobbering each other's edits/tests).
          const message = err instanceof Error ? err.message : String(err);
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
        denyElicitations: true,
      });
      // Backfill: give the depth-1 child executor a real parentId so any
      // depth-2 forks it spawns carry handle.id as their parentId.
      if (childParentSession !== undefined) {
        childParentSession.sessionId = handle.id;
      }
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
        return { content: 'Agent tool call aborted', isError: true };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
      return runBackgroundBranch({
        handle,
        registry: this.ctx.backgroundRegistry,
        prompt: parsed.prompt,
        model: childConfig.model,
        parentSessionId: this.ctx.parentSession.sessionId,
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
        await handle.teardown().catch(() => undefined);
        return {
          content: `Agent tool attachment resolution failed: ${err instanceof Error ? err.message : String(err)}`,
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
    });
    const warn = collectPostRunWarnings(childConfig.model, parsed.attachments !== undefined, namedAgent?.name, parsed.prompt, childWriteCapable, supportsVision);
    if (warn && !result.isError) result.content = warn + result.content;
    return result;
  }
}
