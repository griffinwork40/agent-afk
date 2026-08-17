/**
 * Tests for the first-run welcome banner (Part 2 of tui-skill-discovery).
 *
 * Covers:
 *   - isFirstRun() returns true when the marker file is absent
 *   - isFirstRun() returns false when the marker file exists
 *   - markFirstRunSeen() creates the marker file
 *   - printFirstRunBanner() prints on first run (TTY, no resume)
 *   - printFirstRunBanner() skips on non-TTY
 *   - printFirstRunBanner() skips on resume sessions
 *   - printFirstRunBanner() skips when marker already exists (not first run)
 *   - printFirstRunBanner() marks as seen after printing (no repeat)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// We test the module after overriding AFK_HOME so marker paths land under a
// tmp dir we control. The module is re-imported fresh per test via vi.resetModules.
// ---------------------------------------------------------------------------

describe('first-run banner', () => {
  let tmpDir: string;
  let origConsoleLog: typeof console.log;
  let logged: string[];

  beforeEach(() => {
    // Isolated tmp dir per test — avoids cross-test marker file pollution.
    tmpDir = path.join(os.tmpdir(), `afk-first-run-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });

    // Override AFK_HOME so getReplHistoryPath / getFirstRunMarkerPath land here.
    vi.stubEnv('AFK_HOME', tmpDir);
    vi.resetModules();

    // Capture console.log calls.
    logged = [];
    origConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.log = origConsoleLog;
    vi.unstubAllEnvs();
    vi.resetModules();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // --------------------------------------------------------------------------
  // isFirstRun()
  // --------------------------------------------------------------------------

  it('isFirstRun() returns true when the marker is absent', async () => {
    const { isFirstRun } = await import('./first-run.js');
    expect(isFirstRun()).toBe(true);
  });

  it('isFirstRun() returns false when the marker exists', async () => {
    const { isFirstRun, markFirstRunSeen } = await import('./first-run.js');
    markFirstRunSeen();
    expect(isFirstRun()).toBe(false);
  });

  // --------------------------------------------------------------------------
  // markFirstRunSeen()
  // --------------------------------------------------------------------------

  it('markFirstRunSeen() creates the marker file', async () => {
    const { markFirstRunSeen } = await import('./first-run.js');
    markFirstRunSeen();

    // Resolve the marker path through the same helper to pin the contract.
    const { getFirstRunMarkerPath } = await import('../../../paths.js');
    expect(existsSync(getFirstRunMarkerPath())).toBe(true);
  });

  it('markFirstRunSeen() is idempotent (calling twice does not throw)', async () => {
    const { markFirstRunSeen } = await import('./first-run.js');
    expect(() => {
      markFirstRunSeen();
      markFirstRunSeen();
    }).not.toThrow();
  });

  // --------------------------------------------------------------------------
  // printFirstRunBanner()
  // --------------------------------------------------------------------------

  it('prints on first run in a TTY non-resume session', async () => {
    const { printFirstRunBanner } = await import('./first-run.js');
    const printed = printFirstRunBanner({ isTTY: true, isResume: false });

    expect(printed).toBe(true);
    expect(logged.join(' ')).toContain('/skills');
    expect(logged.join(' ')).toContain('/help');
  });

  it('skips when not a TTY', async () => {
    const { printFirstRunBanner } = await import('./first-run.js');
    const printed = printFirstRunBanner({ isTTY: false, isResume: false });

    expect(printed).toBe(false);
    expect(logged).toHaveLength(0);
  });

  it('skips when resuming a session', async () => {
    const { printFirstRunBanner } = await import('./first-run.js');
    const printed = printFirstRunBanner({ isTTY: true, isResume: true });

    expect(printed).toBe(false);
    expect(logged).toHaveLength(0);
  });

  it('skips (returns false) when the marker already exists', async () => {
    const { printFirstRunBanner, markFirstRunSeen } = await import('./first-run.js');
    // Pre-write the marker to simulate a returning user.
    markFirstRunSeen();
    logged = [];

    const printed = printFirstRunBanner({ isTTY: true, isResume: false });

    expect(printed).toBe(false);
    expect(logged).toHaveLength(0);
  });

  it('marks as seen after printing — second call does not print again', async () => {
    const { printFirstRunBanner } = await import('./first-run.js');

    const first = printFirstRunBanner({ isTTY: true, isResume: false });
    logged = [];

    const second = printFirstRunBanner({ isTTY: true, isResume: false });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(logged).toHaveLength(0);
  });

  it('banner text contains Welcome mention', async () => {
    const { printFirstRunBanner } = await import('./first-run.js');
    printFirstRunBanner({ isTTY: true, isResume: false });

    expect(logged.join(' ').toLowerCase()).toContain('welcome');
  });
});
