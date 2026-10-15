/**
 * Unproven-diagnosis Stop hook (issue #2987).
 *
 * Prevents a turn from closing with an unproven "external / root cause
 * unknown" diagnosis when no instrumentation evidence was collected this turn.
 * Opt-in via `AFK_UNPROVEN_DIAGNOSIS_GATE=1`.
 *
 * ## Trigger condition
 *
 * Fires when ALL of the following hold:
 *   1. `AFK_UNPROVEN_DIAGNOSIS_GATE=1`.
 *   2. The turn is not a continuation (stopHookActive is falsy) — fires at
 *      most once per turn.
 *   3. The turn is not a subagent (parentSessionId is absent).
 *   4. The assistant text contains at least one cause-unknown phrase.
 *   5. The turn's successful tool calls contain none of the instrumentation
 *      tool names.
 *
 * ## Exception
 *
 * Does NOT fire when the text already contains instrumentation evidence
 * localising the fault inside the external component (e.g. a trace showing
 * the gap inside a third-party TLS handshake). Detection: any instrumentation
 * tool name in `successfulToolNames` suppresses the hook.
 *
 * ## Design choices
 *
 * - Pure regex + tool-name list: deterministic, no network call, no LLM call.
 *   Jev is a possible future upgrade (noted in the PR body).
 * - `injectContext` (not `block`): the agent gets one continuation round to
 *   run the ladder; if it can't, it explains why and closes cleanly.
 * - Never hard-fails: all errors are swallowed; the hook is always a no-op
 *   on error (fail-open).
 *
 * @module agent/unproven-diagnosis-detect
 */

import type { HookContext, HookDecision, HookHandler } from './hooks.js';
import { env } from '../config/env.js';
import { debugLog } from '../utils/debug.js';

// ─── Cause-unknown phrase patterns ──────────────────────────────────────────

/**
 * Phrases indicating an unproven external / root-cause-unknown diagnosis.
 * Each regex uses the `i` flag for case-insensitivity and does NOT use `g`
 * (we only need a boolean hit, not all matches).
 *
 * Invariant: keep these conservative — false silence is cheap; false alarms
 * train users to ignore the hook. Add patterns only when a new phrase class
 * is confirmed to be a problem (postmortems / session telemetry).
 */
