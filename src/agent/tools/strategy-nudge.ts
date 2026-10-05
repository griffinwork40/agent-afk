/**
 * Advisory same-error strategy nudge.
 *
 * Invariant: this is the third of three distinct failure observers, and all
 * three stay live because they key on different things:
 *   - `repeat-circuit-breaker.ts` counts BYTE-IDENTICAL calls (any outcome).
 *   - `repeat-failure-guard.ts` counts consecutive failures of the SAME
 *     normalized CALL and refuses execution at 3.
 *   - this module counts recurrences of the SAME normalized ERROR, regardless
 *     of which call produced it.
 * The gap this closes: an agent that varies its command on every attempt but
 * keeps hitting the same underlying error never trips either of the first two,
 * because each attempt has a fresh call fingerprint. That varied-attempt,
 * same-error loop is exactly the moment a human stops tweaking and changes
 * mode (search the error, reread the code, re-plan). Measured on 268 witness
 * traces (2026-10-05): ~1.8% of bash failures were followed by a web search
 * within 5 calls.
 *
 * Contract:
 *   - Advisory only: appends text to an error result; never changes `isError`,
 *     never refuses or blocks a call, never alters successes.
 *   - Fires at most ONCE per error signature per dispatcher (session or fork).
 *   - Only failures from {@link STRATEGY_NUDGE_TOOLS} are counted, and only
 *     when an error line can be identified. A failure with no recognizable
 *     error line (or only generic "exited with code N" headers) yields no
 *     signature and can never trigger the nudge: a false positive teaches the
 *     model to ignore nudges, which is worse than a missed one.
 *   - Recurrence must happen within {@link STRATEGY_NUDGE_WINDOW} observed
 *     results; an error that comes back much later resets the count. A
 *     signature that already nudged never nudges again, even if the count
 *     resets and climbs back up to the threshold.
 *
 * @module agent/tools/strategy-nudge
 */

import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';
import type { TraceSink } from '../trace/index.js';
import { emitSessionPhase } from '../trace/emit.js';
import { buildErrorHead } from '../providers/shared/tool-call-trace.js';
import { repeatFailureFingerprint } from './repeat-failure-guard.js';

/** Occurrences of one error signature (within the window) that fire the nudge. */
export const STRATEGY_NUDGE_THRESHOLD = 2;

/**
 * Recency window, in observed tool results (all tools, successes included).
 * Twenty results is a few rounds of work: long enough to span "try, tweak,
 * try again", short enough that a regression an hour later is not counted
 * as the same stuck loop.
 */
export const STRATEGY_NUDGE_WINDOW = 20;

/**
 * Tools whose failures are counted. Execution tools only: failures of
 * exploration tools (read_file, grep, glob) are normally navigation misses,
 * not a stuck approach, and would be the dominant false-positive source.
 */
export const STRATEGY_NUDGE_TOOLS: ReadonlySet<string> = new Set(['bash', 'test_run']);

/** Synthetic or "the system said no" results: never evidence of a stuck approach. */
const EXCLUDED_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  'abort',
  'timeout',
  'repeat-failure',
  'denial-breaker',
  'policy-refusal',
  'permission-denied',
  'hook-block',
  'elicitation-declined',
  'budget',
]);

const MAX_TRACKED_SIGNATURES = 256;
const MIN_SIGNATURE_CHARS = 12;
const MAX_QUOTED_CHARS = 200;
const MAX_LINES_SCANNED = 400;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Header and boilerplate lines that look like errors but identify nothing. */
const GENERIC_LINES: readonly RegExp[] = [
  /^command exited with code \d+/i,
  /^failed to execute:?\s*$/i,
  /command failed with exit code \d+/i,
  /exited with (?:status|code) \d+\.?$/i,
  /^(?:npm|pnpm|yarn)\s+err!?\s+(?:code|errno|syscall|path|lifecycle|a complete log)/i,
  /^elifecycle\b/i,
  /^at\s/,
  /^error:?\s*$/i,
  /^\s*\^+\s*$/,
  // test_run summary line (from test-run.ts:327): count summary with duration
  /\d+ passed \| \d+ failed/,
  // test_run command line: "Command: pnpm test ..."
  /^command:/i,
  // test_run failure-list header (bare, always identical)
  /^failed tests:\s*$/i,
];

