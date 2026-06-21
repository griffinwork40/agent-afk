import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  formatTerminalStateForTelegram,
  pushTerminalStateToTelegram,
  doneHasCorroboratingEvidence,
  resetAfkPushBudget,
  afkPushCount,
  MAX_PUSHES_PER_SESSION,
} from './afk-push.js';
import type { TerminalState } from './terminal-state.js';
import type { ToolEvent } from '../../slash/types.js';

function done(extra: Partial<TerminalState> = {}): TerminalState {
  return { kind: 'done', rawBody: '', ...extra };
}

let toolSeq = 0;
function tool(toolName: string, isError?: boolean): ToolEvent {
  toolSeq += 1;
  return { toolName, toolUseId: `tu-${toolSeq}`, input: '', ...(isError !== undefined && { isError }) };
}

describe('formatTerminalStateForTelegram', () => {
  it('renders a kind label header for each terminal state', () => {
    expect(formatTerminalStateForTelegram(done())).toContain('AFK');
    expect(formatTerminalStateForTelegram(done()).toLowerCase()).toContain('done');
    expect(
      formatTerminalStateForTelegram({ kind: 'blocked', rawBody: '' }).toLowerCase(),
    ).toContain('blocked');
    expect(
      formatTerminalStateForTelegram({ kind: 'asking', rawBody: '' }).toLowerCase(),
    ).toContain('asking');
  });

  it('includes the structured fields for the state kind', () => {
    const msg = formatTerminalStateForTelegram(
      done({ whatWasDone: 'migrated the field', evidence: 'src/x.ts:10', deferred: 'phase 2' }),
    );
    expect(msg).toContain('migrated the field');
    expect(msg).toContain('src/x.ts:10');
    expect(msg).toContain('phase 2');
  });

  it('is an allowlist by construction — only fields for THIS kind appear', () => {
    // A done verdict that also (nonsensically) carries blocked/asking fields:
    // the formatter must ignore the off-kind fields entirely.
    const msg = formatTerminalStateForTelegram(
      done({
        whatWasDone: 'the real summary',
        whatBlocks: 'SHOULD-NOT-APPEAR-blocked',
        question: 'SHOULD-NOT-APPEAR-question',
      }),
    );
    expect(msg).toContain('the real summary');
    expect(msg).not.toContain('SHOULD-NOT-APPEAR');
  });

  it('scrubs secrets that leaked into a structured field', () => {
    const msg = formatTerminalStateForTelegram(
      done({ whatWasDone: 'set key sk-ant-abcdefgh12345678 in config' }),
    );
    expect(msg).not.toContain('sk-ant-abcdefgh12345678');
    expect(msg).toContain('REDACTED');
  });

  it('falls back to rawBody only when no structured field is present', () => {
    expect(formatTerminalStateForTelegram(done({ rawBody: 'fallback body text' }))).toContain(
      'fallback body text',
    );
  });
});

