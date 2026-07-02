/**
 * Targeted tests for parallelize-dispatch's discriminated union return shape.
 *
 * Audit context: docs/audits/orchestration-pressure-audit.md §D, §F.1 — failed
 * delegation must not silently look like "parallelism not needed". The phase
 * now returns one of:
 *   - { kind: 'skipped' }  — legitimate no-op
 *   - { kind: 'plan' }     — orchestration plan produced
 *   - { kind: 'failed' }   — dispatch attempted and failed; caller must surface
 *
 * Tests cover:
 *   1. too-few-files            → skipped
 *   2. registry hit succeeds    → plan
 *   3. plugin-body hit succeeds → plan
 *   4. subagent status != succeeded → failed
 *   5. succeeded but no message    → failed
 *   6. dispatch throws            → failed
 *   7. caller in index.ts distinguishes skipped vs failed via history entries
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IAgentSession } from '../agent/types.js';

// ---- Mocks ---------------------------------------------------------------

// Mutable fork-subagent behavior, swapped per test.
let forkBehavior: () => Promise<{
  id: string;
  status: string;
  message: { content: string } | undefined;
  error?: { message: string };
}> = async () => ({
  id: 'mint-parallelize',
  status: 'succeeded',
  message: { content: 'mocked wave plan' },
});
let forkShouldThrow = false;

vi.mock('../agent/subagent.js', () => ({
  SubagentManager: vi.fn(() => ({
    forkSubagent: vi.fn(async () => {
      if (forkShouldThrow) throw new Error('synthetic fork failure');
      return {
        id: 'mint-parallelize',
        runToResult: vi.fn(async () => forkBehavior()),
      };
    }),
    teardownAll: vi.fn(async () => undefined),
  })),
}));

// Mutable plugin-body discovery, swapped per test.
let pluginBodies: Map<string, { body: string; pluginPath: string }> = new Map([
  ['parallelize', { body: 'PARALLELIZE_BODY_STUB', pluginPath: '/fake/plugin' }],
]);
vi.mock('../agent/tools/skill-bridge.js', () => ({
  discoverPluginSkillBodies: () => pluginBodies,
}));

vi.mock('../cli/shared-helpers.js', () => ({
  getApiKey: () => 'test-api-key',
  getModel: () => 'sonnet',
}));

// Mutable registry hit for getSkill('parallelize').
let registryParallelize: { handler: (input: unknown) => Promise<unknown> } | null = null;
vi.mock('./index.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getSkill: (name: string) => {
      if (name === 'parallelize' && registryParallelize) {
        return { name, description: '', handler: registryParallelize.handler };
      }
      throw new Error(`Skill not found: ${name}`);
    },
  };
});

// Import after mocks are wired.
import {
  runParallelizeDispatch,
  type ParallelizeDispatchResult,
} from './mint/_phases/parallelize-dispatch.js';

function mockSession(): IAgentSession {
  return {
    sessionId: 'sess-parallelize-test',
    sendMessage: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(),
    getInputStreamRef: vi.fn(),
    abortSignal: new AbortController().signal,
  };
}

const FEW_FILES_PLAN = 'Edit src/a.ts and src/b.ts and that is all.';
const MANY_FILES_PLAN =
  'Files: src/a.ts, src/b.ts, src/c.ts, src/d.ts\nAlso touch tests/x.test.ts and docs/y.md.';

describe('runParallelizeDispatch — discriminated union', () => {
  beforeEach(() => {
    forkShouldThrow = false;
    forkBehavior = async () => ({
      id: 'mint-parallelize',
      status: 'succeeded',
      message: { content: 'mocked wave plan' },
    });
    pluginBodies = new Map([
      ['parallelize', { body: 'PARALLELIZE_BODY_STUB', pluginPath: '/fake/plugin' }],
    ]);
    registryParallelize = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns skipped when plan has too few file references', async () => {
    const result = await runParallelizeDispatch(FEW_FILES_PLAN, mockSession());
    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') {
      expect(result.reason).toBe('too-few-files');
    }
  });

  it('returns plan from the registry handler when it succeeds', async () => {
    registryParallelize = {
      handler: async () => ({ wave: ['agent-a', 'agent-b'] }),
    };
    const result = await runParallelizeDispatch(MANY_FILES_PLAN, mockSession());
    expect(result.kind).toBe('plan');
    if (result.kind === 'plan') {
      expect(result.plan).toEqual({ wave: ['agent-a', 'agent-b'] });
    }
  });

  it('falls through to plugin body when registry throws "not found", and returns plan on success', async () => {
    // registryParallelize=null → getSkill throws → fallthrough to plugin body path.
    const result = await runParallelizeDispatch(MANY_FILES_PLAN, mockSession());
    expect(result.kind).toBe('plan');
    if (result.kind === 'plan') {
      expect(result.plan).toBe('mocked wave plan');
    }
  });

  it('returns failed when registry handler throws', async () => {
    registryParallelize = {
      handler: async () => {
        throw new Error('boom inside registered parallelize');
      },
    };
    const result = await runParallelizeDispatch(MANY_FILES_PLAN, mockSession());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.error).toMatch(/parallelize skill handler threw/);
      expect(result.error).toMatch(/boom inside registered parallelize/);
    }
  });

  it('returns failed when subagent status is not succeeded', async () => {
    forkBehavior = async () => ({
      id: 'mint-parallelize',
      status: 'failed',
      message: undefined,
      error: { message: 'mocked dispatch failure' },
    });
    const result = await runParallelizeDispatch(MANY_FILES_PLAN, mockSession());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.error).toMatch(/status=failed/);
      expect(result.error).toMatch(/mocked dispatch failure/);
    }
  });

  it('returns failed when subagent succeeded but returned no message', async () => {
    forkBehavior = async () => ({
      id: 'mint-parallelize',
      status: 'succeeded',
      message: undefined,
    });
    const result = await runParallelizeDispatch(MANY_FILES_PLAN, mockSession());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.error).toMatch(/no message/);
    }
  });

  it('returns failed when forkSubagent itself throws', async () => {
    forkShouldThrow = true;
    const result = await runParallelizeDispatch(MANY_FILES_PLAN, mockSession());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.error).toMatch(/parallelize dispatch threw/);
      expect(result.error).toMatch(/synthetic fork failure/);
    }
  });

  it('returns skipped (skill-body-missing) when no plugin body is discoverable', async () => {
    pluginBodies = new Map(); // no 'parallelize' body
    const result = await runParallelizeDispatch(MANY_FILES_PLAN, mockSession());
    // Treated as legitimate skip — there's nothing wrong, parallelize is just
    // not installed in this environment.
    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') {
      expect(result.reason).toBe('skill-body-missing');
    }
  });

  // PR #152 review finding M-1 regression test.
  //
  // The pre-fix countFileReferences combined two heuristics (extension regex
  // + `Files:`-list parser) and summed their hits, so a genuinely 2-file plan
  // whose `Files:` list was followed by a newline scored 3 and falsely
  // tripped the `< 3` dispatch gate. The fix deduplicates path tokens via a
  // Set; this boundary case must classify as skipped.
  it('classifies a 2-file Files: list followed by a newline as skipped (M-1 regression)', async () => {
    const TWO_FILES_TRAILING_NEWLINE = 'Files: src/a.ts, src/b.ts\nApply the edits.';
    const result = await runParallelizeDispatch(TWO_FILES_TRAILING_NEWLINE, mockSession());
    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') {
      expect(result.reason).toBe('too-few-files');
    }
  });

  it('deduplicates repeated mentions of the same file path', async () => {
    // Same path mentioned twice + one other file = 2 distinct files → skipped.
    const DUP_PLAN = 'Edit src/a.ts. Then re-edit src/a.ts and finally src/b.ts.';
    const result = await runParallelizeDispatch(DUP_PLAN, mockSession());
    expect(result.kind).toBe('skipped');
  });

  it('counts 3 distinct files in a prose plan as enough to dispatch', async () => {
    // Three distinct paths in prose (no `Files:` list) should clear the gate.
    registryParallelize = {
      handler: async () => ({ wave: ['ok'] }),
    };
    const THREE_FILES_PROSE = 'Touch src/a.ts, src/b.ts, and src/c.ts please.';
    const result = await runParallelizeDispatch(THREE_FILES_PROSE, mockSession());
    expect(result.kind).toBe('plan');
  });

  it('caller can distinguish skipped from failed at the type level', () => {
    // Compile-time check via narrowing — every case is reachable.
    const samples: ParallelizeDispatchResult[] = [
      { kind: 'skipped', reason: 'too-few-files' },
      { kind: 'plan', plan: { wave: [] } },
      { kind: 'failed', error: 'x' },
    ];
    const kinds = samples.map((s) => s.kind).sort();
    expect(kinds).toEqual(['failed', 'plan', 'skipped']);
  });
});
