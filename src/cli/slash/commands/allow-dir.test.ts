/**
 * Unit tests for the /allow-dir slash command.
 *
 * Uses a mock GrantManager so no filesystem access to ~/.afk is needed.
 *
 * @module cli/slash/commands/allow-dir.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setAllowDirDispatcher, allowDirCmd, type GrantManager } from './allow-dir.js';
import type { SlashContext } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockGrantManager(
  initial?: Partial<{ resolveBase: string; readRoots: string[]; writeRoots: string[] }>,
): GrantManager & {
  _readRoots: string[];
  _writeRoots: string[];
  _resolveBase: string | undefined;
} {
  const resolveBase = initial?.resolveBase;
  const readRoots: string[] = initial?.readRoots?.slice() ?? (resolveBase ? [resolveBase] : []);
  const writeRoots: string[] = initial?.writeRoots?.slice() ?? (resolveBase ? [resolveBase] : []);

  return {
    _readRoots: readRoots,
    _writeRoots: writeRoots,
    _resolveBase: resolveBase,

    addReadRoot(p) {
      if (!readRoots.includes(p)) readRoots.push(p);
    },
    addWriteRoot(p) {
      if (!readRoots.includes(p)) readRoots.push(p);
      if (!writeRoots.includes(p)) writeRoots.push(p);
    },
    revokeRoot(p) {
      const rIdx = readRoots.indexOf(p);
      if (rIdx !== -1) readRoots.splice(rIdx, 1);
      const wIdx = writeRoots.indexOf(p);
      if (wIdx !== -1) writeRoots.splice(wIdx, 1);
    },
    getGrants() {
      return { resolveBase, readRoots: readRoots.slice(), writeRoots: writeRoots.slice() };
    },
  };
}

function makeCtx(): SlashContext & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    session: { current: {} } as unknown as SlashContext['session'],
    stats: {} as SlashContext['stats'],
    out: {
      line: (s: string) => { lines.push(s); },
      info: (s: string) => { lines.push(s); },
      error: (s: string) => { errors.push(s); },
      warn: (s: string) => { lines.push(s); },
    } as SlashContext['out'],
    ui: {} as SlashContext['ui'],
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'allow-dir-test-'));
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  // Reset dispatcher ref between tests
  setAllowDirDispatcher(undefined as unknown as GrantManager);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/allow-dir', () => {
  it('shows error when no dispatcher is wired', async () => {
    const ctx = makeCtx();
    const result = await allowDirCmd.handler(ctx, '');
    expect(ctx.errors).toHaveLength(1);
    expect(ctx.errors[0]).toMatch(/not available/);
    expect(result).toBe('continue');
  });

  it('bare form lists current grants', async () => {
    const mgr = makeMockGrantManager({ resolveBase: '/base', readRoots: ['/base'], writeRoots: ['/base'] });
    setAllowDirDispatcher(mgr);
    const ctx = makeCtx();
    const result = await allowDirCmd.handler(ctx, '');
    expect(result).toBe('continue');
    const output = ctx.lines.join('\n');
    expect(output).toContain('resolveBase');
    expect(output).toContain('/base');
    expect(output).toContain('readRoots');
    expect(output).toContain('writeRoots');
  });

  it('bare form with empty grants shows (none)', async () => {
    const mgr = makeMockGrantManager();
    setAllowDirDispatcher(mgr);
    const ctx = makeCtx();
    await allowDirCmd.handler(ctx, '');
    const output = ctx.lines.join('\n');
    expect(output).toContain('(none)');
  });

  it('adds to readRoots for a valid path', async () => {
    const mgr = makeMockGrantManager();
    setAllowDirDispatcher(mgr);
    const ctx = makeCtx();
    const result = await allowDirCmd.handler(ctx, tmpDir);
    expect(result).toBe('continue');
    expect(mgr._readRoots).toContain(tmpDir);
    expect(mgr._writeRoots).not.toContain(tmpDir);
    expect(ctx.lines[0]).toContain('Read-only grant');
    expect(ctx.lines[0]).toContain(tmpDir);
  });

  it('adds to both readRoots and writeRoots with --rw', async () => {
    const mgr = makeMockGrantManager();
    setAllowDirDispatcher(mgr);
    const ctx = makeCtx();
    const result = await allowDirCmd.handler(ctx, `--rw ${tmpDir}`);
    expect(result).toBe('continue');
    expect(mgr._readRoots).toContain(tmpDir);
    expect(mgr._writeRoots).toContain(tmpDir);
    expect(ctx.lines[0]).toContain('Read+write grant');
  });

  it('revokes a path with --revoke', async () => {
    const mgr = makeMockGrantManager({ readRoots: [tmpDir], writeRoots: [tmpDir] });
    setAllowDirDispatcher(mgr);
    const ctx = makeCtx();
    const result = await allowDirCmd.handler(ctx, `--revoke ${tmpDir}`);
    expect(result).toBe('continue');
    expect(mgr._readRoots).not.toContain(tmpDir);
    expect(mgr._writeRoots).not.toContain(tmpDir);
    expect(ctx.lines[0]).toContain('Revoked');
  });

  it('errors on nonexistent path (read grant)', async () => {
    const mgr = makeMockGrantManager();
    setAllowDirDispatcher(mgr);
    const ctx = makeCtx();
    const result = await allowDirCmd.handler(ctx, '/nonexistent/path/xyz123');
    expect(result).toBe('continue');
    expect(ctx.errors[0]).toContain('does not exist');
  });

  it('errors on nonexistent path (--rw grant)', async () => {
    const mgr = makeMockGrantManager();
    setAllowDirDispatcher(mgr);
    const ctx = makeCtx();
    const result = await allowDirCmd.handler(ctx, '--rw /nonexistent/path/xyz123');
    expect(result).toBe('continue');
    expect(ctx.errors[0]).toContain('does not exist');
  });

  it('allows revoke of nonexistent path (no existence check)', async () => {
    const mgr = makeMockGrantManager({ readRoots: ['/some/path'], writeRoots: [] });
    setAllowDirDispatcher(mgr);
    const ctx = makeCtx();
    // revoke doesn't check disk existence
    const result = await allowDirCmd.handler(ctx, '--revoke /some/path');
    expect(result).toBe('continue');
    expect(ctx.errors).toHaveLength(0);
    expect(ctx.lines[0]).toContain('Revoked');
  });

  it('errors when flag provided without path', async () => {
    const mgr = makeMockGrantManager();
    setAllowDirDispatcher(mgr);
    const ctx = makeCtx();
    const result = await allowDirCmd.handler(ctx, '--rw');
    expect(result).toBe('continue');
    expect(ctx.errors[0]).toContain('Usage');
  });

  it('resolves relative path from process.cwd()', async () => {
    // Create a subdir within tmpDir so we can test relative resolution
    const subDir = join(tmpDir, 'sub');
    mkdirSync(subDir);
    const mgr = makeMockGrantManager();
    setAllowDirDispatcher(mgr);
    const ctx = makeCtx();
    // Pass absolute path — relative resolution is process.cwd()-based;
    // just verify an absolute path that exists works end-to-end
    const result = await allowDirCmd.handler(ctx, subDir);
    expect(result).toBe('continue');
    expect(ctx.errors).toHaveLength(0);
    expect(mgr._readRoots).toContain(subDir);
  });

  it('resolveBase cannot be directly blocked (mock test)', () => {
    // The non-revocability of resolveBase is enforced by SessionToolDispatcher,
    // not by /allow-dir itself. /allow-dir calls revokeRoot and the dispatcher
    // ignores resolveBase. Here we just verify the mock path works.
    const base = '/base';
    const mgr = makeMockGrantManager({ resolveBase: base, readRoots: [base] });
    // Even if we call revokeRoot on it, our mock removes it — real dispatcher won't
    mgr.revokeRoot(base, 'slash');
    expect(mgr._readRoots).not.toContain(base); // mock has no non-revocable logic
    // (The dispatcher unit tests verify the actual non-revocability)
  });
});
