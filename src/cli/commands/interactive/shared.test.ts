/**
 * Tests for `printResumeBanner` — the full conversation replay printed after
 * a session resume.
 *
 * Coverage targets:
 *   - Empty turns array → silent no-op (legacy sidecars)
 *   - Single turn → header + User/Assistant blocks + footer
 *   - Multiple turns → all turns rendered, all present in output
 *   - Header and footer lines are present
 *   - Content is routed through writer.fn, not stdout directly
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { printResumeBanner, resolveResumeCwd, formatStatusFields } from './shared.js';
import { recordQuotaSnapshot, resetQuotaCacheForTests } from '../../../agent/quota-cache.js';
import type { SessionStats, TurnRecord } from '../../slash/types.js';
import type { CompletionWriter } from './shared.js';

function makeStats(turns: TurnRecord[]): SessionStats {
  return {
    totalTurns: turns.length,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: 0,
    turnCosts: [],
    turnTokens: [],
    turns,
    model: 'sonnet',
    permissionMode: 'default',
  };
}

function makeWriter(): { writer: CompletionWriter; lines: string[] } {
  const lines: string[] = [];
  return {
    writer: { fn: (line: string) => lines.push(line) },
    lines,
  };
}

// Strip ANSI styling so assertions can match on the underlying text without
// caring about palette.dim's escape codes. Same regex shape the helper uses
// internally to sanitize tool output.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

describe('printResumeBanner', () => {
  it('is a silent no-op when turns is empty', () => {
    const { writer, lines } = makeWriter();
    printResumeBanner(makeStats([]), writer);
    expect(lines).toEqual([]);
  });

  it('emits a header and footer framing the replay', () => {
    const { writer, lines } = makeWriter();
    const turn: TurnRecord = {
      user: 'fix the auth bug',
      assistant: 'I patched the token check.',
      timestamp: 0,
    };
    printResumeBanner(makeStats([turn]), writer);

    const text = lines.map((l) => stripAnsi(l)).join('\n');
    expect(text).toContain('Resuming session');
    expect(text).toContain('End of history');
  });

  it('emits user and assistant content inside the replay', () => {
    const { writer, lines } = makeWriter();
    const turn: TurnRecord = {
      user: 'fix the auth bug',
      assistant: 'I patched the token check.',
      timestamp: 0,
    };
    printResumeBanner(makeStats([turn]), writer);

    const text = lines.map((l) => stripAnsi(l)).join('\n');
    expect(text).toContain('fix the auth bug');
    expect(text).toContain('I patched the token check.');
  });

  it('includes all turns when multiple are present', () => {
    const { writer, lines } = makeWriter();
    const turns: TurnRecord[] = [
      { user: 'first ask', assistant: 'first reply', timestamp: 0 },
      { user: 'second ask', assistant: 'second reply', timestamp: 1 },
      { user: 'third ask', assistant: 'third reply', timestamp: 2 },
    ];
    printResumeBanner(makeStats(turns), writer);

    const text = lines.map((l) => stripAnsi(l)).join('\n');
    expect(text).toContain('first ask');
    expect(text).toContain('second ask');
    expect(text).toContain('third ask');
  });

  it('includes the turn count in the header', () => {
    const { writer, lines } = makeWriter();
    const turns: TurnRecord[] = [
      { user: 'a', assistant: 'b', timestamp: 0 },
      { user: 'c', assistant: 'd', timestamp: 1 },
    ];
    printResumeBanner(makeStats(turns), writer);

    const text = lines.map((l) => stripAnsi(l)).join('\n');
    expect(text).toContain('2 turns');
  });

  it('routes all output through writer.fn, not console.log', () => {
    // All lines must arrive through the mock writer — if any go to console,
    // lines would be empty while output was printed elsewhere.
    const { writer, lines } = makeWriter();
    printResumeBanner(makeStats([{ user: 'x', assistant: 'y', timestamp: 0 }]), writer);
    expect(lines.length).toBeGreaterThan(0);
  });
});

/**
 * Tests for `resolveResumeCwd` — the precedence helper that lets a resumed
 * interactive session run in the directory it was saved in (the fork/resume
 * cwd-restore fix), without clobbering an explicit `--worktree` override.
 *
 * Precedence under test:
 *   (a) stored cwd that EXISTS on disk is used
 *   (b) stored cwd that does NOT exist falls back (returns undefined)
 *   (c) an explicit extras.cwd (--worktree) always wins over stored cwd
 */
