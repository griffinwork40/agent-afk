/**
 * Eval-run runner.
 *
 * Loads an {@link EvalCase}, executes the smallest deterministic validation
 * contract registered for its `assertion.patternId` (see
 * {@link ./contracts}), re-verifies the eval-case's committed fixture
 * checksum, aggregates a top-line {@link EvalRunStatus}, and persists the
 * result triple:
 *
 *   <evalRunId>.json   EvalRun result (the artifact)
 *   <evalRunId>.md     human-friendly rendered view
 *   .index.jsonl       append-only event log (best-effort)
 *
 * ## What this runner does NOT do
 *
 * No LLM. No patch/apply. No git. No fixture *replay* through the detector —
 * the eval-case's own `pattern-absent` assertion remains the full contract;
 * this runner validates the guardrail the pattern maps to instead. The
 * boundary is documented on {@link EvalRunSchema}.
 *
 * ## Eval-run ID format
 *
 *   `<cardSlug>-run-<yyyymmdd>-<6hex>`
 *
 * The `-run-` infix keeps the four improve artifact kinds mechanically
 * distinguishable by name alone:
 *   cards      `repeated-tool-grep-ac8317edd609`
 *   proposals  `repeated-tool-grep-ac8317edd609-20260524-ab12cd`
 *   eval-cases `repeated-tool-grep-ac8317edd609-eval-20260524-9c4d2f`
 *   eval-runs  `repeated-tool-grep-ac8317edd609-run-20260611-7e1a09`
 *
 * @module improve/eval-run/runner
 */

import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  EvalRunIndexEventSchema,
  EvalRunSchema,
  type EvalCase,
  type EvalCheck,
  type EvalRun,
  type EvalRunEvidenceRef,
  type EvalRunIndexEvent,
  type EvalRunStatus,
  type TriageNote,
} from '../schemas.js';
import {
  getEvalRunJsonPath,
  getEvalRunMarkdownPath,
  getEvalRunsDir,
  getEvalRunsIndexPath,
} from '../paths.js';
import { getAfkHome } from '../../paths.js';
import { sha256Bytes } from '../eval-gen/replay-fixture.js';
import type { IdContext } from '../eval-gen/writer.js';
import { makeCheck, resolveContract, snapshot, supportedContractPatterns } from './contracts.js';

/** Runner identity stamped into every result. */
export const EVAL_RUN_RUNNER_VERSION = 'eval-run@v1';

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Build an eval-run id from a card slug: `<cardSlug>-run-<yyyymmdd>-<6hex>`.
 * Matches `^[a-z0-9][a-z0-9-]*$` so long as `cardSlug` already does.
 */
export function generateEvalRunId(cardSlug: string, ctx: IdContext = {}): string {
  const now = (ctx.now ?? (() => new Date()))();
  const yyyymmdd = formatYyyymmdd(now);
  const suffix =
    ctx.randomSuffix !== undefined ? ctx.randomSuffix() : randomBytes(3).toString('hex');
  if (!/^[0-9a-f]{6}$/.test(suffix)) {
    throw new Error(`generateEvalRunId: randomSuffix must be 6 lowercase hex chars (got '${suffix}')`);
  }
  return `${cardSlug}-run-${yyyymmdd}-${suffix}`;
}

function formatYyyymmdd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface RunEvalCaseContext {
  /** Pre-generated id. Tests inject; the CLI uses {@link generateEvalRunId}. */
  evalRunId: string;
  /** Override timestamp source. Defaults to `new Date()`. */
  now?: () => Date;
  /** Monotonic clock for `durationMs`. Defaults to `Date.now`. */
  clockMs?: () => number;
  /**
   * Resolve the absolute path of the eval-case's committed fixture from its
   * AFK-relative `replay.fixturePath`. Defaults to `join(getAfkHome(), p)`.
   * Tests inject for isolation.
   */
  resolveFixtureAbsPath?: (relativeFixturePath: string) => string;
}

/**
 * Execute the validation contract for an eval-case and return an
 * {@link EvalRun}. Pure modulo the fixture read; performs NO disk writes —
 * the caller persists via {@link writeEvalRun}.
 *
 * Status precedence (highest wins): `error` > `fail` > `unsupported` > `pass`.
 * A failed check (including a fixture-integrity mismatch) forces `fail` even
 * when the pattern has no contract — a corrupt fixture is a real failure.
 */
