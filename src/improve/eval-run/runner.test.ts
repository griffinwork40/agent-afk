/**
 * Tests for `improve/eval-run/runner.ts`.
 *
 * Coverage:
 *   - generateEvalRunId: `-run-` infix format + injection seams + bad suffix.
 *   - runEvalCase: fixture-integrity grounding (pass / mismatch / missing);
 *     status aggregation + precedence (pass / fail / unsupported); injected
 *     clock → deterministic durationMs; honours the resolveFixtureAbsPath seam.
 *   - writeEvalRun: JSON + md atomic write + .index.jsonl append; round-trips
 *     through getEvalRun / listEvalRuns.
 *   - renderEvalRunMarkdown: sections, disclaimer, pipe-escaping in cells.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import {
  decideStatus,
  EVAL_RUN_RUNNER_VERSION,
  generateEvalRunId,
  getEvalRun,
  listEvalRuns,
  renderEvalRunMarkdown,
  runEvalCase,
  writeEvalRun,
} from './runner.js';
import { makeCheck } from './contracts.js';
import { sha256Bytes } from '../eval-gen/replay-fixture.js';
import { EvalCaseSchema, type EvalCase, type FailurePattern } from '../schemas.js';
import {
  getEvalRunJsonPath,
  getEvalRunMarkdownPath,
  getEvalRunsDir,
  getEvalRunsIndexPath,
} from '../paths.js';

// ---------------------------------------------------------------------------
// Filesystem fixture
// ---------------------------------------------------------------------------

let originalAfkHome: string | undefined;
let tempHome: string;

beforeEach(() => {
  originalAfkHome = process.env['AFK_HOME'];
  tempHome = mkdtemp();
  process.env['AFK_HOME'] = tempHome;
});

afterEach(() => {
  if (originalAfkHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = originalAfkHome;
  rmSync(tempHome, { recursive: true, force: true });
});

function mkdtemp(): string {
  const { mkdtempSync } = require('fs');
  return mkdtempSync(join(tmpdir(), 'afk-evalrun-test-'));
}

const FIXED_NOW = () => new Date('2026-06-11T12:00:00.000Z');
const DEFAULT_FIXTURE_BYTES = Buffer.from('{"seq":0,"kind":"tool_call"}\n');

/**
 * Build a schema-valid EvalCase and (by default) write its fixture under the
 * temp AFK_HOME so the default resolver finds it. `sliceSha256` is computed
 * from the bytes written so fixture-integrity passes unless tampered.
 */
function makeEvalCase(opts: {
  evalCaseId?: string;
  cardSlug?: string;
  pattern?: FailurePattern;
  fixtureBytes?: Buffer;
  writeFixture?: boolean;
} = {}): EvalCase {
  const cardSlug = opts.cardSlug ?? 'repeated-tool-grep-abc123';
  const evalCaseId = opts.evalCaseId ?? `${cardSlug}-eval-20260611-ab12cd`;
  const pattern = opts.pattern ?? 'repeated-tool-use';
  const fixtureBytes = opts.fixtureBytes ?? DEFAULT_FIXTURE_BYTES;
  const fixturePath = `agent-framework/improve/eval-cases/${evalCaseId}.fixture.jsonl`;

  if (opts.writeFixture !== false) {
    const abs = join(tempHome, fixturePath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, fixtureBytes);
  }

  const evalCase: EvalCase = {
    schemaVersion: 1,
    evalCaseId,
    cardSlug,
    proposalId: null,
    title: `Replay [pattern-absent]: ${pattern} (through seq 0)`,
    createdAt: '2026-06-11T11:00:00.000Z',
    kind: 'replay',
    replay: {
      sourceSessionId: 'sess-a',
      sourceTracePath: 'state/witness/sess-a/trace.jsonl',
      fixturePath,
      evidenceRowIndex: 0,
      evidenceEventIndices: [0],
      sliceLineRange: { startLine: 1, endLine: 1 },
      sliceLineCount: 1,
      sliceSha256: sha256Bytes(fixtureBytes),
    },
    assertion: {
      kind: 'pattern-absent',
      patternId: pattern,
      detectorVersion: `${pattern}@v1`,
      rationale: 'test rationale',
    },
    provenance: {
      detectorAtGeneration: `${pattern}@v1`,
      fingerprintAtGeneration: null,
      cardOccurrenceCountAtGeneration: 1,
      cardLastSeenAtGeneration: '2026-06-11T11:00:00.000Z',
      generatedBy: 'replay-fixture',
    },
    status: 'draft',
    notes: [],
  };
  return EvalCaseSchema.parse(evalCase);
}

