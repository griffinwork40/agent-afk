/**
 * Turn-stream execution, extracted from {@link AgentSession}.
 *
 * Owns the cluster of methods that constitute a single outbound provider turn:
 *   - `buildTransformDeps()` — wires per-turn callbacks into the stream consumer
 *   - `runStream()` — the core `sendMessageStreamInternal` loop
 *   - `assertCanSend()` — pre-turn guard (state, abort, maxTurns)
 *   - `summarize()` — content-block-array → history-string collapse
 *   - `withPendingContext()` — FIFO drain of queued framework context
 *   - `ensureLedger()` — lazy ledger-writer creation on first turn
 *
 * No back-reference to {@link AgentSession}: all mutable state is accessed
 * through the {@link TurnRunnerDeps} context supplied at construction.
 *
 * @module agent/session/turn-stream-runner
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { AbortError } from '../../utils/errors.js';
import { debugLog } from '../../utils/debug.js';
import { captureSubagentPrompt } from './subagent-prompt-capture.js';
import {
  createSubagentOutputRecorder,
  type SubagentOutputRecorder,
} from './subagent-output-capture.js';
import { transformProviderEvent, type TransformDeps } from './stream-consumer.js';
import type { AccountingAccumulator } from './accounting-accumulator.js';
import type { LedgerLifecycle } from './ledger-lifecycle.js';
import type { OutputBroadcast } from './output-broadcast.js';
import type { SessionStateManager } from './session-state.js';
import { sessionLabelFromTracePath } from '../../paths.js';
import type {
  AgentConfig,
  OutputEvent,
  ResponseMetadata,
  SessionState,
} from '../types.js';
import type { ProviderQuery, ProviderEvent } from '../provider.js';
import type { Message } from '../types.js';

/**
 * Context bag passed to {@link TurnStreamRunner} at construction.
 * All mutable fields are accessed via their owning objects — no raw
 * primitive refs that would diverge on reset.
 */
export interface TurnRunnerDeps {
  getConfig: () => AgentConfig;
  getAbortController: () => AbortController;
  getProviderIterator: () => AsyncIterator<ProviderEvent>;
  stateManager: SessionStateManager;
  accounting: AccountingAccumulator;
  ledger: LedgerLifecycle;
  outputBroadcast: OutputBroadcast;
  conversationHistory: Message[];
  getInitPromise: () => Promise<void> | null;
  getSessionId: () => string | undefined;
  getState: () => SessionState;
  setState: (s: SessionState) => void;
  getLastResponseMetadata: () => ResponseMetadata | null;
  setLastResponseMetadata: (m: ResponseMetadata) => void;
  getPendingFrameworkContext: () => string[];
  setPendingFrameworkContext: (v: string[]) => void;
  getInboundMessageCount: () => number;
  incInboundMessageCount: () => number;
  getTurnCount: () => number;
  incTurnCount: () => void;
  getSubagentOutputRecorder: () => SubagentOutputRecorder | null | undefined;
  setSubagentOutputRecorder: (r: SubagentOutputRecorder | null) => void;
  getProviderQuery: () => ProviderQuery;
  getLedgerMetadata: () => ReturnType<SessionStateManager['getSessionMetadata']>;
}

/**
 * Runs a single provider-turn stream, accumulates output events, and
 * manages the subagent output recorder lifecycle.
 *
 * Constructed once per session; `deps.getProviderIterator()` is re-read on
 * every call so the runner works across resets.
 */
export class TurnStreamRunner {
  private readonly deps: TurnRunnerDeps;

  constructor(deps: TurnRunnerDeps) {
    this.deps = deps;
  }

