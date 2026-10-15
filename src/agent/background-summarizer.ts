/**
 * BackgroundSummarizer — periodic Haiku summaries for background subagent jobs.
 *
 * Side-car to BackgroundAgentRegistry. When opt-in is enabled via
 * `afk.config.json "bgSummaries": true`, the summarizer periodically asks
 * claude-haiku-4-5 to summarize each running job's transcript tail in ≤80
 * tokens. Summaries are surfaced by `/bgsub:list` on a second indented line.
 *
 * Design invariants:
 *   - Does NOT touch main-session token usage (separate oneShotCompletion call).
 *   - `transcriptTail` is the only transcript source (ring buffer on InternalJob).
 *   - Budget cap: `maxCallsPerSession` (default 200) — skips silently when exceeded.
 *   - Stale-on-failure: last good text is preserved; `stale: true` is set.
 *   - Per-job jitter: `(jobIndex * 3000) % intervalMs` to spread API calls.
 *
 * @module agent/background-summarizer
 */

import { debugLog } from '../utils/debug.js';
import type { BackgroundAgentRegistry } from './background-registry.js';
import { oneShotCompletion } from './providers/anthropic-direct/oneshot.js';
import { withTransientRetry } from './providers/shared/transient-retry.js';
import { traceExhaustedRetry } from './providers/shared/transient-retry.trace.js';
import { redactSecrets } from './redact-secrets.js';
import type { TraceSink } from './trace/index.js';

export interface SummaryEntry {
  text: string;
  refreshedAt: number;
  stale: boolean;
}

export interface BackgroundSummarizerOptions {
  registry: BackgroundAgentRegistry;
  apiKey: string;
  model?: string;
  /** Base interval between refreshes in ms. Default 15 000. */
  intervalMs?: number;
  /** Hard cap on input tokens for the Haiku call. Default 1000. */
  maxInputTokens?: number;
  /** Hard cap on output tokens for the Haiku call. Default 80. */
  maxOutputTokens?: number;
  /** Session-wide budget: skip after this many calls. Default 200. */
  maxCallsPerSession?: number;
  /**
   * Witness trace sink for recording retry-exhaustion events. When provided,
   * a `connection_retry_exhausted` session_phase event is emitted via
   * {@link traceExhaustedRetry} whenever the one-shot retry budget is spent.
   * Optional — omitting it silently disables trace emission (no-op path).
   */
  traceWriter?: TraceSink;
  /**
   * Injected for tests. When provided, supplants real oneShotCompletion.
   * The function receives the full user prompt and an optional AbortSignal.
   */
  callLLM?: (prompt: string, signal?: AbortSignal) => Promise<string>;
  /**
   * Injected for tests. When provided, supplants registry.getTranscript(jobId).
   */
  getTranscript?: (jobId: string) => string | undefined;
}

const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_INPUT_TOKENS = 1000;
const DEFAULT_MAX_OUTPUT_TOKENS = 80;
const DEFAULT_MAX_CALLS = 200;
const PER_JOB_JITTER_MS = 3_000;

const SYSTEM_PROMPT =
  'Summarize what this background subagent is currently doing in ≤80 tokens. ' +
  'Be concrete: name specific tools used, files examined, decisions made. ' +
  'Avoid filler ("appears to be working on…").';

// Secret-redaction helper moved to ./redact-secrets.js so lightweight
// externalization sinks (session-ledger, telegram streaming) can reuse the
// same patterns without pulling this module's provider-call dependency graph.
// Re-exported here for back-compat with existing importers and tests.
export { redactSecrets };

export class BackgroundSummarizer {
  private readonly registry: BackgroundAgentRegistry;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly intervalMs: number;
  private readonly maxInputTokens: number;
  private readonly maxOutputTokens: number;
  private readonly maxCallsPerSession: number;
  private readonly callLLM: (prompt: string, signal?: AbortSignal) => Promise<string>;
  private readonly getTranscriptFn: (jobId: string) => string | undefined;
  private readonly traceWriter: TraceSink | undefined;

