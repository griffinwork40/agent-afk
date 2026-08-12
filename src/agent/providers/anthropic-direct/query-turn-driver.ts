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
import { contextLimitFor } from '../../model-limits.js';
import type { AnthropicClientLike, AnthropicToolDef } from './types.js';
import { repairOrphanToolUses } from './query/repair-orphan-tool-uses.js';
import type { SessionState } from './query/session-state.js';
import type { AbortCoordinator } from '../shared/abort-coordinator.js';
import type { RetryLayer } from './query/retry-layer.js';
import { contextWindowTokensUsed, guardContextOverflow } from './query/auto-compact.js';
import type { HookRegistry } from '../../hooks.js';
import { annotateFastError, prepareTurnRequest } from './query/turn-request.js';
import { maybeAutoCompact } from './query-turn-driver.auto-compact.js';

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

      // Context-overflow guard (#962): fail fast with a legible error BEFORE
      // sending the request when we know the provider will 400 it. Uses the
      // stale-by-one-round `lastUsage.contextWindowTokens` as a lower bound —
      // conservative by design (skips the first turn when lastUsage is null,
      // never silently shrinks max_tokens). See shared/auto-compact.ts.
      // Yields an error event (rather than throwing) so the abort controller is
      // cleared before control returns to the outer loop — throwing here would
      // skip the inner try/finally that clears it and leave compact() returning
      // 'turn-in-flight' on any subsequent manual compact call.
      {
        let overflowErr: Error | undefined;
        try {
          guardContextOverflow(
            contextWindowTokensUsed(ctx.state.lastUsage ?? {}),
            ctx.maxTokens,
            contextLimitFor(ctx.state.requestedModel ?? ctx.state.currentModel),
            ctx.state.requestedModel ?? ctx.state.currentModel,
          );
        } catch (e) {
          overflowErr = e instanceof Error ? e : new Error(String(e));
        }
        if (overflowErr !== undefined) {
          ctx.abort.clear(controller);
          yield { type: 'error', error: overflowErr };
          return;
        }
      }

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
          // P2 (Codex review): yield `turn.completed` BEFORE the closed-return
          // so stream-consumer.ts's `setLastResponseMetadata` fires and
          // `AgentSession.lastStopReason` is populated. Without this, a
          // close() that interrupts the overload pause tier delivers the
          // OVERLOAD_EXHAUSTED terminal here; the previous ordering set
          // `ctx.state.lastUsage` (provider-internal) but returned before
          // `yield event`, so `transformProviderEvent` for `turn.completed`
          // (which calls `setLastResponseMetadata`) was never reached.
          // Result: session sealed `succeeded` with `lastStopReason` unset
          // instead of `failed` with `OVERLOAD_EXHAUSTED`. By marking
          // `turnEmittedTerminal = true` before the closed-return we also keep
          // the downstream synthesize-terminal logic correct: no second terminal
          // is emitted after we return.
          if (event.type === 'turn.completed') {
            ctx.state.lastUsage = event.usage;
            ctx.abort.clear(controller);
            turnEmittedTerminal = true;
            yield event;
            if (ctx.state.closed) return;
            continue;
          }
          if (ctx.state.closed) return;
          if (event.type === 'error') {
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


