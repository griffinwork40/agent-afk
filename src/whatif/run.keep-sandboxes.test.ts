/**
 * Tests for --keep-sandboxes sandbox-manifest behaviour (#2478).
 *
 * Verifies that when keepSandboxes is set, <runDir>/sandboxes.json is written
 * with the arm-to-root mapping, and that neither root is a sub-path of runDir.
 * When keepSandboxes is false, no sandboxes.json is written.
 *
 * Setup mirrors src/whatif/run.test.ts (fake runner, complete, judge).
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
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
  RunnerOptions,
  WhatifDeps,
  WhatifOptions,
} from './types.js';

// ---------------------------------------------------------------------------
// Fake runner / complete / judge — mirrors run.test.ts helpers
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

function makeRunner(): AgentRunner {
  return {
    name: 'fake',
    run: vi.fn(async (_env: Environment, ep: Episode, sample: number): Promise<EpisodeTrace> => {
      if (_env.label === 'candidate') return makeCandidateTrace(ep.id, sample);
      return makeBaselineTrace(ep.id, sample);
    }) as unknown as AgentRunner['run'],
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
          testQuestion: 'Does the response ask the user a clarifying question before using any tool?',
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
        result[q.id] = input.output.toLowerCase().includes('ask') ? 0.95 : 0.05;
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
/** Extra sandbox roots to clean up if keepSandboxes=true kept them. */
const extraRoots: string[] = [];

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whatif-ks-test-'));
  sessionsDir = path.join(tmpDir, 'sessions');
  stateDir = path.join(tmpDir, 'state');
  await fsp.mkdir(sessionsDir, { recursive: true });
  await fsp.mkdir(stateDir, { recursive: true });

  // Inject AFK_STATE_DIR so getWhatifDir() resolves inside tmpDir
  vi.stubEnv('AFK_STATE_DIR', stateDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  // Remove our test tmp dir
  await fsp.rm(tmpDir, { recursive: true, force: true });
  // Remove kept sandbox roots (they live under os.tmpdir() separately)
  for (const root of extraRoots.splice(0)) {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpec(title = 'Keep-sandboxes test'): ChangeSpec {
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
    keepSandboxes: false, // default; tests override per-case
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

describe('--keep-sandboxes sandbox manifest (#2478)', () => {
  it('writes sandboxes.json in runDir when keepSandboxes=true', async () => {
    const options = makeOptions({ keepSandboxes: true });
    const deps = makeDeps();

    const report = await runWhatif(options, deps);

    // Track roots for cleanup
    if (report.keptSandboxes) {
      extraRoots.push(report.keptSandboxes.baseline, report.keptSandboxes.candidate);
    }

    const manifestPath = path.join(report.runDir, 'sandboxes.json');
    expect(existsSync(manifestPath), 'sandboxes.json should exist in runDir').toBe(true);

    const content = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    expect(content).toHaveProperty('baseline');
    expect(content).toHaveProperty('candidate');
    expect(typeof content.baseline).toBe('string');
    expect(typeof content.candidate).toBe('string');
  });

  it('sandboxes.json matches report.keptSandboxes', async () => {
    const options = makeOptions({ keepSandboxes: true });
    const deps = makeDeps();

    const report = await runWhatif(options, deps);

    if (report.keptSandboxes) {
      extraRoots.push(report.keptSandboxes.baseline, report.keptSandboxes.candidate);
    }

    expect(report.keptSandboxes).toBeDefined();
    const manifestPath = path.join(report.runDir, 'sandboxes.json');
    const content = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    expect(content.baseline).toBe(report.keptSandboxes!.baseline);
    expect(content.candidate).toBe(report.keptSandboxes!.candidate);
  });

  it('neither sandbox root is inside runDir and manifest is not inside either root', async () => {
    const options = makeOptions({ keepSandboxes: true });
    const deps = makeDeps();

    const report = await runWhatif(options, deps);

    if (report.keptSandboxes) {
      extraRoots.push(report.keptSandboxes.baseline, report.keptSandboxes.candidate);
    }

    expect(report.keptSandboxes).toBeDefined();
    const { baseline, candidate } = report.keptSandboxes!;
    const manifestPath = path.join(report.runDir, 'sandboxes.json');

    // runDir must not be inside baseline or candidate
    expect(report.runDir.startsWith(baseline + path.sep)).toBe(false);
    expect(report.runDir.startsWith(candidate + path.sep)).toBe(false);

    // Roots must not be inside runDir
    expect(baseline.startsWith(report.runDir + path.sep)).toBe(false);
    expect(candidate.startsWith(report.runDir + path.sep)).toBe(false);

    // The manifest file must not be inside either root
    expect(manifestPath.startsWith(baseline + path.sep)).toBe(false);
    expect(manifestPath.startsWith(candidate + path.sep)).toBe(false);
  });

  it('both sandbox roots still exist on disk when keepSandboxes=true', async () => {
    const options = makeOptions({ keepSandboxes: true });
    const deps = makeDeps();

    const report = await runWhatif(options, deps);

    if (report.keptSandboxes) {
      extraRoots.push(report.keptSandboxes.baseline, report.keptSandboxes.candidate);
    }

    expect(report.keptSandboxes).toBeDefined();
    expect(existsSync(report.keptSandboxes!.baseline), 'baseline root should still exist').toBe(true);
    expect(existsSync(report.keptSandboxes!.candidate), 'candidate root should still exist').toBe(true);
  });

  it('does NOT write sandboxes.json when keepSandboxes=false', async () => {
    const options = makeOptions({ keepSandboxes: false });
    const deps = makeDeps();

    const report = await runWhatif(options, deps);

    const manifestPath = path.join(report.runDir, 'sandboxes.json');
    expect(existsSync(manifestPath), 'sandboxes.json should NOT exist when keepSandboxes=false').toBe(false);
    expect(report.keptSandboxes).toBeUndefined();
  });
});