  /** Pre-turn guard: throws when the session cannot accept a new message. */
  assertCanSend(): void {
    const { getState, getAbortController, getConfig, getTurnCount, accounting } = this.deps;
    const state = getState();
    if (state === 'closed') throw new Error('Cannot send message: session is closed');
    if (getAbortController().signal.aborted) {
      throw new AbortError('Cannot send message: session aborted');
    }
    if (state === 'processing' || state === 'streaming' || state === 'compacting') {
      throw new Error('Cannot send message: session is busy');
    }
    const config = getConfig();
    if (config.maxTurns && getTurnCount() >= config.maxTurns) {
      // Origin signal for `max_turns_exceeded`: the throw surfaces as a
      // generic dispatch error; flag the cause for closure classification.
      accounting.markMaxTurnsHit();
      throw new Error(`Maximum turns (${config.maxTurns}) exceeded`);
    }
  }

  /** Collapse a content-block array into a single history summary string. */
  summarize(blocks: ContentBlockParam[]): string {
    const textParts: string[] = [];
    let imageCount = 0;
    for (const block of blocks) {
      if (block.type === 'text') textParts.push(block.text);
      else if (block.type === 'image') imageCount++;
    }
    let summary = textParts.join(' ');
    if (imageCount > 0) {
      summary = summary
        ? `${summary} [+ ${imageCount} image(s)]`
        : `[+ ${imageCount} image(s)]`;
    }
    return summary || '[content block(s)]';
  }

  /**
   * Drain queued framework context, prepending it to the outbound content
   * (FIFO). Clears the queue so context is delivered exactly once.
   */
  withPendingContext(
    content: string | ContentBlockParam[],
  ): string | ContentBlockParam[] {
    const { getPendingFrameworkContext, setPendingFrameworkContext } = this.deps;
    const pending = getPendingFrameworkContext();
    if (pending.length === 0) return content;
    const prefix = pending.join('\n\n');
    setPendingFrameworkContext([]);
    if (typeof content === 'string') return `${prefix}\n\n${content}`;
    return [{ type: 'text', text: prefix }, ...content];
  }

  /** Create the session ledger writer on first use. */
  ensureLedger(): void {
    const { getConfig, getSessionId, ledger, getLedgerMetadata } = this.deps;
    const config = getConfig();
    ledger.ensure({
      depth: config.depth,
      parentSessionId: config.parentSessionId,
      sessionId: getSessionId(),
      fallbackModel: String(config.model),
      tracePath: config.traceWriter?.getTracePath(),
      getMetadata: getLedgerMetadata,
    });
  }

  /**
   * Build the per-turn `TransformDeps` bag that wires session callbacks into
   * the stream consumer. A fresh instance per turn prevents cross-turn
   * state leakage (the `_successfulToolNames` accumulator is turn-scoped).
   */
  buildTransformDeps(): TransformDeps {
    const {
      getConfig,
      getAbortController,
      stateManager,
      accounting,
      setLastResponseMetadata,
      conversationHistory,
    } = this.deps;
    const config = getConfig();
    return {
      // Fresh per-turn accumulator for successful tool names (see
      // TransformDeps._successfulToolNames). Initialized here — one deps
      // object per turn — so it never leaks across turns.
      _successfulToolNames: [],
      conversationHistory,
      getSessionMetadata: () => stateManager.getSessionMetadata(),
      setSessionMetadata: (updater) => stateManager.setSessionMetadata(updater),
      updateSessionIdentity: (sid) => stateManager.updateSessionIdentity(sid),
      resolveInitialization: () => stateManager.resolveInitializationOnce(),
      setLastResponseMetadata: (m) => {
        setLastResponseMetadata(m);
        // Mirror per-turn cost/token/stopReason into the session-wide
        // accumulator so the trace writer's `session_sealed` payload
        // reports cumulative spend.
        accounting.recordTurnMetadata(m);
      },
      // Budget enforcement (C6): wire maxBudgetUsd from config so the
      // stream consumer can abort when cumulative cost crosses the ceiling.
      maxBudgetUsd: config.maxBudgetUsd,
      abortBudget: (reason) => {
        const ctrl = getAbortController();
        if (!ctrl.signal.aborted) ctrl.abort(reason);
      },
      // Witness layer: thread the writer so the stream consumer can emit
      // the `budget` trace event on the turn that crosses maxBudgetUsd.
      ...(config.traceWriter ? { traceWriter: config.traceWriter } : {}),
    };
  }