  /** Summaries keyed by jobId. */
  private readonly summaries = new Map<string, SummaryEntry>();
  /** Per-job registration index — drives jitter calculation. */
  private readonly jobIndexMap = new Map<string, number>();
  /** Monotonic counter for assigning job indices. */
  private jobIndexCounter = 0;
  /** Session-wide LLM call counter. */
  private callsThisSession = 0;
  /** Last summary refresh timestamp per jobId (for cadence gating). */
  private readonly lastRefreshedAt = new Map<string, number>();

  private abortController: AbortController = new AbortController();
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private readonly tickIntervalMs: number;

  constructor(opts: BackgroundSummarizerOptions) {
    this.registry = opts.registry;
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxInputTokens = opts.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
    this.maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.maxCallsPerSession = opts.maxCallsPerSession ?? DEFAULT_MAX_CALLS;
    this.traceWriter = opts.traceWriter;

    // Tick interval is ~1/10 of the base interval so we can achieve
    // per-job jitter granularity without a separate timer per job.
    this.tickIntervalMs = Math.max(1000, Math.floor(this.intervalMs / 10));

    if (opts.callLLM !== undefined) {
      this.callLLM = opts.callLLM;
    } else {
      // Contract: maxRetries: 1 — one retry for transient errors; the existing
      // stale-on-failure fallback (catch block in refreshJobSummary) handles
      // permanent failures.
      // onRetry increments callsThisSession so each actual LLM call (initial
      // + each retry) is counted toward the budget cap, preventing a 1-retry
      // scenario from making 2 calls against a budget that charged only 1.
      // onExhausted emits a connection_retry_exhausted trace event when the
      // one-shot retry budget is spent (maxRetries: 1 → attempt 2 is the
      // terminal failure).
      this.callLLM = (prompt: string, signal?: AbortSignal) =>
        withTransientRetry(
          () => oneShotCompletion({
            token: this.apiKey,
            model: this.model,
            system: SYSTEM_PROMPT,
            user: prompt,
            maxTokens: this.maxOutputTokens,
            signal,
          }),
          {
            maxRetries: 1,
            signal,
            onRetry: () => { this.callsThisSession++; },
            onExhausted: traceExhaustedRetry(this.traceWriter, 'background_summarizer', 1),
          },
        );
    }

    this.getTranscriptFn = opts.getTranscript ?? ((jobId) => this.registry.getTranscript(jobId));

    // Subscribe to registry events to maintain jobIndexMap.
    this.registry.on('started', (job) => {
      this.jobIndexMap.set(job.jobId, this.jobIndexCounter++);
    });
    this.registry.on('settled', (job) => {
      // Clean up on settle: remove summary + index so we don't leak memory.
      this.summaries.delete(job.jobId);
      this.jobIndexMap.delete(job.jobId);
      this.lastRefreshedAt.delete(job.jobId);
    });
  }

  start(): void {
    if (this.tickTimer !== undefined) return; // already running
    this.abortController = new AbortController();
    this.tickTimer = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
  }

  stop(): void {
    if (this.tickTimer !== undefined) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    this.abortController.abort();
  }

  getSummary(jobId: string): SummaryEntry | undefined {
    return this.summaries.get(jobId);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    const now = Date.now();
    const runningJobs = this.registry.list().filter((j) => j.status === 'running');

    // Collect jobs that are due for a refresh this tick.
    const due: string[] = [];
    for (const job of runningJobs) {
      const idx = this.jobIndexMap.get(job.jobId) ?? 0;
      // Per-job jitter: offset by (jobIndex * 3s) % intervalMs so jobs
      // fire at staggered times rather than all on the same tick.
      const jitter = (idx * PER_JOB_JITTER_MS) % this.intervalMs;
      const minAge = this.intervalMs - 1000 - jitter;
      const lastRefresh = this.lastRefreshedAt.get(job.jobId) ?? 0;
      if (now - lastRefresh < minAge) continue;

      // Reserve the budget slot eagerly (before the parallel dispatch) so
      // the cap is enforced within a single tick even when multiple jobs are
      // due simultaneously.  refreshJob's finally{} decrements on any failure
      // so the reservation is always balanced.
      if (this.callsThisSession >= this.maxCallsPerSession) {
        debugLog(
          `[BackgroundSummarizer] budget cap (${this.callsThisSession}/${this.maxCallsPerSession}) — skipping ${job.jobId}`,
        );
        continue;
      }
      this.callsThisSession++;

      due.push(job.jobId);
    }

    // Refresh all due jobs concurrently so a slow LLM call for one job does
    // not stall refreshes for every other running job in the same tick.
    await Promise.allSettled(due.map((jobId) => this.refreshJob(jobId, now)));
  }

