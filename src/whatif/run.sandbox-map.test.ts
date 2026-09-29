/**
 * Tests for `src/whatif/run.sandbox-map.ts` and the sandbox-map integration
 * in `runWhatif` (the `--keep-sandboxes` path).
 *
 * Covers:
 *   (a) writeSandboxMap writes a valid JSON file in runDir and returns the path.
 *   (b) writeSandboxMap returns null and does not throw on write failure.
 *   (c) runWhatif with keepSandboxes=true: <runDir>/sandboxes.json exists,
 *       lists baseline+candidate roots that exist on disk, and the mapping file
 *       is NOT under either sandbox root (nor are the roots under runDir).
 *   (d) runWhatif with keepSandboxes=false: no sandboxes.json is written.
 *   (e) report.keptSandboxes is populated iff keepSandboxes=true.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeSandboxMap, SANDBOX_MAP_FILENAME } from './run.sandbox-map.js';
import { runWhatif } from './run.js';
import type {
  AgentRunner,
  ChangeSpec,
  CompleteFn,
  Environment,
  JudgeInput,
  JudgeResult,
  Judge,
  RequestSnapshot,
  RunnerOptions,
  WhatifDeps,
  WhatifOptions,
} from './types.js';

// ---------------------------------------------------------------------------
// Minimal fakes (matching the shapes from run.test.ts)
// ---------------------------------------------------------------------------

let tmpDir = '';
let sessionsDir = '';

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sbmap-test-'));
  sessionsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sbmap-sess-'));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.rm(sessionsDir, { recursive: true, force: true });
});

function makeSpec(): ChangeSpec {
  return {
    title: 'Sandbox map test',
    changes: [
      {
        kind: 'append',
        target: 'user-afk-md',
        text: 'Always ask the user a clarifying question before using any tool.',
      },
    ],
  };
}

function makeSnap(): RequestSnapshot {
  return {
    model: 'claude-haiku-4-5-20250929',
    system: 'You are a test assistant.',
    tools: [],
    firstUserMessage: 'Briefly, what can you help me with in this project?',
  };
}

function makeFakeRunner(): AgentRunner {
  return {
    name: 'fake',
    snapshot: vi.fn(async (_env: Environment, _prompt: string, _opts: RunnerOptions) => makeSnap()),
    run: vi.fn(async () => ({ turns: [], costUsd: 0 })),
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
      return { text: JSON.stringify(preds), costUsd: 0.001 };
    }
    return { text: '[]', costUsd: 0 };
  });
}

function makeFakeJudge(): Judge {
  return {
    name: 'claude',
    external: false,
    async grade(_input: JudgeInput): Promise<JudgeResult> {
      return {};
    },
    close: vi.fn(async () => {}),
  };
}

function makeOptions(
  overrides: Partial<WhatifOptions & { sessionsDir?: string }> = {},
): WhatifOptions & { sessionsDir?: string } {
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
    runner: makeFakeRunner(),
    complete: makeFakeComplete(),
    makeJudge: vi.fn(async () => judge),
    makeCrossCheckJudge: vi.fn(async () => undefined),
    onProgress: vi.fn(),
    signal: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit tests: writeSandboxMap
// ---------------------------------------------------------------------------

describe('writeSandboxMap', () => {
  it('writes a JSON file to runDir and returns the path', async () => {
    const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sbmap-unit-'));
    try {
      const roots = { baseline: '/tmp/afk-aaaa', candidate: '/tmp/afk-bbbb' };
      const result = writeSandboxMap(runDir, roots);

      expect(result).toBe(path.join(runDir, SANDBOX_MAP_FILENAME));
      const raw = await fsp.readFile(result!, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      expect(parsed).toEqual(roots);
    } finally {
      await fsp.rm(runDir, { recursive: true, force: true });
    }
  });

  it('returns null (does not throw) when the directory does not exist', () => {
    const result = writeSandboxMap('/nonexistent-run-dir-12345', {
      baseline: '/tmp/a',
      candidate: '/tmp/b',
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration tests: runWhatif + --keep-sandboxes
// ---------------------------------------------------------------------------

describe('runWhatif — sandbox mapping (keepSandboxes=true)', () => {
  it('writes sandboxes.json to runDir with valid baseline+candidate roots', async () => {
    const report = await runWhatif(makeOptions({ keepSandboxes: true }), makeDeps());

    const mapPath = path.join(report.runDir, 'sandboxes.json');
    const raw = await fsp.readFile(mapPath, 'utf8');
    const map = JSON.parse(raw) as { baseline: string; candidate: string };

    expect(typeof map.baseline).toBe('string');
    expect(typeof map.candidate).toBe('string');
    expect(map.baseline.length).toBeGreaterThan(0);
    expect(map.candidate.length).toBeGreaterThan(0);
  });

  it('mapping file is in runDir, not under either sandbox root', async () => {
    const report = await runWhatif(makeOptions({ keepSandboxes: true }), makeDeps());

    expect(report.keptSandboxes).toBeDefined();
    const { baseline, candidate } = report.keptSandboxes!;
    const mapPath = path.join(report.runDir, 'sandboxes.json');

    // The mapping file must not live inside either sandbox root
    expect(mapPath.startsWith(baseline)).toBe(false);
    expect(mapPath.startsWith(candidate)).toBe(false);

    // The sandbox roots must not live inside the run dir
    expect(baseline.startsWith(report.runDir)).toBe(false);
    expect(candidate.startsWith(report.runDir)).toBe(false);
  });

  it('report.keptSandboxes matches sandboxes.json on disk', async () => {
    const report = await runWhatif(makeOptions({ keepSandboxes: true }), makeDeps());

    expect(report.keptSandboxes).toBeDefined();
    const mapPath = path.join(report.runDir, 'sandboxes.json');
    const raw = await fsp.readFile(mapPath, 'utf8');
    const map = JSON.parse(raw) as { baseline: string; candidate: string };

    expect(map.baseline).toBe(report.keptSandboxes!.baseline);
    expect(map.candidate).toBe(report.keptSandboxes!.candidate);
  });
});

describe('runWhatif — sandbox mapping (keepSandboxes=false)', () => {
  it('does NOT write sandboxes.json and report.keptSandboxes is absent', async () => {
    const report = await runWhatif(makeOptions({ keepSandboxes: false }), makeDeps());

    const mapPath = path.join(report.runDir, 'sandboxes.json');
    const exists = await fsp.access(mapPath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
    expect(report.keptSandboxes).toBeUndefined();
  });
});