  /**
   * Core turn-stream loop: pushes `content` onto the input stream, drains
   * the provider iterator for this turn's events, and yields each
   * {@link OutputEvent}. Awaits `initPromise` first so the session id exists.
   *
   * Corresponds to `AgentSession.sendMessageStreamInternal`.
   */
  async *runStream(
    content: string | ContentBlockParam[],
    inputStream: { pushUserMessage: (c: string | ContentBlockParam[]) => void },
  ): AsyncIterableIterator<OutputEvent> {
    const initPromise = this.deps.getInitPromise();
    if (initPromise) await initPromise;

    const effectiveContent = this.withPendingContext(content);
    const historySummary =
      typeof effectiveContent === 'string'
        ? effectiveContent
        : this.summarize(effectiveContent);

    const userMessage: Message = {
      role: 'user',
      content: historySummary,
      timestamp: new Date(),
    };
    this.deps.conversationHistory.push(userMessage);
    inputStream.pushUserMessage(effectiveContent);

    this.ensureLedger();
    this.deps.ledger.recordUser(historySummary);

    const inboundMessageIndex = this.deps.incInboundMessageCount();
    const config = this.deps.getConfig();
    const sessionId = this.deps.getSessionId();
    void captureSubagentPrompt({
      sessionId:
        sessionLabelFromTracePath(config.traceWriter?.getTracePath()) ?? sessionId,
      subagentId: config.subagentId,
      isSubagentFork: config.isSubagentFork === true,
      model: config.model === undefined ? undefined : String(config.model),
      turn: inboundMessageIndex,
      prompt: historySummary,
    });

    const deps = this.buildTransformDeps();

    // Invariant: SESSION-scoped recorder — one transcript per multi-turn child.
    // `undefined` = not yet attempted; `null` = capture disabled (checked once).
    if (this.deps.getSubagentOutputRecorder() === undefined) {
      this.deps.setSubagentOutputRecorder(
        createSubagentOutputRecorder({
          sessionId:
            sessionLabelFromTracePath(config.traceWriter?.getTracePath()) ?? sessionId,
          subagentId: config.subagentId,
          isSubagentFork: config.isSubagentFork === true,
          model: config.model === undefined ? undefined : String(config.model),
        }),
      );
    }
    const outputRecorder = this.deps.getSubagentOutputRecorder();

    try {
      while (true) {
        const result = await this.deps.getProviderIterator().next();
        if (result.done) break;
        const event = result.value;
        const output = transformProviderEvent(event, deps);

        if (output) {
          outputRecorder?.observe(output);
          if (output.type === 'done') {
            this.deps.incTurnCount();
            // A completed turn clears a prior error so the seal status
            // reflects the FINAL turn's outcome, not any earlier error.
            this.deps.accounting.clearProviderError();
          } else if (output.type === 'error') {
            // Terminal-cause flag: a per-turn provider error must flip the
            // eventual clean close from `succeeded` to `failed`.
            this.deps.accounting.markProviderError();
          }
          this.deps.ledger.recordEvent(output);
          this.deps.outputBroadcast.push(output);
          yield output;
          if (output.type === 'done' || output.type === 'error') break;
        }
      }
      outputRecorder?.end('stream_complete');
    } finally {
      // Invariant: `finally` is the ONLY path an aborted or timed-out child
      // takes — closing the generator runs it while `break` does not reach it.
      if (this.deps.getState() === 'streaming') {
        outputRecorder?.end('aborted_or_incomplete');
        this.deps.setState('idle');
      }
    }
  }

  /**
   * Queue hook-generated framework context for delivery with the next real
   * outbound user message. See the displacement-bug rationale in AgentSession.
   */
  queueFrameworkContext(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const pending = this.deps.getPendingFrameworkContext();
    this.deps.setPendingFrameworkContext([...pending, trimmed]);
    debugLog(
      `AgentSession: queued framework context (${trimmed.length} chars) for the next user message`,
    );
  }
}
