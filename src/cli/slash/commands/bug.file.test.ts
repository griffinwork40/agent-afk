/**
 * Tests for `/bug --file`: confirmation gate, fail-closed fallbacks, label
 * gating, and arg parsing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseBugArgs, runBug } from './bug.js';
import { buildFilePreviewRows, type BugFileDeps } from './bug.file.js';
import { BUG_REPORT_REPO } from './bug.body.js';
import { resetHyperlinksEnabledForTest } from '../../hyperlink.js';
import type { SlashContext, SessionStats } from '../types.js';
import type { PickerController } from '../../terminal-compositor.js';

type Key = 'return' | 'escape' | 'ctrl-c';

function makeCompositor(key: Key): { compositor: unknown; rows: () => readonly string[]; exit: ReturnType<typeof vi.fn> } {
  let captured: PickerController | null = null;
  const exit = vi.fn();
  const compositor = {
    enterPickerMode: (c: PickerController): void => {
      captured = c;
      queueMicrotask(() => {
        if (key === 'ctrl-c') c.onKey(undefined, { name: 'c', ctrl: true });
        else c.onKey(undefined, { name: key });
      });
    },
    exitPickerMode: exit,
  };
  return { compositor, rows: () => captured?.renderRows() ?? [], exit };
}

function makeCtx(compositor: unknown | null): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const stats: SessionStats = {
    totalTurns: 0, totalCostUsd: 0, totalTokens: 0, totalDurationMs: 0,
    sessionStartTime: Date.now(), turnCosts: [], turnTokens: [], turns: [],
    model: 'sonnet', permissionMode: 'default',
  };
  const ctx = {
    session: {} as SlashContext['session'],
    stats,
    out: {
      line: (t = ''): void => { lines.push(t); },
      raw: (t: string): void => { lines.push(t); },
      success: (t: string): void => { lines.push(`SUCCESS:${t}`); },
      info: (t: string): void => { lines.push(`INFO:${t}`); },
      warn: (t: string): void => { lines.push(`WARN:${t}`); },
      error: (t: string): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
    getCompositor: () => compositor,
  } as unknown as SlashContext;
  return { ctx, lines };
}

function makeDeps(overrides: Partial<BugFileDeps> = {}): BugFileDeps & { createIssue: ReturnType<typeof vi.fn> } {
  return {
    checkGhReady: vi.fn(async () => ({ ok: true as const })),
    getGhLogin: vi.fn(async () => 'octocat'),
    getViewerPermission: vi.fn(async () => 'READ' as const),
    createIssue: vi.fn(async () => 'https://github.com/griffinwork40/agent-afk/issues/9999'),
    ...overrides,
  } as BugFileDeps & { createIssue: ReturnType<typeof vi.fn> };
}

const printedLink = (lines: string[]): boolean => lines.some((l) => l.startsWith(`https://github.com/${BUG_REPORT_REPO}/issues/new?`));

beforeEach(() => resetHyperlinksEnabledForTest(false));
afterEach(() => resetHyperlinksEnabledForTest());

describe('parseBugArgs', () => {
  it('detects a leading --file flag', () => {
    expect(parseBugArgs('--file it crashed')).toEqual({ file: true, description: 'it crashed' });
    expect(parseBugArgs('  --file  ')).toEqual({ file: true, description: '' });
  });
  it('treats --file elsewhere, or a lookalike prefix, as description text', () => {
    expect(parseBugArgs('it crashed --file')).toEqual({ file: false, description: 'it crashed --file' });
    expect(parseBugArgs('--filed twice')).toEqual({ file: false, description: '--filed twice' });
  });
});

describe('/bug --file', () => {
  it('files after Enter, with no label for read-only accounts', async () => {
    const { compositor, exit } = makeCompositor('return');
    const { ctx, lines } = makeCtx(compositor);
    const deps = makeDeps();
    await runBug(ctx, '--file REPL froze', deps);
    expect(deps.createIssue).toHaveBeenCalledTimes(1);
    const opts = deps.createIssue.mock.calls[0]![0];
    expect(opts.repo).toBe(BUG_REPORT_REPO);
    expect(opts.title).toBe('REPL froze');
    expect(opts.body).toContain('**Environment**');
    expect(opts.labels).toEqual([]);
    expect(exit).toHaveBeenCalled();
    expect(lines.some((l) => l.startsWith('SUCCESS:') && l.includes('/issues/9999'))).toBe(true);
  });

  it('adds the bug label for triage-capable accounts', async () => {
    const { compositor } = makeCompositor('return');
    const deps = makeDeps({ getViewerPermission: vi.fn(async () => 'TRIAGE' as const) });
    await runBug(makeCtx(compositor).ctx, '--file x', deps);
    expect(deps.createIssue.mock.calls[0]![0].labels).toEqual(['bug']);
  });

  it.each<Key>(['escape', 'ctrl-c'])('files nothing when the user cancels (%s)', async (key) => {
    const { compositor } = makeCompositor(key);
    const { ctx, lines } = makeCtx(compositor);
    const deps = makeDeps();
    await runBug(ctx, '--file x', deps);
    expect(deps.createIssue).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('Nothing was filed'))).toBe(true);
  });

  it('previews repo, account, labels, title, and body before filing', async () => {
    const { compositor, rows } = makeCompositor('escape');
    await runBug(makeCtx(compositor).ctx, '--file tool lane flickers', makeDeps());
    const text = rows().join('\n');
    expect(text).toContain(BUG_REPORT_REPO);
    expect(text).toContain('@octocat');
    expect(text).toContain('PUBLIC');
    expect(text).toContain('tool lane flickers');
    expect(text).toContain('none (triage will label it)');
    expect(text).toContain('**Environment**');
  });

  it('falls back to the link without a compositor (non-interactive) and never calls gh', async () => {
    const { ctx, lines } = makeCtx(null);
    const deps = makeDeps();
    await runBug(ctx, '--file x', deps);
    expect(deps.checkGhReady).not.toHaveBeenCalled();
    expect(deps.createIssue).not.toHaveBeenCalled();
    expect(printedLink(lines)).toBe(true);
  });

  it('falls back to the link when gh is not ready, showing the hint', async () => {
    const { compositor } = makeCompositor('return');
    const { ctx, lines } = makeCtx(compositor);
    const deps = makeDeps({ checkGhReady: vi.fn(async () => ({ ok: false as const, hint: '`gh` is not authenticated — run: gh auth login' })) });
    await runBug(ctx, '--file x', deps);
    expect(deps.createIssue).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('gh auth login'))).toBe(true);
    expect(printedLink(lines)).toBe(true);
  });

  it('falls back to the link when the account cannot be read', async () => {
    const { compositor } = makeCompositor('return');
    const { ctx, lines } = makeCtx(compositor);
    const deps = makeDeps({ getGhLogin: vi.fn(async () => null) });
    await runBug(ctx, '--file x', deps);
    expect(deps.createIssue).not.toHaveBeenCalled();
    expect(printedLink(lines)).toBe(true);
  });

  it('falls back to the link when gh issue create fails', async () => {
    const { compositor } = makeCompositor('return');
    const { ctx, lines } = makeCtx(compositor);
    const deps = makeDeps({ createIssue: vi.fn(async () => { throw new Error('boom'); }) });
    await runBug(ctx, '--file x', deps);
    expect(lines.some((l) => l.startsWith('ERROR:') && l.includes('boom'))).toBe(true);
    expect(printedLink(lines)).toBe(true);
  });

  it('requires a description', async () => {
    const { compositor } = makeCompositor('return');
    const { ctx, lines } = makeCtx(compositor);
    const deps = makeDeps();
    await runBug(ctx, '--file', deps);
    expect(deps.checkGhReady).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('Usage: /bug --file'))).toBe(true);
  });

  it('without --file keeps the v1 link behaviour and never touches gh', async () => {
    const { ctx, lines } = makeCtx(null);
    const deps = makeDeps();
    await runBug(ctx, 'plain report', deps);
    expect(deps.checkGhReady).not.toHaveBeenCalled();
    expect(printedLink(lines)).toBe(true);
  });
});

describe('buildFilePreviewRows', () => {
  it('lists labels when present', () => {
    const rows = buildFilePreviewRows({ title: 't', body: 'b' }, 'me', ['bug']).join('\n');
    expect(rows).toContain('bug');
    expect(rows).not.toContain('none (triage');
  });
});
