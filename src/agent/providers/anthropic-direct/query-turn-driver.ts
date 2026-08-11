/**
 * The multi-turn outer loop for {@link AnthropicDirectQuery}.
 *
 * Extracted verbatim from `query-runtime.ts` (#824 split); the class keeps a
 * one-line `yield*` delegate from its `[Symbol.asyncIterator]`. Behavior is
 * unchanged — the same events in the same order, and every abort/terminal
 * invariant documented inline below is preserved as written.
 *
 * A TypeScript class cannot be physically continued across modules, so the
 * loop takes a {@link TurnDriverContext} of live accessors instead of reading
 * `this`. Every member is a getter or a method: the loop observes mutations
 * (`setCwd` swapping the dispatcher, `setModel` changing the wire id) that
 * land between turns, so snapshotting would silently freeze the session.
 *
 * @module agent/providers/anthropic-direct/query-turn-driver
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { randomUUID } from 'node:crypto';
import type {
  ProviderCompactResult,
  ProviderEvent,
  ProviderSessionInfo,
  ProviderUserTurn,
} from '../../provider.js';
import { EXIT_PLAN_MODE_TOOL_NAME } from '../../tools/handlers/exit-plan-mode.js';
import { autoCompactLimitFor } from '../../model-limits.js';
import type { AnthropicClientLike, AnthropicToolDef } from './types.js';
import { repairOrphanToolUses } from './query/repair-orphan-tool-uses.js';
import type { SessionState } from './query/session-state.js';
import type { AbortCoordinator } from '../shared/abort-coordinator.js';
import type { RetryLayer } from './query/retry-layer.js';
import { contextWindowTokensUsed, shouldAutoCompact } from './query/auto-compact.js';
import type { HookRegistry } from '../../hooks.js';
import { HookBlockedError } from '../../../utils/errors.js';
import { annotateFastError, prepareTurnRequest } from './query/turn-request.js';

/** Live accessors the turn driver needs from the owning query. */
export interface TurnDriverContext {
  readonly initSessionId: string;
  readonly promptStream: AsyncIterable<ProviderUserTurn>;
  readonly state: SessionState;
  readonly abort: AbortCoordinator;
  readonly retry: RetryLayer;
  readonly maxTokens: number;
  readonly tools: AnthropicToolDef[] | null;
  readonly thinking: import('@anthropic-ai/sdk/resources').ThinkingConfigParam | undefined;
  readonly effort: import('../../types/sdk-types.js').EffortLevel | undefined;
  readonly baseUrl: string | undefined;
  readonly maxToolUseIterations: number | undefined;
  readonly softDeadlineMs: number | undefined;
  readonly traceWriter: import('../../trace/index.js').TraceWriter | undefined;
  readonly subagentId: string | undefined;
  readonly mcpManager: import('../../mcp/index.js').McpManager | undefined;
  readonly hookRegistry: HookRegistry | undefined;
  readonly throttleQueue: import('./throttle-queue.js').ThrottleQueue | undefined;
  readonly fastModeController: import('../../fast-mode.js').FastModeController | undefined;
  /** Build the per-turn `system` payload (re-read each turn for date rollover). */
  composeSystem(): ContentBlockParam[] | null;
  /** Synthetic terminal for an interrupted turn that yielded none of its own. */
  makeInterruptedTurnEvent(): ProviderEvent;
  /** Summarize older turns; invoked at the auto-compaction turn boundary. */
  compact(): Promise<ProviderCompactResult>;
}

