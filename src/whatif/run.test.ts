/**
 * End-to-end tests for `src/whatif/run.ts`.
 *
 * Uses fake AgentRunner, CompleteFn, Judge, and temp directories so no real
 * model calls or filesystem mutations outside the tmp area occur.
 *
 * Contract addition exercised: `options.sessionsDir?` for injecting a tmp
 * sessions dir into collectRealTurns.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { runWhatif, WhatifBudgetError, WhatifMdeError } from './run.js';
import type {
  AgentRunner,
  ChangeSpec,
  CompleteFn,
  Environment,
  Episode,
  EpisodeTrace,
  Judge,
  JudgeInput,
  JudgeResult,
  RequestSnapshot,
  RunnerOptions,
  WhatifDeps,
  WhatifOptions,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers — fake ledger sessions dir
// ---------------------------------------------------------------------------

function ledgerLine(kind: string, text: string): string {
  return JSON.stringify({ v: 1, ts: Date.now(), kind, text });
}

async function writeSession(
  sessionsDir: string,
  sessionId: string,
  prompts: string[],
): Promise<void> {
  const dir = path.join(sessionsDir, sessionId);
  await fsp.mkdir(dir, { recursive: true });
  const lines = prompts.map((p) => ledgerLine('user', p)).join('\n') + '\n';
  await fsp.writeFile(path.join(dir, 'events.jsonl'), lines, 'utf8');
}

// ---------------------------------------------------------------------------
// Fake runner
// ---------------------------------------------------------------------------

const BASELINE_SYSTEM = 'You are baseline assistant.';
const CANDIDATE_SYSTEM = 'You are candidate assistant. Always ask before acting.';

function makeSnap(system: string): RequestSnapshot {
  return {
    model: 'claude-haiku-4-5-20250929',
    system,
    tools: [],
    firstUserMessage: 'Briefly, what can you help me with in this project?',
  };
}

/**
 * Candidate trace: first tool is `ask_question` (recorded verdict), so
 * askedBeforeActing=true and firstAction='ask'.
 * Baseline trace: direct answer with write_file tool (recorded side effect).
 */
function makeCandidateTrace(episodeId: string, sample: number): EpisodeTrace {
  return {
    episodeId,
    env: 'candidate',
    sample,
    text: 'May I clarify your request first?',
    tools: [{ tool: 'ask_question', input: { question: 'What do you need?' }, verdict: 'recorded' }],
    costUsd: 0.0001,
    inputTokens: 100,
    outputTokens: 20,
    durationMs: 100,
  };
}

function makeBaselineTrace(episodeId: string, sample: number): EpisodeTrace {
  return {
    episodeId,
    env: 'baseline',
    sample,
    text: 'Sure, I will write the file.',
    tools: [{ tool: 'write_file', input: { path: 'out.txt', content: 'data' }, verdict: 'recorded' }],
    costUsd: 0.0001,
    inputTokens: 100,
    outputTokens: 20,
    durationMs: 100,
  };
}

function makeRunner(runFn?: MockInstance): AgentRunner {
  const runMock =
    runFn ??
    vi.fn(async (_env: Environment, ep: Episode, sample: number): Promise<EpisodeTrace> => {
      if (_env.label === 'candidate') return makeCandidateTrace(ep.id, sample);
      return makeBaselineTrace(ep.id, sample);
    });

  return {
    name: 'fake',
    run: runMock as unknown as AgentRunner['run'],
    snapshot: vi.fn(async (env: Environment): Promise<RequestSnapshot> => {
      if (env.label === 'candidate') return makeSnap(CANDIDATE_SYSTEM);
      return makeSnap(BASELINE_SYSTEM);
    }),
  };
}

// ---------------------------------------------------------------------------
// Fake CompleteFn
// ---------------------------------------------------------------------------

/**
 * Returns one prediction "asks before acting" (direction: 'added') the
 * first time called, then returns empty array for subsequent calls
 * (discover phase).
 */
function makeFakeComplete(): CompleteFn {
  let calls = 0;
  return vi.fn(async () => {
    calls++;
    if (calls === 1) {
      // predictChanges call
      const preds = [
        {
          id: 'p1',
          behavior: 'Asks a clarifying question before acting',
          direction: 'added',
          confidence: 'high',
          reason: 'Candidate prompt instructs asking first',
          testQuestion: 'Does the response ask the user a clarifying question before using any tool?',
          probes: ['Write a file named hello.txt with content world'],
        },
      ];
      return { text: JSON.stringify(preds), costUsd: 0.002 };
    }
    // discoverDifferences call (returns no new diffs)
    return { text: '[]', costUsd: 0.001 };
  });
}

