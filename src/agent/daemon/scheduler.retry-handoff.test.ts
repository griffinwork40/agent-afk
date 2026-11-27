/**
 * Regression tests for Spec 1: handoff + retry interaction.
 *
 * Verifies:
 *   - A retry attempt that wrote a durable handoff on attempt N does NOT
 *     suppress the failure notification when attempt N+1 also fails (without
 *     elicitation). The `wroteHandoff` flag is reset per attempt.
 *   - A successful final attempt that wrote a handoff suppresses only the
 *     completion notification (not failure).
 *   - A failed final attempt that wrote a handoff on that same attempt does
 *     NOT suppress the failure notification.
 *
 * Uses the CronScheduler sessionFactory seam + elicitationRouter directly.
 *
 * @module agent/daemon/scheduler.retry-handoff.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mocks (must come before any imports that transitively load these)
// ---------------------------------------------------------------------------

vi.mock('node-cron', () => ({
  schedule: vi.fn(() => ({ start: () => {}, stop: () => {}, destroy: () => {}, getStatus: () => 'stopped' })),
}));

vi.mock('../providers/index.js', () => ({
  resolveProvider: () => { throw new Error('not used in retry-handoff tests'); },
  providerForModel: () => 'anthropic-direct',
}));

vi.mock('../default-hook-registry.js', () => ({
  createDefaultHookRegistry: () => ({ registry: undefined, memoryStore: { close: () => {} } }),
}));

vi.mock('../operator-notify.js', () => ({ operatorNotify: vi.fn().mockResolvedValue(null) }));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { CronScheduler, type TelemetryRecord } from './scheduler.js';
import { elicitationRouter } from '../elicitation-router.js';
import type { AgentSession } from '../session/agent-session.js';
import type { ScheduledTask } from './triggers.js';

type Factory = NonNullable<ConstructorParameters<typeof CronScheduler>[0]>['sessionFactory'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

/** Capture the per-session elicitation key installed by runAgentAttempt. */
function interceptInstallForSession(): {
  getKey: () => string | undefined;
  restore: () => void;
} {
  let key: string | undefined;
  const orig = elicitationRouter.installForSession.bind(elicitationRouter);
  elicitationRouter.installForSession = (k, h) => { key = k; orig(k, h); };
  return {
    getKey: () => key,
    restore: () => { elicitationRouter.installForSession = orig; key = undefined; },
  };
}

/** Build a session that triggers elicitation then resolves/rejects. */
function makeElicitSession(
  getKey: () => string | undefined,
  outcome: 'success' | Error,
): AgentSession {
  return {
    sendMessage: async (_cmd: string) => {
      const ac = new AbortController();
      const sessionKey = getKey();
      await elicitationRouter.route(
        { serverName: 'agent', origin: 'agent', message: 'Should I continue?', type: 'confirm' },
        { signal: ac.signal, ...(sessionKey !== undefined ? { sessionKey } : {}) },
      );
      if (outcome instanceof Error) throw outcome;
      return { role: 'assistant' as const, content: 'done', timestamp: new Date() };
    },
    close: async () => {},
    sessionId: 'retry-elicit-session',
    cwd: '/tmp',
  } as unknown as AgentSession;
}

