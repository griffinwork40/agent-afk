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
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { SlashContext, SessionStats } from '../types.js';
import type { PickerController, TerminalCompositor } from '../../terminal-compositor.js';
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
// /config fast-paths (view / set / unknown-arg / non-TTY fallback)
// ---------------------------------------------------------------------------

describe('/config fast-paths', () => {
  const configCmd = configDoctorCommands.find((c) => c.name === '/config')!;

  it('/config view renders the read-only dump', async () => {
    const { ctx, lines } = makeCtx();
    const result = await configCmd.handler(ctx, 'view');
    expect(result).toBe('continue');
    expect(lines.join('\n')).toMatch(/model|provider/i);
  });

  it('/config set with no value warns about usage', async () => {
    const { ctx, lines } = makeCtx();
    await configCmd.handler(ctx, 'set');
    expect(lines.join('\n')).toMatch(/WARN:.*Usage/i);
  });

  it('/config set <unknown-key> errors and writes nothing', async () => {
    const { ctx, lines } = makeCtx();
    await configCmd.handler(ctx, 'set definitely_not_a_key 1');
    expect(lines.join('\n')).toMatch(/ERROR:.*[Uu]nknown/);
  });

  it('/config set <human-tier> refuses (points to the menu/CLI, no write)', async () => {
    const { ctx, lines } = makeCtx();
    await configCmd.handler(ctx, 'set permissionMode plan');
    expect(lines.join('\n')).toMatch(/WARN:.*human-tier/i);
  });

  it('unknown argument warns and still shows the dump', async () => {
    const { ctx, lines } = makeCtx();
    await configCmd.handler(ctx, 'wat');
    const body = lines.join('\n');
    expect(body).toMatch(/WARN:.*Unknown argument/i);
    expect(body).toMatch(/model|provider/i);
  });

  it('falls back to the read-only view when no compositor is available (non-TTY)', async () => {
    const { ctx, lines } = makeCtx();
    // makeCtx() supplies no getCompositor → the interactive branch must fall back.
    const result = await configCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(lines.join('\n')).toContain('ANTHROPIC_API_KEY');
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

// ---------------------------------------------------------------------------
// /config interactive menu — malformed-config resilience
// ---------------------------------------------------------------------------

/** Minimal picker host: captures the controller so a test can drive keys. */
class FakeHost {
  controller: PickerController | null = null;
  enterPickerMode(controller: PickerController): void {
    this.controller = controller;
  }
  exitPickerMode(): void {
    this.controller = null;
  }
  repaintPicker(): void {}
  press(name: string): void {
    if (!this.controller) throw new Error('FakeHost: no controller installed');
    this.controller.onKey(undefined, { name, ctrl: false, shift: false });
  }
}

describe('/config interactive menu — malformed config', () => {
  const configCmd = configDoctorCommands.find((c) => c.name === '/config')!;
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalAfkHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env['HOME'];
    originalAfkHome = process.env['AFK_HOME'];
    // AFK_HOME (if set in the runner env) would win over HOME — clear it so the
    // config path resolves under our temp HOME.
    delete process.env['AFK_HOME'];
    tmpHome = join(tmpdir(), `afk-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env['HOME'] = tmpHome;
    const cfgDir = join(tmpHome, '.afk', 'config');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'afk.config.json'), '{ this is : not valid json', 'utf-8');
  });

  afterEach(() => {
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['HOME'] = originalHome;
    else delete process.env['HOME'];
    if (originalAfkHome !== undefined) process.env['AFK_HOME'] = originalAfkHome;
  });

  it('degrades to the read-only view (no throw) when afk.config.json is malformed', async () => {
    const { ctx, lines } = makeCtx();
    const host = new FakeHost();
    ctx.getCompositor = (): TerminalCompositor => host as unknown as TerminalCompositor;

    const p = configCmd.handler(ctx, '');
    // The category picker renders without reading config; selecting a category
    // triggers key-row rendering → getConfigValue throws MalformedConfigError.
    host.press('return');
    const result = await p;

    expect(result).toBe('continue');
    const body = lines.join('\n');
    expect(body).toMatch(/ERROR:.*settings menu/i);
    // Read-only dump fallback still renders.
    expect(body).toContain('ANTHROPIC_API_KEY');
  });
});
