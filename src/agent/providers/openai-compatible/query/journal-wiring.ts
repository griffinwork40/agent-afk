/**
 * Message-journal wiring for {@link OpenAICompatibleQuery}
 * (docs/message-journal.md). Kept out of query.ts so the query only carries
 * one-line commit-point calls.
 *
 * Commit points (all `sync(priorTurns)`; JournalSync diffs by reference):
 *   - top of every `runIteration` (what is about to be sent);
 *   - after a tool round's assistant{tool_calls} + tool messages are pushed;
 *   - after the terminal assistant message is pushed;
 *   - after a successful compaction splice (`reason: 'compact'`);
 *   - after a microcompaction pass ({@link OpenAIJournalWiring.afterCompact}):
 *     it rewrites tool content IN PLACE, which the by-reference diff cannot
 *     see, so it invalidates from the first cleared message and re-syncs.
 *
 * Resume: when `config.resumeMessages` is set, `priorTurns` is seeded from it
 * via the adapter and the legacy text-only `resumeHistory` replay is skipped
 * (it would duplicate the conversation). Without a journal nothing changes.
 *
 * @module agent/providers/openai-compatible/query/journal-wiring
 */

import { JournalSync } from '../../../journal/index.js';
import type { AgentConfig, ResumeHistoryTurn } from '../../../types/config-types.js';
import type { ProviderCompactResult, ProviderUsage } from '../../../provider.js';
import type { OpenAIMessage } from '../messages.js';
import { openAIJournalAdapterForEndpoint } from '../journal-adapter.js';
import { resumeSeedInputTokens } from '../../shared/resume-usage-seed.js';
import type { JournalMessage } from '../../../journal/index.js';
import { resolveMicrocompactOptions } from '../../shared/compaction.js';
import { env } from '../../../../config/env.js';
import { microcompactToolResults } from '../compact.js';

export class OpenAIJournalWiring {
  private readonly journalSync: JournalSync<OpenAIMessage>;

  private readonly adapter;

  constructor(private readonly config: AgentConfig, baseURL?: string) {
    this.adapter = openAIJournalAdapterForEndpoint(baseURL);
    this.journalSync = new JournalSync(config.messageJournal, this.adapter);
  }

  /**
   * Starting `priorTurns` for this runtime: the journal-resumed conversation
   * when present (and seeded into the journal), otherwise `[]` (seeded lazily
   * on the first sync, which also resets a journal after `/clear`).
   */
  initialTurns(): OpenAIMessage[] {
    const resumed = this.config.resumeMessages;
    if (resumed === undefined) return [];
    const turns = this.adapter.fromJournalMessages(resumed);
    this.journalSync.seed(turns);
    return turns;
  }

  /**
   * Context-overflow guard seed (#1294): the last sidecar turn's `inputTokens`
   * when present, else an estimate over `resumeMessages` (shared helper).
   * Conservative: over-estimating triggers compaction; under-estimating lets
   * a full context hit a 400.
   */
  resumedUsage(): ProviderUsage | null {
    const inputTokens = resumeSeedInputTokens(this.config);
    if (inputTokens === undefined || inputTokens <= 0) return null;
    return { inputTokens, stopReason: null, resultSubtype: 'success', isError: false };
  }

  /** Legacy sidecar replay, suppressed when the journal supplied the history. */
  legacyResumeHistory(): { resumeHistory?: ResumeHistoryTurn[] } {
    const history = this.config.resumeHistory;
    return history !== undefined && this.config.resumeMessages === undefined ? { resumeHistory: history } : {};
  }

  /**
   * Journal a compaction attempt's outcome. A splice (`compacted`) replaces
   * index 0, so the plain diff re-appends everything (covering any
   * microcompaction edits made after it). A microcompaction-only pass wrote
   * placeholders IN PLACE into already-synced tool messages, invisible to the
   * by-reference diff, so invalidate from the first edited message first.
   * Never throws.
   */
  afterCompact(turns: readonly OpenAIMessage[], result: ProviderCompactResult): void {
    const mc = result.microcompaction;
    if (!result.compacted && (mc === undefined || mc.blocksCleared <= 0)) return;
    if (!result.compacted) this.journalSync.invalidateFrom(mc?.firstClearedIndex ?? 0);
    this.sync(turns, true);
  }

  /**
   * Deterministic microcompaction fallback (options from env, same source as
   * compact.ts) with its in-place edits journaled. Returns the
   * `microcompacted` result, or `null` when nothing qualified.
   */
  microcompactFallback(turns: OpenAIMessage[]): ProviderCompactResult | null {
    const opts = resolveMicrocompactOptions(
      env.AFK_MICROCOMPACT_TOOL_RESULT_BYTES,
      env.AFK_MICROCOMPACT_KEEP_LAST,
      env.AFK_MICROCOMPACT_DELEGATION_BYTES,
    );
    const { blocksCleared, bytesReclaimed, firstClearedIndex } = microcompactToolResults(turns, opts);
    if (blocksCleared <= 0) return null;
    const result: ProviderCompactResult = {
      compacted: false,
      reason: 'microcompacted',
      messagesBefore: turns.length,
      messagesAfter: turns.length,
      microcompaction: { blocksCleared, bytesReclaimed, ...(firstClearedIndex !== undefined ? { firstClearedIndex } : {}) },
    };
    this.afterCompact(turns, result);
    return result;
  }

  /** Live conversation in journal form (synced first); `undefined` without a journal. */
  snapshot(turns: readonly OpenAIMessage[]): JournalMessage[] | undefined {
    if (!this.journalSync.enabled) return undefined;
    this.sync(turns);
    return this.journalSync.snapshot();
  }

  /** Commit the current array to the journal. Never throws. */
  sync(turns: readonly OpenAIMessage[], compacted = false): void {
    try {
      this.journalSync.sync(turns, compacted ? { reason: 'compact' } : {});
    } catch {
      // Journal is best-effort; a mapping bug must never break a turn.
    }
  }
}
