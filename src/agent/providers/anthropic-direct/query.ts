/**
 * `ProviderQuery` for the `anthropic-direct` provider.
 *
 * Owns the **multi-turn outer loop** across user inputs:
 *   1. Synthesizes a `session.init` event before any user input arrives so
 *      `waitForInitialization()` resolves without a round-trip — Anthropic
 *      itself only assigns nothing here (we mint our own UUID).
 *   2. Pulls user turns from the harness `promptStream` one at a time, races
 *      against an internal `closedPromise` so `close()` unblocks a pending
 *      `next()`.
 *   3. Builds a fresh `AbortController` per turn (with `interrupt()` /
 *      `close()` early-abort handling), composes the OAuth-recipe headers +
 *      system prefix + `messages.create` params, and delegates the per-turn
 *      agentic loop to {@link runTurn}.
 *   4. Maintains a single `messages: MessageParam[]` array across turns —
 *      `runTurn` mutates it in place to append assistant + tool_result
 *      rounds, so the next iteration sees the full history.
 *
 * Imperative methods (`setModel`, `setPermissionMode`, `supportedModels`, ...)
 * are intentionally minimal: model is per-call so `setModel` only mutates the
 * stored value, and discovery methods return empty/static data so the
 * harness stays provider-agnostic. `setPermissionMode` updates a live field
 * read by {@link AnthropicDirectQuery.composeSystem} each turn — when the
 * mode is `'plan'`, a posture addendum is appended to the system payload
 * so the model knows planning is the only legal output (writes are still
 * refused at the hook layer; see `agent/plan-mode-gate`).
 *
 * @module agent/providers/anthropic-direct/query
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';
import { randomUUID } from 'node:crypto';
import { pathContainmentBypassed } from '../../permission-policy.js';
import type {
  ProviderAccountInfo,
  ProviderAgentInfo,
  ProviderCommandInfo,
  ProviderCompactResult,
  ProviderContextUsage,
  ProviderEvent,
  ProviderMcpServerStatus,
  ProviderModelInfo,
  ProviderQuery,
  ProviderRewindResult,
  ProviderSessionInfo,
  ProviderUserTurn,
} from '../../provider.js';
import { buildRequestHeaders } from './auth.js';
import {
  getCacheTtl,
  isCacheEnabled,
  withSystemBreakpoint,
} from './cache-policy.js';
import { buildPlanModeAddendumBlock } from './plan-mode-addendum.js';
import { buildAfkModeAddendumBlock } from './afk-mode-addendum.js';
import { collectSupportedCommands } from '../shared/supported-commands.js';
import { contextLimitFor } from '../../model-limits.js';
import { resolveModelId } from '../../session/model-resolution.js';
import type { ToolDispatcher } from './tool-dispatcher.js';
import type {
  AnthropicClientLike,
  AnthropicToolDef,
  AuthMode,
  RunTurnInput,
} from './types.js';
import { repairOrphanToolUses } from './query/repair-orphan-tool-uses.js';
import { type SessionState, createSessionState } from './query/session-state.js';
import { AbortCoordinator } from './query/abort-coordinator.js';
import { RetryLayer } from './query/retry-layer.js';
import { compactHistory } from './query/compact-handler.js';
import { contextWindowTokensUsed, shouldAutoCompact, buildContextUsageFields } from './query/auto-compact.js';
import type { HookRegistry } from '../../hooks.js';
import { HookBlockedError } from '../../../utils/errors.js';

/**
 * Small static starter list returned by `supportedModels()`. The provider
 * accepts arbitrary Claude model ids at runtime — this is only a hint for UI
 * surfaces that want a quick dropdown.
 */
const STARTER_MODELS: ReadonlyArray<{ value: string; displayName: string; description: string }> = [
  {
    value: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    description: 'Latest balanced Claude — recommended default',
  },
  {
    value: 'claude-opus-4-5-20250929',
    displayName: 'Claude Opus 4.5',
    description: 'Highest-capability Claude',
  },
  {
    value: 'claude-haiku-4-5-20250929',
    displayName: 'Claude Haiku 4.5',
    description: 'Fastest, cheapest Claude',
  },
];