const CAUSE_UNKNOWN_PATTERNS: readonly RegExp[] = [
  // "root cause" near "not found|unknown|couldn't determine|unclear"
  /root\s*cause[^.!?\n]{0,60}(?:not\s+found|unknown|could(?:n'?t|not)\s+(?:determine|identify|find)|unclear)/i,
  // "couldn't find the root cause" / "unable to determine the root cause"
  /(?:couldn'?t|could\s+not|unable\s+to)\s+(?:find|determine|identify)\s+(?:the\s+)?root\s+cause/i,
  // "the cause is something else in …"
  /\bthe\s+cause\s+is\s+something\s+else\s+in\b/i,
  // "something else in <external>" — without "the cause is"
  /\bsomething\s+else\s+in\s+[a-zA-Z0-9_'"-]{2,}/i,
  // "likely upstream" / "probably upstream"
  /\b(?:likely|probably|likely\s+an?|probably\s+an?)\s+upstream\b/i,
  // "I didn't find the root cause" / "I could not find the root cause"
  /\bI\s+(?:didn'?t|could\s+not|couldn'?t)\s+(?:find|identify|determine)\s+(?:the\s+)?(?:root\s+)?cause\b/i,
  // "the root cause is unknown" / "root cause remains unknown"
  /\broot\s+cause\s+(?:is|remains)\s+unknown\b/i,
  // "externally caused" / "external cause"
  /\bexternal(?:ly\s+caused|[- ]cause)\b/i,
];

/**
 * True when the assistant text contains at least one cause-unknown phrase.
 * Pure function — no I/O.
 */
export function hasCauseUnknownPhrase(text: string): boolean {
  return CAUSE_UNKNOWN_PATTERNS.some((re) => re.test(text));
}

// ─── Instrumentation tool names ──────────────────────────────────────────────

/**
 * Tool names whose presence indicates the agent collected instrumentation
 * evidence this turn. A successful call to any of these suppresses the hook
 * because the agent is already running the elimination ladder or was already
 * unable to localise the fault with tools.
 *
 * Invariant: extend rather than replace. A missing entry means the hook
 * fires when it shouldn't; an extra entry means it stays silent on a genuine
 * unproven diagnosis.
 */
export const INSTRUMENTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  // File-read tools used for hash/manifest checks
  'read_file',
  'glob',
  'grep',
  // Bash — covers counter/log insertion, bypass reruns, env probes
  'bash',
  // List-directory used for filesystem inventory
  'list_directory',
  // web_scrape / web_request used to fetch upstream manifests
  'web_scrape',
  'web_request',
]);

/**
 * True when `successfulToolNames` contains at least one instrumentation tool.
 * Pure function — no I/O.
 */
export function hasInstrumentationEvidence(successfulToolNames: readonly string[]): boolean {
  return successfulToolNames.some((name) => INSTRUMENTATION_TOOL_NAMES.has(name));
}

// ─── Correction message ───────────────────────────────────────────────────────

const CORRECTION =
  '[unproven-diagnosis-gate] This turn declared an external or unknown root ' +
  'cause without instrumentation evidence to support that conclusion. Before ' +
  'closing, run the elimination ladder:\n\n' +
  '  1. **Hash-check installs** — verify installed packages byte-for-byte ' +
  'against published manifests (e.g. `pip hash`, `npm ls --json`, package ' +
  'lock comparison).\n' +
  '  2. **Bypass the wrapper** — rerun the failing path through the ' +
  'unpatched/unmodified entry point to confirm the symptom reproduces.\n' +
  '  3. **Clean-environment repeat** — reproduce in a fresh environment ' +
  '(new venv, new session, or Docker container) to rule out local state.\n' +
  '  4. **Check upstream config flags** — review the external component\'s ' +
  'documented config options and defaults for the observed behaviour.\n' +
  '  5. **Instrument the path** — insert a call counter or log at the ' +
  'suspected entry point to confirm whether it is reached and how often.\n\n' +
  'Cite the step that confirms or contradicts the external hypothesis before ' +
  'closing. If the above steps are infeasible (no access, already done, or ' +
  'cost exceeds value), state that explicitly rather than leaving the diagnosis ' +
  'unproven.';

// ─── Stop hook ────────────────────────────────────────────────────────────────

/**
 * Build a `Stop` hook handler that detects unproven external / cause-unknown
 * diagnoses and injects the elimination-ladder correction into the next turn.
 *
 * Opt-in: reads `AFK_UNPROVEN_DIAGNOSIS_GATE` on every invocation (lazy env
 * read, consistent with env.ts design; tests can mutate `process.env` freely).
 *
 * Fires at most once per turn: the hook returns `{}` when `stopHookActive`
 * is truthy (the continuation round is already running). Never blocks; never
 * throws. Fails open on any error.
 *
 * @param deps - Optional overrides for unit tests (env getter, text getter).
 */
export function createUnprovenDiagnosisDetectHook(deps?: {
  isEnabled?: () => boolean;
}): HookHandler {
  const isEnabled = deps?.isEnabled ?? (() => env.AFK_UNPROVEN_DIAGNOSIS_GATE === '1');

  return (context: HookContext): HookDecision => {
    try {
      if (context.event !== 'Stop') return {};
      if (!isEnabled()) return {};
      // Skip subagent turns — only top-level sessions get the gate.
      if (context.parentSessionId) return {};
      // Fire at most once per turn — continuation rounds are already running
      // the ladder; let them proceed.
      if (context.stopHookActive) return {};

      const text = context.assistantText ?? '';
      if (!hasCauseUnknownPhrase(text)) return {};

      const toolNames = context.successfulToolNames ?? [];
      if (hasInstrumentationEvidence(toolNames)) return {};

      debugLog('[unproven-diagnosis-gate] cause-unknown phrase found, no instrumentation evidence', {
        sessionId: context.sessionId,
        continuation: context.continuation,
      });

      return { injectContext: CORRECTION };
    } catch {
      // Fail open: a bug in the hook must never disrupt a turn.
      return {};
    }
  };
}