// ---------------------------------------------------------------------------
// generateEvalRunId
// ---------------------------------------------------------------------------

describe('generateEvalRunId', () => {
  it('uses the -run- infix and a yyyymmdd-6hex suffix', () => {
    const id = generateEvalRunId('repeated-tool-grep-abc123', {
      now: FIXED_NOW,
      randomSuffix: () => '7e1a09',
    });
    expect(id).toBe('repeated-tool-grep-abc123-run-20260611-7e1a09');
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('throws on a non-hex suffix', () => {
    expect(() => generateEvalRunId('slug', { randomSuffix: () => 'ZZZ' })).toThrow(/6 lowercase hex/);
  });
});

// ---------------------------------------------------------------------------
// decideStatus — status precedence (error > fail > unsupported > pass)
// ---------------------------------------------------------------------------

describe('decideStatus precedence', () => {
  const passCheck = makeCheck({ name: 'p', description: 'd', pass: true, expected: '', actual: '' });
  const failCheck = makeCheck({ name: 'f', description: 'd', pass: false, expected: '', actual: '' });

  it('error beats fail (a contract threw)', () => {
    expect(decideStatus({ hasContract: true, contractThrew: true, checks: [failCheck] })).toBe('error');
  });

  it('fail beats unsupported and pass (a failed check)', () => {
    expect(decideStatus({ hasContract: false, contractThrew: false, checks: [failCheck] })).toBe('fail');
  });

  it('unsupported when no contract is registered and every check passes', () => {
    expect(decideStatus({ hasContract: false, contractThrew: false, checks: [passCheck] })).toBe('unsupported');
  });

  it('pass when a contract ran and every check passed', () => {
    expect(decideStatus({ hasContract: true, contractThrew: false, checks: [passCheck] })).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// runEvalCase
// ---------------------------------------------------------------------------

describe('runEvalCase', () => {
  const baseCtx = {
    evalRunId: 'repeated-tool-grep-abc123-run-20260611-7e1a09',
    now: FIXED_NOW,
    clockMs: stubClock([1000, 1042]),
  };

  it('passes for a supported pattern with an intact fixture', async () => {
    const run = await runEvalCase(makeEvalCase({ pattern: 'repeated-tool-use' }), { ...baseCtx, clockMs: stubClock([1000, 1042]) });

    expect(run.status).toBe('pass');
    expect(run.contract).toBe('repeat-loop-circuit-breaker');
    expect(run.patternId).toBe('repeated-tool-use');
    expect(run.durationMs).toBe(42);
    expect(run.createdAt).toBe('2026-06-11T12:00:00.000Z');
    expect(run.runner).toEqual({ version: EVAL_RUN_RUNNER_VERSION, mode: 'deterministic' });

    // fixture-integrity is always the first check.
    expect(run.checks[0]?.name).toBe('fixture-integrity');
    expect(run.checks[0]?.status).toBe('pass');
    // ...followed by the 4 circuit-breaker checks, all passing.
    expect(run.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(run.checks).toHaveLength(5);
  });

  it('fails when the committed fixture no longer matches its sha256', async () => {
    const evalCase = makeEvalCase({ pattern: 'repeated-tool-use' });
    // Tamper: overwrite the fixture on disk with different bytes.
    const abs = join(tempHome, evalCase.replay.fixturePath);
    writeFileSync(abs, Buffer.from('{"seq":0,"tampered":true}\n'));

    const run = await runEvalCase(evalCase, { ...baseCtx, clockMs: stubClock([1, 2]) });

    expect(run.status).toBe('fail');
    const fixtureCheck = run.checks.find((c) => c.name === 'fixture-integrity');
    expect(fixtureCheck?.status).toBe('fail');
    // The guardrail checks themselves still pass — only the fixture is corrupt.
    expect(run.checks.filter((c) => c.name !== 'fixture-integrity').every((c) => c.status === 'pass')).toBe(true);
  });

  it('fails when the committed fixture is missing', async () => {
    const evalCase = makeEvalCase({ pattern: 'repeated-tool-use', writeFixture: false });
    const run = await runEvalCase(evalCase, { ...baseCtx, clockMs: stubClock([1, 2]) });
    expect(run.status).toBe('fail');
    const fixtureCheck = run.checks.find((c) => c.name === 'fixture-integrity');
    expect(fixtureCheck?.status).toBe('fail');
    expect(fixtureCheck?.actual).toContain('not found');
  });

  it('validates the closure-anomaly (abort recovery hint) contract end to end', async () => {
    const run = await runEvalCase(makeEvalCase({ pattern: 'closure-anomaly' }), { ...baseCtx, clockMs: stubClock([1, 2]) });
    expect(run.status).toBe('pass');
    expect(run.contract).toBe('closure-abort-recovery-hint');
    expect(run.checks.some((c) => c.name === 'abort-closure-has-guidance' && c.status === 'pass')).toBe(true);
  });

  it('a failed check beats a passing contract (corrupt fixture forces fail)', async () => {
    // closure-anomaly now has a contract whose checks pass; a missing fixture
    // must still force `fail` (fixture-integrity beats the passing contract).
    const evalCase = makeEvalCase({ pattern: 'closure-anomaly', writeFixture: false });
    const run = await runEvalCase(evalCase, { ...baseCtx, clockMs: stubClock([1, 2]) });
    expect(run.status).toBe('fail');
    expect(run.checks.find((c) => c.name === 'fixture-integrity')?.status).toBe('fail');
    expect(run.checks.filter((c) => c.name !== 'fixture-integrity').every((c) => c.status === 'pass')).toBe(true);
  });

  it('validates the subagent-block (skill depth hint) contract end to end', async () => {
    const run = await runEvalCase(makeEvalCase({ pattern: 'subagent-block' }), { ...baseCtx, clockMs: stubClock([1, 2]) });
    expect(run.status).toBe('pass');
    expect(run.contract).toBe('skill-max-depth-recovery-hint');
    expect(run.checks.some((c) => c.name === 'recovery-hint-present' && c.status === 'pass')).toBe(true);
  });

  it('honours the resolveFixtureAbsPath seam', async () => {
    const evalCase = makeEvalCase({ pattern: 'tool-failure-density', writeFixture: false });
    // Write the fixture somewhere the default resolver would NOT look.
    const customAbs = join(tempHome, 'custom', 'elsewhere.jsonl');
    mkdirSync(dirname(customAbs), { recursive: true });
    writeFileSync(customAbs, DEFAULT_FIXTURE_BYTES);

    const run = await runEvalCase(evalCase, {
      ...baseCtx,
      clockMs: stubClock([1, 2]),
      resolveFixtureAbsPath: () => customAbs,
    });
    expect(run.status).toBe('pass');
    expect(run.checks.find((c) => c.name === 'fixture-integrity')?.status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// writeEvalRun + read helpers
// ---------------------------------------------------------------------------

describe('writeEvalRun / getEvalRun / listEvalRuns', () => {
  it('writes JSON + md + index, and round-trips through getEvalRun', async () => {
    const run = await runEvalCase(makeEvalCase(), {
      evalRunId: 'repeated-tool-grep-abc123-run-20260611-aaa111',
      now: FIXED_NOW,
      clockMs: stubClock([0, 3]),
    });
    const outcome = writeEvalRun(run);

    expect(outcome.jsonPath).toBe(getEvalRunJsonPath(run.evalRunId));
    expect(outcome.markdownPath).toBe(getEvalRunMarkdownPath(run.evalRunId));
    expect(existsSync(getEvalRunsDir())).toBe(true);
    expect(existsSync(outcome.jsonPath)).toBe(true);
    expect(existsSync(outcome.markdownPath)).toBe(true);

    const reread = getEvalRun(run.evalRunId);
    expect(reread).toEqual(run);

    // Index has exactly one created event for this run.
    const indexLines = readFileSync(getEvalRunsIndexPath(), 'utf-8').trim().split('\n');
    expect(indexLines).toHaveLength(1);
    const event = JSON.parse(indexLines[0]!);
    expect(event.event).toBe('created');
    expect(event.evalRunId).toBe(run.evalRunId);
    expect(event.status).toBe('pass');
  });

  it('lists runs newest-first', async () => {
    const older = await runEvalCase(makeEvalCase(), {
      evalRunId: 'slug-run-20260611-000001',
      now: () => new Date('2026-06-11T10:00:00.000Z'),
      clockMs: stubClock([0, 1]),
    });
    const newer = await runEvalCase(makeEvalCase(), {
      evalRunId: 'slug-run-20260611-000002',
      now: () => new Date('2026-06-11T11:00:00.000Z'),
      clockMs: stubClock([0, 1]),
    });
    writeEvalRun(older);
    writeEvalRun(newer);

    const entries = listEvalRuns();
    expect(entries.map((e) => e.evalRunId)).toEqual([newer.evalRunId, older.evalRunId]);
    expect(entries[0]?.status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// renderEvalRunMarkdown
// ---------------------------------------------------------------------------

describe('renderEvalRunMarkdown', () => {
  it('renders the header, disclaimer, checks table, and evidence', async () => {
    const run = await runEvalCase(makeEvalCase({ pattern: 'repeated-tool-use' }), {
      evalRunId: 'repeated-tool-grep-abc123-run-20260611-7e1a09',
      now: FIXED_NOW,
      clockMs: stubClock([0, 7]),
    });
    const md = renderEvalRunMarkdown(run);

    expect(md).toContain('# repeated-tool-grep-abc123-run-20260611-7e1a09 — `eval-run` — `pass`');
    expect(md).toContain('does');
    expect(md).toContain('NOT replay the fixture through the detector');
    expect(md).toContain('## Result: ✓ PASS');
    expect(md).toContain('| Check | Status | Expected | Actual |');
    expect(md).toContain('fixture-integrity');
    expect(md).toContain('REPEAT_CIRCUIT_BREAKER_THRESHOLD');
    expect(md).toContain(`\`${EVAL_RUN_RUNNER_VERSION}\``);
  });

  it('escapes pipes in table cells so the markdown table stays valid', async () => {
    const run = await runEvalCase(makeEvalCase({ pattern: 'tool-failure-density' }), {
      evalRunId: 'slug-run-20260611-bbbbbb',
      now: FIXED_NOW,
      clockMs: stubClock([0, 1]),
    });
    const md = renderEvalRunMarkdown(run);
    // tool-failure-density actual cells contain a "[a, b]" detector list — no
    // raw pipes there, but the escaping helper must never leak an unescaped
    // pipe into a cell. Assert every checks-table row has the right column count.
    const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Check') && !l.startsWith('|---'));
    for (const row of rows) {
      // 4 columns → 5 pipe delimiters (escaped pipes are \\| and don't count).
      const delimiters = row.replace(/\\\|/g, '').split('|').length - 1;
      expect(delimiters).toBe(5);
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A monotonic clock stub that yields the given values, then repeats the last. */
function stubClock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}