/** Constructor options for {@link AnthropicDirectQuery}. */
export interface AnthropicDirectQueryOptions {
  client: Anthropic;
  authMode: AuthMode;
  promptStream: AsyncIterable<ProviderUserTurn>;
  toolDispatcher: ToolDispatcher;
  sessionId?: string;
  initialMessages?: MessageParam[];
  model: string;
  /**
   * The model the caller requested — a short alias (`opus_1m`, `sonnet`, …)
   * or a full id. When omitted, defaults to `model`. Carries the alias so the
   * context-window lookup can distinguish 1M variants (`opus_1m`) from their
   * base (`opus`), which resolve to the same wire `model` but have different
   * windows. See {@link SessionState.requestedModel}.
   */
  requestedModel?: string;
  permissionMode?: string;
  maxTokens: number;
  tools: AnthropicToolDef[] | null;
  userSystem: string | null;
  systemPrefix: ContentBlockParam[] | null;
  /** When set, called on 401 to obtain a fresh SDK client. Retry once. */
  tokenRefresher?: () => Promise<Anthropic | null>;
  /** Extended thinking configuration forwarded to `messages.create`. */
  thinking?: import('@anthropic-ai/sdk/resources').ThinkingConfigParam;
  /**
   * Effort level forwarded as `output_config.effort` to `messages.create`.
   * When set, the per-request `anthropic-beta` header is extended with the
   * effort beta string via the `withEffort` flag on `buildRequestHeaders`.
   */
  effort?: import('../../types/sdk-types.js').EffortLevel;
  /**
   * Local-server base URL. When set, prompt-cache markers are suppressed
   * across all turns (see `isCacheEnabled({baseUrl})`).
   */
  baseUrl?: string;
  /**
   * Hard cap on tool-use loop iterations within a single user turn, forwarded
   * to `runTurn` as `RunTurnInput.maxToolUseIterations`. Unset/`0` means no cap
   * (the top-level default); subagent forks pass a non-zero ceiling so a
   * runaway child cannot spin unboundedly while the parent awaits its result.
   */
  maxToolUseIterations?: number;
  /** Witness-layer trace writer threaded into each per-turn run. */
  traceWriter?: import('../../trace/index.js').TraceWriter;
  /**
   * When true (default), the query automatically waits for the OAuth
   * subscription reset and replays the in-flight turn on 429 usage-limit
   * errors instead of surfacing them immediately.
   */
  autoResumeOnUsageLimit?: boolean;
  /**
   * Factory for rebuilding the cwd-dependent pair (userSystem + dispatcher)
   * when `setCwd()` is called mid-session. When absent, `setCwd()` is a
   * no-op (e.g. external-dispatcher callers that own their own lifecycle).
   *
   * The factory is supplied by `AnthropicDirectProvider.query()` as a
   * closure over the stable parts of the system prompt (toolBase,
   * MEMORY_SYSTEM_PROMPT, manifest, userSystemPart) that do not change when
   * the cwd changes. Only the `# Environment\n- Working directory:` line
   * and the bash/grep/glob handler closures need to be rebuilt.
   */
  cwdDependentsFactory?: (cwd: string) => { userSystem: string; dispatcher: ToolDispatcher };
  /**
   * Provider callback invoked by `setPermissionMode()` to update the
   * provider-level `_currentPermissionMode` — the field the path-approval hook
   * reads via the provider's `getGrants().allowAll`. This is the path-approval
   * half of a live `/bypass` toggle; the file-tool half is the dispatcher's
   * `setAllowAll()`. Supplied by `AnthropicDirectProvider.query()`.
   */
  onPermissionMode?: (mode: string) => void;
  /**
   * Optional MCP manager — used by `session.init` and `mcpServerStatus()`
   * to surface live MCP server status to the REPL (`/mcp`), the Telegram
   * bridge, and the daemon's state file. The query itself does NOT call
   * into the manager beyond reading status; tool dispatch is handled via
   * the merged handler map in the dispatcher (set up in
   * `AnthropicDirectProvider.buildDispatcher`).
   */
  mcpManager?: import('../../mcp/index.js').McpManager;
  /**
   * Auto-compaction threshold (fraction of context window, 0–1 exclusive).
   * When provided, the turn loop triggers compact() automatically after
   * any turn whose token footprint exceeds this fraction of the model's
   * context limit. Guarded by abort.isIdle() and the compact-handler lock.
   * undefined means auto-compaction is disabled (the default).
   */
  autoCompactThreshold?: number;
  /**
   * Hook registry forwarded from the session harness. When present, the
   * auto-compact path dispatches `PreCompact(trigger:'auto')` before calling
   * `compact()`, matching the manual-compact paths in the REPL and Telegram
   * surfaces. A `block` decision (HookBlockedError) skips compaction for that
   * turn without surfacing an error to the caller.
   */
  hookRegistry?: HookRegistry;
}

