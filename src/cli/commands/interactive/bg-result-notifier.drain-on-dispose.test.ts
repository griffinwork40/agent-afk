/**
 * Scenario 1 (tracking #3714): "Test background-result delivery when the
 * parent turn ends before the buffer drains."
 *
 * Covers the BgResultNotifier.dispose() path where one or more background
 * jobs have settled (injections buffered) but the parent session ends before
 * drainInjections() is ever called.
 *
 * Missing coverage confirmed: the existing bg-result-notifier.test.ts only
 * exercises dispose() to verify that post-dispose settles do not buffer — it
 * does not test the case where dispose() fires WHILE injections are pending.
 *
 * Invariants under test (src/cli/commands/interactive/bg-result-notifier.ts):
 *   1. dispose() writes a stderr notice naming each undrained jobId.
 *   2. dispose() does NOT call registry.markDelivered (jobs were never
 *      delivered, so the witness trace must not lie and claim they were).
 *   3. After dispose(), drainInjections() and drainNotifications() both return
 *      empty (buffers cleared, no double-deliver possible).
 *   4. The undrained job remains joinable via the registry (the result is not
 *      lost, only uninjected into the model context).
 *   5. Multiple undrained jobs — each jobId appears in the stderr notice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackgroundAgentRegistry } from '../../../agent/background-registry.js';
import type { SubagentHandle, SubagentResult } from '../../../agent/subagent.js';
import { BgResultNotifier } from './bg-result-notifier.js';

// Silence routing-telemetry writes emitted by BackgroundAgentRegistry on settle.
vi.mock('../../../agent/routing-telemetry.js', () => ({
  appendRoutingDecision: vi.fn(async () => {}),
}));

/** Stub a SubagentHandle whose runInBackground terminal callback we control. */
function makeBgHandle(id = 'sub-1'): {
  handle: SubagentHandle;
  fireTerminal: (r: SubagentResult) => void;
} {
  let captured: ((r: SubagentResult) => void) | undefined;
  return {
    handle: {
      id,
      status: 'idle',
      runInBackground: vi.fn((_p: string, on?: (r: SubagentResult) => void) => {
        captured = on;
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
      run: vi.fn(),
      runToResult: vi.fn(),
    } as unknown as SubagentHandle,
    fireTerminal: (r) => captured?.(r),
  };
}

function succeed(id: string, content: string): SubagentResult {
  return {
    id,
    status: 'succeeded',
    message: { content, role: 'assistant' } as unknown as SubagentResult['message'],
  } as SubagentResult;
}

describe('BgResultNotifier — dispose() with pending injections (turn-ends-before-drain)', () => {
  let registry: BackgroundAgentRegistry;
  let notifier: BgResultNotifier;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let markDeliveredSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env['AFK_BG_AUTO_DELIVER'];
    registry = new BackgroundAgentRegistry({});
    notifier = new BgResultNotifier(registry);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    markDeliveredSpy = vi.spyOn(registry, 'markDelivered');
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    markDeliveredSpy.mockRestore();
    delete process.env['AFK_BG_AUTO_DELIVER'];
  });

  // ── Invariant 1: stderr notice names the undrained job ────────────────────

  it('dispose() writes a stderr notice when an injection is pending but undrainied', () => {
    const { handle, fireTerminal } = makeBgHandle('sub-drain-1');
    const job = registry.register({ handle, prompt: 'find the bug', model: 'sonnet' });
    fireTerminal(succeed('sub-drain-1', 'Root cause identified.'));

    // Sanity: the injection is buffered — the turn has NOT drained yet.
    expect(notifier.hasPendingInjections()).toBe(true);

    // Parent turn ends → dispose() is called before drainInjections().
    notifier.dispose();

    const combined = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(combined).toMatch(/background job/i);
    expect(combined).toContain(job.jobId);
    expect(combined).toMatch(/never delivered/i);
    expect(combined).toMatch(/bgsub:join/);
  });

  // ── Invariant 2: markDelivered is NOT called (witness trace must not lie) ──

  it('dispose() does NOT call registry.markDelivered for undrained jobs', () => {
    const { handle, fireTerminal } = makeBgHandle('sub-drain-2');
    registry.register({ handle, prompt: 'audit codebase', model: 'haiku' });
    fireTerminal(succeed('sub-drain-2', 'Audit complete.'));

    notifier.dispose();

    expect(markDeliveredSpy).not.toHaveBeenCalled();
  });

  // ── Invariant 3: buffers are cleared after dispose() ────────────────────

  it('drainInjections() returns empty string after dispose() (no double-deliver)', () => {
    const { handle, fireTerminal } = makeBgHandle('sub-drain-3');
    registry.register({ handle, prompt: 'scan deps', model: 'sonnet' });
    fireTerminal(succeed('sub-drain-3', 'No CVEs found.'));

    notifier.dispose();

    expect(notifier.drainInjections()).toBe('');
    expect(notifier.drainNotifications()).toHaveLength(0);
    expect(notifier.hasPendingInjections()).toBe(false);
  });

  // ── Invariant 4: the result is still in the registry (not lost) ──────────

  it('the settled result remains joinable in the registry after dispose()', async () => {
    const { handle, fireTerminal } = makeBgHandle('sub-drain-4');
    const job = registry.register({ handle, prompt: 'background research', model: 'sonnet' });
    fireTerminal(succeed('sub-drain-4', 'Findings: all clear.'));

    notifier.dispose();

    // The job is still terminal and joinable — the result was not lost.
    const settled = registry.get(job.jobId);
    expect(settled).toBeDefined();
    expect(settled?.status).toBe('completed');

    const result = await registry.join(job.jobId);
    expect(result.status).toBe('succeeded');
  });

  // ── Invariant 5: multiple undrained jobs — all jobIds appear in the notice ─

  it('dispose() names every pending jobId in the stderr notice', () => {
    const a = makeBgHandle('sub-drain-5a');
    const b = makeBgHandle('sub-drain-5b');
    const jobA = registry.register({ handle: a.handle, prompt: 'task A', model: 'sonnet' });
    const jobB = registry.register({ handle: b.handle, prompt: 'task B', model: 'haiku' });
    a.fireTerminal(succeed('sub-drain-5a', 'A done'));
    b.fireTerminal(succeed('sub-drain-5b', 'B done'));

    expect(notifier.hasPendingInjections()).toBe(true);
    notifier.dispose();

    const combined = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(combined).toContain(jobA.jobId);
    expect(combined).toContain(jobB.jobId);
    // The count mentioned in the notice should reflect both jobs.
    expect(combined).toMatch(/2 background job/i);
  });

  // ── Edge: dispose() with NO pending injections is silent ─────────────────

  it('dispose() does not write to stderr when the buffer is empty', () => {
    // Nothing registered or settled — buffer is clean.
    notifier.dispose();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  // ── Edge: dispose() after drainInjections() is also silent ───────────────

  it('dispose() is silent when injections were already drained before session end', () => {
    const { handle, fireTerminal } = makeBgHandle('sub-drain-6');
    registry.register({ handle, prompt: 'already drained', model: 'sonnet' });
    fireTerminal(succeed('sub-drain-6', 'delivered'));

    // Normal path: the turn drains before the session ends.
    notifier.drainInjections();
    expect(notifier.hasPendingInjections()).toBe(false);

    notifier.dispose();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
