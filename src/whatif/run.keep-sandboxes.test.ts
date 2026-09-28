/**
 * Tests for --keep-sandboxes behaviour: sandboxes.json written to runDir
 * and report.keptSandboxes populated.
 *
 * Exercises the fix for issue #2478: after #2467 each arm got its own
 * mkdtempSync root under os.tmpdir(), but nothing recorded those paths.
 * The fix writes <runDir>/sandboxes.json and sets report.keptSandboxes.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWhatif } from './run.js';
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
  WhatifDeps,
  WhatifOptions,
} from './types.js';

// ---------------------------------------------------------------------------
// Minimal fakes (copied from run.test.ts setup)
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

function makeRunner(): AgentRunner {
  return {
    name: 'fake',
    run: vi.fn(async (_env: Environment, ep: Episode, sample: number): Promise<EpisodeTrace> => {
      const isCandidate = _env.label === 'candidate';
      return {
        episodeId: ep.id,
        env: _env.label as 'baseline' | 'candidate',
        sample,
        text: isCandidate ? 'May I clarify first?' : 'Sure, writing file.',
        tools: [],
        costUsd: 0.0001,
        inputTokens: 100,
        outputTokens: 20,
        durationMs: 100,
      };
    }),
    snapshot: vi.fn(async (env: Environment): Promise<RequestSnapshot> => {
      if (env.label === 'candidate') return makeSnap(CANDIDATE_SYSTEM);
      return makeSnap(BASELINE_SYSTEM);
    }),
  };
}

function makeFakeComplete(): CompleteFn {
  let calls = 0;
  return vi.fn(async () => {
    calls++;
    if (calls === 1) {
      const preds = [
        {
          id: 'p1',
          behavior: 'Asks a clarifying question before acting',
          direction: 'added',
          confidence: 'high',
          reason: 'Candidate prompt instructs asking first',
          testQuestion: 'Does the response ask the user a clarifying question?',
          probes: ['Write a file named hello.txt with content world'],
        },
      ];
      return { text: JSON.stringify(preds), costUsd: 0.002 };
    }
    return { text: '[]', costUsd: 0.001 };
  });
}

function makeFakeJudge(): Judge {
  return {
    name: 'claude',
    external: false,
    async grade(input: JudgeInput): Promise<JudgeResult> {
      const result: JudgeResult = {};
      for (const q of input.questions) {
        result[q.id] = input.output.toLowerCase().includes('clarify') ? 0.95 : 0.05;
      }
      return result;
    },
    close: vi.fn(async () => {}),
  };
}

function makeSpec(): ChangeSpec {
  return {
    title: 'Test keep-sandboxes',
    changes: [
      {
        kind: 'append',
        target: 'user-afk-md',
        text: 'Always ask the user a clarifying question before using any tool.',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let tmpDir: string;
let sessionsDir: string;
let stateDir: string;
// Track arm roots returned by the test so we can clean them up.
const keptRoots: string[] = [];

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whatif-ks-test-'));
  sessionsDir = path.join(tmpDir, 'sessions');
  stateDir = path.join(tmpDir, 'state');
  await fsp.mkdir(sessionsDir, { recursive: true });
  await fsp.mkdir(stateDir, { recursive: true });
  vi.stubEnv('AFK_STATE_DIR', stateDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  // Clean up any kept sandbox roots recorded during the test.
  for (const root of keptRoots.splice(0)) {
    await fsp.rm(root, { recursive: true, force: true });
  }
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

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
// Tests
// ---------------------------------------------------------------------------

describe('--keep-sandboxes: sandboxes.json written to runDir', () => {
  it('writes sandboxes.json to runDir when keepSandboxes is true', async () => {
    const deps = makeDeps();
    const options = makeOptions({ keepSandboxes: true });

    const report = await runWhatif(options, deps);

    // Track the roots so afterEach can clean them up.
    if (report.keptSandboxes) {
      keptRoots.push(report.keptSandboxes.baseline, report.keptSandboxes.candidate);
    }

    const sandboxesJsonPath = path.join(report.runDir, 'sandboxes.json');
    const raw = await fsp.readFile(sandboxesJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { baseline: string; candidate: string };

    // The file must be valid JSON with string paths.
    expect(typeof parsed.baseline).toBe('string');
    expect(typeof parsed.candidate).toBe('string');

    // report.keptSandboxes must equal the file contents.
    expect(report.keptSandboxes).toEqual(parsed);

    // Neither arm root is inside runDir (they live under os.tmpdir()).
    const relBaseline = path.relative(report.runDir, parsed.baseline);
    const relCandidate = path.relative(report.runDir, parsed.candidate);
    expect(relBaseline.startsWith('..')).toBe(true);
    expect(relCandidate.startsWith('..')).toBe(true);

    // sandboxes.json must not be inside either arm root.
    const relJsonFromBaseline = path.relative(parsed.baseline, sandboxesJsonPath);
    const relJsonFromCandidate = path.relative(parsed.candidate, sandboxesJsonPath);
    expect(relJsonFromBaseline.startsWith('..')).toBe(true);
    expect(relJsonFromCandidate.startsWith('..')).toBe(true);

    // Both arm roots must exist on disk (sandboxes were kept, not deleted).
    await expect(fsp.access(parsed.baseline)).resolves.toBeUndefined();
    await expect(fsp.access(parsed.candidate)).resolves.toBeUndefined();
  });

  it('does not write sandboxes.json and report.keptSandboxes is undefined when keepSandboxes is false', async () => {
    const deps = makeDeps();
    const options = makeOptions({ keepSandboxes: false });

    const report = await runWhatif(options, deps);

    expect(report.keptSandboxes).toBeUndefined();

    const sandboxesJsonPath = path.join(report.runDir, 'sandboxes.json');
    await expect(fsp.access(sandboxesJsonPath)).rejects.toThrow();
  });
});