/**
 * Per-session `ProviderQuery` for the direct Anthropic SDK adapter.
 *
 * Constructed synchronously by {@link AnthropicDirectProvider.query}; the
 * outer `for await` loop is driven by the harness via the async-iterable
 * lane. Owns no SDK lifecycle of its own beyond the per-turn `messages.create`
 * calls and the per-turn `AbortController`.
 */
export class AnthropicDirectQuery implements ProviderQuery {
  private readonly initSessionId: string;
  private readonly promptStream: AsyncIterable<ProviderUserTurn>;
  /**
   * Mutable: updated by {@link updateCwdDependents} when the session's
   * working directory changes mid-session (e.g. after worktree rename).
   * Rebuilt by `AnthropicDirectProvider.setCwd()` and flushed here so
   * the next `composeSystem()` call picks up the new cwd line without
   * requiring a session reset.
   */
  private readonly maxTokens: number;
  private readonly tools: AnthropicToolDef[] | null;
  private readonly systemPrefix: ContentBlockParam[] | null;
  private readonly thinking?: import('@anthropic-ai/sdk/resources').ThinkingConfigParam;
  private readonly effort?: import('../../types/sdk-types.js').EffortLevel;
  private readonly baseUrl?: string;
  private readonly maxToolUseIterations?: number;
  private readonly traceWriter?: import('../../trace/index.js').TraceWriter;

  /**
   * Per-session mutable state — see {@link SessionState}. Held as a
   * single bag so the orchestrator's invariants live in one place and
   * future extractions (compact, abort, retry) can be passed the same
   * reference without each carrying its own copy.
   *
   * `userSystem` and `toolDispatcher` are mutable here even though they
   * look like construction-time values — `setCwd()` flushes both in
   * place so the next turn picks up the new working directory.
   *
   * `messages` is a stable array reference: `runTurn` mutates it in
   * place and `compact()` splices it; never reassign.
   */
  private readonly state: SessionState;

  /**
   * Per-session abort coordination — see {@link AbortCoordinator}.
   * Owns the only write path to the current-controller slot via
   * `abort.clear(controller)`; `abort.begin()` mints fresh controllers
   * and drains queued `interrupt()` / `close()` reasons onto them.
   */
  private readonly abort: AbortCoordinator;
  /**
   * Wraps `runTurn` with the OAuth-aware retry tiers (429 usage-limit
   * and 401 auth refresh). Owns the writable SDK client; the orchestrator
   * reads the current value via `this.retry.client` for paths like
   * `compact()` that bypass `runTurn`.
   */
  private readonly retry: RetryLayer;
  private readonly cwdDependentsFactory?: (cwd: string) => { userSystem: string; dispatcher: ToolDispatcher };
  private readonly onPermissionMode?: (mode: string) => void;
  private readonly mcpManager?: import('../../mcp/index.js').McpManager;
  private readonly hookRegistry?: HookRegistry;

