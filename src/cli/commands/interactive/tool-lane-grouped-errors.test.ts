/**
 * Tests for failure visibility on collapsed grouped-sibling rows.
 *
 * A subagent running a burst of the same leaf tool collapses into one row:
 * `$ bash ×50 — 48 ok, 2 errors`. Before this behaviour the row stopped there.
 * The failure text was retained on `ToolEntry.result` but had no render path, so
 * a child looping on one broken command looked exactly like a child making
 * progress — the operator's only clue was a counter that also increments on
 * success.
 *
 * These tests pin the three properties that make the row actionable: the failure
 * message appears, it is the MOST RECENT one (answering "is it still failing?"
 * rather than "did it ever fail"), and it is bounded so it cannot push the row
 * past the terminal clamp.
 */

import { describe, it, expect } from 'vitest';
import { ToolLane } from './tool-lane.js';
import type { ChalkInstance } from 'chalk';
import { displayWidth, stripAnsi } from '../../display.js';
import { palette } from '../../palette.js';
import type { ToolResultChunk } from '../../../agent/types/message-types.js';
import type { ToolFailureClass } from '../../../agent/trace/types.js';

function makeResult(content: string, isError = false): ToolResultChunk {
  return { type: 'tool_result', toolUseId: 'unused', content, isError };
}

/**
 * Build a lane with an Agent parent and `n` bash children, marking the entries
 * at `errorAt` as failures with the supplied messages. GROUP_THRESHOLD_LEAF is 3,
 * so n >= 3 collapses into a single grouped row.
 */
function laneWithBashGroup(n: number, errorAt: Map<number, string>): ToolLane {
  const lane = new ToolLane();
  lane.addStartWithAgentContext('agent', 'Agent', '(pr796-fix)', undefined);
  for (let i = 0; i < n; i++) {
    const id = `b${i}`;
    lane.addStartWithAgentContext(id, 'bash', `("cmd ${i}")`, 'agent');
    // has(), not a truthiness check on get() — an intentionally EMPTY failure
    // message is a case under test, and '' is falsy.
    lane.addResult(
      id,
      errorAt.has(i) ? makeResult(errorAt.get(i)!, true) : makeResult('ok'),
    );
  }
  return lane;
}

function bashRow(lane: ToolLane): string {
  const rows = stripAnsi(lane.getOverlay()).split('\n');
  const row = rows.find((l) => l.includes('bash') && l.includes('×'));
  if (!row) throw new Error(`no grouped bash row in:\n${rows.join('\n')}`);
  return row;
}

/**
 * Render the grouped row with `palette.error` / `palette.warning` swapped for
 * tagged sentinel renderers, so tone is asserted as literal text.
 *
 * Invariant: tone CANNOT be asserted by matching raw ANSI here. Chalk
 * auto-disables color when the test process has no TTY, so every `\u001b[31m`
 * probe silently passes on a row that was never toned at all — a vacuously
 * green assertion. Swapping the palette member (the same mechanism
 * `applyTheme()` uses, mirrored from tool-lane-format.test.ts) is
 * colour-level-independent and therefore actually load-bearing.
 */
function tonedBashRow(lane: ToolLane): string {
  const savedError = palette.error;
  const savedWarning = palette.warning;
  try {
    palette.error = ((...t: unknown[]) => `<ERR>${t.join(' ')}</ERR>`) as ChalkInstance;
    palette.warning = ((...t: unknown[]) => `<WARN>${t.join(' ')}</WARN>`) as ChalkInstance;
    const row = stripAnsi(lane.getOverlay()).split('\n').find((l) => l.includes('×'));
    if (!row) throw new Error('no grouped row');
    return row;
  } finally {
    palette.error = savedError;
    palette.warning = savedWarning;
  }
}

/**
 * Like `laneWithBashGroup`, but each failure carries a `failureClass` so the
 * benign/fault split is exercised. A `cls` of `undefined` models an
 * unclassified failure — the pre-classification default, which must stay red.
 */
function laneWithClassifiedGroup(
  n: number,
  failures: ReadonlyArray<{ at: number; message: string; cls: ToolFailureClass | undefined }>,
): ToolLane {
  const byIndex = new Map(failures.map((f) => [f.at, f]));
  const lane = new ToolLane();
  lane.addStartWithAgentContext('agent', 'Agent', '(gated-run)', undefined);
  for (let i = 0; i < n; i++) {
    const id = `b${i}`;
    lane.addStartWithAgentContext(id, 'bash', `("cmd ${i}")`, 'agent');
    const f = byIndex.get(i);
    lane.addResult(
      id,
      f
        ? {
            type: 'tool_result',
            toolUseId: 'unused',
            content: f.message,
            isError: true,
            ...(f.cls ? { failureClass: f.cls } : {}),
          }
        : makeResult('ok'),
    );
  }
  return lane;
}

