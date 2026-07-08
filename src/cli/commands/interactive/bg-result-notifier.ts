/**
 * REPL-side auto-delivery for background subagent results.
 *
 * Subscribes to `BackgroundAgentRegistry`'s `settled` event and buffers, per
 * settled job:
 *
 *   1. **Model-context injection** — a `<background-subagent-result>` XML
 *      envelope carrying the job's final output (completed) or error
 *      (failed), drained by the REPL loop and PREPENDED to the next user
 *      message before `runTurn`. Mirrors the `ShellPassthrough` injection
 *      contract exactly: results sit between user messages, the model reads
 *      them on the next turn. No mid-turn push — the provider consumes one
 *      input-stream message per turn, so live injection would desync the
 *      stream renderer (see commit 51c46d8 for the SubagentStop variant of
 *      that bug).
 *   2. **Human notification** — a one-line summary the REPL renders at the
 *      top of the next loop iteration, alongside shell-job notices.
 *
 * Cancelled jobs get a notification only (no injection): explicit cancels
 * were operator-initiated so the model gains nothing from the result, and
 * cascade cancels fire during session teardown when the buffer will never
 * drain anyway.
 *
 * `/bgsub:join` remains available for manual replay — delivery does not
 * consume the job; the registry entry stays joinable until TTL eviction.
 *
 * Opt-out: set `AFK_BG_AUTO_DELIVER=0` (or false/off/no) to restore the
 * join-only behavior. Checked at event time so tests can toggle per-case.
 *
 * @module cli/commands/interactive/bg-result-notifier
 */

import type {
  BackgroundAgentRegistry,
  BackgroundJob,
} from '../../../agent/background-registry.js';
import { annotateIfIncomplete } from '../../../agent/subagent/result.js';
import { env } from '../../../config/env.js';
import { formatDuration } from '../../format-utils.js';

/**
 * Maximum byte length of one job's injected output. Results beyond this are
 * truncated with a marker pointing at `/bgsub:join <id>` for the full text.
 * 16KB keeps a burst of parallel jobs from flooding the next turn's prompt
 * while comfortably fitting the compressed-findings contract subagents are
 * instructed to follow.
 */
export const MAX_INJECTION_BYTES = 16 * 1024;

/** Maximum number of pending injections/notifications kept; oldest dropped. */
const MAX_PENDING = 25;

/**
 * One pending settled-job event surfaced via {@link BgResultNotifier.drainNotifications}.
 * The REPL formats and renders these at the top of the next loop iteration.
 */
export interface PendingBgAgentNotification {
  job: BackgroundJob;
}

/**
 * Minimal XML escaping for content inserted into the result envelope.
 * Guards against subagent output containing closing tags that would break
 * the envelope framing and inject arbitrary structure into model context —
 * same defense as ShellPassthrough's escapeXml (C-2).
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Extract the model-facing output text from a settled job's result. */
function extractOutput(job: BackgroundJob): string {
  const result = job.result;
  if (!result) return '';
  if (job.status === 'failed') {
    const errText = result.error
      ? `${result.error.name}: ${result.error.message}`
      : 'unknown error';
    const partial =
      typeof result.partialOutput === 'string' && result.partialOutput.length > 0
        ? `\n\nPartial output before failure:\n${result.partialOutput}`
        : '';
    return `Subagent failed — ${errText}${partial}`;
  }
  const raw = result.message?.content;
  // A `completed` background job can still carry an incomplete partial (capped
  // or stream-truncated); mark it so the injected result isn't read as final.
  if (typeof raw === 'string') return annotateIfIncomplete(raw, result.stopReason);
  if (raw !== undefined) return JSON.stringify(raw);
  return '';
}

/**
 * Truncate `text` to `maxBytes` of UTF-8, appending a marker naming the
 * job so the model knows how to retrieve the full result. Byte-accurate
 * (not char-accurate) so multi-byte content can't overshoot the cap.
 *
 * Invariant: called on ALREADY-ESCAPED text so the cap bounds the final
 * injected size. Escape-then-truncate matters: escaping expands `<` to
 * `&lt;` (4×), so truncating pre-escape text would let adversarial output
 * (e.g. 16KB of `<`) balloon to ~64KB post-escape and bypass the cap.
 * Truncation may cut an entity mid-sequence (`&am`); harmless in model
 * context.
 */