  constructor(opts: AnthropicDirectQueryOptions) {
    this.initSessionId = opts.sessionId ?? randomUUID();
    this.promptStream = opts.promptStream;
    this.maxTokens = opts.maxTokens;
    this.tools = opts.tools;
    this.systemPrefix = opts.systemPrefix;
    this.thinking = opts.thinking;
    if (opts.effort !== undefined) this.effort = opts.effort;
    if (opts.baseUrl !== undefined) this.baseUrl = opts.baseUrl;
    if (opts.maxToolUseIterations !== undefined)
      this.maxToolUseIterations = opts.maxToolUseIterations;
    this.traceWriter = opts.traceWriter;
    this.cwdDependentsFactory = opts.cwdDependentsFactory;
    this.onPermissionMode = opts.onPermissionMode;
    this.mcpManager = opts.mcpManager;
    if (opts.hookRegistry !== undefined) this.hookRegistry = opts.hookRegistry;
    this.retry = new RetryLayer({
      client: opts.client,
      authMode: opts.authMode,
      initSessionId: this.initSessionId,
      ...(opts.tokenRefresher ? { tokenRefresher: opts.tokenRefresher } : {}),
      autoResumeOnUsageLimit: opts.autoResumeOnUsageLimit ?? true,
    });
    this.state = createSessionState({
      model: opts.model,
      ...(opts.requestedModel !== undefined ? { requestedModel: opts.requestedModel } : {}),
      permissionMode: opts.permissionMode ?? 'default',
      userSystem: opts.userSystem,
      toolDispatcher: opts.toolDispatcher,
      ...(opts.initialMessages ? { initialMessages: opts.initialMessages } : {}),
      ...(opts.autoCompactThreshold !== undefined ? { autoCompactThreshold: opts.autoCompactThreshold } : {}),
    });
    this.abort = new AbortCoordinator();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    const info: ProviderSessionInfo = {
      sessionId: this.initSessionId,
      model: this.state.currentModel,
      permissionMode: this.state.currentPermissionMode,
      cwd: process.cwd(),
      tools: [],
      slashCommands: [],
      skills: [],
      plugins: [],
      // Live MCP server status — `/mcp` reads `meta.mcpServers` (set by the
      // session harness from this field) to render the connection summary.
      // When no manager is wired, an empty list is the right answer (no
      // MCP support in this session).
      mcpServers: this.mcpManager?.getServerStates().map((s) => ({
        name: s.serverName,
        status: s.status,
      })) ?? [],
      apiKeySource: this.retry.authMode,
      version: 'anthropic-direct-v1',
    };
    yield { type: 'session.init', info };

    const promptIterator = this.promptStream[Symbol.asyncIterator]();
    try {
      while (!this.state.closed) {
        const nextOrClose = await Promise.race([
          promptIterator.next(),
          this.abort.closedPromise,
        ]);
        if (nextOrClose === '__closed__') break;
        const turnResult = nextOrClose as IteratorResult<ProviderUserTurn>;
        if (turnResult.done) break;
        const turn = turnResult.value;

        const controller = this.abort.begin();
        if (controller.signal.aborted) {
          // Early-return path: the per-turn try/finally below has not been
          // entered yet, so clear the slot here. `abort.clear()` is the
          // only write path to null and uses compare-and-clear so a
          // parallel scope replacing the slot is preserved.
          //
          // This fires only when `begin()` drained a pending abort onto the
          // fresh controller — i.e. an `interrupt()`/`close()` that arrived
          // BETWEEN turns (no live controller to fire on). The REPL never
          // interrupts between turns (the ESC soft-stop handler is per-turn
          // and `handleSigint` fires only while `turnInFlight`), so unlike the
          // mid-turn abort handled below, terminating here is correct and
          // expected (covered by anthropic-direct.test.ts's pendingAbort +
          // compact-not-blocked guards).
          this.abort.clear(controller);
          return;
        }

        // Self-heal history before appending the new user turn. If the
        // previous turn ended with an assistant message carrying any
        // unmatched `tool_use` blocks (e.g. an interrupt that fired between
        // the tool-use push and the tool_result push, or a corrupted
        // session restored from disk), Anthropic's Messages API will 400
        // this request with `tool_use ids were found without tool_result
        // blocks immediately after`. Synthesize cancelled tool_result
        // placeholders so the API contract holds and the user can continue.
        repairOrphanToolUses(this.state.messages);

        // Append the new user turn to history. Strings and content-block
        // arrays both ride through as-is — Anthropic's MessageParam accepts
        // either shape natively.
        this.state.messages.push({ role: 'user', content: turn.content });

        const system = this.composeSystem();
        const headers = buildRequestHeaders(
          this.retry.authMode,
          this.initSessionId,
          randomUUID(),
          this.effort !== undefined,
        );

        const runInput: RunTurnInput = {
          // The SDK's `messages.create` overloads narrow on the `stream`
          // literal; our pinned `AnthropicClientLike` shape is the
          // streaming-only subset we actually call. Cast at the boundary.
          client: this.retry.client as unknown as AnthropicClientLike,
          messages: this.state.messages,
          system,
          tools: this.tools,
          toolDispatcher: this.state.toolDispatcher,
          model: this.state.currentModel,
          maxTokens: this.maxTokens,
          headers,
          signal: controller.signal,
          ctx: { sessionId: this.initSessionId },
          ...(this.thinking !== undefined ? { thinking: this.thinking } : {}),
          ...(this.effort !== undefined ? { effort: this.effort } : {}),
          ...(this.baseUrl !== undefined ? { baseUrl: this.baseUrl } : {}),
          ...(this.maxToolUseIterations !== undefined
            ? { maxToolUseIterations: this.maxToolUseIterations }
            : {}),
          ...(this.traceWriter ? { traceWriter: this.traceWriter } : {}),
          onUsageProgress: (usage) => { this.state.lastUsage = usage; },
        };

        // Tracks whether THIS turn yielded a terminal event (`turn.completed`
        // → 'done', or `error`). The abort handling below synthesizes a
        // terminal event only when the turn produced none, so the consumer's
        // `providerIterator.next()` loop is never advanced past a turn it
        // already saw end.
        let turnEmittedTerminal = false;
        try {
          for await (const event of this.retry.turnWithRetries(runInput, () => this.state.closed)) {
            if (this.state.closed) return;
            if (event.type === 'turn.completed') {
              this.state.lastUsage = event.usage;
              // Constraint: this generator suspends at `yield event` below.
              // If the consumer breaks on `turn.completed` (e.g. AgentSession's
              // sendMessageStream loop breaks on `done`) without pulling again,
              // the outer finally never runs and the abort slot stays non-null
              // between turns — which `compact()` treats as `turn-in-flight`.
              // Clear eagerly so any inter-turn observer (compact, status,
              // telemetry) sees an idle coordinator regardless of when the
              // generator is resumed.
              this.abort.clear(controller);
            }
            if (event.type === 'turn.completed' || event.type === 'error') {
              turnEmittedTerminal = true;
            }
            yield event;
          }
        } catch (err) {
          // Invariant: a `close()` terminates this generator; an `interrupt()`
          // (ESC soft-stop) must NOT — it aborts the current turn but keeps the
          // session alive for the next message. Both abort the per-turn
          // controller, so distinguish on `state.closed` (only `close()` sets
          // it), NOT on `signal.aborted` (true for both). Returning on
          // interrupt is the "can't resume after ESC" bug: it permanently ends
          // the shared provider iterator (AgentSession reuses ONE iterator
          // across turns), so every later `sendMessageStream` gets `{done:true}`
          // and silently runs no turn while slash commands — which bypass the
          // iterator — keep working.
          if (this.state.closed) return;
          if (controller.signal.aborted) {
            this.abort.clear(controller);
            // `loop.ts` yields `turn.completed` on a graceful mid-stream abort,
            // so a terminal event is usually already delivered. Synthesize one
            // only if the throw pre-empted it, so the consumer unwinds instead
            // of hanging on a `next()` that never resolves.
            if (!turnEmittedTerminal) yield this.makeInterruptedTurnEvent();
            continue;
          }
          const e = err instanceof Error ? err : new Error(String(err));
          yield { type: 'error', error: e };
          return;
        } finally {
          this.abort.clear(controller);
        }

        // A turn that exits the loop CLEANLY (no throw) while the signal is
        // aborted is an interrupt: `loop.ts` handles a mid-stream abort by
        // yielding `turn.completed` and returning, and an interrupt during the
        // usage-limit auto-resume wait makes the retry layer return cleanly
        // (retry-layer's `if (result === 'aborted') return`) with NO terminal
        // event. In both cases the session must survive — only `close()`
        // (state.closed) terminates the generator. Emit a terminal event if
        // the turn produced none (the usage-limit-wait case — the hang behind
        // commit c462ebd, which `return` fixed at the cost of bricking resume),
        // then loop back for the next prompt. (`abort.clear` in the finally
        // nulls the slot but does NOT reset `signal.aborted`.)
        if (this.state.closed) return;
        if (controller.signal.aborted) {
          if (!turnEmittedTerminal) yield this.makeInterruptedTurnEvent();
          continue;
        }

        // Auto-compaction: fire at the natural turn boundary — after the
        // per-turn event loop exits and the abort slot is cleared — so we
        // never trigger while a tool call is in flight.
        //
        // External constraint: abort.isIdle() MUST be true here (cleared by
        // abort.clear(controller) in the finally above) so compact-handler's
        // own isIdle() guard passes and the 'turn-in-flight' bail is not hit
        // spuriously. Do not move this block into the inner for-await —
        // compact() mutates state.messages in place and must only run at a
        // clean turn boundary, never mid-tool-call.
        if (this.state.autoCompactThreshold !== undefined && !this.state.closed) {
          const usage = this.state.lastUsage;
          // requestedModel (not the wire currentModel) so 1M aliases use their
          // true window — opus_1m resolves to the same wire id as opus but must
          // compact at ~90% of 1M, not 200k.
          const contextLimit = contextLimitFor(this.state.requestedModel);
          if (usage !== null && contextLimit > 0) {
            // Use the context-window footprint (input + cache_read +
            // cache_creation + output for the last round), NOT input+output
            // alone — Anthropic's input_tokens excludes cache, so the cached
            // conversation prefix (often the bulk of the window) must be
            // counted or compaction never fires before the window overflows.
            const usedTokens = contextWindowTokensUsed(usage);
            if (shouldAutoCompact(usedTokens, contextLimit, this.state.autoCompactThreshold)) {
              // Fire-and-await: compact() is async but we hold the turn
              // boundary here (generator suspended at promptIterator.next()
              // on the next iteration). Awaiting inline keeps the ordering
              // deterministic and avoids a dangling promise race.
              //
              // Invariant: dispatch PreCompact(trigger:'auto') BEFORE compact()
              // so registered hooks can block or observe the operation, mirroring
              // the manual-compact paths in REPL (/compact) and Telegram. A block
              // decision throws HookBlockedError — caught here to skip compaction
              // for this turn without propagating to the outer error handler.
              try {
                if (this.hookRegistry) {
                  await this.hookRegistry.dispatch({
                    event: 'PreCompact',
                    sessionId: this.initSessionId,
                    trigger: 'auto',
                  });
                }
                await this.compact();
              } catch (compactErr) {
                if (compactErr instanceof HookBlockedError) {
                  // Hook blocked auto-compaction — skip this turn's compaction
                  // without surfacing an error; the session continues normally.
                } else {
                  throw compactErr;
                }
              }
            }
          }
        }
      }
    } catch (iterErr) {
      const e = iterErr instanceof Error ? iterErr : new Error(String(iterErr));
      yield { type: 'error', error: e };
    } finally {
      try {
        await promptIterator.return?.();
      } catch {
        // best-effort cleanup
      }
    }
  }