describe('grouped sibling rows — failure visibility', () => {
  it('surfaces the failure message alongside the error tally', () => {
    const lane = laneWithBashGroup(5, new Map([[3, 'fatal: not a git repository']]));
    const row = bashRow(lane);
    expect(row).toContain('4 ok');
    expect(row).toContain('1 error');
    expect(row).toContain('fatal: not a git repository');
  });

  it('names the MOST RECENT failure, not the first', () => {
    const lane = laneWithBashGroup(
      6,
      new Map([
        [1, 'first failure: ENOENT'],
        [4, 'latest failure: exit 128'],
      ]),
    );
    const row = bashRow(lane);
    expect(row).toContain('2 errors');
    expect(row).toContain('latest failure: exit 128');
    expect(row).not.toContain('first failure');
  });

  it('bounds the preview so one long stderr cannot blow out the row', () => {
    const long = 'E'.repeat(400);
    const lane = laneWithBashGroup(4, new Map([[2, long]]));
    const row = bashRow(lane);
    // 40-column preview budget plus the row's own prefix/tally scaffolding.
    expect(displayWidth(row)).toBeLessThan(140);
    expect(row).toContain('…');
  });

  it('elides absolute paths inside the failure message', () => {
    const lane = laneWithBashGroup(
      4,
      new Map([[1, 'ENOENT: /Users/griffinlong/Projects/open_source/agent-afk/missing.ts']]),
    );
    const row = bashRow(lane);
    expect(row).toContain('missing.ts');
    expect(row).not.toContain('/Users/griffinlong');
  });

  it('emits no dangling "last:" when the failure carries no message', () => {
    const lane = laneWithBashGroup(4, new Map([[1, '']]));
    const row = bashRow(lane);
    expect(row).toContain('1 error');
    expect(row).not.toContain('last:');
  });

  it('leaves healthy groups untouched — no error tone, no tail', () => {
    const lane = laneWithBashGroup(5, new Map());
    const row = bashRow(lane);
    expect(row).toContain('5 done');
    expect(row).not.toContain('last:');
    expect(row).not.toContain('error');
  });

  it('keeps the raw healthy row byte-identical to the pre-change ANSI shape', () => {
    // The healthy branch must still be a single palette.dim() span. Snapshot
    // suites compare raw bytes, so a split into per-segment dims would be a
    // silent regression even though it looks the same.
    const lane = laneWithBashGroup(4, new Map());
    const raw = lane.getOverlay().split('\n').find((l) => l.includes('×4'))!;
    // One dim-open before the count, and no red anywhere.
    expect(raw).not.toMatch(/\u001b\[31m/);
  });
});

describe('grouped sibling rows — benign refusals tally apart from faults (#75)', () => {
  it('tallies an all-refused group as "blocked" with no red and no "error"', () => {
    // The #75 case: an agent probing a gated tool. Two allowlist rejections in
    // a burst of five must not paint the row red mid-run.
    const lane = laneWithClassifiedGroup(5, [
      { at: 1, message: 'Tool "bash" is not in the configured allowlist', cls: 'permission-denied' },
      { at: 3, message: 'Tool "bash" is not in the configured allowlist', cls: 'permission-denied' },
    ]);
    const row = bashRow(lane);
    expect(row).toContain('3 ok');
    expect(row).toContain('2 blocked');
    expect(row).not.toContain('error');
    expect(tonedBashRow(lane)).not.toContain('<ERR>');
    expect(tonedBashRow(lane)).toContain('<WARN>2 blocked</WARN>');
  });

  it('reports faults and refusals as separate spans when both are present', () => {
    const lane = laneWithClassifiedGroup(5, [
      { at: 1, message: 'fatal: not a git repository', cls: undefined },
      { at: 3, message: 'blocked by hook', cls: 'hook-block' },
    ]);
    const row = bashRow(lane);
    expect(row).toContain('3 ok');
    expect(row).toContain('1 error');
    expect(row).toContain('1 blocked');
    const toned = tonedBashRow(lane);
    expect(toned).toContain('<ERR>1 error</ERR>');
    expect(toned).toContain('<WARN>1 blocked</WARN>');
  });

  it('surfaces the real fault in the tail even when a refusal landed more recently', () => {
    // Recency alone would show the harmless rejection and bury the broken
    // command — the exact failure mode the "last:" tail exists to prevent.
    const lane = laneWithClassifiedGroup(5, [
      { at: 1, message: 'fatal: not a git repository', cls: undefined },
      { at: 4, message: 'denied by permission gate', cls: 'permission-denied' },
    ]);
    const row = bashRow(lane);
    expect(row).toContain('last: fatal: not a git repository');
    expect(row).not.toContain('denied by permission gate');
  });

  it('still shows a refusal in the tail when there is no real fault to outrank it', () => {
    const lane = laneWithClassifiedGroup(4, [
      { at: 2, message: 'denied by permission gate', cls: 'permission-denied' },
    ]);
    const row = bashRow(lane);
    expect(row).toContain('last: denied by permission gate');
    expect(tonedBashRow(lane)).not.toContain('<ERR>');
  });

  it('keeps an unclassified failure red — absence of a class is not benign', () => {
    const lane = laneWithClassifiedGroup(4, [
      { at: 2, message: 'boom', cls: undefined },
    ]);
    expect(bashRow(lane)).toContain('1 error');
    const toned = tonedBashRow(lane);
    expect(toned).toContain('<ERR>1 error</ERR>');
    expect(toned).not.toContain('<WARN>');
  });
});
