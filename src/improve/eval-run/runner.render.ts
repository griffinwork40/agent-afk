/**
 * Markdown rendering and read-side helpers for `afk improve eval-run`.
 *
 * Extracted from `runner.ts` to keep each file under the 350 code-line
 * ceiling. Provides {@link renderEvalRunMarkdown}, {@link listEvalRuns},
 * {@link getEvalRun}, and supporting types.
 *
 * @module improve/eval-run/runner.render
 */

import { existsSync, readdirSync } from 'fs';
import { readJsonFileLoose } from '../../utils/json-file.js';
import { join } from 'path';
import { EvalRunSchema, type EvalCheck, type EvalRun, type EvalRunStatus } from '../schemas.js';
import { getEvalRunJsonPath, getEvalRunsDir } from '../paths.js';
import { isReplayNeutralizeCheck } from './replay.js';

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

const STATUS_GLYPH: Record<EvalRunStatus, string> = {
  pass: '✓ PASS',
  fail: '✗ FAIL',
  unsupported: '– UNSUPPORTED',
  error: '⚠ ERROR',
};

const CHECK_GLYPH: Record<EvalCheck['status'], string> = {
  pass: '✓',
  fail: '✗',
  skipped: '–',
};

export function renderEvalRunMarkdown(run: EvalRun): string {
  const passed = run.checks.filter((c) => c.status === 'pass').length;
  const failed = run.checks.filter((c) => c.status === 'fail').length;
  const skipped = run.checks.filter((c) => c.status === 'skipped').length;

  const out: string[] = [];
  out.push(`# ${run.evalRunId} — \`eval-run\` — \`${run.status}\``);
  out.push('');
  out.push(`Deterministic guardrail validation of eval-case \`${run.evalCaseId}\`.`);
  out.push('');
  out.push(
    `**Eval-case:** \`${run.evalCaseId}\` · **Card:** \`${run.cardSlug}\` · ` +
      `**Pattern:** \`${run.patternId}\` · **Contract:** ${run.contract ? `\`${run.contract}\`` : '_(none)_'} · ` +
      `**Created:** ${run.createdAt} · **Duration:** ${run.durationMs}ms`,
  );
  out.push('');

  // A neutralise check (repeat-loop or closure-guided) is present only when a
  // fixture-replay actually drove the recorded failure (not when it was skipped
  // for a non-reproducing fixture), so it is the honest signal that this run
  // proved a fix vs. only a guardrail.
  const didReplay = run.checks.some((c) => isReplayNeutralizeCheck(c.name));
  if (didReplay) {
    out.push('> **What this is.** A deterministic validation of pattern');
    out.push(`> \`${run.patternId}\`. It re-drove the failure recorded in the committed`);
    out.push('> fixture through the LIVE guardrail and asserts the recorded failure is');
    out.push('> neutralised at the recorded magnitude — proving the behaviour is fixed,');
    out.push('> not merely that a guardrail exists. It re-drives the recorded failure');
    out.push('> conditions; it does NOT re-execute the original tool/LLM.');
  } else {
    out.push('> **What this is.** A narrow, deterministic check that the guardrail');
    out.push(`> mapped to pattern \`${run.patternId}\` is present and behaving. It`);
    out.push("> validates the guardrail the pattern maps to; the eval-case's own");
    out.push('> `pattern-absent` assertion remains the full contract.');
  }
  out.push('');

  out.push(`## Result: ${STATUS_GLYPH[run.status]}  (${passed}/${run.checks.length} checks passed${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''})`);
  out.push('');

  out.push('## Checks');
  out.push('');
  if (run.checks.length === 0) {
    out.push('_(none)_');
  } else {
    out.push('| Check | Status | Expected | Actual |');
    out.push('|---|---|---|---|');
    for (const c of run.checks) {
      out.push(`| ${cell(c.name)} | ${CHECK_GLYPH[c.status]} ${c.status} | ${cell(c.expected)} | ${cell(c.actual)} |`);
    }
  }
  out.push('');

  out.push('## Evidence');
  out.push('');
  if (run.evidence.length === 0) {
    out.push('_(none)_');
  } else {
    for (const e of run.evidence) {
      out.push(`- **[${e.kind}]** \`${e.ref}\` — ${e.detail}`);
    }
  }
  out.push('');

  out.push('## Runner');
  out.push('');
  out.push(`- **Version:** \`${run.runner.version}\` · **Mode:** \`${run.runner.mode}\``);
  out.push('');

  out.push('## Notes');
  out.push('');
  if (run.notes.length === 0) {
    out.push('_(none)_');
  } else {
    for (const n of run.notes) out.push(`- _${n.at}_ — ${n.text}`);
  }
  out.push('');

  return out.join('\n');
}

/** Escape a value for a markdown table cell (pipes + newlines). */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ---------------------------------------------------------------------------
// Read-side helpers
// ---------------------------------------------------------------------------

export interface EvalRunListEntry {
  evalRunId: string;
  evalCaseId: string;
  cardSlug: string;
  patternId: EvalRun['patternId'];
  contract: string | null;
  status: EvalRunStatus;
  createdAt: string;
}

export function listEvalRuns(): EvalRunListEntry[] {
  const dir = getEvalRunsDir();
  if (!existsSync(dir)) return [];
  const entries: EvalRunListEntry[] = [];
  for (const fileName of readdirSync(dir)) {
    if (!fileName.endsWith('.json')) continue;
    if (fileName.startsWith('.')) continue;
    const run = readEvalRunIfExists(join(dir, fileName));
    if (!run) continue;
    entries.push({
      evalRunId: run.evalRunId,
      evalCaseId: run.evalCaseId,
      cardSlug: run.cardSlug,
      patternId: run.patternId,
      contract: run.contract,
      status: run.status,
      createdAt: run.createdAt,
    });
  }
  entries.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.evalRunId < b.evalRunId ? -1 : 1;
  });
  return entries;
}

export function getEvalRun(evalRunId: string): EvalRun | undefined {
  return readEvalRunIfExists(getEvalRunJsonPath(evalRunId));
}

function readEvalRunIfExists(path: string): EvalRun | undefined {
  // readJsonFileLoose: ENOENT and parse errors return undefined. Unexpected I/O
  // errors (EACCES, EISDIR) re-throw. Zod validation still runs below.
  const raw = readJsonFileLoose<unknown>(path);
  if (raw == null) return undefined;
  const validated = EvalRunSchema.safeParse(raw);
  return validated.success ? validated.data : undefined;
}