  /**
   * Build the `system` parameter for `messages.create`. Combines the OAuth
   * billing-header prefix (when present) with the user-supplied system
   * prompt, then stamps a prompt-cache breakpoint on the last block so the
   * stable `tools + system` prefix is reused across the entire session
   * (cache caches in order tools → system → messages, so a single
   * end-of-system breakpoint covers both). Returns `null` when neither
   * side has anything to contribute — the loop omits the field entirely.
   */
  private composeSystem(): ContentBlockParam[] | null {
    const prefix = this.systemPrefix;
    const userSys = this.state.userSystem;
    const blocks: ContentBlockParam[] = [];
    if (prefix && prefix.length > 0) blocks.push(...prefix);
    if (userSys && userSys.length > 0) {
      blocks.push({ type: 'text', text: userSys });
    }
    // Plan-mode / AFK-mode posture: appended as the *last* block so the cache
    // breakpoint stamper lands on it. Toggling mode mid-session busts the cache
    // exactly once (correct); same-mode turns hit cleanly. The two modes are
    // mutually exclusive permission-mode values, so at most one block is added.
    const planBlock = buildPlanModeAddendumBlock(this.state.currentPermissionMode);
    if (planBlock !== null) blocks.push(planBlock);
    const afkBlock = buildAfkModeAddendumBlock(this.state.currentPermissionMode);
    if (afkBlock !== null) blocks.push(afkBlock);
    if (blocks.length === 0) return null;
    if (!isCacheEnabled({ baseUrl: this.baseUrl })) return blocks;
    return withSystemBreakpoint(blocks, getCacheTtl());
  }

