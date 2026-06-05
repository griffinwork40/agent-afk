/**
 * Caller-level integration test for the `failed` parallelize-dispatch path.
 *
 * PR #152 review finding L-1: the existing mint.test.ts integration test
 * only pins the `skipped` arm. This file pins the `failed` arm at the
 * caller (mint pipeline) boundary, asserting that:
 *
 *   1. A `failed` parallelize-dispatch result writes `"failed: …"` to
 *      state.history (not `"skipped: …"`, not absent).
 *   2. The mint pipeline proceeds to the build phase single-lane —
 *      i.e. non-fatal degradation is preserved.
 *   3. The truncated error message (not the raw error) is what crosses
 *      the persistence boundary (PR #152 review finding M-2).
 *
 * Isolated in its own file so the partial mock of `parallelize-dispatch.js`
 * does not bleed into the full mint.test.ts suite.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, rmSync } from 'fs';
import type { IAgentSession } from '../agent/types.js';

// ---- Mocks ---------------------------------------------------------------

// Force the parallelize-dispatch phase to return `failed` for every call.
// We intentionally include a long error string with synthetic "user content"
// to verify the caller truncates before persistence/telemetry.
const LONG_ERROR =
  'parallelize subagent status=failed: ' +
  'simulated handler error containing pretend plan body: ' +
  'lorem ipsum '.repeat(40);

vi.mock('./mint/_phases/parallelize-dispatch.js', () => ({
  runParallelizeDispatch: vi.fn(async () => ({
    kind: 'failed',
    error: LONG_ERROR,
  })),
}));

// Spy on telemetry so we can assert what crossed the wire without writing
// to disk (appendRoutingDecision is a no-op under VITEST anyway). vi.hoisted
// is required because vi.mock factories are hoisted above top-level locals.
const { appendRoutingDecisionSpy } = vi.hoisted(() => ({
  appendRoutingDecisionSpy: vi.fn(async () => undefined),
}));
vi.mock('../agent/routing-telemetry.js', () => ({
  appendRoutingDecision: appendRoutingDecisionSpy,
}));

// Mock SubagentManager so the rest of the pipeline (spec/research/plan/
// build/verify/heal/ship) runs against deterministic stubs — same shape
// the main mint.test.ts uses.
vi.mock('../agent/subagent.js', () => {
  return {
    SubagentManager: vi.fn(() => ({
      forkSubagent: vi.fn(async (options) => {
        const idPrefix = options.idPrefix || 'subagent';

        let output: unknown = undefined;
        if (idPrefix === 'mint-build') {
          output = {
            status: 'PASS',
            files_changed: ['src/index.ts'],
            tests_passed: true,
            notes: 'Mocked build',
          };
        } else if (idPrefix.startsWith('mint-verify-')) {
          // Default verify: PASS so the heal loop does not engage and the
          // test stays focused on the parallelize-failed surface.
          output = {
            status: 'PASS',
            issues: [],
            summary: 'Mocked verify pass',
          };
        }

        const messageContent = `Mocked ${idPrefix} output`;
        return {
          id: idPrefix,
          status: 'idle',
          session: { sendMessage: vi.fn() },
          run: vi.fn(async () => ({ content: messageContent })),
          runToResult: vi.fn(async () => ({
            id: idPrefix,
            status: 'succeeded',
            message: { content: messageContent },
            output,
          })),
          runInBackground: vi.fn(),
          cancel: vi.fn(),
          teardown: vi.fn(async () => undefined),
        };
      }),
    })),
  };
});

// Import after mocks are wired.
import { getSkill } from './index.js';
import './mint/index.js';

let originalHome: string | undefined;
let tmpHome: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

describe('Mint Skill > Parallelize phase failed-path surfacing (L-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    originalHome = process.env['HOME'];
    tmpHome = join(
      tmpdir(),
      `afk-mint-failed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    process.env['HOME'] = tmpHome;
    // Silence the intentional console.warn emitted by the failed branch.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['HOME'] = originalHome;
  });

  it('records "failed: …" in history and proceeds to build single-lane', async () => {
    const skill = getSkill('mint');
    const mockSession: IAgentSession = {
      sessionId: 'parallelize-failed-session',
      sendMessage: vi.fn(),
      interrupt: vi.fn(),
      close: vi.fn(),
      getInputStreamRef: vi.fn(),
      abortSignal: new AbortController().signal,
    };

    const result = await skill.handler(
      { idea: 'Test feature with failed parallelize', autoApprove: true },
      mockSession,
    );

    expect(result).toBeDefined();
    if (!('state' in result) || !result.state) {
      throw new Error('expected stateful mint result');
    }

    // (1) History entry shape — "failed: …" prefix, not "skipped: …".
    const parallelizeEntries = result.state.history.filter(
      (e) => e.phase === 'parallelize',
    );
    expect(parallelizeEntries.length).toBe(1);
    expect(parallelizeEntries[0].output).toMatch(/^failed: /);
    expect(parallelizeEntries[0].output).not.toMatch(/^skipped: /);

    // (2) Build phase still ran single-lane — buildResults populated, no
    // wave orchestration plan attached.
    expect(result.state.buildResults).toBeDefined();
    expect(result.state.waveOrchestrationPlan).toBeUndefined();
    const buildEntries = result.state.history.filter((e) => e.phase === 'build');
    expect(buildEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('truncates the error string before persistence and telemetry (M-2)', async () => {
    const skill = getSkill('mint');
    const mockSession: IAgentSession = {
      sessionId: 'parallelize-failed-trunc-session',
      sendMessage: vi.fn(),
      interrupt: vi.fn(),
      close: vi.fn(),
      getInputStreamRef: vi.fn(),
      abortSignal: new AbortController().signal,
    };

    await skill.handler(
      { idea: 'Test truncation', autoApprove: true },
      mockSession,
    );

    // The synthetic LONG_ERROR is > 240 chars. After truncation the suffix
    // must be the ellipsis sentinel '…' and total length ≤ 241.
    expect(LONG_ERROR.length).toBeGreaterThan(240);
    expect(appendRoutingDecisionSpy).toHaveBeenCalled();
    const call = appendRoutingDecisionSpy.mock.calls.find(
      ([entry]) => (entry as { event?: string }).event === 'fallback.inline',
    );
    expect(call).toBeDefined();
    const entry = call![0] as { error_message?: string };
    expect(entry.error_message).toBeDefined();
    expect(entry.error_message!.length).toBeLessThanOrEqual(241);
    expect(entry.error_message!.endsWith('…')).toBe(true);
    // The truncated string must not contain the trailing repeated chunk
    // (which appears only after position 240 in LONG_ERROR).
    expect(entry.error_message).not.toMatch(/ipsum lorem ipsum lorem ipsum lorem ipsum lorem$/);
  });
});