/** Drive the session: emit `session.init`, then loop user turns until closed. */
export async function* driveTurns(ctx: TurnDriverContext): AsyncGenerator<ProviderEvent, void, void> {
  const info: ProviderSessionInfo = {
    sessionId: ctx.initSessionId,
    model: ctx.state.currentModel,
    permissionMode: ctx.state.currentPermissionMode,
    cwd: process.cwd(),
    tools: [],
    slashCommands: [],
    skills: [],
    plugins: [],
    // Live MCP server status — `/mcp` reads `meta.mcpServers` (set by the
    // session harness from this field) to render the connection summary.
    // When no manager is wired, an empty list is the right answer (no
    // MCP support in this session).
    mcpServers: ctx.mcpManager?.getServerStates().map((s) => ({
      name: s.serverName,
      status: s.status,
    })) ?? [],
    apiKeySource: ctx.retry.authMode,
    version: 'anthropic-direct-v1',
  };
  yield { type: 'session.init', info };

  const promptIterator = ctx.promptStream[Symbol.asyncIterator]();
  try {
    while (!ctx.state.closed) {
      const nextOrClose = await Promise.race([
        promptIterator.next(),
        ctx.abort.closedPromise,
      ]);
      if (nextOrClose === '__closed__') break;
      const turnResult = nextOrClose as IteratorResult<ProviderUserTurn>;
      if (turnResult.done) break;
      const turn = turnResult.value;

      const controller = ctx.abort.begin();
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
        ctx.abort.clear(controller);
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
      repairOrphanToolUses(ctx.state.messages);

      // Append the new user turn to history. Strings and content-block
      // arrays both ride through as-is — Anthropic's MessageParam accepts
      // either shape natively.
      ctx.state.messages.push({ role: 'user', content: turn.content });

      const system = ctx.composeSystem();
      // Snapshot preference + eligibility exactly once. The resulting headers
      // and body intent live on one immutable RunTurnInput for every round/retry.
      const { decision: fastDecision, runInput } = prepareTurnRequest({
        client: ctx.retry.client as unknown as AnthropicClientLike,
        messages: ctx.state.messages,
        system,
        tools: ctx.state.currentPermissionMode === 'plan'
          ? ctx.tools
          : (ctx.tools?.filter((t) => t.name !== EXIT_PLAN_MODE_TOOL_NAME) ?? null),
        toolDispatcher: ctx.state.toolDispatcher,
        model: ctx.state.currentModel,
        maxTokens: ctx.maxTokens,
        signal: controller.signal,
        authMode: ctx.retry.authMode,
        sessionId: ctx.initSessionId,
        requestId: randomUUID(),
        ...(ctx.fastModeController ? { fastModeController: ctx.fastModeController } : {}),
        ...(ctx.thinking !== undefined ? { thinking: ctx.thinking } : {}),
        ...(ctx.effort !== undefined ? { effort: ctx.effort } : {}),
        ...(ctx.baseUrl !== undefined ? { baseUrl: ctx.baseUrl } : {}),
        ...(ctx.maxToolUseIterations !== undefined ? { maxToolUseIterations: ctx.maxToolUseIterations } : {}),
        ...(ctx.softDeadlineMs !== undefined ? { softDeadlineMs: ctx.softDeadlineMs } : {}),
        ...(ctx.traceWriter ? { traceWriter: ctx.traceWriter } : {}),
        ...(ctx.subagentId !== undefined ? { subagentId: ctx.subagentId } : {}),
        ...(ctx.throttleQueue ? { throttleQueue: ctx.throttleQueue } : {}),
        onUsageProgress: (usage) => { ctx.state.lastUsage = usage; },
      });

      // Tracks whether THIS turn yielded a terminal event (`turn.completed`
      // → 'done', or `error`). The abort handling below synthesizes a
      // terminal event only when the turn produced none, so the consumer's
      // `providerIterator.next()` loop is never advanced past a turn it
      // already saw end.
      let turnEmittedTerminal = false;
      try {
        for await (const event of ctx.retry.turnWithRetries(runInput, () => ctx.state.closed)) {
          // M1: process `turn.completed` BEFORE the closed check so
          // `lastUsage.stopReason` (and AgentSession's `lastStopReason`) is
          // recorded even when a concurrent close() lands during the overload
          // pause. Without this ordering, a close() that interrupts the pause
          // tier delivers the OVERLOAD_EXHAUSTED terminal here, but the old
          // `if (ctx.state.closed) return` discarded it immediately, leaving
          // `lastStopReason` unset → session seals `succeeded` not `failed`.
          // Clearing the abort slot here is unchanged (was already inside the
          // turn.completed branch); moving it above the closed check keeps the
          // invariant that inter-turn observers always see an idle coordinator.
          if (event.type === 'turn.completed') {
            ctx.state.lastUsage = event.usage;
            ctx.abort.clear(controller);
          }
          if (ctx.state.closed) return;
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
        if (ctx.state.closed) return;
        if (controller.signal.aborted) {
          ctx.abort.clear(controller);
          // `loop.ts` yields `turn.completed` on a graceful mid-stream abort,
          // so a terminal event is usually already delivered. Synthesize one
          // only if the throw pre-empted it, so the consumer unwinds instead
          // of hanging on a `next()` that never resolves.
          if (!turnEmittedTerminal) yield ctx.makeInterruptedTurnEvent();
          continue;
        }
        const e = annotateFastError(err, fastDecision?.effective === true);
        yield { type: 'error', error: e };
        return;
      } finally {
        ctx.abort.clear(controller);
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
      if (ctx.state.closed) return;
      if (controller.signal.aborted) {
        if (!turnEmittedTerminal) yield ctx.makeInterruptedTurnEvent();
        continue;
      }

      yield* maybeAutoCompact(ctx);
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
 * Auto-compaction: fire at the natural turn boundary — after the per-turn
 * event loop exits and the abort slot is cleared — so we never trigger while a
 * tool call is in flight.
 *
 * External constraint: `abort.isIdle()` MUST be true here (cleared by
 * `abort.clear(controller)` in the caller's finally) so compact-handler's own
 * isIdle() guard passes and the 'turn-in-flight' bail is not hit spuriously.
 * Do not call this from inside the inner for-await — compact() mutates
 * state.messages in place and must only run at a clean turn boundary, never
 * mid-tool-call.
 *
 * Yields nothing; it is a generator purely so the caller's `yield*` keeps the
 * original inline control flow (a throw here propagates identically).
 */
async function* maybeAutoCompact(ctx: TurnDriverContext): AsyncGenerator<ProviderEvent, void, void> {
  if (ctx.state.autoCompactThreshold === undefined || ctx.state.closed) return;
  const usage = ctx.state.lastUsage;
  // requestedModel (not the wire currentModel) so 1M aliases use their
  // true window — opus_1m resolves to the same wire id as opus but must
  // compact at ~90% of 1M, not 200k. autoCompactLimitFor additionally
  // caps the DEFAULT `sonnet` at a 200k working budget: its 1M window is
  // truthful, but base sessions compact early for cost/latency, while the
  // `sonnet_1m` opt-in bypasses the cap. See model-limits.ts.
  const compactionLimit = autoCompactLimitFor(ctx.state.requestedModel);
  if (usage === null || compactionLimit <= 0) return;
  // Use the context-window footprint (input + cache_read +
  // cache_creation + output for the last round), NOT input+output
  // alone — Anthropic's input_tokens excludes cache, so the cached
  // conversation prefix (often the bulk of the window) must be
  // counted or compaction never fires before the window overflows.
  const usedTokens = contextWindowTokensUsed(usage);
  if (!shouldAutoCompact(usedTokens, compactionLimit, ctx.state.autoCompactThreshold)) return;
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
    if (ctx.hookRegistry) {
      await ctx.hookRegistry.dispatch({
        event: 'PreCompact',
        sessionId: ctx.initSessionId,
        trigger: 'auto',
      });
    }
    await ctx.compact();
  } catch (compactErr) {
    if (compactErr instanceof HookBlockedError) {
      // Hook blocked auto-compaction — skip this turn's compaction
      // without surfacing an error; the session continues normally.
    } else {
      throw compactErr;
    }
  }
}