function truncateBytes(text: string, maxBytes: number, jobId: string): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  // toString on a sliced buffer may end mid-codepoint; the replacement char
  // it produces is harmless in model context.
  return (
    buf.toString('utf8') +
    `\n… [truncated at ${maxBytes} bytes — full result via /bgsub:join ${jobId}]`
  );
}

/**
 * Build the model-injection envelope for one settled job. Wrapped in
 * `<background-subagent-result>` tags — distinct from the `agent` tool's
 * foreground result envelope so the model understands this arrived
 * asynchronously, not as a tool result it just awaited.
 */
export function buildBgResultInjection(job: BackgroundJob): string {
  const duration =
    job.endedAt !== undefined ? formatDuration(job.endedAt - job.startedAt) : 'unknown';
  // Escape BEFORE truncating so the byte cap bounds the final injected
  // size — see truncateBytes' invariant for the expansion-bypass rationale.
  const output = truncateBytes(escapeXml(extractOutput(job)), MAX_INJECTION_BYTES, job.jobId);
  const lines: string[] = [];
  lines.push(
    `<background-subagent-result jobId="${job.jobId}" status="${job.status}" ` +
      `model="${escapeXml(job.model)}" duration="${duration}">`,
  );
  lines.push(`<task>${escapeXml(job.label)}</task>`);
  lines.push('<output>');
  lines.push(output);
  lines.push('</output>');
  lines.push('</background-subagent-result>');
  return lines.join('\n');
}

/**
 * Resolve the auto-deliver toggle. Default ON; denylist opt-out matching
 * the AFK_SHELL_PASSTHROUGH convention (0/false/off/no, case-insensitive).
 */
export function isAutoDeliverEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return !/^(0|false|off|no)$/i.test(raw);
}

/**
 * Public API used by the REPL loop. One instance per `runReplLoop` —
 * lifetime tracks the surrounding REPL session; `dispose()` unsubscribes
 * from the registry in the loop's teardown path.
 */
export class BgResultNotifier {
  /** Buffer of settled jobs awaiting injection into the next user turn. */
  private pendingInjections: BackgroundJob[] = [];
  /** Buffer of settled jobs awaiting a one-line completion notice. */
  private pendingNotifications: PendingBgAgentNotification[] = [];

  private readonly onSettled = (job: BackgroundJob): void => {
    if (!isAutoDeliverEnabled(env.AFK_BG_AUTO_DELIVER)) return;
    this.pendingNotifications.push({ job });
    if (this.pendingNotifications.length > MAX_PENDING) {
      this.pendingNotifications.shift();
    }
    // Cancelled jobs are notice-only: explicit cancels are operator-driven
    // and cascade cancels happen at teardown (buffer never drains).
    if (job.status === 'cancelled') return;
    this.pendingInjections.push(job);
    if (this.pendingInjections.length > MAX_PENDING) {
      this.pendingInjections.shift();
    }
  };

  constructor(private readonly registry: BackgroundAgentRegistry) {
    registry.on('settled', this.onSettled);
  }

  /**
   * Drain and return the concatenated injection envelopes to prepend to the
   * next user message. Empty string when nothing is queued so callers can
   * blindly concatenate. Marks each delivered job in the witness trace via
   * the registry so operators can distinguish auto-delivery from explicit
   * joins.
   */
  drainInjections(): string {
    if (this.pendingInjections.length === 0) return '';
    const jobs = this.pendingInjections;
    this.pendingInjections = [];
    for (const job of jobs) this.registry.markDelivered(job.jobId);
    return jobs.map((j) => buildBgResultInjection(j)).join('\n') + '\n';
  }

  /**
   * Drain and return pending completion notifications so the REPL loop's
   * top-of-iteration block can render them. The REPL owns formatting.
   */
  drainNotifications(): readonly PendingBgAgentNotification[] {
    if (this.pendingNotifications.length === 0) return [];
    const out = this.pendingNotifications;
    this.pendingNotifications = [];
    return out;
  }

  /**
   * Drop all buffered injections and notifications without delivering
   * them. Called on mid-session /resume swap: jobs that settled under the
   * outgoing session must not leak their results into the resumed
   * session's first turn (mirrors the verdict-ledger reset semantics).
   */
  reset(): void {
    this.pendingInjections = [];
    this.pendingNotifications = [];
  }

  /** Unsubscribe from the registry. Idempotent. */
  dispose(): void {
    this.registry.off('settled', this.onSettled);
  }
}