describe('resolveResumeCwd — resume cwd precedence', () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it('uses the stored cwd when it still exists on disk', () => {
    tmp = mkdtempSync(join(tmpdir(), 'afk-resume-cwd-'));
    // No --worktree override → fall back to the (existing) stored cwd.
    expect(resolveResumeCwd(undefined, tmp)).toBe(tmp);
  });

  it('falls back (undefined) when the stored cwd exists but is a regular file, not a directory', () => {
    tmp = mkdtempSync(join(tmpdir(), 'afk-resume-cwd-'));
    const file = join(tmp, 'not-a-dir');
    writeFileSync(file, 'x');
    expect(resolveResumeCwd(undefined, file)).toBeUndefined();
  });

  it('falls back (undefined) when the stored cwd no longer exists', () => {
    // A cleaned-up worktree: the stored path is gone. The helper returns
    // undefined so the caller degrades to process.cwd().
    const gone = join(tmpdir(), `afk-resume-cwd-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    expect(resolveResumeCwd(undefined, gone)).toBeUndefined();
  });

  it('lets an explicit extras.cwd (--worktree) win over the stored cwd', () => {
    tmp = mkdtempSync(join(tmpdir(), 'afk-resume-cwd-'));
    // Even though the stored cwd exists, the explicit override takes priority
    // and is returned WITHOUT an existsSync check.
    expect(resolveResumeCwd('/explicit/worktree', tmp)).toBe('/explicit/worktree');
  });

  it('returns undefined when neither an override nor a stored cwd is present', () => {
    expect(resolveResumeCwd(undefined, undefined)).toBeUndefined();
  });

  it('returns the explicit override even when there is no stored cwd', () => {
    expect(resolveResumeCwd('/explicit/worktree', undefined)).toBe('/explicit/worktree');
  });
});

describe('formatStatusFields — subscription-quota segment', () => {
  beforeEach(() => {
    resetQuotaCacheForTests();
  });
  afterEach(() => {
    resetQuotaCacheForTests();
  });

  it('omits the quota field entirely when no headers have been observed', () => {
    // Permanent state under API-key auth — must be absent, not a placeholder.
    const fields = formatStatusFields(makeStats([]));
    expect('quotaWindows' in fields).toBe(false);
  });

  it('forwards both windows as raw 0..1 fractions, not pre-formatted text', () => {
    // The adapter must NOT format: `quota-indicator.ts` owns tone, countdown and
    // staleness so the status line can grade droppability from the same severity
    // it renders with.
    recordQuotaSnapshot({
      fiveHourUtilization: 0.62,
      sevenDayUtilization: 0.31,
      observedAt: new Date(),
    });
    const windows = formatStatusFields(makeStats([])).quotaWindows;
    expect(windows?.fiveHour?.utilization).toBe(0.62);
    expect(windows?.sevenDay?.utilization).toBe(0.31);
  });

  it('forwards the reset deadlines and the observation time verbatim', () => {
    // Regression guard: these three fields were parsed by the cache but read by
    // nothing for the segment's whole first life. The countdown and the stale
    // marker both depend on them surviving the hand-off.
    const fiveHourResetsAt = new Date('2026-07-29T17:00:00Z');
    const sevenDayResetsAt = new Date('2026-08-02T09:00:00Z');
    const observedAt = new Date('2026-07-29T12:00:00Z');
    recordQuotaSnapshot({
      fiveHourUtilization: 0.62,
      fiveHourResetsAt,
      sevenDayUtilization: 0.31,
      sevenDayResetsAt,
      observedAt,
    });
    const windows = formatStatusFields(makeStats([])).quotaWindows;
    expect(windows?.fiveHour?.resetsAt).toBe(fiveHourResetsAt);
    expect(windows?.sevenDay?.resetsAt).toBe(sevenDayResetsAt);
    expect(windows?.observedAt).toBe(observedAt);
  });

  it('carries only the 5h window when the 7d window is absent', () => {
    recordQuotaSnapshot({ fiveHourUtilization: 0.05, observedAt: new Date() });
    const windows = formatStatusFields(makeStats([])).quotaWindows;
    expect(windows?.fiveHour?.utilization).toBe(0.05);
    expect(windows?.sevenDay).toBeUndefined();
  });

  it('carries only the 7d window when the 5h window is absent', () => {
    recordQuotaSnapshot({ sevenDayUtilization: 0.5, observedAt: new Date() });
    const windows = formatStatusFields(makeStats([])).quotaWindows;
    expect(windows?.sevenDay?.utilization).toBe(0.5);
    expect(windows?.fiveHour).toBeUndefined();
  });
});

describe('formatStatusFields — turn indicator', () => {
  afterEach(() => {
    resetQuotaCacheForTests();
  });

  function makeTurnStats(totalTurns: number): SessionStats {
    return makeStats(Array.from({ length: totalTurns }, (_, i) => ({
      role: 'user' as const,
      content: `msg ${i}`,
    }) as unknown as TurnRecord));
  }

  it('omits turnCount when totalTurns is 0 (before any turn completes)', () => {
    const fields = formatStatusFields(makeTurnStats(0));
    expect(fields.turnCount).toBeUndefined();
    expect(fields.maxTurns).toBeUndefined();
  });

  it('includes turnCount equal to totalTurns when at least one turn completed', () => {
    const fields = formatStatusFields(makeTurnStats(3));
    expect(fields.turnCount).toBe(3);
  });

  it('omits maxTurns when the cap argument is 0 (unconstrained session)', () => {
    const fields = formatStatusFields(makeTurnStats(2), undefined, undefined, 0);
    expect(fields.maxTurns).toBeUndefined();
  });

  it('omits maxTurns when the cap argument is undefined', () => {
    const fields = formatStatusFields(makeTurnStats(2));
    expect(fields.maxTurns).toBeUndefined();
  });

  it('includes maxTurns when a positive cap is supplied', () => {
    const fields = formatStatusFields(makeTurnStats(2), undefined, undefined, 10);
    expect(fields.maxTurns).toBe(10);
  });

  it('does not include maxTurns when turnCount is absent (totalTurns === 0)', () => {
    // Even if a cap is supplied, omitting the turn field is the right call before
    // any turn completes — rendering `turn 0/10` would be confusing.
    const fields = formatStatusFields(makeTurnStats(0), undefined, undefined, 10);
    expect(fields.turnCount).toBeUndefined();
    expect(fields.maxTurns).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formatStatusFields — token budget indicator
// ---------------------------------------------------------------------------

describe('formatStatusFields — token budget indicator', () => {
  afterEach(() => {
    resetQuotaCacheForTests();
  });

  function makeCostStats(totalCostUsd: number): SessionStats {
    return {
      totalTurns: 1,
      totalCostUsd,
      totalTokens: 0,
      totalDurationMs: 0,
      sessionStartTime: 0,
      turnCosts: [],
      turnTokens: [],
      turns: [],
      model: 'sonnet',
      permissionMode: 'default',
    };
  }

  it('includes budgetUsd equal to totalCostUsd', () => {
    const fields = formatStatusFields(makeCostStats(1.42));
    expect(fields.budgetUsd).toBe(1.42);
  });

  it('includes budgetUsd of 0 when cost is 0', () => {
    const fields = formatStatusFields(makeCostStats(0));
    expect(fields.budgetUsd).toBe(0);
  });

  it('omits maxBudgetUsd when not supplied', () => {
    const fields = formatStatusFields(makeCostStats(1.0));
    expect(fields.maxBudgetUsd).toBeUndefined();
  });

  it('omits maxBudgetUsd when supplied as 0 (unconstrained)', () => {
    const fields = formatStatusFields(makeCostStats(1.0), undefined, undefined, undefined, undefined, 0);
    expect(fields.maxBudgetUsd).toBeUndefined();
  });

  it('includes maxBudgetUsd when a positive cap is supplied', () => {
    const fields = formatStatusFields(makeCostStats(2.50), undefined, undefined, undefined, undefined, 10);
    expect(fields.budgetUsd).toBe(2.50);
    expect(fields.maxBudgetUsd).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// formatStatusFields — active agent fan-out count
// ---------------------------------------------------------------------------

describe('formatStatusFields — active agent fan-out count', () => {
  afterEach(() => {
    resetQuotaCacheForTests();
  });

  function makeBasicStats(): SessionStats {
    return {
      totalTurns: 0,
      totalCostUsd: 0,
      totalTokens: 0,
      totalDurationMs: 0,
      sessionStartTime: 0,
      turnCosts: [],
      turnTokens: [],
      turns: [],
      model: 'sonnet',
      permissionMode: 'default',
    };
  }

  it('omits activeAgentCount when no registry is supplied', () => {
    const fields = formatStatusFields(makeBasicStats());
    expect(fields.activeAgentCount).toBeUndefined();
  });

  it('omits activeAgentCount when registry has no running jobs', () => {
    // BackgroundAgentRegistry with no active jobs — list() returns empty array
    // We use a simple mock object satisfying the list() interface contract
    const mockRegistry = {
      list: () => [],
    } as unknown as import('../../../../src/agent/background-registry.js').BackgroundAgentRegistry;
    const fields = formatStatusFields(makeBasicStats(), undefined, undefined, undefined, mockRegistry);
    expect(fields.activeAgentCount).toBeUndefined();
  });

  it('omits activeAgentCount when all registry jobs are terminated (not running)', () => {
    // Registry has jobs but all are completed/failed — running count is 0, field suppressed
    const mockRegistry = {
      list: () => [
        { status: 'completed' as const, jobId: 'bg-1', provenance: 'user' as const, subagentId: 'sa-1', label: 'done1', model: 'sonnet', startedAt: Date.now() },
        { status: 'failed' as const, jobId: 'bg-2', provenance: 'user' as const, subagentId: 'sa-2', label: 'done2', model: 'sonnet', startedAt: Date.now() },
      ],
    } as unknown as import('../../../../src/agent/background-registry.js').BackgroundAgentRegistry;
    const fields = formatStatusFields(makeBasicStats(), undefined, undefined, undefined, mockRegistry);
    expect(fields.activeAgentCount).toBeUndefined();
  });

  it('includes activeAgentCount equal to the running job count', () => {
    const mockRegistry = {
      list: () => [
        { status: 'running' as const, jobId: 'bg-1', provenance: 'user' as const, subagentId: 'sa-1', label: 'test', model: 'sonnet', startedAt: Date.now() },
        { status: 'running' as const, jobId: 'bg-2', provenance: 'user' as const, subagentId: 'sa-2', label: 'test2', model: 'sonnet', startedAt: Date.now() },
        { status: 'completed' as const, jobId: 'bg-3', provenance: 'user' as const, subagentId: 'sa-3', label: 'done', model: 'sonnet', startedAt: Date.now() },
      ],
    } as unknown as import('../../../../src/agent/background-registry.js').BackgroundAgentRegistry;
    const fields = formatStatusFields(makeBasicStats(), undefined, undefined, undefined, mockRegistry);
    expect(fields.activeAgentCount).toBe(2);
  });
});
