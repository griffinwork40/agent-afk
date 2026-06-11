/**
 * Per-turn agentic loop for the `anthropic-direct` provider.
 *
 * Owns the **multi-step tool-use loop within a single user turn**: orchestrates
 * `client.messages.create({...stream: true})` calls, threads each call's raw
 * events through {@link translateMessageStream}, dispatches tool calls via the
 * pluggable {@link ToolDispatcherLike}, accumulates message history (assistant
 * turn + `tool_result` user turn) for the next iteration, sums usage across
 * iterations. Caps tool-use rounds only when `maxToolUseIterations` is
 * explicitly set to a positive value; the default ({@link
 * DEFAULT_MAX_TOOL_USE_ITERATIONS} = 0) means "no cap" — terminate naturally
 * when the model stops emitting tool_use blocks. Callers that want a hard
 * ceiling pass `maxToolUseIterations` per turn.
 *
 * The caller (query.ts) owns the **multi-turn outer loop** across user inputs,
 * the messages array's lifetime, and `session.init` synthesis. This module is
 * a pure async generator over `ProviderEvent`s with no module-scope state.
 *
 * Mutation contract: `runTurn` mutates `input.messages` in place — appending
 * the assistant turn's content blocks and a follow-up user turn carrying
 * `tool_result` blocks for every tool-use round. Callers must read
 * `input.messages` AFTER the generator returns so the next user turn sees the
 * full history.
 *
 * @module agent/providers/anthropic-direct/loop
 */

import { randomUUID } from 'node:crypto';
import type {
  ContentBlockParam,
  MessageParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources';
import type { ProviderEvent, ProviderUsage } from '../../provider.js';
import type {
  AnthropicMessagesCreateParams,
  AnthropicToolDef,
  RunTurnInput,
  ToolCall,
  ToolResult,
  TurnResult,
  WireToolDef,
} from './types.js';
import { sumProviderUsage, toProviderUsage } from './types.js';
import {
  getCacheTtl,
  isCacheEnabled,
  withMessagesBreakpoint,
} from './cache-policy.js';
import { translateMessageStream } from './translate.js';
import { emitToolCall, emitSessionPhase } from '../../trace/emit.js';
import { env } from '../../../config/env.js';

/**
 * Default cap on tool-use rounds within a single user turn. `0` means "no
 * cap" — the loop terminates only when the model stops emitting tool_use
 * blocks, the abort signal fires, or the SDK errors. Set
 * `RunTurnInput.maxToolUseIterations` to a positive value for a hard ceiling.
 */
export const DEFAULT_MAX_TOOL_USE_ITERATIONS = 0;

/**
 * Project an internal {@link AnthropicToolDef} to the wire-safe shape the
 * Anthropic Messages API actually accepts. Strips internal classification
 * metadata (`category`, `concurrencySafe`, `riskClass`) that would otherwise
 * trip a 400 `tools.0.custom.<field>: Extra inputs are not permitted` on
 * `messages.create`.
 *
 * The wire boundary type (`AnthropicMessagesCreateParams.tools: WireToolDef[]`)
 * forces every call site to go through a projection like this one — keep it
 * that way.
 */
export function toWireTool(tool: AnthropicToolDef): WireToolDef {
  const { name, description, input_schema } = tool;
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    input_schema,
  };
}

export const OVERLOAD_MAX_RETRIES = 3;
const OVERLOAD_BASE_DELAY_MS = 5_000;

export function isTransientServerError(err: Error): boolean {
  if (!('status' in err)) return false;
  const status = (err as Error & { status: number }).status;
  return status === 529 || status === 503;
}

/**
 * Detect a transient Anthropic *overload* delivered as a **mid-stream** SSE
 * `error` event. A connection-phase 529 carries a real HTTP `status` (handled
 * by {@link isTransientServerError} inside {@link createWithRetry}); a
 * mid-stream overload is different — the SDK throws it from inside the stream
 * iterator as `new APIError(undefined, <parsed SSE body>, …)`, so `status` is
 * `undefined` and the only signal is the parsed body's nested
 * `error.type === 'overloaded_error'`. translate.ts converts that throw into an
 * in-band `{type:'error', error}` event whose `error` IS the APIError, so this
 * predicate inspects the (usually absent) status AND the nested SSE body in
 * both its double-nested (`{type:'error', error:{type:'overloaded_error'}}`)
 * and flat (`{type:'overloaded_error'}`) shapes.
 */
