/**
 * Tests for the /spine slash command handlers.
 *
 * Covers:
 *   - handleDismiss: 1-based index validation, boundary indices, removal
 *   - handlePending: empty file, contradicts with matching doc entry, corrupted-line fallback
 *   - handleInit: --force flag behaviour, no-seed fallback
 *   - Routing: unknown subcommand warning
 *
 * All file I/O is redirected to a real temp directory (not mocked) so the
 * handlers exercise the actual readFileSync / writeFileSync / existsSync
 * paths. The spine-store and classifier are mocked to keep tests hermetic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SlashContext, SessionStats } from '../types.js';

// ── Temp state directory ──────────────────────────────────────────────────────
// Shared across tests in one run; reset per-test in beforeEach.
let tmpStateDir = '';
let tmpRepoDir = '';

// ── Mock paths.ts ─────────────────────────────────────────────────────────────
vi.mock('../../../paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../paths.js')>();
  return {
    ...actual,
    getAfkStateDir: (): string => tmpStateDir,
  };
});

// ── Mock child_process so git calls are controllable ─────────────────────────
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn().mockReturnValue(''),
  };
});

// ── Mock spine-store to avoid touching real SPINE.md ─────────────────────────
vi.mock('../../../agent/spine/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../agent/spine/index.js')>();
  return {
    ...actual,
    readSpine: vi.fn().mockReturnValue(null),
    writeSpine: vi.fn(),
    addEntry: vi.fn().mockReturnValue('INV-001'),
    findEntry: vi.fn().mockReturnValue(undefined),
    classifySeedMaterial: vi.fn().mockResolvedValue({ items: [], rawOutput: '', parsed: true }),
  };
});

// ── Import under test ─────────────────────────────────────────────────────────
import { spineCmd } from './spine.js';

// ── Shared helpers ─────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
function clean(s: string): string {
  return s.replace(ANSI, '');
}

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
    unpricedTurns: 0,
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

/** Write N dummy pending JSONL lines to the temp pending file. */
function writePending(entries: object[]): void {
  writeFileSync(
    join(tmpStateDir, 'spine-pending.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf-8',
  );
}

function readPending(): object[] {
  const raw = readFileSync(join(tmpStateDir, 'spine-pending.jsonl'), 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').map((l) => JSON.parse(l) as object);
}

// ── Test setup / teardown ─────────────────────────────────────────────────────

beforeEach(async () => {
  tmpStateDir = join(tmpdir(), `afk-spine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpRepoDir = join(tmpStateDir, 'repo');
  mkdirSync(tmpStateDir, { recursive: true });
  mkdirSync(tmpRepoDir, { recursive: true });
  vi.clearAllMocks();

  // Default: git rev-parse returns tmpRepoDir
  const mod = await import('node:child_process');
  vi.mocked(mod.execFileSync).mockReturnValue(tmpRepoDir);
});

afterEach(() => {
  try {
    rmSync(tmpStateDir, { recursive: true, force: true });
  } catch { /* ignore cleanup errors */ }
});

// ── /spine dismiss ────────────────────────────────────────────────────────────

describe('/spine dismiss', () => {
  it('warns when no pending items exist', async () => {
    const { ctx, lines } = makeCtx();
    const result = await spineCmd.handler(ctx, 'dismiss 1');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.startsWith('INFO:') && clean(l).includes('No pending'))).toBe(true);
  });

  it('warns on non-numeric index', async () => {
    writePending([{ type: 'test', item: {}, sessionId: 'x', ts: '2026-09-01T00:00:00Z' }]);
    const { ctx, lines } = makeCtx();
    await spineCmd.handler(ctx, 'dismiss foo');
    expect(lines.some((l) => l.startsWith('WARN:') && clean(l).includes('Invalid index'))).toBe(true);
  });

  it('warns on index 0 (below 1-based range)', async () => {
    writePending([{ type: 'test', item: {}, sessionId: 'x', ts: '2026-09-01T00:00:00Z' }]);
    const { ctx, lines } = makeCtx();
    await spineCmd.handler(ctx, 'dismiss 0');
    expect(lines.some((l) => l.startsWith('WARN:') && clean(l).includes('Invalid index'))).toBe(true);
  });

  it('warns on index beyond length', async () => {
    writePending([
      { type: 'test', item: {}, sessionId: 'x', ts: '2026-09-01T00:00:00Z' },
    ]);
    const { ctx, lines } = makeCtx();
    await spineCmd.handler(ctx, 'dismiss 2');
    expect(lines.some((l) => l.startsWith('WARN:') && clean(l).includes('Invalid index'))).toBe(true);
  });

  it('accepts boundary index 1 of 1 — removes sole entry', async () => {
    writePending([{ type: 'sole', item: {}, sessionId: 'x', ts: '2026-09-01T00:00:00Z' }]);
    const { ctx, lines } = makeCtx();
    const result = await spineCmd.handler(ctx, 'dismiss 1');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.startsWith('SUCCESS:') && clean(l).includes('Dismissed item 1'))).toBe(true);
    // File should now be empty
    const remaining = readPending();
    expect(remaining).toHaveLength(0);
  });

  it('accepts boundary index N of N — removes last entry', async () => {
    writePending([
      { type: 'a', item: {}, sessionId: 'x', ts: '2026-09-01T00:00:00Z' },
      { type: 'b', item: {}, sessionId: 'x', ts: '2026-09-02T00:00:00Z' },
      { type: 'c', item: {}, sessionId: 'x', ts: '2026-09-03T00:00:00Z' },
    ]);
    const { ctx } = makeCtx();
    await spineCmd.handler(ctx, 'dismiss 3');
    const remaining = readPending();
    expect(remaining).toHaveLength(2);
    expect((remaining[0] as Record<string, unknown>)['type']).toBe('a');
    expect((remaining[1] as Record<string, unknown>)['type']).toBe('b');
  });

  it('removes the correct middle entry, preserving order of others', async () => {
    writePending([
      { type: 'first', item: {}, sessionId: 'x', ts: '2026-09-01T00:00:00Z' },
      { type: 'second', item: {}, sessionId: 'x', ts: '2026-09-02T00:00:00Z' },
      { type: 'third', item: {}, sessionId: 'x', ts: '2026-09-03T00:00:00Z' },
    ]);
    const { ctx } = makeCtx();
    await spineCmd.handler(ctx, 'dismiss 2');
    const remaining = readPending();
    expect(remaining).toHaveLength(2);
    expect((remaining[0] as Record<string, unknown>)['type']).toBe('first');
    expect((remaining[1] as Record<string, unknown>)['type']).toBe('third');
  });

  it('success message includes remaining count', async () => {
    writePending([
      { type: 'a', item: {}, sessionId: 'x', ts: '2026-09-01T00:00:00Z' },
      { type: 'b', item: {}, sessionId: 'x', ts: '2026-09-02T00:00:00Z' },
    ]);
    const { ctx, lines } = makeCtx();
    await spineCmd.handler(ctx, 'dismiss 1');
    expect(lines.some((l) => l.startsWith('SUCCESS:') && clean(l).includes('1 item(s) remaining'))).toBe(true);
  });
});

// ── /spine dismiss-all ────────────────────────────────────────────────────────

describe('/spine dismiss-all', () => {
  it('informs when nothing to dismiss', async () => {
    const { ctx, lines } = makeCtx();
    const result = await spineCmd.handler(ctx, 'dismiss-all');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.startsWith('INFO:') && clean(l).includes('No pending'))).toBe(true);
  });

  it('clears all items and reports count', async () => {
    writePending([
      { type: 'a', item: {}, sessionId: 'x', ts: '' },
      { type: 'b', item: {}, sessionId: 'x', ts: '' },
      { type: 'c', item: {}, sessionId: 'x', ts: '' },
    ]);
    const { ctx, lines } = makeCtx();
    const result = await spineCmd.handler(ctx, 'dismiss-all');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.startsWith('SUCCESS:') && clean(l).includes('3 pending'))).toBe(true);
    // File content should now be empty
    const remaining = readPending();
    expect(remaining).toHaveLength(0);
  });
});

// ── /spine pending ────────────────────────────────────────────────────────────

describe('/spine pending', () => {
  it('shows "No pending" message when file does not exist', async () => {
    const { ctx, lines } = makeCtx();
    const result = await spineCmd.handler(ctx, 'pending');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.startsWith('INFO:') && clean(l).includes('No pending'))).toBe(true);
  });

  it('shows "No pending" message when file is present but empty', async () => {
    writeFileSync(join(tmpStateDir, 'spine-pending.jsonl'), '', 'utf-8');
    const { ctx, lines } = makeCtx();
    await spineCmd.handler(ctx, 'pending');
    expect(lines.some((l) => l.startsWith('INFO:') && clean(l).includes('No pending'))).toBe(true);
  });

  it('renders a basic pending entry by index', async () => {
    writePending([
      {
        type: 'contradicts',
        sessionId: 'ses-abc',
        ts: '2026-09-01T12:00:00Z',
        item: { existingId: 'INV-001', description: 'Direct env access spotted' },
      },
    ]);
    const { ctx, lines } = makeCtx();
    await spineCmd.handler(ctx, 'pending');
    const text = lines.map(clean).join('\n');
    expect(text).toContain('1');
    expect(text).toContain('contradicts');
    expect(text).toContain('ses-abc');
  });

  it('shows "current:" line for contradicts when spine entry matches', async () => {
    writePending([
      {
        type: 'contradicts',
        sessionId: 'ses-abc',
        ts: '2026-09-01T12:00:00Z',
        item: { existingId: 'INV-007', description: 'Conflict with existing entry' },
      },
    ]);

    const { readSpine, findEntry } = await import('../../../agent/spine/index.js');
    const mockEntry = {
      id: 'INV-007',
      date: '2026-09-01',
      sessionId: 'old-session',
      description: 'Canonical existing description',
    };
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [mockEntry] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(mockEntry);

    const { ctx, lines } = makeCtx();
    await spineCmd.handler(ctx, 'pending');
    const text = lines.map(clean).join('\n');
    expect(text).toContain('current:');
    expect(text).toContain('Canonical existing description');
  });

  it('renders a corrupted / unparseable line with [unparseable] label', async () => {
    writeFileSync(
      join(tmpStateDir, 'spine-pending.jsonl'),
      'NOT VALID JSON AT ALL\n',
      'utf-8',
    );
    const { ctx, lines } = makeCtx();
    await spineCmd.handler(ctx, 'pending');
    const text = lines.map(clean).join('\n');
    expect(text).toContain('[unparseable]');
    expect(text).toContain('NOT VALID JSON AT ALL');
  });

  it('shows dismiss hint at bottom', async () => {
    writePending([{ type: 'foo', sessionId: 'x', ts: '2026-09-01T00:00:00Z', item: {} }]);
    const { ctx, lines } = makeCtx();
    await spineCmd.handler(ctx, 'pending');
    const text = lines.map(clean).join('\n');
    expect(text).toContain('/spine dismiss');
    expect(text).toContain('/spine dismiss-all');
  });

  it('numbers items correctly when multiple entries are present', async () => {
    writePending([
      { type: 'a', sessionId: 'x', ts: '2026-09-01T00:00:00Z', item: { description: 'Alpha' } },
      { type: 'b', sessionId: 'x', ts: '2026-09-02T00:00:00Z', item: { description: 'Beta' } },
      { type: 'c', sessionId: 'x', ts: '2026-09-03T00:00:00Z', item: { description: 'Gamma' } },
    ]);
    const { ctx, lines } = makeCtx();
    await spineCmd.handler(ctx, 'pending');
    const text = lines.map(clean).join('\n');
    expect(text).toContain('1');
    expect(text).toContain('2');
    expect(text).toContain('3');
  });
});

// ── /spine init ───────────────────────────────────────────────────────────────

describe('/spine init', () => {
  it('warns and returns early when SPINE.md already exists (no --force)', async () => {
    // Write a dummy SPINE.md in tmpRepoDir
    writeFileSync(join(tmpRepoDir, 'SPINE.md'), '# SPINE\n', 'utf-8');

    // Mock git to resolve to tmpRepoDir
    const mod = await import('node:child_process');
    vi.mocked(mod.execFileSync).mockReturnValue(tmpRepoDir);

    const { writeSpine } = await import('../../../agent/spine/index.js');
    const { ctx, lines } = makeCtx();
    const result = await spineCmd.handler(ctx, 'init');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.startsWith('WARN:') && clean(l).includes('already exists'))).toBe(true);
    expect(vi.mocked(writeSpine)).not.toHaveBeenCalled();
  });

  it('proceeds when SPINE.md exists but --force is passed', async () => {
    writeFileSync(join(tmpRepoDir, 'SPINE.md'), '# SPINE\n', 'utf-8');

    const mod = await import('node:child_process');
    vi.mocked(mod.execFileSync).mockReturnValue(tmpRepoDir);

    const { classifySeedMaterial, writeSpine } = await import('../../../agent/spine/index.js');
    vi.mocked(classifySeedMaterial).mockResolvedValue({ items: [], rawOutput: '', parsed: true });

    const { ctx } = makeCtx();
    const result = await spineCmd.handler(ctx, 'init --force');
    expect(result).toBe('continue');
    // writeSpine should be called (even for empty skeleton)
    expect(vi.mocked(writeSpine)).toHaveBeenCalled();
  });

  it('writes empty skeleton when no seed material and no SPINE.md', async () => {
    const mod = await import('node:child_process');
    // execFileSync: rev-parse returns tmpRepoDir; rg and git log return empty
    vi.mocked(mod.execFileSync).mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a.includes('rev-parse')) return tmpRepoDir;
      return '';
    });

    const { writeSpine } = await import('../../../agent/spine/index.js');
    const { ctx, lines } = makeCtx();
    const result = await spineCmd.handler(ctx, 'init');
    expect(result).toBe('continue');
    expect(vi.mocked(writeSpine)).toHaveBeenCalled();
    expect(lines.some((l) => clean(l).includes('empty skeleton') || clean(l).includes('empty SPINE'))).toBe(true);
  });

  it('falls back to empty skeleton when classifier throws (e.g. no API key)', async () => {
    const mod = await import('node:child_process');
    vi.mocked(mod.execFileSync).mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a.includes('rev-parse')) return tmpRepoDir;
      // Simulate rg finding seed material — the pattern arg is 'Invariant:|Contract:|History:'
      if (a.some((arg) => typeof arg === 'string' && arg.startsWith('Invariant:'))) {
        return 'Invariant: all env vars go through env.ts';
      }
      return '';
    });

    const { classifySeedMaterial, writeSpine } = await import('../../../agent/spine/index.js');
    vi.mocked(classifySeedMaterial).mockRejectedValue(new Error('No API key'));

    const { ctx, lines } = makeCtx();
    await spineCmd.handler(ctx, 'init');
    expect(vi.mocked(writeSpine)).toHaveBeenCalled();
    expect(lines.some((l) => l.startsWith('WARN:') && clean(l).includes('Classifier failed'))).toBe(true);
  });
});

// ── /spine show ───────────────────────────────────────────────────────────────

describe('/spine show', () => {
  it('warns when no SPINE.md exists', async () => {
    const { readSpine } = await import('../../../agent/spine/index.js');
    vi.mocked(readSpine).mockReturnValue(null);

    const { ctx, lines } = makeCtx();
    const result = await spineCmd.handler(ctx, 'show');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.startsWith('WARN:') && clean(l).includes('No SPINE.md'))).toBe(true);
  });

  it('renders section headers and entries', async () => {
    const { readSpine } = await import('../../../agent/spine/index.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        {
          name: 'Invariants',
          prefix: 'INV',
          entries: [{ id: 'INV-001', date: '2026-09-01', sessionId: 'ses-x', description: 'No raw chalk' }],
        },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });

    const { ctx, lines } = makeCtx();
    await spineCmd.handler(ctx, '');
    const text = lines.map(clean).join('\n');
    expect(text).toContain('Invariants');
    expect(text).toContain('INV-001');
    expect(text).toContain('No raw chalk');
  });

  it('shows "(none)" for empty sections', async () => {
    const { readSpine } = await import('../../../agent/spine/index.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });

    const { ctx, lines } = makeCtx();
    await spineCmd.handler(ctx, 'show');
    const text = lines.map(clean).join('\n');
    expect(text).toContain('(none)');
  });
});

// ── Unknown subcommand ────────────────────────────────────────────────────────

describe('/spine unknown subcommand', () => {
  it('warns and suggests valid subcommands', async () => {
    const { ctx, lines } = makeCtx();
    const result = await spineCmd.handler(ctx, 'zoltar');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.startsWith('WARN:') && clean(l).includes('zoltar'))).toBe(true);
    expect(lines.some((l) => clean(l).includes('show') || clean(l).includes('init'))).toBe(true);
  });
});
