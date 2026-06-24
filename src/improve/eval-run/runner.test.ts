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
import { dirname, join, resolve } from 'path';
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
import {
  REPLAY_CHECK_CLOSURE_GUIDED,
  REPLAY_CHECK_CLOSURE_REPRODUCES,
  REPLAY_CHECK_NEUTRALIZED,
  REPLAY_CHECK_REPRODUCES,
  type LoopDriver,
} from './replay.js';
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

/** The committed fixture that encodes a real 8× repeated-tool-use loop. */
const LOOP_FIXTURE_BYTES = readFileSync(
  resolve(__dirname, '__fixtures__/repeated-tool-use-loop.fixture.jsonl'),
);

/** The committed fixture that encodes a real `abort` closure. */
const CLOSURE_FIXTURE_BYTES = readFileSync(
  resolve(__dirname, '__fixtures__/closure-anomaly-abort.fixture.jsonl'),
);

/** Build a closure fixture: a prefix ending in a `closure` event with `reason`. */
function closureFixtureBytes(reason: string): Buffer {
  const lines = [
    JSON.stringify({
      ts: '2026-06-20T10:00:00.000Z',
      seq: 0,
      kind: 'tool_call',
      payload: { phase: 'started', toolUseId: 'tu-1', name: 'bash', inputBytes: 80 },
    }),
    JSON.stringify({
      ts: '2026-06-20T10:00:00.050Z',
      seq: 1,
      kind: 'tool_call',
      payload: {
        phase: 'completed',
        toolUseId: 'tu-1',
        name: 'bash',
        resultBytes: 256,
        isError: false,
        truncated: false,
        durationMs: 50,
      },
    }),
    JSON.stringify({
      ts: '2026-06-20T10:00:01.000Z',
      seq: 2,
      kind: 'closure',
      payload: { reason, finalTurnCount: 3, finalCostUsd: 0.0123, finalTokens: { input: 1200, output: 340 } },
    }),
  ];
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

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

  it('replayInconclusive forces unsupported even with a contract and passing checks', () => {
    // A skipped replay must never read as `pass` — guardrail presence is not
    // card-specific behavioural proof.
    expect(
      decideStatus({ hasContract: true, contractThrew: false, checks: [passCheck], replayInconclusive: true }),
    ).toBe('unsupported');
  });

  it('a real failure still beats replayInconclusive', () => {
    expect(
      decideStatus({ hasContract: true, contractThrew: false, checks: [failCheck], replayInconclusive: true }),
    ).toBe('fail');
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

  it('passes for a supported pattern with an intact fixture that reproduces the loop', async () => {
    // Intact fixture that actually encodes the recorded loop → the replay layer
    // runs end to end (reproduces + neutralised) alongside the guardrail contract.
    const run = await runEvalCase(makeEvalCase({ pattern: 'repeated-tool-use', fixtureBytes: LOOP_FIXTURE_BYTES }), {
      ...baseCtx,
      clockMs: stubClock([1000, 1042]),
    });

    expect(run.status).toBe('pass');
    expect(run.contract).toBe('repeat-loop-circuit-breaker');
    expect(run.patternId).toBe('repeated-tool-use');
    expect(run.durationMs).toBe(42);
    expect(run.createdAt).toBe('2026-06-11T12:00:00.000Z');
    expect(run.runner).toEqual({ version: EVAL_RUN_RUNNER_VERSION, mode: 'deterministic' });

    // fixture-integrity is always the first check.
    expect(run.checks[0]?.name).toBe('fixture-integrity');
    expect(run.checks[0]?.status).toBe('pass');
    // fixture-integrity + 4 circuit-breaker checks + 2 fixture-replay checks.
    expect(run.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(run.checks).toHaveLength(7);
    expect(run.checks.find((c) => c.name === REPLAY_CHECK_REPRODUCES)?.status).toBe('pass');
    expect(run.checks.find((c) => c.name === REPLAY_CHECK_NEUTRALIZED)?.status).toBe('pass');
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
    // An abort-closure fixture exercises BOTH layers: the guardrail-presence
    // contract and the fixture-replay (reproduces + guided). All pass → `pass`.
    const run = await runEvalCase(
      makeEvalCase({ pattern: 'closure-anomaly', fixtureBytes: CLOSURE_FIXTURE_BYTES }),
      { ...baseCtx, clockMs: stubClock([1, 2]) },
    );
    expect(run.status).toBe('pass');
    expect(run.contract).toBe('closure-abort-recovery-hint');
    expect(run.checks.some((c) => c.name === 'abort-closure-has-guidance' && c.status === 'pass')).toBe(true);
    // The replay layer also ran against the recorded abort closure.
    expect(run.checks.find((c) => c.name === REPLAY_CHECK_CLOSURE_REPRODUCES)?.status).toBe('pass');
    expect(run.checks.find((c) => c.name === REPLAY_CHECK_CLOSURE_GUIDED)?.status).toBe('pass');
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
    const run = await runEvalCase(makeEvalCase({ fixtureBytes: LOOP_FIXTURE_BYTES }), {
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
    const older = await runEvalCase(makeEvalCase({ fixtureBytes: LOOP_FIXTURE_BYTES }), {
      evalRunId: 'slug-run-20260611-000001',
      now: () => new Date('2026-06-11T10:00:00.000Z'),
      clockMs: stubClock([0, 1]),
    });
    const newer = await runEvalCase(makeEvalCase({ fixtureBytes: LOOP_FIXTURE_BYTES }), {
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
  it('renders the header, replay disclaimer, checks table, and evidence', async () => {
    const run = await runEvalCase(
      makeEvalCase({ pattern: 'repeated-tool-use', fixtureBytes: LOOP_FIXTURE_BYTES }),
      {
        evalRunId: 'repeated-tool-grep-abc123-run-20260611-7e1a09',
        now: FIXED_NOW,
        clockMs: stubClock([0, 7]),
      },
    );
    const md = renderEvalRunMarkdown(run);

    expect(md).toContain('# repeated-tool-grep-abc123-run-20260611-7e1a09 — `eval-run` — `pass`');
    // The fixture reproduced + was neutralised, so the replay disclaimer renders.
    expect(md).toContain('proving the behaviour is fixed');
    expect(md).toContain('NOT re-execute the original tool/LLM');
    expect(md).toContain('## Result: ✓ PASS');
    expect(md).toContain('| Check | Status | Expected | Actual |');
    expect(md).toContain('fixture-integrity');
    expect(md).toContain(REPLAY_CHECK_NEUTRALIZED);
    expect(md).toContain('REPEAT_CIRCUIT_BREAKER_THRESHOLD');
    expect(md).toContain(`\`${EVAL_RUN_RUNNER_VERSION}\``);
  });

  it('renders the guardrail-only disclaimer for a pattern with no replay handler', async () => {
    const run = await runEvalCase(makeEvalCase({ pattern: 'tool-failure-density' }), {
      evalRunId: 'slug-run-20260611-cccccc',
      now: FIXED_NOW,
      clockMs: stubClock([0, 1]),
    });
    const md = renderEvalRunMarkdown(run);
    expect(md).toContain('the guardrail the pattern maps to');
    expect(md).not.toContain('proving the behaviour is fixed');
  });

  it('renders the "behaviour fixed" disclaimer for a closure-anomaly replay run', async () => {
    const run = await runEvalCase(
      makeEvalCase({ pattern: 'closure-anomaly', fixtureBytes: CLOSURE_FIXTURE_BYTES }),
      { evalRunId: 'closure-anomaly-abort-run-20260611-dddddd', now: FIXED_NOW, clockMs: stubClock([0, 1]) },
    );
    const md = renderEvalRunMarkdown(run);
    // The guided check drove → the (now pattern-agnostic) "behaviour fixed"
    // disclaimer renders and the closure guided check shows in the table.
    expect(md).toContain('proving the behaviour is fixed');
    expect(md).toContain('NOT re-execute the original tool/LLM');
    expect(md).toContain(REPLAY_CHECK_CLOSURE_GUIDED);
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
// runEvalCase — fixture-replay (the "behaviour fixed?" gate)
// ---------------------------------------------------------------------------

describe('runEvalCase fixture-replay', () => {
  const baseCtx = {
    evalRunId: 'repeated-tool-get-runtime-state-abc123-run-20260611-7e1a09',
    now: FIXED_NOW,
    clockMs: stubClock([0, 5]),
  };

  it('PASSES end to end when the live guardrail neutralises the recorded loop', async () => {
    const run = await runEvalCase(
      makeEvalCase({ pattern: 'repeated-tool-use', fixtureBytes: LOOP_FIXTURE_BYTES }),
      baseCtx,
    );

    expect(run.status).toBe('pass');
    expect(run.checks.find((c) => c.name === REPLAY_CHECK_REPRODUCES)?.status).toBe('pass');
    const neutralized = run.checks.find((c) => c.name === REPLAY_CHECK_NEUTRALIZED);
    expect(neutralized?.status).toBe('pass');
    expect(neutralized?.actual).toContain('tripped at call 8');
  });

  it('FAILS end to end when the recorded loop still reproduces (guardrail stripped)', async () => {
    // Inject a driver whose breaker never trips — the pre-fix world.
    const noBreaker: LoopDriver = async (_tool, count) => ({ trippedAtCall: null, callsDriven: count });
    const run = await runEvalCase(
      makeEvalCase({ pattern: 'repeated-tool-use', fixtureBytes: LOOP_FIXTURE_BYTES }),
      { ...baseCtx, driveLoop: noBreaker },
    );

    expect(run.status).toBe('fail');
    // The fixture still reproduces, so that check passes …
    expect(run.checks.find((c) => c.name === REPLAY_CHECK_REPRODUCES)?.status).toBe('pass');
    // … but the loop is not neutralised → the gate fails.
    expect(run.checks.find((c) => c.name === REPLAY_CHECK_NEUTRALIZED)?.status).toBe('fail');
  });

  it('reports unsupported (NOT pass) when an intact fixture no longer reproduces the loop', async () => {
    // The default 1-line stub fixture is intact but encodes no loop, so the
    // replay is skipped. The guardrail contract passes, but a skipped replay
    // must never surface as `pass` — that would be guardrail presence
    // masquerading as card-specific behavioural proof.
    const run = await runEvalCase(makeEvalCase({ pattern: 'repeated-tool-use' }), baseCtx);

    expect(run.status).toBe('unsupported');
    expect(run.checks.find((c) => c.name === REPLAY_CHECK_REPRODUCES)?.status).toBe('skipped');
    expect(run.checks.find((c) => c.name === REPLAY_CHECK_NEUTRALIZED)).toBeUndefined();
    // The guardrail contract itself still passed — the demotion is purely the
    // missing card-specific proof, not a guardrail regression.
    expect(run.checks.filter((c) => c.name.startsWith('replay:')).length).toBe(1);
  });

  it('does not run a replay for a pattern with no registered handler', async () => {
    const run = await runEvalCase(makeEvalCase({ pattern: 'tool-failure-density' }), baseCtx);
    expect(run.checks.some((c) => c.name === REPLAY_CHECK_REPRODUCES)).toBe(false);
    expect(run.checks.some((c) => c.name === REPLAY_CHECK_NEUTRALIZED)).toBe(false);
  });

  it('PASSES end to end when the live guardrail guides the recorded abort closure', async () => {
    const run = await runEvalCase(
      makeEvalCase({ pattern: 'closure-anomaly', fixtureBytes: CLOSURE_FIXTURE_BYTES }),
      baseCtx,
    );

    expect(run.status).toBe('pass');
    expect(run.checks.find((c) => c.name === REPLAY_CHECK_CLOSURE_REPRODUCES)?.status).toBe('pass');
    expect(run.checks.find((c) => c.name === REPLAY_CHECK_CLOSURE_GUIDED)?.status).toBe('pass');
  });

  it('FAILS end to end for an anomalous closure the guardrail does not cover (fail-closed)', async () => {
    // `timeout` reproduces but buildClosureGuidance returns null for it today.
    const run = await runEvalCase(
      makeEvalCase({ pattern: 'closure-anomaly', fixtureBytes: closureFixtureBytes('timeout') }),
      baseCtx,
    );

    expect(run.status).toBe('fail');
    // The fixture still reproduces an anomalous closure, so that check passes …
    expect(run.checks.find((c) => c.name === REPLAY_CHECK_CLOSURE_REPRODUCES)?.status).toBe('pass');
    // … but no recovery guidance exists for the reason → the gate fails.
    expect(run.checks.find((c) => c.name === REPLAY_CHECK_CLOSURE_GUIDED)?.status).toBe('fail');
  });

  it('reports unsupported (NOT pass) when an intact fixture has no anomalous closure', async () => {
    // A benign `model_end_turn` close is intact but not anomalous → the replay
    // is skipped. The guardrail contract passes, but a skipped replay must never
    // surface as `pass` — that would be guardrail presence masquerading as
    // card-specific behavioural proof.
    const run = await runEvalCase(
      makeEvalCase({ pattern: 'closure-anomaly', fixtureBytes: closureFixtureBytes('model_end_turn') }),
      baseCtx,
    );

    expect(run.status).toBe('unsupported');
    expect(run.checks.find((c) => c.name === REPLAY_CHECK_CLOSURE_REPRODUCES)?.status).toBe('skipped');
    expect(run.checks.find((c) => c.name === REPLAY_CHECK_CLOSURE_GUIDED)).toBeUndefined();
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