function makeSessionNoElicit(outcome: 'success' | Error): AgentSession {
  return {
    sendMessage: async (_cmd: string) => {
      if (outcome instanceof Error) throw outcome;
      return { role: 'assistant' as const, content: 'done', timestamp: new Date() };
    },
    close: async () => {},
  } as unknown as AgentSession;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

describe('Spec 1: handoff + retry notification suppression', () => {
  let dir: string;
  let telemetryPath: string;
  let handoffsDir: string;
  let savedAfkHome: string | undefined;
  let savedProjectMcp: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-retry-handoff-'));
    telemetryPath = join(dir, 'forge-telemetry.jsonl');
    handoffsDir = join(dir, 'handoffs');
    savedAfkHome = process.env['AFK_HOME'];
    savedProjectMcp = process.env['AFK_ALLOW_PROJECT_MCP'];
    process.env['AFK_HOME'] = dir;
    process.env['AFK_ALLOW_PROJECT_MCP'] = '0';
  });

  afterEach(() => {
    if (savedAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = savedAfkHome;
    if (savedProjectMcp === undefined) delete process.env['AFK_ALLOW_PROJECT_MCP'];
    else process.env['AFK_ALLOW_PROJECT_MCP'] = savedProjectMcp;
    rmSync(dir, { recursive: true, force: true });
  });

  function baseTask(extra: Partial<ScheduledTask> = {}): ScheduledTask {
    return {
      taskId: 'rh-task',
      command: '/cmd',
      trigger: 'cron',
      cronExpression: '* * * * *',
      notifyOn: 'always',
      ...extra,
    };
  }

  // ---------------------------------------------------------------------------
  // Test 1: attempt 1 elicits + fails (transient) → retry resets wroteHandoff →
  //         attempt 2 succeeds WITHOUT eliciting → notificationDecision unset
  //         (completion notification fires normally)
  // ---------------------------------------------------------------------------
  it('wroteHandoff resets on retry: elicit+fail on attempt1, clean success on attempt2 → no suppression', async () => {
    const intercept = interceptInstallForSession();
    let attemptN = 0;

    // Attempt 1: elicits (writes handoff) then throws transient error
    // Attempt 2: succeeds cleanly (no elicitation)
    const factory: Factory = (() => {
      attemptN += 1;
      if (attemptN === 1) return makeElicitSession(intercept.getKey, httpError(429));
      return makeSessionNoElicit('success');
    }) as Factory;

    const s = new CronScheduler({
      telemetryPath,
      handoffsDir,
      budgetGate: async () => ({ skip: false }),
      sessionFactory: factory,
      retrySleep: async () => {},
    });
    s.register(baseTask({ maxAttempts: 2, retryDelayMs: 1000 }));

    let rec: TelemetryRecord;
    try {
      rec = await s.tick('rh-task');
    } finally {
      await s.stop();
      intercept.restore();
    }

    expect(rec!.status).toBe('success');
    expect(rec!.attempts).toBe(2);
    // attempt 2 did NOT write a handoff, so notificationDecision must be absent
    // → completion notification fires normally (not suppressed by stale handoff state)
    expect(rec!.notificationDecision).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Test 2: attempt 1 elicits + fails → attempt 2 also elicits + succeeds →
  //         notificationDecision is suppressed (completion suppressed by handoff)
  // ---------------------------------------------------------------------------
  it('wroteHandoff on the final successful attempt suppresses completion', async () => {
    const intercept = interceptInstallForSession();
    let attemptN = 0;

    const factory: Factory = (() => {
      attemptN += 1;
      if (attemptN === 1) return makeElicitSession(intercept.getKey, httpError(503));
      // attempt 2: elicits then succeeds
      return makeElicitSession(intercept.getKey, 'success');
    }) as Factory;

    const s = new CronScheduler({
      telemetryPath,
      handoffsDir,
      budgetGate: async () => ({ skip: false }),
      sessionFactory: factory,
      retrySleep: async () => {},
    });
    s.register(baseTask({ maxAttempts: 2, retryDelayMs: 1000 }));

    let rec: TelemetryRecord;
    try {
      rec = await s.tick('rh-task');
    } finally {
      await s.stop();
      intercept.restore();
    }

    expect(rec!.status).toBe('success');
    expect(rec!.attempts).toBe(2);
    // Final attempt wrote a handoff and succeeded → completion suppressed
    expect(rec!.notificationDecision?.state).toBe('suppressed');
    expect(rec!.notificationDecision?.kind).toBe('completion');
    expect(rec!.notificationDecision?.reason).toBe('handoff-pending');
  });

  // ---------------------------------------------------------------------------
  // Test 3: single attempt that elicits + fails → failure notification NOT
  //         suppressed (Spec 1: failures must always notify)
  // ---------------------------------------------------------------------------
  it('wroteHandoff on a failed final attempt does NOT suppress failure notification', async () => {
    const intercept = interceptInstallForSession();

    const factory: Factory = (() => makeElicitSession(intercept.getKey, new Error('task crashed'))) as Factory;

    const s = new CronScheduler({
      telemetryPath,
      handoffsDir,
      budgetGate: async () => ({ skip: false }),
      sessionFactory: factory,
    });
    s.register(baseTask());

    let rec: TelemetryRecord;
    try {
      rec = await s.tick('rh-task');
    } finally {
      await s.stop();
      intercept.restore();
    }

    expect(rec!.status).toBe('error');
    // Failure after elicitation — notification must NOT be suppressed
    expect(rec!.notificationDecision).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Test 4: wroteHandoff reset between attempts — both attempts write handoffs
  //         but final attempt fails → still no suppression (failure path)
  // ---------------------------------------------------------------------------
  it('wroteHandoff reset ensures only the final attempt state drives the decision', async () => {
    const intercept = interceptInstallForSession();
    let attemptN = 0;

    const factory: Factory = (() => {
      attemptN += 1;
      // Both attempts elicit; attempt 2 fails non-transient (no retry)
      if (attemptN === 1) return makeElicitSession(intercept.getKey, httpError(429));
      return makeElicitSession(intercept.getKey, new Error('final failure'));
    }) as Factory;

    const s = new CronScheduler({
      telemetryPath,
      handoffsDir,
      budgetGate: async () => ({ skip: false }),
      sessionFactory: factory,
      retrySleep: async () => {},
    });
    // maxAttempts=2, attempt 2 throws non-transient → no further retry
    s.register(baseTask({ maxAttempts: 2, retryDelayMs: 1000 }));

    let rec: TelemetryRecord;
    try {
      rec = await s.tick('rh-task');
    } finally {
      await s.stop();
      intercept.restore();
    }

    // Non-transient error on attempt 2 → status=error, attempts=1 (no retry)
    expect(rec!.status).toBe('error');
    // Failure path: no suppression regardless of wroteHandoff
    expect(rec!.notificationDecision).toBeUndefined();
  });
});