export async function runEvalCase(evalCase: EvalCase, ctx: RunEvalCaseContext): Promise<EvalRun> {
  const now = (ctx.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const clock = ctx.clockMs ?? (() => Date.now());
  const t0 = clock();

  const checks: EvalCheck[] = [];
  const evidence: EvalRunEvidenceRef[] = [];
  const notes: TriageNote[] = [];

  // 1. Fixture integrity — ground the run in the eval-case's durable artifact.
  const fixture = checkFixtureIntegrity(evalCase, ctx);
  checks.push(fixture.check);
  if (fixture.evidence) evidence.push(fixture.evidence);

  // 2. Run the pattern's validation contract (if one is registered).
  const contract = resolveContract(evalCase.assertion.patternId);
  let contractId: string | null = null;
  let contractThrew = false;

  if (!contract) {
    notes.push({
      at: nowIso,
      text:
        `No deterministic validation contract is registered for pattern ` +
        `'${evalCase.assertion.patternId}'. Supported: ${supportedContractPatterns().join(', ')}.`,
    });
  } else {
    contractId = contract.id;
    try {
      const probe = await contract.run();
      checks.push(...probe.checks);
      evidence.push(...probe.evidence);
    } catch (err) {
      contractThrew = true;
      const message = err instanceof Error ? err.message : String(err);
      notes.push({
        at: nowIso,
        text: `Contract '${contract.id}' threw during execution: ${snapshot(message)}`,
      });
    }
  }

  const status = decideStatus({ hasContract: contract !== undefined, contractThrew, checks });
  const durationMs = Math.max(0, Math.round(clock() - t0));

  const evalRun: EvalRun = {
    schemaVersion: 1,
    evalRunId: ctx.evalRunId,
    evalCaseId: evalCase.evalCaseId,
    cardSlug: evalCase.cardSlug,
    patternId: evalCase.assertion.patternId,
    contract: contractId,
    status,
    createdAt: nowIso,
    durationMs,
    checks,
    evidence,
    runner: { version: EVAL_RUN_RUNNER_VERSION, mode: 'deterministic' },
    notes,
  };

  // Validate up-front so the caller never persists a malformed object.
  EvalRunSchema.parse(evalRun);
  return evalRun;
}

function decideStatus(args: {
  hasContract: boolean;
  contractThrew: boolean;
  checks: EvalCheck[];
}): EvalRunStatus {
  if (args.contractThrew) return 'error';
  if (args.checks.some((c) => c.status === 'fail')) return 'fail';
  if (!args.hasContract) return 'unsupported';
  return 'pass';
}

interface FixtureCheckResult {
  check: EvalCheck;
  evidence?: EvalRunEvidenceRef;
}

/**
 * Re-verify the eval-case's committed fixture: hash the bytes on disk and
 * compare to `replay.sliceSha256`. A missing or mismatched fixture is a
 * `fail` — the eval-case's durable contract is broken. The fixture writer
 * (`eval-gen`) performs the inverse check at write time; this is the
 * read-time half the schema documents.
 */
function checkFixtureIntegrity(evalCase: EvalCase, ctx: RunEvalCaseContext): FixtureCheckResult {
  const resolve = ctx.resolveFixtureAbsPath ?? ((p: string) => join(getAfkHome(), p));
  const abs = resolve(evalCase.replay.fixturePath);
  const expectedSha = evalCase.replay.sliceSha256;
  const name = 'fixture-integrity';
  const description = "Committed replay fixture exists and matches the eval-case's recorded sha256";

  if (!existsSync(abs)) {
    return {
      check: makeCheck({
        name,
        description,
        pass: false,
        expected: `fixture present at ${evalCase.replay.fixturePath}`,
        actual: 'fixture file not found on disk',
      }),
    };
  }

  let actualSha: string;
  try {
    actualSha = sha256Bytes(readFileSync(abs));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      check: makeCheck({
        name,
        description,
        pass: false,
        expected: `readable fixture (${expectedSha})`,
        actual: `read error: ${snapshot(message)}`,
      }),
    };
  }

  const ok = actualSha === expectedSha;
  return {
    check: makeCheck({
      name,
      description,
      pass: ok,
      expected: expectedSha,
      actual: actualSha,
    }),
    evidence: {
      kind: 'fixture',
      ref: evalCase.replay.fixturePath,
      detail: `sha256 ${ok ? 'match' : 'MISMATCH'} (${evalCase.replay.sliceLineCount} lines)`,
    },
  };
}

// ---------------------------------------------------------------------------
// Persist
// ---------------------------------------------------------------------------

export interface WriteEvalRunOutcome {
  evalRunId: string;
  jsonPath: string;
  markdownPath: string;
}

/** Persist an eval-run: JSON + markdown (atomic) + `.index.jsonl` append. */
export function writeEvalRun(evalRun: EvalRun): WriteEvalRunOutcome {
  const validated = EvalRunSchema.parse(evalRun);

  const dir = getEvalRunsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const jsonPath = getEvalRunJsonPath(validated.evalRunId);
  const mdPath = getEvalRunMarkdownPath(validated.evalRunId);

  atomicWriteJson(jsonPath, validated);
  atomicWriteText(mdPath, renderEvalRunMarkdown(validated));

  appendIndex({
    timestamp: new Date().toISOString(),
    event: 'created',
    evalRunId: validated.evalRunId,
    evalCaseId: validated.evalCaseId,
    cardSlug: validated.cardSlug,
    patternId: validated.patternId,
    contract: validated.contract,
    status: validated.status,
  });

  return { evalRunId: validated.evalRunId, jsonPath, markdownPath: mdPath };
}

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

  out.push('> **What this is.** A narrow, deterministic check that the guardrail');
  out.push(`> mapped to pattern \`${run.patternId}\` is present and behaving. It does`);
  out.push('> NOT replay the fixture through the detector — that broader capability');
  out.push("> is reserved for a later sprint. The eval-case's own `pattern-absent`");
  out.push('> assertion remains the full contract.');
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
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    const validated = EvalRunSchema.safeParse(parsed);
    return validated.success ? validated.data : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Index append + atomic writes (matching eval-gen writer conventions)
// ---------------------------------------------------------------------------

function appendIndex(event: EvalRunIndexEvent): void {
  const validated = EvalRunIndexEventSchema.parse(event);
  const dir = getEvalRunsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(getEvalRunsIndexPath(), JSON.stringify(validated) + '\n', { flag: 'a' });
  } catch {
    // Best-effort, matching the card / proposal / eval-case writers.
  }
}

function atomicWriteJson(path: string, data: unknown): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

function atomicWriteText(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