  private async refreshJob(jobId: string, now: number): Promise<void> {
    // Budget slot was reserved (incremented) by tick() before dispatch.
    //
    // Accounting invariant: every real API call must be charged exactly once.
    //   - tick() charges 1 for the initial attempt.
    //   - The withTransientRetry onRetry callback charges 1 per retry attempt.
    //   - We must only decrement the reservation when NO real API call was made
    //     (e.g. empty transcript early-return, or abort before the call launched).
    //     If at least one API call happened the slot was consumed; decrementing
    //     would under-count actual spend and allow the cap to be exceeded.
    let succeeded = false;
    let apiCallAttempted = false;
    try {
      const transcript = this.getTranscriptFn(jobId);
      if (transcript === undefined || transcript.trim().length === 0) {
        // No content yet — skip silently; release the reserved budget slot.
        return;
      }

      // Truncate to fit within maxInputTokens (rough approximation: 4 chars/token).
      const charBudget = this.maxInputTokens * 4;
      const rawTail =
        transcript.length > charBudget ? transcript.slice(-charBudget) : transcript;

      // ── Secret redaction ─────────────────────────────────────────────────
      // DATA-EGRESS CONTRACT: the transcript tail is the only content sent to the
      // Haiku third-party call (claude-haiku-4-5 via oneShotCompletion). We strip
      // common secret patterns before transmission to reduce the risk of leaking
      // API keys, tokens, or other credentials that may appear in tool output.
      //
      // Patterns redacted (replaced with [REDACTED]):
      //   • Bearer / token header values        (Authorization: Bearer <token>)
      //   • Anthropic API keys                  (sk-ant-...)
      //   • Generic long hex/base64 secrets     (≥32 contiguous non-space chars
      //                                          that look like a key)
      //
      // This is a best-effort defence-in-depth measure. The authoritative data
      // boundary is the `bgSummaries` opt-in flag in afk.config.json — operators
      // must consciously enable summarisation and thereby accept that a redacted
      // transcript tail will leave the local process.
      const transcriptText = redactSecrets(rawTail);

      const userPrompt =
        `Transcript tail:\n<transcript>\n${transcriptText}\n</transcript>`;

      this.lastRefreshedAt.set(jobId, now);

      apiCallAttempted = true;
      const text = await this.callLLM(userPrompt, this.abortController.signal);
      this.summaries.set(jobId, {
        text: text.trim(),
        refreshedAt: now,
        stale: false,
      });
      succeeded = true;
    } catch (err) {
      debugLog(`[BackgroundSummarizer] Haiku call failed for ${jobId}:`, err);
      // Mark stale only when the failure is not due to stop() aborting us.
      if (!this.abortController.signal.aborted) {
        const prev = this.summaries.get(jobId);
        if (prev !== undefined) {
          this.summaries.set(jobId, { ...prev, stale: true });
        }
      }
    } finally {
      // Decrement the budget reservation ONLY when no real API call was made
      // (empty-transcript early-return or abort before the call launched).
      // When apiCallAttempted=true, the initial slot from tick() was consumed
      // by the real call; any retries were individually charged by the onRetry
      // callback in the constructor.  Decrementing here in that case would
      // undercount actual spend and allow the cap to be exceeded on retry paths.
      if (!succeeded && !apiCallAttempted) {
        this.callsThisSession--;
      }
    }
  }
}
