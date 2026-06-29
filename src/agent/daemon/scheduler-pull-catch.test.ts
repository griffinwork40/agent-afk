/**
 * Tests for the pullTick outer-catch path in CronScheduler (issue #253).
 *
 * Lives in its own file because vi.mock('./queue-store.js') is hoisted to
 * module scope, replacing queue-store for the entire module graph of this
 * file.  Isolating avoids contaminating scheduler-pull.test.ts which uses the
 * real queue-store with real disk I/O.
 *
 * Covered branch (issue #253 — branch 4, optional):
 *   pullTick outer-catch: when dequeueNext throws, the error is logged but
 *   the poll loop survives (isDequeuing is reset, no unhandled rejection).
 *
 * @module agent/daemon/scheduler-pull-catch.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentConfig } from '../types.js';
import type { AgentSession } from '../session/agent-session.js';

// ---------------------------------------------------------------------------
// Mock strategy:
//
//   `dequeueNext` is mocked at module scope so CronScheduler (which imports
//   it from './queue-store.js') picks up the fake. Each test can override the
//   mock implementation via `vi.mocked(dequeueNext).mockImplementation(...)`.
//
//   We also spy on console.error to verify the pull-tick-failed log fires
//   without hard-asserting its exact wording (a sibling issue is changing the
//   exact log text).
// ---------------------------------------------------------------------------

vi.mock('./queue-store.js', () => ({
  dequeueNext: vi.fn(),
  enqueue: vi.fn(),
  listPending: vi.fn().mockReturnValue([]),
}));

// Import AFTER vi.mock is registered (vitest hoists vi.mock above imports).
import { CronScheduler } from './scheduler.js';
import { dequeueNext } from './queue-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockSession(response = 'ok'): AgentSession {
  return {
    sendMessage: vi.fn().mockResolvedValue({ content: response }),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentSession;
}

function makeScheduler(
  queueDir: string,
  telemetryPath: string,
  sessionFactory?: (config: AgentConfig) => AgentSession,
): CronScheduler {
  return new CronScheduler({
    queueDir,
    telemetryPath,
    pullPollIntervalMs: 30_000,
    sessionFactory: sessionFactory ?? (() => makeMockSession()),
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let queueDir: string;
let telemetryDir: string;
let telemetryPath: string;
let homeDir: string | undefined;
let savedAfkHome: string | undefined;
let savedAllowProjectMcp: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  queueDir = mkdtempSync(join(tmpdir(), 'afk-pull-catch-test-queue-'));
  telemetryDir = mkdtempSync(join(tmpdir(), 'afk-pull-catch-test-tel-'));
  telemetryPath = join(telemetryDir, 'forge-telemetry.jsonl');
  homeDir = mkdtempSync(join(tmpdir(), 'afk-pull-catch-test-home-'));
  savedAfkHome = process.env['AFK_HOME'];
  savedAllowProjectMcp = process.env['AFK_ALLOW_PROJECT_MCP'];
  process.env['AFK_HOME'] = homeDir;
  process.env['AFK_ALLOW_PROJECT_MCP'] = '0';

  vi.mocked(dequeueNext).mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  rmSync(queueDir, { recursive: true, force: true });
  rmSync(telemetryDir, { recursive: true, force: true });
  if (savedAfkHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = savedAfkHome;
  if (savedAllowProjectMcp === undefined) delete process.env['AFK_ALLOW_PROJECT_MCP'];
  else process.env['AFK_ALLOW_PROJECT_MCP'] = savedAllowProjectMcp;
  if (homeDir !== undefined) rmSync(homeDir, { recursive: true, force: true });
  homeDir = undefined;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pullTick — outer-catch branch (branch 4: dequeueNext throws)', () => {
  it('logs the error but does NOT crash or rethrow when dequeueNext throws', async () => {
    // Arm: dequeueNext throws an unexpected error that escapes quarantinePoisonEntry.
    vi.mocked(dequeueNext).mockImplementation(() => {
      throw new Error('unexpected dequeue failure');
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const scheduler = makeScheduler(queueDir, telemetryPath);
    scheduler.startPullLoop();

    // Advance past one poll interval — pullTick fires and hits the outer catch.
    await vi.advanceTimersByTimeAsync(30_000);

    // The scheduler is still alive — stop() resolves cleanly (no unhandled rejection).
    await expect(scheduler.stop()).resolves.toBeUndefined();

    // console.error was called (the pull-tick-failed log fired).
    // We assert it was called at least once rather than on exact wording,
    // because issue #250 is changing the log text.
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('resets isDequeuing after a pullTick catch so the next tick can proceed', async () => {
    // First call throws; second call succeeds and returns null (empty queue).
    let callCount = 0;
    vi.mocked(dequeueNext).mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('transient failure');
      return null; // second tick: empty queue, do nothing
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const scheduler = makeScheduler(queueDir, telemetryPath);
    scheduler.startPullLoop();

    // First tick — throws, outer catch fires, isDequeuing reset.
    await vi.advanceTimersByTimeAsync(30_000);
    // Second tick — dequeueNext called again (proves isDequeuing was reset).
    await vi.advanceTimersByTimeAsync(30_000);

    expect(callCount).toBe(2);

    await scheduler.stop();
    consoleSpy.mockRestore();
  });
});