export function isOverloadedErrorEvent(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { status?: unknown; error?: unknown };
  if (e.status === 529 || e.status === 503) return true;
  const body = e.error;
  if (body === null || typeof body !== 'object') return false;
  const b = body as { type?: unknown; error?: { type?: unknown } | null };
  const innerType = (b.error !== null && typeof b.error === 'object' ? b.error.type : undefined) ?? b.type;
  return innerType === 'overloaded_error';
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    timer.unref();
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function createWithRetry(
  client: { messages: { create(params: unknown, opts: unknown): unknown } },
  params: AnthropicMessagesCreateParams,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<AsyncIterable<unknown>> {
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) {
      const delay = OVERLOAD_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await sleepWithAbort(delay, signal);
      if (signal.aborted) throw new Error('aborted');
    }
    try {
      return (await Promise.resolve(
        client.messages.create(params, { headers, signal }),
      )) as AsyncIterable<unknown>;
    } catch (err) {
      if (signal.aborted) throw err;
      const e = err instanceof Error ? err : new Error(String(err));
      if (isTransientServerError(e) && attempt < OVERLOAD_MAX_RETRIES) {
        continue;
      }
      throw e;
    }
  }
}

function summarizeToolInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  // Skill dispatch: the `name` field IS the skill being invoked (diagnose,
  // review, mint, …). Surface it as a paren-wrapped label so the tool lane
  // renders `skill(diagnose)` instead of a bare `skill [skill]` — matching the
  // `Agent(<label>)` dispatch convention and the paren-wrap signal the overflow
  // renderer keys on (cli/commands/interactive/tool-lane-render-grouping-overflow.ts).
  // Unlike `agent`, a skill's label is fully known from the tool input, so it
  // needs no deferred mergeAgentLabel promotion — and it MUST be surfaced here
  // because load-mode skills never fork a child Agent row to carry the name.
  if (toolName === 'skill' || toolName === 'Skill') {
    const skillName = obj['name'];
    if (typeof skillName === 'string' && skillName.length > 0) {
      return `(${skillName.length > 60 ? skillName.slice(0, 59) + '…' : skillName})`;
    }
    return '';
  }
  const path = obj['file_path'] ?? obj['path'] ?? obj['filePath'];
  if (typeof path === 'string') return ' ' + path;
  const cmd = obj['command'] ?? obj['cmd'];
  if (typeof cmd === 'string') {
    const firstLine = cmd.split('\n')[0]!;
    return ' ' + (firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine);
  }
  const query = obj['query'] ?? obj['pattern'] ?? obj['url'] ?? obj['description'];
  if (typeof query === 'string') return ' ' + query;
  return '';
}

/**
 * Run one user turn through the model + tool dispatcher loop. Yields
 * `ProviderEvent`s as the model streams; on completion of the turn (the model
 * stops with anything other than `tool_use`, or the iteration cap is hit),
 * yields a final `turn.completed` event with summed usage and returns.
 *
 * The caller is responsible for: (a) appending the new user `MessageParam` to
 * `input.messages` BEFORE calling `runTurn`, and (b) reading the mutated
 * `input.messages` array AFTER `runTurn` returns so the next user turn sees
 * the full history (assistant turn + `tool_result` rounds, if any).
 *
 * Errors from `messages.create` (network, auth) are yielded as `error`
 * events and terminate the turn. Errors from the dispatcher are absorbed
 * into the synthesized `tool_result` block as `is_error: true` so the model
 * can recover. Aborts yield `turn.completed` with accumulated usage so
 * downstream consumers always receive a terminal event.
 */
