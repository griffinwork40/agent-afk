/**
 * Tests for the /stats slash command.
 *
 * Covers: (1) no ledger → info message, (2) empty ledger → "no runs" message,
 * (3) populated ledger → expected output lines including inconclusive claims.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SlashContext, SessionStats } from '../types.js';
import { statsCmd } from './stats.ts';
import { TrustedSkillLedger } from '../../trusted-skill-ledger.js';

function makeStats(): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    permissionMode: 'default',
  };
}

function makeCtx(ledger?: TrustedSkillLedger | undefined): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: { current: {} } as unknown as SlashContext['session'],
    stats: makeStats(),
    out: {
      line: (t = ''): void => { lines.push(t); },
      raw: (t): void => { lines.push(t); },
      success: (t): void => { lines.push(`SUCCESS:${t}`); },
      info: (t): void => { lines.push(`INFO:${t}`); },
      warn: (t): void => { lines.push(`WARN:${t}`); },
      error: (t): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
    ledger,
  };
  return { ctx, lines };
}

describe('/stats slash command', () => {
  it('no ledger (undefined) → emits info message and returns continue', async () => {
    const { ctx, lines } = makeCtx(undefined);
    const result = await statsCmd.handler(ctx);
    expect(result).toBe('continue');
    expect(lines).toContain('INFO:No skill stats available.');
  });

  it('ledger present but empty → emits "no runs" message and returns continue', async () => {
    const ledger = new TrustedSkillLedger();
    const { ctx, lines } = makeCtx(ledger);
    const result = await statsCmd.handler(ctx);
    expect(result).toBe('continue');
    expect(lines.some((l) => l.includes('No skill runs recorded'))).toBe(true);
  });

  it('populated ledger → outputs skill name, runs, duration', async () => {
    const ledger = new TrustedSkillLedger();
    ledger.record({ skillName: 'shadow-verify', durationMs: 2400, claimsTotal: 3, claimsConfirmed: 2, claimsRefuted: 1 });
    const { ctx, lines } = makeCtx(ledger);
    const result = await statsCmd.handler(ctx);
    expect(result).toBe('continue');
    const body = lines.join('\n');
    expect(body).toContain('shadow-verify');
    expect(body).toContain('1 run');
    expect(body).toContain('2.4s total');
    expect(body).toContain('3 claims');
    expect(body).toContain('2 confirmed');
    expect(body).toContain('1 refuted');
  });

  it('populated ledger with inconclusive claims → inconclusive appears in output', async () => {
    const ledger = new TrustedSkillLedger();
    ledger.record({
      skillName: 'premise-gate',
      durationMs: 1500,
      claimsTotal: 4,
      claimsConfirmed: 2,
      claimsRefuted: 1,
      claimsInconclusive: 1,
    });
    const { ctx, lines } = makeCtx(ledger);
    await statsCmd.handler(ctx);
    const body = lines.join('\n');
    expect(body).toContain('1 inconclusive');
  });

  it('multiple runs → aggregated totals in output', async () => {
    const ledger = new TrustedSkillLedger();
    ledger.record({ skillName: 'shadow-verify', durationMs: 1000 });
    ledger.record({ skillName: 'shadow-verify', durationMs: 2000 });
    const { ctx, lines } = makeCtx(ledger);
    await statsCmd.handler(ctx);
    const body = lines.join('\n');
    expect(body).toContain('2 runs');
    expect(body).toContain('3.0s total');
  });
});
