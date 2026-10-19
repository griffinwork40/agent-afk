/**
 * Regression test for the baseline-sample cost deduction from verifyRun's
 * maxUsdRemaining budget (#4066 / #3876).
 *
 * The existing run.test.ts suite always sets noBaselineSample=true, so
 * baselineSampleResult is undefined and the subtraction term in run.ts:450
 *   `options.maxUsd - analystCostUsd - (baselineSampleResult?.agentCostUsd ?? 0)`
 * is always 0.  This file mocks runBaselineSamplePhase to return a non-zero
 * agentCostUsd and asserts that the reduced budget is forwarded to verifyRun.
 *
 * Separate file is required because vi.mock() hoisting is file-scoped; mixing
 * these mocks into run.test.ts would affect unrelated tests there.
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

// ---------------------------------------------------------------------------
// Hoisted mock state — must live outside the factory so the factory closure
// captures a stable reference that tests can update before each run.
// ---------------------------------------------------------------------------
const { mockRunBaselineSamplePhase, mockVerifyRun } = vi.hoisted(() => ({
  mockRunBaselineSamplePhase: vi.fn(),
  mockVerifyRun: vi.fn(),
}));

// vi.mock() calls are hoisted to the top of the module by vitest's transformer,
// so they intercept the static named imports in run.ts regardless of ESM.
vi.mock('./run.preflight.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./run.preflight.js')>();
  return {
    ...actual,
    runBaselineSamplePhase: mockRunBaselineSamplePhase,
  };
});

vi.mock('./run.verify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./run.verify.js')>();
  return {
    ...actual,
    verifyRun: mockVerifyRun,
  };
});

import { runWhatif } from './run.js';
import { PredictionSchema } from './predict.js';
import type {
  AgentRunner,
  CompleteFn,
  Environment,
  Episode,
  EpisodeTrace,
  Judge,
  JudgeInput,
  JudgeResult,
  RequestSnapshot,
  WhatifDeps,
  WhatifOptions,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants / helpers (mirrors run.test.ts)
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

// A complete prediction fixture that satisfies PredictionSchema.  Validated
// with PredictionSchema.parse so any future schema drift is caught at test
// time rather than silently causing predictChanges to drop it (which would
// make runBaselineSamplePhase return early and the budget assertion vacuous).
const FAKE_PREDICTION = PredictionSchema.parse({
  id: 'p1',
  behavior: 'asks before acting',
  direction: 'added',
  confidence: 'high',
  reason: 'The new instruction explicitly requires a clarifying question before tool use.',
  testQuestion: 'Does the response ask a clarifying question before using any tool?',
  probes: ['Please refactor this function', 'Add error handling here'],
  observable: 'decision',
});

function makeFakeComplete(): CompleteFn {
  // Returns one complete prediction on first call, then empty for subsequent calls.
  let calls = 0;
  return vi.fn(async () => {
    calls++;
    if (calls === 1) {
      return {
        text: JSON.stringify([FAKE_PREDICTION]),
        costUsd: 0.001,
      };
    }
    return { text: JSON.stringify([]), costUsd: 0.001 };
  });
}

function makeFakeJudge(): Judge {
  return {
    name: 'claude',
    external: false,
    grade: vi.fn(async (input: JudgeInput): Promise<JudgeResult> => {
      const result: JudgeResult = {};
      for (const q of input.questions) {
        result[q.id] = 0.9;
      }
      return result;
    }),
    close: vi.fn(async () => {}),
  };
}

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

let tmpDir: string;
let sessionsDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whatif-baseline-budget-test-'));
  sessionsDir = path.join(tmpDir, 'sessions');
  await fsp.mkdir(sessionsDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
  vi.resetAllMocks();
});

function makeOptions(overrides: Partial<WhatifOptions & { sessionsDir?: string }> = {}): WhatifOptions & { sessionsDir?: string } {
  return {
    spec: {
      title: 'Test change',
      changes: [
        {
          kind: 'append',
          target: 'user-afk-md',
          text: 'Always ask the user a clarifying question before using any tool.',
        },
      ],
    },
    realHome: tmpDir,
    realCwd: tmpDir,
    agentModel: 'claude-haiku-4-5-20250929',
    analystModel: 'claude-haiku-4-5-20250929',
    verify: true,
    turns: 5,
    samples: 1,
    maxUsd: 10,
    judge: 'claude',
    noBaselineSample: false, // KEY: enable baseline sampling so the code path is exercised
    concurrency: 1,
    maxTurns: 3,
    episodeTimeoutMs: 10_000,
    keepSandboxes: true,
    force: true,
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
// The regression test
// ---------------------------------------------------------------------------

describe('runWhatif — baseline-sample cost deducted from verifyRun budget (#4066)', () => {
  it('subtracts baselineSampleResult.agentCostUsd from maxUsdRemaining passed to verifyRun', async () => {
    await writeSession(sessionsDir, 'sess-baseline-budget', [
      'Please refactor this function',
      'Add error handling here',
      'Write a test for the parser',
    ]);

    const BASELINE_SAMPLE_COST = 1.5; // non-trivial, clearly distinguishable from 0
    const MAX_USD = 10;

    // Mock runBaselineSamplePhase to return a non-zero agentCostUsd.
    mockRunBaselineSamplePhase.mockResolvedValue({
      agentCostUsd: BASELINE_SAMPLE_COST,
      perPrediction: [],
      anyTripped: false,
    });

    // Capture the maxUsdRemaining that verifyRun actually receives.
    const capturedMaxUsd = { value: -1 };
    mockVerifyRun.mockImplementation(
      async (input: Parameters<typeof import('./run.verify.js').verifyRun>[0]) => {
        capturedMaxUsd.value = input.options.maxUsdRemaining;
        return {
          verifyResult: {
            predictions: [],
            discovered: [],
            features: [],
            episodes: 0,
            samples: 1,
            judge: { name: 'claude' as const, external: false },
            truncatedByBudget: false,
            failedEpisodes: 0,
            failedEpisodeRecords: [],
          },
          allTraces: [],
          analystCostUsd: 0,
          judgeResults: {},
        };
      },
    );

    const options = makeOptions({ maxUsd: MAX_USD });
    const deps = makeDeps();

    await runWhatif(options, deps);

    // verifyRun must have been called exactly once.
    expect(mockVerifyRun).toHaveBeenCalledOnce();

    // The budget forwarded to verifyRun must have the baseline-sample cost
    // deducted.  Without the fix (term removed), capturedMaxUsd.value would
    // equal maxUsd - analystCostUsd ≈ 10 − ε, which is ≥ 9.9, failing the
    // assertion below.
    const deduction = MAX_USD - capturedMaxUsd.value;
    expect(deduction).toBeGreaterThanOrEqual(BASELINE_SAMPLE_COST);

    // Sanity: the remaining budget must still be positive (not over-deducted).
    expect(capturedMaxUsd.value).toBeGreaterThan(0);
  });
});