export async function* runTurn(
  input: RunTurnInput,
): AsyncGenerator<ProviderEvent, void, void> {
  const maxIterations =
    input.maxToolUseIterations ?? DEFAULT_MAX_TOOL_USE_ITERATIONS;
  let accumulatedUsage: ProviderUsage = { stopReason: null };
  let iterations = 0;
  // Mid-stream overload retry budget. Spent as a 529/overloaded_error is
  // observed *during* stream consumption (where createWithRetry can't reach),
  // and reset to 0 after every clean round so each tool-use round gets its own
  // allowance — mirroring createWithRetry's per-call (not per-turn) scope.
  let overloadRetries = 0;
  const taskId = randomUUID();
  const loopStartTime = Date.now();

  // Single point of truth for the turn-end wall-clock measurement that lands
  // in the REPL footer's `◦ Xs · $cost · N tok` line via
  // ResponseMetadata.durationMs → printTurnFooter. Pre-fix the eight
  // `turn.completed` yield sites below all passed bare `accumulatedUsage`,
  // and neither `toProviderUsage` nor `sumProviderUsage` ever wrote
  // `durationMs` — so the footer rendered as just `◦ N tok` for every
  // anthropic-direct turn. Factored as a closure so the eight call sites
  // can't drift apart silently — grep for `withTurnDuration` to audit.
  const withTurnDuration = (usage: ProviderUsage): ProviderUsage => ({
    ...usage,
    durationMs: Date.now() - loopStartTime,
  });

  // Witness layer: mark loop entry once for this turn. Fire-and-forget —
  // a broken trace writer must never stall tool dispatch.
  void emitSessionPhase(input.traceWriter, { phase: 'loop_start' });

  // Witness layer: loop_end fires from the generator's finally block so
  // all eight return paths — abort, error, clean end-of-turn, capped —
  // are covered without per-site annotation. Fire-and-forget; trace
  // latency must never stall an already-returning turn.
  try {
  while (true) {
    if (input.signal.aborted) {
      yield {
        type: 'turn.completed',
        usage: withTurnDuration(accumulatedUsage),
        sessionId: input.ctx.sessionId,
      };
      return;
    }

    // Stamp a prompt-cache breakpoint on the last content block of the
    // last message before sending — non-mutating clone-and-stamp so the
    // marker never accumulates back into stored history. Cache lookup
    // walks back over prefix-hash matches up to a 20-block window, so the
    // moving marker still hits prior writes within the tool-use loop and
    // across consecutive turns.
    const messagesForRequest = isCacheEnabled({ baseUrl: input.baseUrl })
      ? withMessagesBreakpoint(input.messages, getCacheTtl())
      : input.messages;

    const params: AnthropicMessagesCreateParams = {
      model: input.model,
      max_tokens: input.maxTokens,
      messages: messagesForRequest,
      stream: true,
      ...(input.system !== null ? { system: input.system } : {}),
      ...(input.tools !== null && input.tools.length > 0
        ? { tools: input.tools.map(toWireTool) }
        : {}),
      ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
      ...(input.effort !== undefined
        ? { output_config: { effort: input.effort } }
        : {}),
    };

    // Witness layer: stamp request-initiation time so the model_ttfb phase
    // below can report time-to-first-byte for THIS model API call.
    const requestStartedAt = Date.now();
    let events: AsyncIterable<unknown>;
    try {
      events = await createWithRetry(
        input.client,
        params,
        input.headers,
        input.signal,
      );
    } catch (err) {
      if (input.signal.aborted) {
        yield {
          type: 'turn.completed',
          usage: withTurnDuration(accumulatedUsage),
          sessionId: input.ctx.sessionId,
        };
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      if (e.message.includes('thinking')) {
        dumpThinkingDiagnostic(input.messages, e);
      }
      yield { type: 'error', error: e };
      return;
    }

    // Translate the raw SDK events into ProviderEvents and capture the
    // digested TurnResult emitted at end-of-stream.
    let turnResult: TurnResult | null = null;
    let translatorErrored = false;
    let retryOverload = false;
    // Witness layer: emit model_ttfb exactly once for this API call, on the
    // first translated stream event. Reset per while-iteration so each model
    // call reports its own time-to-first-byte.
    let ttfbEmitted = false;
    try {
      if (env.AFK_TELEGRAM_TRACE) console.log('[loop] awaiting translateMessageStream events');
      for await (const out of translateMessageStream(
        events as Parameters<typeof translateMessageStream>[0],
        input.ctx,
      )) {
        if (!ttfbEmitted) {
          ttfbEmitted = true;
          // Time-to-first-byte: request initiation (incl. any auth retries
          // inside createWithRetry) → first translated stream event.
          // Fire-and-forget; trace latency must never stall the stream.
          void emitSessionPhase(input.traceWriter, {
            phase: 'model_ttfb',
            durationMs: Date.now() - requestStartedAt,
            // Resolved wire id for THIS call — captures mid-session model
            // overrides/switches that differ from the session default recorded
            // on session_init_start. `input.model` is already the resolved id
            // passed to the Messages API (see params.model above).
            resolvedModel: input.model,
          });
        }
        if (env.AFK_TELEGRAM_TRACE) console.log('[loop] translate yielded:', out.kind, out.kind === 'event' ? out.event.type : '');
        if (out.kind === 'event') {
          if (out.event.type === 'error') {
            // Mid-stream transient overload (529 / overloaded_error): the SDK
            // throws it from inside the stream iterator with NO HTTP status,
            // so createWithRetry — status-based and connection-phase only —
            // never sees it. translate.ts has already converted that throw
            // into this in-band error event. Re-drive the request after
            // backoff instead of surfacing a fatal error: input.messages is
            // unmutated for this round (the assistant turn and usage are
            // committed only on clean completion below), so the retry re-sends
            // identical history. Any text already streamed for this round may
            // re-emit on the retry — an accepted cosmetic cost vs. crashing
            // the whole turn on a transient server hiccup.
            if (
              isOverloadedErrorEvent(out.event.error) &&
              overloadRetries < OVERLOAD_MAX_RETRIES &&
              !input.signal.aborted
            ) {
              retryOverload = true;
              break;
            }
            yield out.event;
            translatorErrored = true;
            break;
          }
          yield out.event;
        } else {
          turnResult = out.result;
          break;
        }
      }
      if (env.AFK_TELEGRAM_TRACE) console.log('[loop] translate loop exited, turnResult=', turnResult ? 'set' : 'null');
    } catch (err) {
      if (input.signal.aborted) {
        yield {
          type: 'turn.completed',
          usage: withTurnDuration(accumulatedUsage),
          sessionId: input.ctx.sessionId,
        };
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      // Defensive: a mid-stream overload normally reaches us as an in-band
      // error event (handled in the loop above), but if translate.ts ever
      // re-throws one, route it into the same retry path rather than crashing.
      if (isOverloadedErrorEvent(e) && overloadRetries < OVERLOAD_MAX_RETRIES && !input.signal.aborted) {
        retryOverload = true;
      } else {
        yield { type: 'error', error: e };
        return;
      }
    }

    if (retryOverload) {
      overloadRetries += 1;
      // Tell surfaces to discard the current round's already-streamed text:
      // the re-driven request below re-streams the round from scratch, so
      // without a reset the partial text visibly duplicates. Emitted before
      // the backoff so the UI clears immediately rather than after the wait.
      yield { type: 'stream.retry', sessionId: input.ctx.sessionId };
      // Exponential backoff matching createWithRetry: 5s → 10s → 20s.
      await sleepWithAbort(
        OVERLOAD_BASE_DELAY_MS * Math.pow(2, overloadRetries - 1),
        input.signal,
      );
      if (input.signal.aborted) {
        yield {
          type: 'turn.completed',
          usage: withTurnDuration(accumulatedUsage),
          sessionId: input.ctx.sessionId,
        };
        return;
      }
      continue;
    }

    // Past the overload-retry decision for this round (retryOverload is
    // false), so this round's mid-stream overload budget is spent — restore
    // the full allowance for the next tool-use round. Reset here, ABOVE the
    // terminal `return` paths below, so the "each tool-use round starts with a
    // fresh budget" invariant holds uniformly. The translator-error and
    // null-result paths return (so the reset is moot for them today), but
    // placing it above them makes the invariant unconditional and survives a
    // future refactor that turns a terminal path into a `continue`.
    overloadRetries = 0;

    if (translatorErrored) {
      // Error event was already yielded. On an abort (interrupt/close), emit
      // turn.completed with accumulated usage so callers can account for
      // partial costs. On a real stream error, skip turn.completed so cost
      // is not double-counted and state is not incorrectly advanced.
      if (input.signal.aborted) {
        yield {
          type: 'turn.completed',
          usage: withTurnDuration(accumulatedUsage),
          sessionId: input.ctx.sessionId,
        };
      }
      return;
    }
    if (turnResult === null) {
      // Stream ended without a turn-result; treat as a clean end-of-turn
      // with the usage we already have.
      yield {
        type: 'turn.completed',
        usage: withTurnDuration(accumulatedUsage),
        sessionId: input.ctx.sessionId,
      };
      return;
    }

    const roundUsage = toProviderUsage(turnResult.usage, turnResult.stopReason, input.model);
    accumulatedUsage = sumProviderUsage(accumulatedUsage, roundUsage);
    // Context-window footprint = THIS round's full input occupancy. Anthropic's
    // `input_tokens` excludes cache (docs: "tokens which were not read from or
    // used to create a cache"), so the window total is
    // input + cache_read + cache_creation + output for the latest call.
    // Computed from the single round (not `accumulatedUsage`): cumulative
    // `inputTokens` would double-count tokens already present in the latest
    // `cache_read`. `sumProviderUsage` discards this field (it builds a fresh
    // object), so it is re-stamped every round and reflects only the last one.
    accumulatedUsage.contextWindowTokens =
      (roundUsage.inputTokens ?? 0) +
      (roundUsage.outputTokens ?? 0) +
      (roundUsage.cachedInputTokens ?? 0) +
      (roundUsage.cacheCreationTokens ?? 0);
    // Surface per-round cumulative usage so getContextUsage() reflects
    // mid-turn growth on the status line. Fires on every round including
    // the terminal end_turn; the authoritative duration-stamped value is
    // still set on turn.completed immediately after. Synchronous, never awaited.
    input.onUsageProgress?.(accumulatedUsage);

    if (turnResult.stopReason !== 'tool_use') {
      if (turnResult.text.length > 0) {
        yield {
          type: 'assistant.message',
          text: turnResult.text,
          sessionId: input.ctx.sessionId,
        };
        const SUGGESTION_MAX_LENGTH = 200;
        if (turnResult.text.length <= SUGGESTION_MAX_LENGTH) {
          yield {
            type: 'suggestion',
            suggestion: turnResult.text,
            sessionId: input.ctx.sessionId,
          };
        }
      }
      // Anthropic API contract: every `tool_use` block in assistant content
      // MUST be followed by a matching `tool_result` block in the next user
      // message. When stopReason !== 'tool_use', we are exiting the turn
      // WITHOUT dispatching tools — any tool_use blocks the translator
      // collected (e.g. a tool_use truncated by `max_tokens`, or one paired
      // with a `pause_turn` stop) would become orphans the moment they hit
      // history. Strip them before pushing so the next user turn cannot
      // 400 with "tool_use ids were found without tool_result blocks
      // immediately after".
      const safeAssistantBlocks = turnResult.assistantBlocks.filter(
        (b) => b.type !== 'tool_use',
      );
      if (safeAssistantBlocks.length > 0) {
        input.messages.push({
          role: 'assistant',
          content: safeAssistantBlocks,
        });
      }
      yield {
        type: 'turn.completed',
        usage: withTurnDuration(accumulatedUsage),
        sessionId: input.ctx.sessionId,
      };
      return;
    }

    // stopReason === 'tool_use' — push the assistant turn into history,
    // dispatch every tool_use block, then assemble the tool_result user turn.
    //
    // Rollback contract: capture the pre-push length so any throw between
    // here and the final `input.messages.push(toolResultTurn)` below can
    // splice the orphaned assistant message back out. Without this, an
    // unexpected throw inside `executeBatch` / `execute` (one not absorbed
    // into an `is_error: true` ToolResult) would leave history terminating
    // in an unmatched `tool_use` — every subsequent API call would 400.
    const messagesRollbackIdx = input.messages.length;
    input.messages.push({
      role: 'assistant',
      content: turnResult.assistantBlocks,
    });
    try {

    // Build all tool calls and emit start events upfront.
    const calls: ToolCall[] = [];
    // Per-call start timestamps keyed by toolUseId so the completed
    // trace event can carry an accurate `durationMs`. Lives within this
    // loop iteration only — the next iteration starts fresh.
    const startTimes = new Map<string, number>();
    for (const block of turnResult.toolUseBlocks) {
      calls.push({
        id: block.id,
        name: block.name,
        input: block.input,
        signal: input.signal,
      });
      const now = Date.now();
      startTimes.set(block.id, now);
      // Witness layer: tool_call.started fires BEFORE dispatch so even a
      // crashing tool leaves evidence that it was attempted. Fire-and-
      // forget — emitToolCall swallows writer errors internally.
      void emitToolCall(input.traceWriter, {
        phase: 'started',
        toolUseId: block.id,
        name: block.name,
        inputBytes: Buffer.byteLength(JSON.stringify(block.input ?? {}), 'utf8'),
      });
      yield {
        type: 'tool.use.start',
        toolUseId: block.id,
        toolName: block.name,
        toolInput: summarizeToolInput(block.name, block.input),
        sessionId: input.ctx.sessionId,
      };
    }

    if (input.signal.aborted) {
      const abortedResults: ToolResultBlockParam[] = calls.map((call) => ({
        type: 'tool_result' as const,
        tool_use_id: call.id,
        content: 'Tool call aborted',
        is_error: true,
      }));
      input.messages.push({ role: 'user', content: abortedResults as ContentBlockParam[] });
      yield {
        type: 'turn.completed',
        usage: withTurnDuration(accumulatedUsage),
        sessionId: input.ctx.sessionId,
      };
      return;
    }

    // Dispatch: batch (parallel for safe tools) or sequential fallback.
    let results: ToolResult[];
    if (input.toolDispatcher.executeBatch) {
      try {
        results = await input.toolDispatcher.executeBatch(calls);
      } catch (err) {
        results = calls.map(() => ({
          content: `Tool batch execution failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true as const,
        }));
      }
    } else {
      results = [];
      for (const call of calls) {
        if (input.signal.aborted) {
          results.push({ content: 'Tool call aborted', isError: true });
          continue;
        }
        try {
          results.push(await input.toolDispatcher.execute(call));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          results.push({ content: `Tool execution threw: ${message}`, isError: true });
        }
      }
    }

    // Yield results and build tool_result blocks in original order.
    const toolResultBlocks: ToolResultBlockParam[] = [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      const result = results[i]!;

      // Witness layer: tool_call.completed pairs with the .started event
      // emitted above. `truncated` is now sourced from the handler's
      // structured `ToolResult.truncated` flag — set by `handlers/bash.ts`
      // and `handlers/grep.ts` whenever their byte cap is hit. The
      // sentinel-substring fallback survives for third-party tool handlers
      // that emit the `[output truncated …]` sentinel without setting the
      // structured flag (back-compat). Fire-and-forget to keep the loop
      // iteration cheap.
      const startedAt = startTimes.get(call.id);
      const durationMs = typeof startedAt === 'number' ? Date.now() - startedAt : 0;
      const truncated = result.truncated === true || result.content.includes('[output truncated');
      void emitToolCall(input.traceWriter, {
        phase: 'completed',
        toolUseId: call.id,
        name: call.name,
        resultBytes: Buffer.byteLength(result.content, 'utf8'),
        isError: result.isError === true,
        truncated,
        durationMs,
        ...(result.circuitBreaker === true ? { circuitBreaker: true } : {}),
      });

      yield {
        type: 'tool.output',
        toolUseId: call.id,
        toolName: call.name,
        content: result.content,
        ...(result.isError === true ? { isError: true } : {}),
        ...(truncated ? { truncated: true } : {}),
        sessionId: input.ctx.sessionId,
      };

      // Sidecar render-only event for file-mutation tools. Travels on a
      // separate event variant — the `toolResultBlocks.push()` call below
      // cannot reference `result.render` (it's not in scope), so a future
      // refactor cannot accidentally leak diff payloads into the model's
      // `tool_result` content. This is the structural correctness invariant
      // for the diff render channel.
      if (result.render?.diff) {
        yield {
          type: 'tool.diff',
          toolUseId: call.id,
          diff: result.render.diff,
          sessionId: input.ctx.sessionId,
        };
      }

      // Destructure only the model-facing fields so `result.render` is
      // structurally unreachable at this call site — not merely excluded by
      // convention. This makes the isolation load-bearing rather than
      // documentation-only. `image` is the ONE structured field that IS
      // model-facing: when set it becomes an `image` content block alongside
      // the text. `render` remains excluded.
      const { content: resultContent, isError: resultIsError, image: resultImage } = result;
      // When a tool returns an image (e.g. browser_screenshot), emit it as an
      // image block followed by the text summary. The handler keeps the text
      // non-empty so providers that drop the image still see useful context.
      const toolResultContent: ToolResultBlockParam['content'] =
        resultImage !== undefined
          ? [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: resultImage.mediaType,
                  data: resultImage.data,
                },
              },
              ...(resultContent.length > 0
                ? [{ type: 'text' as const, text: resultContent }]
                : []),
            ]
          : resultContent;
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: toolResultContent,
        ...(resultIsError === true ? { is_error: true } : {}),
      });
    }

    const toolResultTurn: MessageParam = {
      role: 'user',
      content: toolResultBlocks as ContentBlockParam[],
    };
    input.messages.push(toolResultTurn);
    } catch (err) {
      // Rollback the orphaned assistant `tool_use` push above so the next
      // turn's API call does not 400 with "tool_use ids were found without
      // tool_result blocks immediately after". Any path that reached the
      // matching `input.messages.push(toolResultTurn)` above (or the
      // earlier aborted-results push at the signal-aborted gate) returned
      // from inside the try with history already consistent, so they do
      // not enter this catch. Re-throw so the outer query-level handler
      // still surfaces the error.
      input.messages.splice(messagesRollbackIdx);
      throw err;
    }

    iterations += 1;

    const lastTool = turnResult.toolUseBlocks[turnResult.toolUseBlocks.length - 1];
    yield {
      type: 'progress',
      progress: {
        taskId,
        description: 'Tool-use loop',
        summary: `Iteration ${iterations}: used ${lastTool?.name ?? 'unknown'}`,
        lastToolName: lastTool?.name,
        totalTokens: accumulatedUsage.totalTokens ?? 0,
        toolUses: iterations,
        durationMs: Date.now() - loopStartTime,
      },
      sessionId: input.ctx.sessionId,
    };
    if (maxIterations > 0 && iterations >= maxIterations) {
      yield {
        type: 'turn.completed',
        usage: withTurnDuration({ ...accumulatedUsage, stopReason: 'tool_use_loop_capped' }),
        sessionId: input.ctx.sessionId,
      };
      return;
    }
  }
  } finally {
    // Emit loop_end regardless of which exit path above fired.
    void emitSessionPhase(input.traceWriter, {
      phase: 'loop_end',
      durationMs: Date.now() - loopStartTime,
    });
  }
}

function dumpThinkingDiagnostic(messages: MessageParam[], error: Error): void {
  try {
    const offending: Array<{ msgIdx: number; blockIdx: number; thinking: string; sigLen: number }> = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
      const blocks = msg.content as ContentBlockParam[];
      for (let j = 0; j < blocks.length; j++) {
        const b = blocks[j]!;
        if ((b as { type: string }).type === 'thinking') {
          const tb = b as { thinking?: string; signature?: string };
          if (!tb.thinking || !tb.signature) {
            offending.push({
              msgIdx: i,
              blockIdx: j,
              thinking: tb.thinking ? `(${tb.thinking.length} chars)` : '(empty)',
              sigLen: tb.signature?.length ?? 0,
            });
          }
        }
      }
    }
    console.error(
      '[afk] thinking-block diagnostic — API rejected request with:',
      error.message,
    );
    console.error(
      `[afk]   messages.length=${messages.length}, invalid thinking blocks:`,
      offending.length > 0 ? JSON.stringify(offending) : 'none found (cause may be elsewhere)',
    );
  } catch {
    // diagnostic must never throw
  }
}