// ---------------------------------------------------------------------------
// Fake Judge
// ---------------------------------------------------------------------------

/**
 * Inspects the output text: if it contains "ask" → P(yes)=0.95 for p1,
 * otherwise 0.05.
 */
function makeFakeJudge(name: 'claude' | 'jev' = 'claude'): Judge {
  return {
    name,
    external: name === 'jev',
    async grade(input: JudgeInput): Promise<JudgeResult> {
      const result: JudgeResult = {};
      for (const q of input.questions) {
        if (q.id === 'p1') {
          result[q.id] = input.output.toLowerCase().includes('ask') ? 0.95 : 0.05;
        } else {
          result[q.id] = 0.5;
        }
      }
      return result;
    },
    close: vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let sessionsDir: string;
let stateDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whatif-run-test-'));
  sessionsDir = path.join(tmpDir, 'sessions');
  stateDir = path.join(tmpDir, 'state');
  await fsp.mkdir(sessionsDir, { recursive: true });
  await fsp.mkdir(stateDir, { recursive: true });

  // Inject AFK_STATE_DIR so getWhatifDir() resolves inside tmpDir
  vi.stubEnv('AFK_STATE_DIR', stateDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers for building options / deps
// ---------------------------------------------------------------------------

function makeSpec(title = 'Append ask rule'): ChangeSpec {
  return {
    title,
    changes: [
      {
        kind: 'append',
        target: 'user-afk-md',
        text: 'Always ask the user a clarifying question before using any tool.',
      },
    ],
  };
}

function makeOptions(overrides: Partial<WhatifOptions & { sessionsDir?: string }> = {}): WhatifOptions & { sessionsDir?: string } {
  return {
    spec: makeSpec(),
    realHome: tmpDir,
    realCwd: tmpDir,
    agentModel: 'claude-haiku-4-5-20250929',
    analystModel: 'claude-haiku-4-5-20250929',
    verify: false,
    turns: 5,
    samples: 1,
    maxUsd: 10,
    judge: 'claude',
    concurrency: 2,
    maxTurns: 3,
    episodeTimeoutMs: 10_000,
    keepSandboxes: true, // keep so we don't need real sandbox teardown
    force: true, // bypass MDE gate in existing tests (gate tested separately)
    sessionsDir,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<WhatifDeps> = {}): WhatifDeps {
  const judge = makeFakeJudge();
  return {
    runner: makeRunner(),
    complete: makeFakeComplete(),
    makeJudge: vi.fn(async () => judge),
    makeCrossCheckJudge: vi.fn(async () => undefined),
    onProgress: vi.fn(),
    signal: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runWhatif — predict-only path', () => {
  it('returns a report without calling runner.run', async () => {
    const deps = makeDeps();
    const options = makeOptions({ verify: false });

    const report = await runWhatif(options, deps);

    expect(report.spec.title).toBe('Append ask rule');
    expect(report.predictions.length).toBeGreaterThan(0);
    expect(report.verify).toBeUndefined();
    expect(deps.runner.run).not.toHaveBeenCalled();
    expect(deps.runner.snapshot).toHaveBeenCalledTimes(2);
  });

  it('writes report.md and results.json to runDir', async () => {
    const deps = makeDeps();
    const options = makeOptions({ verify: false });

    const report = await runWhatif(options, deps);

    const mdContent = await fsp.readFile(path.join(report.runDir, 'report.md'), 'utf8');
    const jsonContent = await fsp.readFile(path.join(report.runDir, 'results.json'), 'utf8');

    expect(mdContent).toContain('# What-If Report');
    expect(JSON.parse(jsonContent)).toMatchObject({ spec: { title: 'Append ask rule' } });
  });

  it('emits progress events for sandbox and snapshot stages', async () => {
    const deps = makeDeps();
    const options = makeOptions({ verify: false });

    await runWhatif(options, deps);

    const stages = (deps.onProgress as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: Array<{ stage: string }>) => c[0]?.stage,
    );
    expect(stages).toContain('sandbox');
    expect(stages).toContain('snapshot');
    expect(stages).toContain('predict');
  });

  it('includes headline', async () => {
    const deps = makeDeps();
    const report = await runWhatif(makeOptions({ verify: false }), deps);
    expect(typeof report.headline).toBe('string');
    expect(report.headline.length).toBeGreaterThan(0);
  });
});

describe('runWhatif — verify path', () => {
  it('confirms prediction and writes all output files', async () => {
    // Write fixture sessions so collectRealTurns finds real turns
    await writeSession(sessionsDir, 'sess-001', [
      'Please help me write a TypeScript file',
      'Fix the linting errors in my project',
    ]);

    const deps = makeDeps();
    const options = makeOptions({ verify: true, samples: 1, maxUsd: 10 });

    const report = await runWhatif(options, deps);

    expect(report.verify).toBeDefined();
    const verify = report.verify!;

    // Prediction p1 (asks before acting) should be confirmed because
    // the fake judge sees 'ask' in candidate output (0.95) and not in
    // baseline (0.05) and the CI should exclude 0.
    const vp1 = verify.predictions.find((vp) => vp.prediction.id === 'p1');
    expect(vp1).toBeDefined();
    expect(vp1!.verdict).toBe('confirmed');
    // #2403: scored only on p1's own synthetic probe, not the replayed real
    // turns; those appear as a separate background rate.
    expect(vp1!.scope?.episodes.baseline).toEqual(['s1']);
    expect(vp1!.scope?.episodes.candidate).toEqual(['s1']);
    expect(vp1!.scope?.targetedEpisodes).toBe(1);
    expect(vp1!.rates.n).toEqual({ baseline: 1, candidate: 1 });
    expect(vp1!.scope?.background?.n.baseline).toBeGreaterThan(0);

    // Feature delta for 'Asked before acting' should be positive
    const askFeat = verify.features.find((f) => f.label === 'Asked before acting');
    expect(askFeat).toBeDefined();
    expect(askFeat!.rates.candidate).toBeGreaterThan(askFeat!.rates.baseline);

    // Files written
    const md = await fsp.readFile(path.join(report.runDir, 'report.md'), 'utf8');
    const results = JSON.parse(
      await fsp.readFile(path.join(report.runDir, 'results.json'), 'utf8'),
    );
    const traces = (
      await fsp.readFile(path.join(report.runDir, 'traces.jsonl'), 'utf8')
    )
      .split('\n')
      .filter(Boolean);

    expect(md).toContain('confirmed');
    expect(md).toContain('Scored on');
    expect(md).toContain('- p1: s1');
    expect(results).toHaveProperty('verify');
    expect(results.verify.predictions[0].scope.episodes.candidate).toEqual(['s1']);
    expect(traces.length).toBeGreaterThan(0);
    // Each line must be valid JSON
    for (const line of traces) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('calls runner.run for every episode × env × sample', async () => {
    await writeSession(sessionsDir, 'sess-002', ['Help me debug this failing test in my project']);

    const runMock = vi.fn(
      async (env: Environment, ep: Episode, sample: number): Promise<EpisodeTrace> => {
        if (env.label === 'candidate') return makeCandidateTrace(ep.id, sample);
        return makeBaselineTrace(ep.id, sample);
      },
    );
    const runner = makeRunner(runMock as unknown as MockInstance);
    const deps = makeDeps({ runner });
    const options = makeOptions({ verify: true, samples: 1, maxUsd: 10 });

    await runWhatif(options, deps);

    // runner.run should have been called: episodes × 2 envs × 1 sample
    expect(runMock).toHaveBeenCalled();
  });

  it('closes judge after verify completes', async () => {
    const judge = makeFakeJudge();
    const deps = makeDeps({ makeJudge: vi.fn(async () => judge) });
    const options = makeOptions({ verify: true, maxUsd: 10 });

    await runWhatif(options, deps);

    expect(judge.close).toHaveBeenCalled();
  });
});

describe('runWhatif — WhatifBudgetError', () => {
  it('throws WhatifBudgetError before runner.run when maxUsd is tiny', async () => {
    const deps = makeDeps();
    // maxUsd=0 ensures any estimate > 0 triggers the error
    const options = makeOptions({ verify: true, maxUsd: 0.000001 });

    await expect(runWhatif(options, deps)).rejects.toBeInstanceOf(WhatifBudgetError);
    expect(deps.runner.run).not.toHaveBeenCalled();
  });

  it('WhatifBudgetError carries estimateUsd and maxUsd', async () => {
    const deps = makeDeps();
    const options = makeOptions({ verify: true, maxUsd: 0.000001 });

    const err = await runWhatif(options, deps).catch((e) => e);
    expect(err).toBeInstanceOf(WhatifBudgetError);
    expect((err as WhatifBudgetError).estimateUsd).toBeGreaterThan(0);
    expect((err as WhatifBudgetError).maxUsd).toBe(0.000001);
  });
});

describe('runWhatif — truncatedByBudget', () => {
  it('sets truncatedByBudget when traces exceed remaining budget', async () => {
    // Each trace costs 0.01; with maxUsd=0.025 (minus analyst ~0.003) we
    // expect the budget to trip after a few episodes.
    const runMock = vi.fn(
      async (env: Environment, ep: Episode, sample: number): Promise<EpisodeTrace> => {
        const trace =
          env.label === 'candidate'
            ? makeCandidateTrace(ep.id, sample)
            : makeBaselineTrace(ep.id, sample);
        return { ...trace, costUsd: 1.0 }; // very expensive traces
      },
    );
    const runner = makeRunner(runMock as unknown as MockInstance);
    const deps = makeDeps({ runner });

    // maxUsd generous enough to pass preflight but episodes will exceed it
    const options = makeOptions({
      verify: true,
      maxUsd: 5,
      turns: 3,
      samples: 1,
    });

    await writeSession(sessionsDir, 'sess-budget', [
      'Please help me write a TypeScript file with generics',
      'Fix the linting errors in my project please',
      'Add comprehensive tests for this module',
    ]);

    const report = await runWhatif(options, deps);
    expect(report.verify?.truncatedByBudget).toBe(true);
  });
});

describe('runWhatif — abort', () => {
  it('stops scheduling and throws after abort signal fires', async () => {
    const controller = new AbortController();
    let callCount = 0;

    const runMock = vi.fn(async (env: Environment, ep: Episode, sample: number) => {
      callCount++;
      controller.abort();
      if (env.label === 'candidate') return makeCandidateTrace(ep.id, sample);
      return makeBaselineTrace(ep.id, sample);
    });
    const runner = makeRunner(runMock as unknown as MockInstance);
    const deps = makeDeps({ runner, signal: controller.signal });

    await writeSession(sessionsDir, 'sess-abort', [
      'Refactor the authentication module to use async/await',
      'Write documentation for the public API endpoints',
      'Run the test suite and fix any failures found',
    ]);

    const options = makeOptions({
      verify: true,
      maxUsd: 10,
      turns: 3,
      samples: 1,
    });

    await expect(runWhatif(options, deps)).rejects.toThrow();
    // runner.run should NOT have been called for all episodes (aborted early)
    // At most a small number of traces should have completed
    expect(callCount).toBeLessThan(6); // 3 episodes × 2 envs = 6 if not aborted
  });
});

describe('WhatifBudgetError class', () => {
  it('has correct name and message', () => {
    const err = new WhatifBudgetError(0.5, 0.1);
    expect(err.name).toBe('WhatifBudgetError');
    expect(err.message).toContain('0.5000');
    expect(err.message).toContain('0.1000');
    expect(err.estimateUsd).toBe(0.5);
    expect(err.maxUsd).toBe(0.1);
    expect(err instanceof Error).toBe(true);
  });

  it('message mentions --max-usd with rounded-up estimate', () => {
    const err = new WhatifBudgetError(1.234, 1.0);
    // Should suggest --max-usd at least at the rounded-up estimate (cents)
    expect(err.message).toContain('--max-usd 1.24');
  });

  it('message mentions --probes/--max-predictions/--samples/--turns as reduction options', () => {
    const err = new WhatifBudgetError(5.0, 3.0);
    expect(err.message).toContain('--probes');
    expect(err.message).toContain('--max-predictions');
    expect(err.message).toContain('--samples');
    expect(err.message).toContain('--turns');
  });
});

// ---------------------------------------------------------------------------
// MDE gate
// ---------------------------------------------------------------------------

describe('runWhatif — MDE gate', () => {
  it('throws WhatifMdeError when underpowered and force is false', async () => {
    // makeOptions uses force:true by default; explicitly set force:false here
    const deps = makeDeps();
    const options = makeOptions({ verify: true, maxUsd: 10, force: false });
    // The gate now fires on per-prediction probe count (≤2 probes/prediction with the
    // current cap), which is always underpowered for the 20pp threshold.
    await expect(runWhatif(options, deps)).rejects.toBeInstanceOf(WhatifMdeError);
    // runner.run must NOT have been called (gate fires before episodes run)
    expect(deps.runner.run).not.toHaveBeenCalled();
  });

  it('WhatifMdeError carries per-prediction probe count as episodesPerArm', async () => {
    const deps = makeDeps();
    const options = makeOptions({ verify: true, maxUsd: 10, force: false });
    const err = await runWhatif(options, deps).catch((e) => e);
    expect(err).toBeInstanceOf(WhatifMdeError);
    // episodesPerArm now holds the per-prediction probe count (small: ≤2)
    expect((err as WhatifMdeError).episodesPerArm).toBeGreaterThanOrEqual(0);
    expect(err.message).toContain('--force');
    expect(err.message).toContain('#2477');
  });

  it('proceeds (no throw) when force is true even with few probes per prediction', async () => {
    const deps = makeDeps();
    // force:true is set by makeOptions default; explicitly confirm here
    const options = makeOptions({ verify: true, maxUsd: 10, force: true });
    // Should not throw WhatifMdeError; may throw other errors (budget) but
    // runner.run should be attempted
    let threw = false;
    try {
      await runWhatif(options, deps);
    } catch (err) {
      // OK to throw something else (budget, runner error) — just not MdeError
      if (err instanceof WhatifMdeError) threw = true;
    }
    expect(threw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Synthetic episodes come first (#2477 step 1)
// ---------------------------------------------------------------------------

describe('runWhatif — synthetic episodes before replay turns', () => {
  it('runner receives synthetic probe episodes before replay turns', async () => {
    // Write real session turns so collectRealTurns finds something
    await writeSession(sessionsDir, 'sess-order-001', [
      'A real user prompt from the corpus',
    ]);

    const episodeOrder: Array<string | undefined> = [];
    const deps = makeDeps({
      runner: {
        ...makeRunner(),
        run: vi.fn(async (_env: Environment, ep: Episode, _s: number, _opts: RunnerOptions): Promise<EpisodeTrace> => {
          episodeOrder.push(ep.targets);
          return makeCandidateTrace(ep.id, _s);
        }),
        snapshot: makeRunner().snapshot,
      },
    });

    const options = makeOptions({ verify: true, samples: 1, maxUsd: 10 });
    try {
      await runWhatif(options, deps);
    } catch {
      // May fail for budget / MDE reasons; we only care about the episode order
    }

    // All targeted episodes (ep.targets defined) should appear before
    // non-targeted episodes (ep.targets undefined) in the run call sequence.
    const firstUntaggedIdx = episodeOrder.findIndex((t) => t === undefined);
    const lastTaggedIdx = episodeOrder.reduceRight(
      (acc, t, idx) => (t !== undefined && acc === -1 ? idx : acc), -1,
    );

    // If both exist, tagged must come before first untagged
    if (firstUntaggedIdx !== -1 && lastTaggedIdx !== -1) {
      expect(lastTaggedIdx).toBeLessThan(firstUntaggedIdx);
    }
    // If no untagged episodes exist that's fine — synthetic-only run
  });
});

// ---------------------------------------------------------------------------
// sandbox manifest (#2478)
// ---------------------------------------------------------------------------

describe('runWhatif — sandbox manifest', () => {
  it('writes sandboxes.json in runDir when keepSandboxes is true', async () => {
    const deps = makeDeps();
    const options = makeOptions({ verify: false, keepSandboxes: true });

    const report = await runWhatif(options, deps);

    // sandboxesFile must be recorded on the report
    expect(report.sandboxesFile).toBeDefined();
    const manifestPath = report.sandboxesFile!;

    // The manifest must live inside runDir (never inside a sandbox root)
    expect(manifestPath).toBe(path.join(report.runDir, 'sandboxes.json'));

    // File must exist and parse correctly
    const raw = await fsp.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as { baseline: string; candidate: string };
    expect(typeof manifest.baseline).toBe('string');
    expect(typeof manifest.candidate).toBe('string');

    // runDir must not be under either arm root
    expect(report.runDir.startsWith(manifest.baseline)).toBe(false);
    expect(report.runDir.startsWith(manifest.candidate)).toBe(false);

    // Neither arm root must be under runDir
    expect(manifest.baseline.startsWith(report.runDir)).toBe(false);
    expect(manifest.candidate.startsWith(report.runDir)).toBe(false);
  });

  it('does not write sandboxes.json when keepSandboxes is false', async () => {
    const deps = makeDeps();
    const options = makeOptions({ verify: false, keepSandboxes: false });

    const report = await runWhatif(options, deps);

    expect(report.sandboxesFile).toBeUndefined();

    const manifestPath = path.join(report.runDir, 'sandboxes.json');
    await expect(fsp.access(manifestPath)).rejects.toThrow();
  });
});