  async interrupt(): Promise<void> {
    this.abort.requestAbort('interrupted');
  }

  /**
   * Synthetic terminal event for an interrupted turn that yielded none of its
   * own. The harness consumer (`AgentSession.sendMessageStreamInternal`) breaks
   * its shared-`providerIterator.next()` loop only on a terminal output
   * (`turn.completed` → 'done', or `error`); without one it strands on a
   * `next()` that never resolves. `loop.ts` already yields `turn.completed` on
   * a normal mid-stream abort, but an interrupt during the usage-limit
   * auto-resume wait makes the retry layer return cleanly with NO terminal
   * event — this fills that gap so the turn unwinds while the session stays
   * alive for the next prompt. Mirrors the OpenAI-compatible provider's
   * `finishTurn` (openai-compatible/query.ts). Minimal usage (no
   * `totalCostUsd`) so the budget gate in `transformProviderEvent` is skipped.
   */
  private makeInterruptedTurnEvent(): ProviderEvent {
    return {
      type: 'turn.completed',
      usage: { stopReason: 'interrupted', resultSubtype: 'interrupted', isError: false },
      sessionId: this.initSessionId,
    };
  }

  async setModel(model?: string): Promise<void> {
    if (model !== undefined && model.length > 0) {
      // `model` is the *requested* model (alias or full id) — see the contract
      // note on AgentSession.setModel. Preserve it for context-window lookups
      // (1M aliases share a wire id with their base) and resolve the wire id
      // sent to the Messages API. resolveModelId is a no-op for full ids.
      this.state.requestedModel = model;
      this.state.currentModel = resolveModelId(model) ?? model;
    }
  }

