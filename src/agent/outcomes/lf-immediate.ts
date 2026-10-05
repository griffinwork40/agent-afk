/**
 * Immediate labeling functions — computed from session tool events + text.
 *
 * LFs computed here:
 *   - closure      : abort/iteration_cap from trace closure events
 *   - budget_cap   : closure.reason == iteration_cap
 *   - error_tail   : 3+ consecutive isError tool events ending the session
 *   - verification : test/lint/build command ran after last write, exit status
 *   - in_session_correction : later user turn with correction keywords
 *   - self_report  : parse final Done/Blocked/Asking/Interrupted block
 *
 * All I/O (trace reads) is behind injectable functions so unit tests need no FS.
 */

import type { Vote, SelfReport } from './schema.js';
import type { Turn, ToolEvent } from './artifacts.js';
import {
  isVerificationCommand,
  parseVerificationSummary,
} from './verification-patterns.js';
import { parseTerminalState } from './terminal-state.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClosureInfo {
  reason: 'abort' | 'iteration_cap' | 'normal' | 'unknown';
}

/** Injectable: load closure info from a witness trace, or return null if unavailable. */
export type LoadClosure = (sessionId: string) => ClosureInfo | null;

// ---------------------------------------------------------------------------
// Write/edit tool names — used to find the last mutation before verification
// ---------------------------------------------------------------------------

const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'patch_apply',
]);

// A single `|` (not `||`), or an explicit exit-status mask.
const MASKED_EXIT = /(?<!\|)\|(?!\|)|\|\|\s*(?:true|:|echo)\b|;\s*(?:true|exit 0)\b/;

/**
 * Contract: true only when `isError` on this event reflects the verification
 * command's own exit status.
 *
 * History: on real data 1,591 of 2,196 stored verification-like bash commands
 * were piped (`pnpm test 2>&1 | tail -5`) or masked, so the recorded exit
 * status was the pipe's last stage, not the test run's, and the ~90-char
 * result preview (`…+3 lines`) carried no pass/fail text either. The first M0
 * cut counted those as passes. Rules: `test_run` is structured and trusted;
 * bash is trusted only when its stored input is complete (stored inputs are
 * truncated with a trailing ellipsis, which could hide a pipe) and unmasked;
 * and `isError` must be explicitly recorded (older events omit it).
 */
function exitStatusTrustworthy(ev: ToolEvent): boolean {
  if (ev.isError !== true && ev.isError !== false) return false;
  if (ev.toolName === 'test_run') return true;
  const input = ev.input ?? '';
  if (input.trimEnd().endsWith('\u2026')) return false;
  return !MASKED_EXIT.test(input);
}

// ---------------------------------------------------------------------------
// Correction keyword heuristic
// ---------------------------------------------------------------------------

const CORRECTION_PATTERNS = [
  /^\s*(no|nope|not quite|wrong|incorrect)/i,
  /\brevert\b/i,
  /\bstill broken\b/i,
  /\bthat'?s not\b/i,
  /\bthat is not\b/i,
  /\broll(?:ing)?\s+back\b/i,
];

