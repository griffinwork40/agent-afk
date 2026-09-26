/**
 * Tests for the growth-guard added to `updateBaseline` in `scripts/lib/size-ratchet.ts`.
 *
 * Acceptance criteria from issue #2207:
 *   - Growing a baselined entry without `--allow-growth` → blocked, no file write.
 *   - A new entry over the ceiling without `--allow-growth` → blocked, no file write.
 *   - `allowGrowth` without a non-empty `reason` → throws synchronously.
 *   - `allowGrowth` + non-empty `reason` → writes; new entries stamp the reason,
 *     grown entries retain their existing hand-written reason.
 *   - Shrinks are always unrestricted (no `blocked` events, file is written).
 *   - Removals (key drops below ceiling) are always unrestricted.
 *   - Bootstrap case (no baseline FILE — file absent) → always writes without --allow-growth.
 *   - Empty baseline FILE (file exists, entries={}) → NOT a bootstrap; --allow-growth required.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadBaseline,
  serializeBaseline,
  updateBaseline,
  type RatchetConfig,
} from '../scripts/lib/size-ratchet.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-ratchet-guard-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(name = 'baseline.json'): RatchetConfig {
  return {
    limit: 100,
    baselinePath: path.join(tmpDir, name),
    baselineRel: name,
    unit: 'line',
    entryPlural: 'functions',
    legacyReason: 'legacy',
  };
}

function writeBaseline(cfg: RatchetConfig, entries: Record<string, { loc: number; reason: string }>): void {
  const baseline = {
    limit: cfg.limit,
    entries: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v])),
  };
  fs.writeFileSync(cfg.baselinePath, serializeBaseline(baseline), 'utf8');
}

// ---------------------------------------------------------------------------
// Growth blocked without flag
// ---------------------------------------------------------------------------

describe('updateBaseline — growth guard', () => {
  it('blocks when a baselined entry grew, returns blocked events, does not write', () => {
    const cfg = makeConfig();
    writeBaseline(cfg, { 'src/a.ts::fn': { loc: 120, reason: 'old reason' } });
    const mtime = fs.statSync(cfg.baselinePath).mtimeMs;

    const sizes = new Map([['src/a.ts::fn', 130]]);
    const result = updateBaseline(cfg, sizes);

    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]).toMatchObject({ key: 'src/a.ts::fn', oldLoc: 120, newLoc: 130 });
    expect(result.kept).toBe(0);
    // File must not be written.
    expect(fs.statSync(cfg.baselinePath).mtimeMs).toBe(mtime);
  });

  it('blocks when a new entry appears over the ceiling, returns blocked events, does not write', () => {
    const cfg = makeConfig();
    // Existing baseline has a different key; new key 'src/b.ts::fn' is fresh.
    writeBaseline(cfg, { 'src/a.ts::fn': { loc: 110, reason: 'existing' } });
    const mtime = fs.statSync(cfg.baselinePath).mtimeMs;

    const sizes = new Map([
      ['src/a.ts::fn', 110], // unchanged
      ['src/b.ts::fn', 150], // new entry over ceiling
    ]);
    const result = updateBaseline(cfg, sizes);

    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]).toMatchObject({ key: 'src/b.ts::fn', oldLoc: null, newLoc: 150 });
    expect(fs.statSync(cfg.baselinePath).mtimeMs).toBe(mtime);
  });

  it('returns multiple blocked events when several entries grew', () => {
    const cfg = makeConfig();
    writeBaseline(cfg, {
      'src/a.ts::fn': { loc: 110, reason: 'r1' },
      'src/b.ts::fn': { loc: 120, reason: 'r2' },
    });

    const sizes = new Map([
      ['src/a.ts::fn', 115],
      ['src/b.ts::fn', 125],
    ]);
    const result = updateBaseline(cfg, sizes);

    expect(result.blocked).toHaveLength(2);
    expect(result.blocked.map((e) => e.key).sort()).toEqual(['src/a.ts::fn', 'src/b.ts::fn']);
  });
});

// ---------------------------------------------------------------------------
// allowGrowth without reason → error
// ---------------------------------------------------------------------------

describe('updateBaseline — allowGrowth validation', () => {
  it('throws synchronously when allowGrowth is true but reason is empty string', () => {
    const cfg = makeConfig();
    writeBaseline(cfg, { 'src/a.ts::fn': { loc: 110, reason: 'old' } });

    expect(() => updateBaseline(cfg, new Map([['src/a.ts::fn', 120]]), { allowGrowth: true, reason: '' })).toThrow(
      /allowGrowth requires a non-empty reason/,
    );
  });

  it('throws when allowGrowth is true but reason is omitted', () => {
    const cfg = makeConfig();
    writeBaseline(cfg, { 'src/a.ts::fn': { loc: 110, reason: 'old' } });

    expect(() => updateBaseline(cfg, new Map([['src/a.ts::fn', 120]]), { allowGrowth: true })).toThrow(
      /allowGrowth requires a non-empty reason/,
    );
  });
});

// ---------------------------------------------------------------------------
// allowGrowth + reason → writes, stamps reason
// ---------------------------------------------------------------------------

describe('updateBaseline — allowGrowth writes correctly', () => {
  it('writes when allowGrowth + reason are supplied; grown entry PRESERVES the existing reason', () => {
    const cfg = makeConfig();
    writeBaseline(cfg, { 'src/a.ts::fn': { loc: 120, reason: 'old reason' } });

    const sizes = new Map([['src/a.ts::fn', 130]]);
    const result = updateBaseline(cfg, sizes, { allowGrowth: true, reason: 'intentional: merged complex path' });

    expect(result.blocked).toHaveLength(0);
    expect(result.kept).toBe(1);

    const written = loadBaseline(cfg);
    // Grown entries preserve the hand-written reason; --reason applies only to NEW entries.
    expect(written.entries['src/a.ts::fn']).toMatchObject({
      loc: 130,
      reason: 'old reason',
    });
  });

  it('stamps new entries with the supplied reason when allowGrowth', () => {
    const cfg = makeConfig();
    writeBaseline(cfg, { 'src/a.ts::fn': { loc: 110, reason: 'existing' } });

    const sizes = new Map([
      ['src/a.ts::fn', 110],
      ['src/b.ts::fn', 160], // new
    ]);
    const result = updateBaseline(cfg, sizes, { allowGrowth: true, reason: 'new fn, pending extraction' });

    expect(result.blocked).toHaveLength(0);
    const written = loadBaseline(cfg);
    expect(written.entries['src/b.ts::fn']).toMatchObject({ loc: 160, reason: 'new fn, pending extraction' });
    // Unchanged entry keeps its original reason.
    expect(written.entries['src/a.ts::fn']?.reason).toBe('existing');
  });
});

// ---------------------------------------------------------------------------
// Shrinks are unrestricted
// ---------------------------------------------------------------------------

describe('updateBaseline — shrinks are unrestricted', () => {
  it('writes a shrunk entry without allowGrowth, no blocked events', () => {
    const cfg = makeConfig();
    writeBaseline(cfg, { 'src/a.ts::fn': { loc: 150, reason: 'working down' } });

    const sizes = new Map([['src/a.ts::fn', 130]]); // smaller
    const result = updateBaseline(cfg, sizes);

    expect(result.blocked).toHaveLength(0);
    expect(result.kept).toBe(1);
    const written = loadBaseline(cfg);
    expect(written.entries['src/a.ts::fn']?.loc).toBe(130);
  });

  it('preserves prior reason on a shrunk entry', () => {
    const cfg = makeConfig();
    writeBaseline(cfg, { 'src/a.ts::fn': { loc: 150, reason: 'hand-written rationale' } });

    const sizes = new Map([['src/a.ts::fn', 140]]);
    updateBaseline(cfg, sizes);

    const written = loadBaseline(cfg);
    expect(written.entries['src/a.ts::fn']?.reason).toBe('hand-written rationale');
  });
});

// ---------------------------------------------------------------------------
// Removals (key drops below ceiling) are unrestricted
// ---------------------------------------------------------------------------

describe('updateBaseline — removals are unrestricted', () => {
  it('drops an entry that now fits under the ceiling; no blocked events', () => {
    const cfg = makeConfig();
    writeBaseline(cfg, {
      'src/a.ts::fn': { loc: 110, reason: 'old' },
      'src/b.ts::fn': { loc: 120, reason: 'also old' },
    });

    // src/a.ts::fn is now 95 (under 100 limit) → should be dropped.
    const sizes = new Map([
      ['src/a.ts::fn', 95],
      ['src/b.ts::fn', 120],
    ]);
    const result = updateBaseline(cfg, sizes);

    expect(result.blocked).toHaveLength(0);
    expect(result.dropped).toContain('src/a.ts::fn');
    expect(result.kept).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap: no baseline FILE → always write
// ---------------------------------------------------------------------------

describe('updateBaseline — bootstrap (no baseline file)', () => {
  it('writes without allowGrowth when no baseline file exists', () => {
    const cfg = makeConfig('missing.json');
    // File does not exist.
    expect(fs.existsSync(cfg.baselinePath)).toBe(false);

    const sizes = new Map([['src/a.ts::fn', 150]]);
    const result = updateBaseline(cfg, sizes);

    expect(result.blocked).toHaveLength(0);
    expect(result.kept).toBe(1);
    expect(fs.existsSync(cfg.baselinePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty baseline FILE (fileExisted=true, entries={}) → NOT a bootstrap
// ---------------------------------------------------------------------------

describe('updateBaseline — empty baseline file (not a bootstrap)', () => {
  it('blocks growth when the baseline file exists but entries is empty (no --allow-growth)', () => {
    const cfg = makeConfig();
    // File exists with empty entries — simulates a bad merge resolution.
    const emptyBaseline = JSON.stringify({ limit: cfg.limit, entries: {} });
    fs.writeFileSync(cfg.baselinePath, emptyBaseline, 'utf8');
    const mtime = fs.statSync(cfg.baselinePath).mtimeMs;

    const sizes = new Map([['src/a.ts::fn', 150]]);
    const result = updateBaseline(cfg, sizes);

    // Must be blocked, not silently treated as bootstrap.
    expect(result.blocked.length).toBeGreaterThan(0);
    expect(result.blocked[0]).toMatchObject({ key: 'src/a.ts::fn', oldLoc: null, newLoc: 150 });
    // File must not be written.
    expect(fs.statSync(cfg.baselinePath).mtimeMs).toBe(mtime);
  });

  it('writes with allowGrowth when the baseline file exists but entries is empty', () => {
    const cfg = makeConfig();
    const emptyBaseline = JSON.stringify({ limit: cfg.limit, entries: {} });
    fs.writeFileSync(cfg.baselinePath, emptyBaseline, 'utf8');

    const sizes = new Map([['src/a.ts::fn', 150]]);
    const result = updateBaseline(cfg, sizes, { allowGrowth: true, reason: 'populating after bad merge' });

    expect(result.blocked).toHaveLength(0);
    expect(result.kept).toBe(1);
    const written = loadBaseline(cfg);
    // New entry (no prior record) — should carry the supplied reason.
    expect(written.entries['src/a.ts::fn']).toMatchObject({ loc: 150, reason: 'populating after bad merge' });
  });
});
