/**
 * Durable per-session event ledger glue, extracted from {@link AgentSession}.
 *
 * Owns the lazy lifecycle around a {@link SessionLedgerWriter}: create-on-first-
 * use (once the provider has issued a session id), pass-through record calls,
 * and an idempotent terminal seal. The session delegates to a single instance
 * held for its whole lifetime — {@link LedgerLifecycle.seal} resets the internal
 * writer + attempt latch so the same instance is reused cleanly across a
 * `reset()` (`/clear`) cycle, matching the original in-class behavior.
 *
 * @module agent/session/ledger-lifecycle
 */

import { env } from '../../config/env.js';
import { sessionLabelFromTracePath } from '../../paths.js';
import { SessionLedgerWriter } from '../session-ledger.js';
import type { OutputEvent } from '../types.js';
import type { ElicitationRequest } from '../types/sdk-types.js';

/**
 * Inputs for {@link LedgerLifecycle.ensure}. `getMetadata` is a lazy accessor so
 * session metadata is read only when a writer is actually created — never on the
 * per-turn no-op path once the attempt latch is set.
 */
export interface LedgerEnsureContext {
  /** Subagent-fork markers — either being set gates the ledger off. */
  depth: number | undefined;
  parentSessionId: string | undefined;
  /** Provider-issued session id; absent until `session.init` drained. */
  sessionId: string | undefined;
  /** Fallback model id (`String(config.model)`) when metadata carries none. */
  fallbackModel: string;
  /** The witness trace path, if tracing is wired (for the id→label bridge). */
  tracePath: string | undefined;
  /** Lazy metadata read — invoked only when the writer is created. */
  getMetadata: () => { model?: string; cwd?: string };
}

export class LedgerLifecycle {
  private writer: SessionLedgerWriter | null = null;
  /** Set true once ledger creation has been attempted (success or not). */
  private initAttempted = false;

  /**
   * Create the ledger writer on first use.
   *
   * Gates (all must pass): top-level session (`depth`/`parentSessionId` unset);
   * `AFK_SESSION_LEDGER_DISABLED` is not `'1'`; the provider has issued a
   * session id. One attempt per lifecycle: if the id is unavailable or unsafe
   * the first time, the session runs unledgered — never throws, never retries
   * per-event (the `initAttempted` latch keeps the hot path cheap).
   */
  ensure(ctx: LedgerEnsureContext): void {
    if (this.initAttempted) return;
    this.initAttempted = true;
    if (ctx.depth !== undefined || ctx.parentSessionId !== undefined) return;
    if (env.AFK_SESSION_LEDGER_DISABLED === '1') return;
    const id = ctx.sessionId;
    if (!id) return;
    const writer = new SessionLedgerWriter(id);
    if (!writer.active) return;
    this.writer = writer;
    const meta = ctx.getMetadata();
    writer.record({
      kind: 'meta',
      sessionId: id,
      model: meta.model ?? ctx.fallbackModel,
      ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
      // Correlate this id-keyed ledger to its witness trace: fresh sessions
      // label the trace dir with a random UUID (not the session id), so the
      // ledger is the durable id→label bridge. `null` when tracing is
      // disabled/unwired, so absence is explicit rather than silent.
      traceLabel: sessionLabelFromTracePath(ctx.tracePath),
    });
  }

  /** Record the outbound user message summary. No-op when unledgered. */
  recordUser(text: string): void {
    this.writer?.recordUser(text);
  }

  /** Record a transformed provider output event. No-op when unledgered. */
  recordEvent(event: OutputEvent): void {
    this.writer?.recordEvent(event);
  }

  /**
   * Append an AFK remote-control `elicitation` record. No-op when the session
   * is unledgered (subagent, ledger disabled, or no provider session id yet).
   */
  recordElicitation(reqId: string, request: ElicitationRequest): void {
    this.writer?.record({ kind: 'elicitation', reqId, request });
  }

  /**
   * Seal the ledger with a terminal record and flush. Idempotent. Resets the
   * internal writer + attempt latch so the instance is reusable after a
   * `reset()` cycle. Callers on the close/reset paths await the returned
   * promise; the abort path fire-and-forgets it.
   */
  seal(reason: string): Promise<void> {
    const writer = this.writer;
    if (!writer) return Promise.resolve();
    this.writer = null;
    this.initAttempted = false;
    return writer.close(reason);
  }
}