function hasCorrectionLanguage(text: string): boolean {
  return CORRECTION_PATTERNS.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Self-report parser
// ---------------------------------------------------------------------------

/**
 * Legacy inline-bold pattern for the backfill path.
 *
 * Invariant: this is used ONLY as a fallback in parseSelfReport when
 * parseTerminalState returns null. Historical transcripts (pre-heading-format
 * prompt) used inline bold markers anywhere in the text (e.g. "Task complete.
 * **Done**" or "**Blocked** — needs credentials."). The backfill path must
 * recognize those transcripts; the live REPL/daemon path should not.
 */
const LEGACY_SELF_REPORT_PATTERN =
  /\*\*(Done|Blocked|Asking|Interrupted)\*\*/i;

/**
 * Parse the assistant's final text for a Done/Blocked/Asking/Interrupted
 * heading and return the matching SelfReport value, or 'none'.
 *
 * Strategy: try parseTerminalState first (gets fenced-code-block skipping,
 * tail-anchoring, and heading-format tolerance). If that returns null, fall
 * back to the legacy inline-bold pattern so historical transcripts in the
 * backfill path are still recognized. The fallback is intentionally not
 * added to parseTerminalState itself — that parser is conservative by design
 * and must not change semantics for the live REPL/daemon verdict surface.
 *
 * History: parseSelfReport previously used only the legacy regex; #2799
 * rebuilt it on parseTerminalState to prevent drift. The fallback preserves
 * backward compatibility for the backfill path without reopening the drift
 * risk for new sessions.
 */
export function parseSelfReport(assistantText: string): SelfReport {
  const state = parseTerminalState(assistantText);
  if (state !== null) return state.kind;

  // Backfill fallback: recognize legacy inline-bold markers from historical
  // transcripts where the keyword was embedded in prose rather than on its
  // own heading line.
  const m = LEGACY_SELF_REPORT_PATTERN.exec(assistantText);
  if (m) {
    const kw = m[1]!.toLowerCase();
    if (kw === 'done') return 'done';
    if (kw === 'blocked') return 'blocked';
    if (kw === 'asking') return 'asking';
    if (kw === 'interrupted') return 'interrupted';
  }

  return 'none';
}

// ---------------------------------------------------------------------------
// Flatten tool events from all turns into a timestamped list
// ---------------------------------------------------------------------------

function flatToolEvents(turns: Turn[]): ToolEvent[] {
  return turns.flatMap((t) => t.toolEvents ?? []);
}

// ---------------------------------------------------------------------------
// LF: closure
// ---------------------------------------------------------------------------

/**
 * Returns a vote for `closure` (strong) if the trace says the session was
 * aborted, or for `budget_cap` (weak) if it hit the iteration cap.
 * Returns null vote if trace is unavailable or normal closure.
 */
export function lfClosure(
  sessionId: string,
  loadClosure: LoadClosure,
  now: string,
): Vote[] {
  const info = loadClosure(sessionId);
  if (info === null) return [];

  const votes: Vote[] = [];
  if (info.reason === 'abort') {
    votes.push({
      lf: 'closure',
      vote: -1,
      strength: 'strong',
      evidence: `trace closure.reason=abort`,
      observed_at: now,
    });
  } else if (info.reason === 'iteration_cap') {
    votes.push({
      lf: 'budget_cap',
      vote: -1,
      strength: 'weak',
      evidence: `trace closure.reason=iteration_cap`,
      observed_at: now,
    });
  }
  return votes;
}

// ---------------------------------------------------------------------------
// LF: error_tail
// ---------------------------------------------------------------------------

/**
 * Returns a strong -1 vote when the session ends with 3+ consecutive isError
 * tool events. Looks at the last N events where N >= 3.
 */
export function lfErrorTail(turns: Turn[], now: string): Vote | null {
  const events = flatToolEvents(turns);
  if (events.length < 3) return null;

  // Walk backward from the end, counting consecutive errors
  let consecutiveErrors = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) break;
    if (ev.isError === true) {
      consecutiveErrors++;
    } else {
      break;
    }
  }

  if (consecutiveErrors >= 3) {
    return {
      lf: 'error_tail',
      vote: -1,
      strength: 'strong',
      evidence: `${consecutiveErrors} consecutive isError tool events at session end`,
      observed_at: now,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// LF: verification
// ---------------------------------------------------------------------------

/**
 * Returns a strong +1 or -1 vote if a verification command ran after the last
 * write/edit tool call. Only fires for mutating sessions (at least one write).
 * +1 = verification passed (no isError); -1 = verification failed with no
 * later passing run.
 *
 * "Write" here means write_file, edit_file, or patch_apply — not bash,
 * because bash can be both a mutation and a verification command; treating
 * bash as a write tool would force verification to run after itself.
 */
export function lfVerification(turns: Turn[], now: string): Vote | null {
  const events = flatToolEvents(turns);

  // Find the index of the last file-mutation tool call
  let lastWriteIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev !== undefined && WRITE_TOOLS.has(ev.toolName)) {
      lastWriteIdx = i;
      break;
    }
  }
  // Also consider bash git-commit commands as evidence of a write session,
  // but only to determine mutating vs text; verification scan is unaffected.
  const hasBashWrite = events.some(
    (ev) => ev.toolName === 'bash' && /git\s+commit|git\s+push/.test(ev.input ?? ''),
  );

  if (lastWriteIdx < 0 && !hasBashWrite) return null; // non-mutating session

  // Search for verification commands. For bash-only sessions, scan all events.
  // For sessions with write_file/edit_file, scan only events after lastWriteIdx.
  const searchFrom = lastWriteIdx >= 0 ? lastWriteIdx + 1 : 0;

  let lastVerifyEv: ToolEvent | null = null;
  for (let i = searchFrom; i < events.length; i++) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (ev.toolName === 'bash' || ev.toolName === 'test_run') {
      const input = ev.input ?? '';
      if (ev.toolName === 'test_run' || isVerificationCommand(input)) {
        lastVerifyEv = ev;
      }
    }
  }

  if (lastVerifyEv === null) return null;

  // Prefer a parsed summary from resultTail — reliable even when the command
  // was piped (72% of real runs). Fall back to exit-status rules only when no
  // tail is recorded or the tail is ambiguous.
  const tail = lastVerifyEv.resultTail ?? '';
  const parsed = tail.length > 0 ? parseVerificationSummary(tail) : null;
  if (parsed !== null) {
    return {
      lf: 'verification',
      vote: parsed === 'pass' ? 1 : -1,
      strength: 'strong',
      evidence: `verification summary from resultTail: ${parsed}`,
      observed_at: now,
    };
  }

  // Tail absent or ambiguous — fall back to exit-status rules, which require
  // a trustworthy (unpiped, unmasked, non-truncated) isError value.
  if (!exitStatusTrustworthy(lastVerifyEv)) return null;

  const passed = lastVerifyEv.isError === false;
  return {
    lf: 'verification',
    vote: passed ? 1 : -1,
    strength: 'strong',
    evidence: `verification command after last write: isError=${String(!passed)}`,
    observed_at: now,
  };
}

