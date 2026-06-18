/**
 * Verifier helpers for the /diagnose skill.
 *
 * Contains:
 * - parseShadowVerifyOutput — tolerant parser for shadow-verify's free-prose output
 * - runReproducerBaseline  — one-shot baseline execution at the repo root
 * - buildVerifierUserPrompt — constructs the verifier subagent's user prompt
 * - autoVerifyHypotheses   — confidence-gate dispatcher that pre-filters hypotheses
 *
 * @module skills/diagnose/_phases/verifier
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '../../../config/env.js';
import { shouldAutoVerify } from '../../_lib/confidence-gate.js';
import type {
  Verification,
  Hypothesis,
  PremiseVerification,
  VerifyBatchFn,
  BaselineResult,
} from './types.js';
import { ShadowVerifyEnvelopeSchema } from './types.js';

const execFile = promisify(execFileCallback);

// ---------------------------------------------------------------------------
// shadow-verify output parsing
// ---------------------------------------------------------------------------

/**
 * Normalize a free-text verdict token into diagnose's premise-gate enum.
 * shadow-verify verifiers speak in confirm/disagree terms; the gate needs
 * VERIFIED | REFUTED | INCONCLUSIVE. Unrecognized tokens degrade to
 * INCONCLUSIVE (safe — the hypothesis stays in play for worktree testing).
 */
function normalizeVerdict(token: string): Verification['verdict'] {
  const t = token.trim().toUpperCase();
  if (['VERIFIED', 'CONFIRMED', 'CONFIRM', 'SUPPORTED', 'TRUE', 'PASS', 'PASSED'].includes(t)) {
    return 'VERIFIED';
  }
  if (
    [
      'REFUTED',
      'REFUTE',
      'DISAGREE',
      'DISAGREED',
      'CONTRADICTED',
      'FALSE',
      'FAIL',
      'FAILED',
    ].includes(t)
  ) {
    return 'REFUTED';
  }
  return 'INCONCLUSIVE';
}

/**
 * Return every top-level brace-balanced `{...}` span in `text`, in order.
 * String- and escape-aware so braces inside JSON string values don't unbalance
 * the scan. Used to recover a JSON object embedded in free-form prose (a fenced
 * code block, inline, or surrounded by narrative).
 */
function findBalancedObjects(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          spans.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return spans;
}

/**
 * Parse the raw text returned by dispatching the `shadow-verify` skill into a
 * typed {@link Verification}[]. shadow-verify is a markdown SKILL.md plugin
 * skill, so `dispatchSkill` returns the verifier sub-agent's FREE-FORM final
 * message — not a bare JSON string. This parser tolerantly recovers the JSON
 * envelope from surrounding prose (fenced block / inline / narrative),
 * validates it, normalizes the verdict vocabulary, and backfills optional
 * fields. It THROWS a descriptive Error when no `{ verifications: [...] }`
 * envelope can be recovered, so the caller ({@link autoVerifyHypotheses}) marks
 * the gated hypotheses INCONCLUSIVE with a clear reason instead of crashing or
 * mislabeling the failure as a dispatch/network error.
 *
 * @throws Error when no parseable verification envelope is present.
 */
export function parseShadowVerifyOutput(raw: string): Verification[] {
  const candidates = findBalancedObjects(raw);
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = ShadowVerifyEnvelopeSchema.safeParse(parsed);
    if (result.success) {
      return result.data.verifications.map((v) => ({
        claim: v.claim ?? '',
        verdict: normalizeVerdict(v.verdict),
        evidence: v.evidence ?? '',
      }));
    }
  }
  throw new Error(
    `shadow-verify did not return a parseable {"verifications":[...]} envelope ` +
      `(${candidates.length} JSON-like span(s) found, none matched the schema); ` +
      `raw output (first 300 chars): ${raw.slice(0, 300)}`,
  );
}

// ---------------------------------------------------------------------------
// Baseline reproducer execution
// ---------------------------------------------------------------------------

/**
 * Truncate a string to its LAST `maxLen` characters, prefixing with a marker
 * when truncation occurred.  Test failures surface at the end of output.
 */
function tailTruncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `...[truncated]\n${s.slice(s.length - maxLen)}`;
}

/**
 * Run the detected reproducer command ONCE on the current/unfixed code and
 * return the measured result as ground truth for the verifier.
 *
 * @param command  The raw shell command string extracted by detectReproducer.
 * @param cwd      MUST be parsedInput.repoPath (the real repo root, which has
 *                 node_modules). Worktrees lack gitignored deps.
 * @param exec     Injectable execFile shim — defaults to the module-level
 *                 promisified execFile so tests can fake it without spawning
 *                 real processes.
 *
 * // Invariant: The parent (orchestrator TS code) executes the SINGLE detected
 * // reproducer command — NOT a model-chosen command — directly at the repo
 * // root. This is bounded and faithful to what the developer would run by
 * // hand, but a true execution sandbox (container / network-egress isolation)
 * // is tracked as a separate follow-up. The kill switch
 * // AFK_DIAGNOSE_BASELINE=0 disables execution entirely for environments
 * // where running untrusted commands at session time is unacceptable.
 */
export async function runReproducerBaseline(
  command: string,
  cwd: string,
  exec: typeof execFile = execFile,
): Promise<BaselineResult> {
  const TRUNCATE_LEN = 4000;

  // Kill switch: opt out of baseline execution.
  if (env.AFK_DIAGNOSE_BASELINE === '0') {
    return {
      skipped: true,
      reason: 'disabled via AFK_DIAGNOSE_BASELINE=0',
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
    };
  }

  // Guard: don't run if there's no command.
  if (!command || !command.trim()) {
    return {
      skipped: true,
      reason: 'no reproducer command detected',
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
    };
  }

  try {
    // Run via shell so the full reproducer string (pipes, env vars, etc.) works.
    const result = await exec('/bin/sh', ['-c', command], {
      cwd,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    // Zero-exit path — reproducer passed on current code.
    return {
      skipped: false,
      exitCode: 0,
      stdout: tailTruncate(result.stdout, TRUNCATE_LEN),
      stderr: tailTruncate(result.stderr, TRUNCATE_LEN),
      timedOut: false,
    };
  } catch (err: unknown) {
    // promisified execFile rejects on non-zero exit — that IS the expected
    // baseline case (failing test/reproducer on unfixed code). Read the
    // structured error properties rather than treating this as a real error.
    const e = err as {
      code?: number | string | null;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };
    const timedOut = e.killed === true || e.signal === 'SIGTERM';
    const exitCode = typeof e.code === 'number' ? e.code : null;
    return {
      skipped: false,
      exitCode,
      stdout: tailTruncate(e.stdout ?? '', TRUNCATE_LEN),
      stderr: tailTruncate(e.stderr ?? '', TRUNCATE_LEN),
      timedOut,
    };
  }
}

// ---------------------------------------------------------------------------
// Verifier prompt construction
// ---------------------------------------------------------------------------

/**
 * Render the BASELINE block appended to the verifier prompt.
 */
function buildBaselineBlock(baseline: BaselineResult, reproducer: string): string {
  const lines: string[] = [
    'BASELINE (measured by the orchestrator on the CURRENT/unfixed code at the repo root — ground truth you MUST NOT contradict):',
  ];
  if (baseline.skipped) {
    lines.push(`(not run: ${baseline.reason ?? 'unknown reason'})`);
  } else {
    lines.push(`$ ${reproducer}`);
    lines.push(
      `exit code: ${baseline.exitCode ?? 'unknown'}${baseline.timedOut ? ' (TIMED OUT)' : ''}`,
    );
    lines.push('stdout (tail):');
    lines.push(baseline.stdout || '(empty)');
    lines.push('stderr (tail):');
    lines.push(baseline.stderr || '(empty)');
    if (baseline.exitCode === 0) {
      lines.push(
        'NOTE: The reproducer PASSED on the current (unfixed) code (exit 0). ' +
          'The failure may not reproduce or the reproducer may be wrong — set ' +
          '`stance: "blocks"` and lower confidence.',
      );
    }
  }
  return lines.join('\n');
}

/**
 * Build the user prompt sent to the read-only verifier subagent.
 * Exported for unit testing.
 */
export function buildVerifierUserPrompt(
  hypothesis: { id: string; claim: string; location?: string; proposed_fix?: string },
  reproducer: string,
  worktreePath: string,
  baseline: BaselineResult,
): string {
  const baselineBlock = buildBaselineBlock(baseline, reproducer);
  return (
    `Test this hypothesis:\n\n` +
    `Claim: ${hypothesis.claim}\n` +
    `Location: ${hypothesis.location ?? 'unknown'}\n` +
    `Proposed fix: ${hypothesis.proposed_fix ?? 'unknown'}\n` +
    `Reproducer: ${reproducer}\n\n` +
    `Working directory (isolated): ${worktreePath}\n\n` +
    baselineBlock
  );
}

// ---------------------------------------------------------------------------
// Confidence-gated auto-verify
// ---------------------------------------------------------------------------

/**
 * Run the confidence gate over each hypothesis and, for those that trip it,
 * dispatch /shadow-verify (via the supplied {@link VerifyBatchFn}) to
 * independently re-check the claim. Returns per-hypothesis premise
 * verifications and the filtered list of hypotheses to carry into worktree
 * testing — REFUTED hypotheses are dropped; VERIFIED and INCONCLUSIVE are kept.
 *
 * Auto-verify is advisory: if the dispatcher throws, gated hypotheses are
 * marked INCONCLUSIVE with the error recorded in `evidence`, and no
 * hypothesis is dropped. Never throws.
 */
export async function autoVerifyHypotheses(
  hypotheses: Hypothesis[],
  verify: VerifyBatchFn,
): Promise<{
  premise_verifications: PremiseVerification[];
  hypotheses_to_test: Hypothesis[];
}> {
  const gated = hypotheses
    .map((hypothesis) => ({ hypothesis, decision: shouldAutoVerify(hypothesis) }))
    .filter((entry) => entry.decision.verify);

  if (gated.length === 0) {
    return { premise_verifications: [], hypotheses_to_test: hypotheses };
  }

  let verifications: Verification[] = [];
  let dispatchError: string | undefined;
  try {
    const result = await verify(gated.map((g) => g.hypothesis.claim));
    // Contract: VerifyBatchFn is typed to return Verification[], but the real
    // dispatcher parses an external sub-agent's output — a buggy or surprising
    // implementation could resolve to undefined / a non-array. Coerce so the
    // positional `verifications[i]` access below can never throw; missing
    // entries fall through to the INCONCLUSIVE "no verifier result" branch.
    // This is what makes the documented "Never throws" guarantee hold.
    verifications = Array.isArray(result) ? result : [];
  } catch (err) {
    dispatchError = err instanceof Error ? err.message : String(err);
  }

  const premise_verifications: PremiseVerification[] = gated.map((entry, i) => {
    const v = verifications[i];
    if (dispatchError !== undefined) {
      return {
        hypothesis_id: entry.hypothesis.id,
        claim: entry.hypothesis.claim,
        verdict: 'INCONCLUSIVE' as const,
        evidence: `shadow-verify dispatch failed: ${dispatchError}`,
        gate_reason: entry.decision.reason,
      };
    }
    if (!v) {
      return {
        hypothesis_id: entry.hypothesis.id,
        claim: entry.hypothesis.claim,
        verdict: 'INCONCLUSIVE' as const,
        evidence: 'no verifier result for this claim',
        gate_reason: entry.decision.reason,
      };
    }
    return {
      hypothesis_id: entry.hypothesis.id,
      claim: entry.hypothesis.claim,
      verdict: v.verdict,
      evidence: v.evidence,
      gate_reason: entry.decision.reason,
    };
  });

  const refutedIds = new Set(
    premise_verifications
      .filter((pv) => pv.verdict === 'REFUTED')
      .map((pv) => pv.hypothesis_id),
  );
  const hypotheses_to_test =
    refutedIds.size === 0
      ? hypotheses
      : hypotheses.filter((h) => !refutedIds.has(h.id));

  return { premise_verifications, hypotheses_to_test };
}