  async setPermissionMode(mode: string): Promise<void> {
    // The plan/AFK system-prompt addendum reads this on the next composeSystem.
    this.state.currentPermissionMode = mode;
    // Live enforcement spans two reads fed by two separate fields — keep both
    // in sync or a live `/bypass` toggle silently fails (and `/bypass off`
    // fails UNSAFE: badge clears while the agent stays unrestricted):
    //  1. File-tool path containment reads the dispatcher's `allowAll` fresh
    //     per call, so flip it in place — effective on the next tool call.
    //     autonomous (AFK) bypasses containment alongside bypassPermissions.
    const allowAll = pathContainmentBypassed(mode);
    this.state.toolDispatcher.setAllowAll?.(allowAll);
    //  2. The path-approval hook reads the PROVIDER's getGrants().allowAll (a
    //     different field, `_currentPermissionMode`); update it via the
    //     provider-supplied callback.
    this.onPermissionMode?.(mode);
  }

  /**
   * Update the cwd-dependent mutable fields in-place so the next (and any
   * in-flight) turn picks up the new working directory without a session
   * reset.
   *
   * Order of operations (matters):
   *
   *   1. The PRIOR dispatcher has `setResolveBase(cwd)` called on it. This
   *      mutates its internal `resolveBase` and migrates the shared
   *      `_readRoots`/`_writeRoots` arrays. The in-flight turn captured
   *      this dispatcher by reference into `runInput.toolDispatcher`
   *      (`loop.ts:419,436`); after this mutation, the very next
   *      `handlerContext` read returns the new cwd, so the in-flight tool
   *      call's bash/grep/glob spawn lands in the post-rename worktree
   *      instead of the deleted old one. Fixes the worktree-autoname race
   *      where turn 1's tool calls fired AFTER `git worktree move` (old
   *      path gone) but BEFORE this method's dispatcher swap took effect.
   *
   *   2. `cwdDependentsFactory(cwd)` rebuilds the `userSystem` string
   *      (which contains the `# Environment\n- Working directory:` line)
   *      and constructs a fresh dispatcher with bash/grep/glob handlers
   *      closed over the new cwd. The system-prompt fragment must be
   *      regenerated because string content is captured by-value at
   *      send time.
   *
   *   3. Install both atomically.
   *
   * When `cwdDependentsFactory` is absent (e.g. external-dispatcher callers
   * that own their own lifecycle), we still attempt step 1 — even without
   * the system-prompt rebuild, propagating the new cwd to the live
   * dispatcher is strictly better than ignoring `setCwd`.
   *
   * This method is intentionally synchronous because it is called between
   * turns — the first-turn worktree hook is awaited BEFORE turn 1, and `/cd`
   * runs between turns — or, defensively, concurrently with an in-flight turn
   * (the in-flight `setResolveBase` propagation path). Either way, the
   * dispatcher mutation lands atomically with respect to the next
   * `handlerContext` getter read.
   */
  setCwd(cwd: string): void {
    // Step 1: mutate the live dispatcher so any in-flight turn that captured
    // this reference (via `runInput.toolDispatcher` in loop.ts) sees the new
    // cwd on its next handlerContext read. Optional chain: dispatchers that
    // don't implement setResolveBase (custom ToolDispatcher implementations
    // passed via externalTools) are gracefully skipped — they own their
    // own cwd model.
    this.state.toolDispatcher.setResolveBase?.(cwd);

    // Step 2-3: rebuild userSystem + dispatcher and swap in. Skip when no
    // factory (external-dispatcher path — step 1's in-place mutation is the
    // only update available, which is also the correct behavior).
    if (!this.cwdDependentsFactory) return;
    const { userSystem, dispatcher } = this.cwdDependentsFactory(cwd);
    this.state.userSystem = userSystem;
    this.state.toolDispatcher = dispatcher;
  }

  async supportedCommands(): Promise<ProviderCommandInfo[]> {
    return collectSupportedCommands();
  }

  async supportedModels(): Promise<ProviderModelInfo[]> {
    return STARTER_MODELS.map((m) => ({ ...m }));
  }

