/**
 * Tests for /config and /doctor slash commands.
 *
 * Covers:
 *  - Both commands are registered via registerAll()
 *  - handler returns 'continue' (never 'exit', never throws)
 *  - some output is written to the captured writer
 *  - /doctor handler does not call process.exit()
 *
 * Health-check I/O (API calls, fs access) is NOT mocked here — the test
 * verifies the slash surface wiring only. Individual check functions are
 * tested in unit coverage of doctor-checks.ts if desired.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SlashContext, SessionStats } from '../types.js';
import { configDoctorCommands } from './config-doctor.ts';
import { registerAll } from '../index.js';
import { resetRegistry, lookup } from '../registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeCtx(): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: { current: {} } as unknown as SlashContext['session'],
    stats: makeStats(),
    out: {
      line: (t = ''): void => { lines.push(`LINE:${t}`); },
      raw: (t): void => { lines.push(`RAW:${t}`); },
      success: (t): void => { lines.push(`SUCCESS:${t}`); },
      info: (t): void => { lines.push(`INFO:${t}`); },
      warn: (t): void => { lines.push(`WARN:${t}`); },
      error: (t): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  };
  return { ctx, lines };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registerAll() includes /config and /doctor', () => {
  beforeEach(() => {
    resetRegistry();
    registerAll();
  });
  afterEach(() => {
    resetRegistry();
  });

  it('/config is registered', () => {
    const cmd = lookup('/config');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('/config');
  });

  it('/doctor is registered', () => {
    const cmd = lookup('/doctor');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('/doctor');
  });
});

// ---------------------------------------------------------------------------
// /config handler
// ---------------------------------------------------------------------------

describe('/config slash command', () => {
  const configCmd = configDoctorCommands.find((c) => c.name === '/config')!;

  it('returns "continue"', async () => {
    const { ctx } = makeCtx();
    const result = await configCmd.handler(ctx, '');
    expect(result).toBe('continue');
  });

  it('writes output lines to ctx.out (non-empty)', async () => {
    const { ctx, lines } = makeCtx();
    await configCmd.handler(ctx, '');
    expect(lines.length).toBeGreaterThan(0);
  });

  it('output contains "model" or "provider" label text', async () => {
    const { ctx, lines } = makeCtx();
    await configCmd.handler(ctx, '');
    const body = lines.join('\n');
    expect(body).toMatch(/model|provider/i);
  });

  it('output contains env var names', async () => {
    const { ctx, lines } = makeCtx();
    await configCmd.handler(ctx, '');
    const body = lines.join('\n');
    expect(body).toContain('ANTHROPIC_API_KEY');
  });

  it('does not call process.exit()', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    try {
      const { ctx } = makeCtx();
      await expect(configCmd.handler(ctx, '')).resolves.toBe('continue');
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('has a non-empty summary and hint', () => {
    expect(configCmd.summary.length).toBeGreaterThan(0);
    expect(configCmd.hint).toBeDefined();
    expect(configCmd.hint!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// /doctor handler
// ---------------------------------------------------------------------------

describe('/doctor slash command', () => {
  const doctorCmd = configDoctorCommands.find((c) => c.name === '/doctor')!;

  it('returns "continue"', async () => {
    const { ctx } = makeCtx();
    const result = await doctorCmd.handler(ctx, '');
    expect(result).toBe('continue');
  });

  it('writes output lines to ctx.out (non-empty)', async () => {
    const { ctx, lines } = makeCtx();
    await doctorCmd.handler(ctx, '');
    expect(lines.length).toBeGreaterThan(0);
  });

  it('output contains "passed" summary text', async () => {
    const { ctx, lines } = makeCtx();
    await doctorCmd.handler(ctx, '');
    const body = lines.join('\n');
    expect(body).toMatch(/passed/i);
  });

  it('does not call process.exit()', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    try {
      const { ctx } = makeCtx();
      await expect(doctorCmd.handler(ctx, '')).resolves.toBe('continue');
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('has a non-empty summary and hint', () => {
    expect(doctorCmd.summary.length).toBeGreaterThan(0);
    expect(doctorCmd.hint).toBeDefined();
    expect(doctorCmd.hint!.length).toBeGreaterThan(0);
  });
});