// ---------------------------------------------------------------------------
// LF: in_session_correction
// ---------------------------------------------------------------------------

/**
 * Returns a weak -1 if a user turn after turn 0 opens with correction language.
 * First turn is excluded (that's the original task, not a correction).
 */
export function lfInSessionCorrection(turns: Turn[], now: string): Vote | null {
  for (let i = 1; i < turns.length; i++) {
    const turn = turns[i];
    if (turn === undefined) continue;
    const user = turn.user ?? '';
    if (hasCorrectionLanguage(user)) {
      return {
        lf: 'in_session_correction',
        vote: -1,
        strength: 'weak',
        evidence: `user turn ${i} correction keywords`,
        observed_at: now,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// LF: self_report
// ---------------------------------------------------------------------------

/**
 * Parses the final assistant turn for a Done/Blocked/Asking block.
 * Returns the self-report value and a zero-vote record (self-report never votes,
 * but Blocked sets the label directly in the combiner).
 */
export function lfSelfReport(
  turns: Turn[],
  now: string,
): { selfReport: SelfReport; vote: Vote } {
  // Look in all assistant texts, prefer the last one
  let selfReport: SelfReport = 'none';
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn === undefined) continue;
    const assistant = turn.assistant ?? '';
    const sr = parseSelfReport(assistant);
    if (sr !== 'none') {
      selfReport = sr;
      break;
    }
  }

  return {
    selfReport,
    vote: {
      lf: 'self_report',
      vote: 0,
      strength: 'weak',
      evidence: `self_report=${selfReport}`,
      observed_at: now,
    },
  };
}

// ---------------------------------------------------------------------------
// Run all immediate LFs together
// ---------------------------------------------------------------------------

export interface ImmediateLFResult {
  votes: Vote[];
  selfReport: SelfReport;
}

export function runImmediateLFs(
  sessionId: string,
  turns: Turn[],
  loadClosure: LoadClosure,
  now: string = new Date().toISOString(),
): ImmediateLFResult {
  const votes: Vote[] = [];

  // closure + budget_cap
  votes.push(...lfClosure(sessionId, loadClosure, now));

  // error_tail
  const errTail = lfErrorTail(turns, now);
  if (errTail !== null) votes.push(errTail);

  // verification
  const verify = lfVerification(turns, now);
  if (verify !== null) votes.push(verify);

  // in_session_correction
  const correction = lfInSessionCorrection(turns, now);
  if (correction !== null) votes.push(correction);

  // self_report
  const { selfReport, vote: srVote } = lfSelfReport(turns, now);
  votes.push(srVote);

  return { votes, selfReport };
}