  async supportedAgents(): Promise<ProviderAgentInfo[]> {
    return [];
  }

  async getContextUsage(): Promise<ProviderContextUsage> {
    // Compute a point-in-time context-footprint percentage so the REPL's
    // ContextSampler (src/cli/context-sampler.ts) has an authoritative
    // value to display. Without this, the sampler's `cachedRatio` stays
    // undefined and the status line falls through to a local-stats
    // approximation that historically over-counted cache_read.
    //
    // `this.state.lastUsage` is `accumulatedUsage` from the last completed turn
    // (loop.ts). Use the context-window footprint it carries
    // (`contextWindowTokens` = last round's input + cache_read + cache_creation
    // + output), NOT input+output alone: Anthropic's input_tokens excludes the
    // cached conversation prefix, which is usually the bulk of the window.
    const last = this.state.lastUsage;
    // requestedModel (not the wire currentModel): 1M aliases (opus_1m) resolve
    // to the same wire id as their base but report a 1M window. Looking up the
    // wire id would yield the 200k fallback and mis-state both the % and the
    // `maxTokens` the REPL `/tokens` view displays.
    const contextLimit = contextLimitFor(this.state.requestedModel);
    let percentage: number | undefined;
    if (last && contextLimit > 0) {
      const used = contextWindowTokensUsed(last);
      percentage = Math.min(100, Math.max(0, (used / contextLimit) * 100));
    }
    // Translate the camelCase ProviderUsage into the snake_case apiUsage +
    // top-level totalTokens the REPL consumers read. See buildContextUsageFields.
    const { totalTokens, apiUsage } = buildContextUsageFields(last);
    return {
      // Context-window usage shape: tools/agents are per-entry token stats AFK does not populate (NOT AgentConfig.agents).
      tools: [],
      agents: [],
      isAutoCompactEnabled: this.state.autoCompactThreshold !== undefined,
      apiUsage,
      totalTokens,
      ...(percentage !== undefined ? { percentage } : {}),
      maxTokens: contextLimit,
    };
  }

  async mcpServerStatus(): Promise<ProviderMcpServerStatus[]> {
    if (!this.mcpManager) return [];
    return this.mcpManager.getServerStates().map((s) => ({
      name: s.serverName,
      status: s.status,
    }));
  }

  async accountInfo(): Promise<ProviderAccountInfo> {
    return {
      subscriptionType:
        this.retry.authMode === 'oauth' ? 'claude-subscription' : 'api-key',
    };
  }

  /**
   * Force-rebuild the underlying Anthropic SDK client from the current
   * keychain credentials. See {@link RetryLayer.forceClientRefresh} for the
   * detailed rationale (TL;DR: the SDK caches `authToken` at construction
   * time, so a fresh token in the keychain is not picked up without a new
   * client instance).
   *
   * `runInput.client` for any **in-flight** turn is not retroactively
   * patched here — that runInput is owned by the turn generator and gets a
   * fresh `this.retry.client` read at the start of every new turn. The next
   * user message therefore sees the swapped client automatically.
   */
  async reauth(): Promise<{ accountId: string; swapped: boolean } | null> {
    return this.retry.forceClientRefresh();
  }

  async rewindFiles(
    _userMessageId: string,
    _options?: { dryRun?: boolean },
  ): Promise<ProviderRewindResult> {
    return {
      canRewind: false,
      error:
        'anthropic-direct provider does not support file checkpoint rewind',
    };
  }

  /**
   * Summarize older turns into a synthetic preamble, preserving the last
   * `AFK_COMPACT_KEEP_LAST_TURNS` (default 2) raw user turns plus their
   * tool rounds. Mutates `state.messages` in place on success.
   *
   * Cancellation: while the summarization request is in flight the
   * coordinator holds a fresh controller so `interrupt()` cancels
   * cleanly. If aborted, history is left untouched.
   *
   * Delegated to {@link compactHistory} so the orchestrator stays focused
   * on the per-turn outer loop. See `query/compact-handler.ts`.
   */
  async compact(): Promise<ProviderCompactResult> {
    return compactHistory({
      state: this.state,
      abort: this.abort,
      retry: this.retry,
      initSessionId: this.initSessionId,
      ...(this.traceWriter ? { traceWriter: this.traceWriter } : {}),
    });
  }

  close(): void {
    this.state.closed = true;
    this.abort.requestAbort('closed');
    this.abort.markClosed();
  }
}