describe('pushTerminalStateToTelegram — rate limiting', () => {
  beforeEach(() => resetAfkPushBudget());

  it('calls the push impl with the formatted message', async () => {
    const push = vi.fn().mockResolvedValue(null);
    await pushTerminalStateToTelegram(done({ whatWasDone: 'hello' }), push);
    expect(push).toHaveBeenCalledTimes(1);
    expect(String(push.mock.calls[0]?.[0])).toContain('hello');
    expect(afkPushCount()).toBe(1);
  });

  it('stops pushing after the per-session cap and sends exactly one mute notice', async () => {
    const push = vi.fn().mockResolvedValue(null);
    // Exhaust the budget.
    for (let i = 0; i < MAX_PUSHES_PER_SESSION; i++) {
      await pushTerminalStateToTelegram(done({ whatWasDone: `turn ${i}` }), push);
    }
    expect(push).toHaveBeenCalledTimes(MAX_PUSHES_PER_SESSION);

    // Next call: a single "muted" notice, not the verdict.
    await pushTerminalStateToTelegram(done({ whatWasDone: 'over budget' }), push);
    expect(push).toHaveBeenCalledTimes(MAX_PUSHES_PER_SESSION + 1);
    expect(String(push.mock.calls[MAX_PUSHES_PER_SESSION]?.[0]).toLowerCase()).toContain('muted');

    // Further calls: silent (no more pushes).
    await pushTerminalStateToTelegram(done({ whatWasDone: 'still over' }), push);
    expect(push).toHaveBeenCalledTimes(MAX_PUSHES_PER_SESSION + 1);
  });

  it('resetAfkPushBudget restores a fresh budget', async () => {
    const push = vi.fn().mockResolvedValue(null);
    for (let i = 0; i < MAX_PUSHES_PER_SESSION; i++) {
      await pushTerminalStateToTelegram(done(), push);
    }
    resetAfkPushBudget();
    expect(afkPushCount()).toBe(0);
    await pushTerminalStateToTelegram(done({ whatWasDone: 'fresh' }), push);
    expect(afkPushCount()).toBe(1);
  });

  it('is best-effort — a throwing push impl never propagates', async () => {
    const push = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(
      pushTerminalStateToTelegram(done({ whatWasDone: 'x' }), push),
    ).resolves.toBeUndefined();
  });

  it('forwards the unverified flag to the formatter', async () => {
    const push = vi.fn().mockResolvedValue(null);
    await pushTerminalStateToTelegram(done({ whatWasDone: 'maybe' }), push, { unverified: true });
    expect(String(push.mock.calls[0]?.[0]).toLowerCase()).toContain('unverified');
  });
});

describe('doneHasCorroboratingEvidence', () => {
  it('is false for no tool events', () => {
    expect(doneHasCorroboratingEvidence([])).toBe(false);
  });

  it('is false when the turn only read (read_file/grep/glob/list_directory)', () => {
    expect(
      doneHasCorroboratingEvidence([tool('read_file'), tool('grep'), tool('glob'), tool('list_directory')]),
    ).toBe(false);
  });

  it('is true for a successful write_file / edit_file / bash', () => {
    expect(doneHasCorroboratingEvidence([tool('write_file')])).toBe(true);
    expect(doneHasCorroboratingEvidence([tool('edit_file')])).toBe(true);
    expect(doneHasCorroboratingEvidence([tool('bash')])).toBe(true);
  });

  it('treats isError:false and omitted isError as success', () => {
    expect(doneHasCorroboratingEvidence([tool('write_file', false)])).toBe(true);
    expect(doneHasCorroboratingEvidence([tool('bash')])).toBe(true);
  });

  it('does NOT count a failed corroborating tool call', () => {
    expect(doneHasCorroboratingEvidence([tool('write_file', true)])).toBe(false);
    expect(doneHasCorroboratingEvidence([tool('bash', true)])).toBe(false);
  });

  it('is true when at least one corroborating call succeeded amid failures/reads', () => {
    expect(
      doneHasCorroboratingEvidence([tool('read_file'), tool('bash', true), tool('write_file')]),
    ).toBe(true);
  });
});

describe('formatTerminalStateForTelegram — verification downgrade', () => {
  it('downgrades a done verdict to "unverified" when opts.unverified is true', () => {
    const msg = formatTerminalStateForTelegram(done({ whatWasDone: 'shipped' }), { unverified: true });
    expect(msg.toLowerCase()).toContain('unverified');
    // The structured field still appears — downgrade annotates, never hides.
    expect(msg).toContain('shipped');
    // A caveat line explains the downgrade.
    expect(msg.toLowerCase()).toContain('no file write');
  });

  it('keeps the standard done label when unverified is false or absent', () => {
    expect(formatTerminalStateForTelegram(done()).toLowerCase()).not.toContain('unverified');
    expect(
      formatTerminalStateForTelegram(done(), { unverified: false }).toLowerCase(),
    ).not.toContain('unverified');
  });

  it('only downgrades the done kind — blocked/asking are never relabelled', () => {
    expect(
      formatTerminalStateForTelegram({ kind: 'blocked', rawBody: 'x' }, { unverified: true }).toLowerCase(),
    ).not.toContain('unverified');
    expect(
      formatTerminalStateForTelegram({ kind: 'asking', rawBody: 'x' }, { unverified: true }).toLowerCase(),
    ).not.toContain('unverified');
  });
});