/** Cue that a line names a concrete failure. Deliberately unanchored ("AssertionError"). */
const ERROR_CUE =
  /(error|errno|exception|cannot|can't|could not|couldn't|not found|no such|failed|denied|refused|undefined|unexpected|invalid|missing|unable|panic|fatal|traceback|assert)/i;

/** First line of `content` that names a concrete error, or null. */
export function findErrorLine(content: string): string | null {
  const lines = content.replace(ANSI, '').split('\n', MAX_LINES_SCANNED);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (GENERIC_LINES.some((re) => re.test(line))) continue;
    if (ERROR_CUE.test(line)) return line;
  }
  return null;
}

/**
 * Normalize an error line into a recurrence key: strip what varies between
 * attempts at the SAME failure (URLs, paths, hashes, long numbers, durations)
 * while keeping what distinguishes DIFFERENT failures (message text, small
 * numbers such as `expected 1 to be 2`).
 */
export function normalizeErrorLine(line: string): string {
  // Protect quoted non-absolute module specifiers before the path-collapse pass
  // so they remain distinct across different module-not-found errors.
  // Rule: a quoted token with no whitespace is preserved when it does NOT start
  // with '/', '~/', or a Windows drive prefix ('c:\', 'c:/').  That covers
  // scoped ('@x/y'), relative ('./x', '../x'), and bare subpath ('lodash/fp',
  // 'react-dom/client') specifiers.  Quoted absolute/home paths and all
  // unquoted paths still collapse — including ENOENT messages that quote the
  // path (e.g. `open '/tmp/afk-abc/x.ts'`), which the quoted-absolute regex
  // below handles explicitly.
  const protected_: string[] = [];
  const withPlaceholders = line
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(
      /(['"])(?!(?:[a-z]:[\\/]|~\/|\/))\S+?\1/g,
      (m) => `\x00p${(protected_.push(m) - 1).toString()}\x00`,
    );
  return withPlaceholders
    .replace(
      /(['"])(?:[a-z]:[\\/]|~\/|\/)[\w.@+\-/\\]*(?::\d+){0,2}\1/g,
      '<path>',
    )
    .replace(/(?:[a-z]:)?(?:\.{0,2}\/|~\/)?(?:[\w.@+-]+\/)+[\w.@+-]*(?::\d+){0,2}/g, '<path>')
    .replace(/\x00p(\d+)\x00/g, (_m, n: string) => protected_[parseInt(n, 10)] ?? _m)
    .replace(/\b[0-9a-f]{7,}\b/g, '<hex>')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g, '<dur>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Recurrence key for a failed result, or null when it must not be counted. */
export function errorSignature(result: ToolResult): { signature: string; line: string } | null {
  if (result.isError !== true) return null;
  if (result.failureClass !== undefined && EXCLUDED_FAILURE_CLASSES.has(result.failureClass)) {
    return null;
  }
  const line = findErrorLine(result.content);
  if (line === null) return null;
  const signature = normalizeErrorLine(line);
  if (signature.replace(/<\w+>/g, '').replace(/\W/g, '').length < MIN_SIGNATURE_CHARS) return null;
  return { signature, line };
}

/** A fired nudge plus the fields the trace event needs. */
export interface StrategyNudgeVerdict {
  readonly tool: string;
  readonly line: string;
  readonly occurrences: number;
  /** True when the recurrences came from different calls (the gap the guard misses). */
  readonly distinctCalls: boolean;
  readonly notice: string;
}

interface SignatureState {
  count: number;
  lastSeen: number;
  fingerprints: Set<string>;
  nudged: boolean;
}

/**
 * Per-dispatcher recurrence tracker.
 *
 * Invariant: one instance per dispatcher, never module scope; a singleton
 * would conflate concurrent sessions in one process (Telegram, daemon).
 */
export class StrategyNudger {
  private readonly signatures = new Map<string, SignatureState>();
  private clock = 0;

  /** Observe every settled result; returns a verdict only when the nudge fires. */
  observe(call: ToolCall, result: ToolResult): StrategyNudgeVerdict | null {
    this.clock += 1;
    if (!STRATEGY_NUDGE_TOOLS.has(call.name)) return null;
    const sig = errorSignature(result);
    if (sig === null) return null;

    let state = this.signatures.get(sig.signature);
    if (state !== undefined && this.clock - state.lastSeen > STRATEGY_NUDGE_WINDOW) {
      state.count = 0;
      state.fingerprints.clear();
    }
    if (state === undefined) {
      state = { count: 0, lastSeen: this.clock, fingerprints: new Set(), nudged: false };
      this.signatures.set(sig.signature, state);
      this.evictOverflow();
    }
    state.count += 1;
    state.lastSeen = this.clock;
    state.fingerprints.add(repeatFailureFingerprint(call));

    if (state.nudged || state.count < STRATEGY_NUDGE_THRESHOLD) return null;
    state.nudged = true;
    const distinctCalls = state.fingerprints.size > 1;
    return {
      tool: call.name,
      line: sig.line,
      occurrences: state.count,
      distinctCalls,
      notice: buildNotice(sig.line, state.count, distinctCalls),
    };
  }

  /** Exposed for tests: recorded occurrences of the signature of `result`. */
  occurrencesFor(result: ToolResult): number {
    const sig = errorSignature(result);
    return sig === null ? 0 : (this.signatures.get(sig.signature)?.count ?? 0);
  }

  private evictOverflow(): void {
    while (this.signatures.size > MAX_TRACKED_SIGNATURES) {
      const oldest = this.signatures.keys().next();
      if (oldest.done === true) return;
      this.signatures.delete(oldest.value);
    }
  }
}

function buildNotice(line: string, occurrences: number, distinctCalls: boolean): string {
  const quoted = line.length > MAX_QUOTED_CHARS ? `${line.slice(0, MAX_QUOTED_CHARS)}…` : line;
  const how = distinctCalls ? ', even though the attempts differed' : '';
  return (
    `\n\n[strategy-nudge] This error has come back ${occurrences} times in recent attempts${how}: ` +
    `${quoted}\n` +
    'Another variation of the same approach is unlikely to fix it. Before the next attempt, ' +
    'change mode: search the web (if a search tool is available) for the exact error message and the versions involved, ' +
    'reread the code, config, or docs you are relying on, or re-plan the approach. ' +
    'If you still believe the current approach is right, state what you expected and what ' +
    'you observed before continuing.'
  );
}

/**
 * Observe a settled result and return it with the nudge appended when one
 * fires. Shared by the single-call `execute()` path and both batch paths so
 * the logic lives exactly once (mirrors `applyToolHealth`).
 *
 * Contract: never changes `isError`; trace emission is fire-and-forget.
 */
export function applyStrategyNudge(
  nudger: StrategyNudger,
  traceWriter: TraceSink | undefined,
  call: ToolCall,
  result: ToolResult,
): ToolResult {
  const verdict = nudger.observe(call, result);
  if (verdict === null) return result;
  void emitSessionPhase(traceWriter, {
    phase: 'strategy_nudge_fired',
    metadata: {
      tool: verdict.tool,
      errorHead: buildErrorHead(true, verdict.line) ?? '',
      occurrences: verdict.occurrences,
      distinctCalls: verdict.distinctCalls,
    },
  });
  return { ...result, content: result.content + verdict.notice };
}
