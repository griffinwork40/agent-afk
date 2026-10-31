import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRepoRootSync } from '../../../utils/git.js';
import { saveSession } from '../../session-store.js';
import { createSessionStats, recordTurn } from '../session-stats.js';
import type { SlashContext, SessionStats } from '../types.js';
import type { PickerController, TerminalCompositor } from '../../terminal-compositor.js';
import { resumeCmd } from './resume.js';

vi.mock('../../../utils/git.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../utils/git.js')>(),
  resolveRepoRootSync: vi.fn(),
}));

let home: string;
let currentCwd: string;
let currentRoot: string;
let worktreeCwd: string;
let foreignCwd: string;
let foreignRoot: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'afk-resume-repo-'));
  vi.stubEnv('AFK_HOME', join(home, 'afk'));
  currentRoot = join(home, 'repo');
  currentCwd = join(currentRoot, 'src');
  worktreeCwd = join(home, 'linked-worktree');
  foreignRoot = join(home, 'foreign');
  foreignCwd = join(foreignRoot, 'src');
  vi.mocked(resolveRepoRootSync).mockReset().mockImplementation(({ cwd } = {}) => {
    if (cwd === currentCwd || cwd === worktreeCwd) return currentRoot;
    if (cwd === foreignCwd) return foreignRoot;
    throw new Error(`Unexpected repo lookup: ${cwd}`);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(resolveRepoRootSync).mockReset();
  rmSync(home, { recursive: true, force: true });
});

function save(name: string, fields: Partial<SessionStats>): void {
  const stats = createSessionStats('sonnet');
  recordTurn(stats, 'work', 'done', {
    sessionId: `sdk-${name}`, totalCostUsd: 0.01, durationMs: 10,
    usage: { input_tokens: 5, output_tokens: 5 },
  });
  Object.assign(stats, fields, { name });
  saveSession(stats);
}

class PickerHost {
  controller: PickerController | undefined;
  frames: string[] = [];
  exits = 0;
  enterPickerMode(controller: PickerController): void {
    this.controller = controller;
    this.frames.push(controller.renderRows().join('\n'));
    // Confirm the preview, but let the test drive the session selection.
    if (this.frames.length > 1) queueMicrotask(() => this.press('return'));
  }
  exitPickerMode(): void { this.exits++; }
  repaintPicker(): void {}
  press(name: string): void {
    if (!this.controller) throw new Error('Picker was not opened');
    this.controller.onKey(undefined, { name });
  }
}

function context(picker: boolean): {
  ctx: SlashContext; lines: string[]; host: PickerHost; requestResume: ReturnType<typeof vi.fn>;
} {
  const lines: string[] = [];
  const line = (text = ''): void => { lines.push(text); };
  const host = new PickerHost();
  const requestResume = vi.fn(async () => ({ ok: true as const, sessionId: 'resumed' }));
  const ctx = {
    stats: { ...createSessionStats('sonnet'), cwd: currentCwd },
    session: { current: { sessionId: 'sdk-live' } },
    out: { line, raw: line, info: line, warn: line, error: line, success: line },
    requestResume,
    ...(picker ? { getCompositor: () => host as unknown as TerminalCompositor } : {}),
  } as unknown as SlashContext;
  return { ctx, lines, host, requestResume };
}

function expectCurrentLookup(): void {
  expect(resolveRepoRootSync).toHaveBeenCalledWith({ cwd: currentCwd, mode: 'git-common-dir' });
}

describe.each([false, true])('/resume repo filtering (picker=%s)', (picker) => {
  it('includes distinct cwd/worktree paths sharing a root and excludes another repository', async () => {
    save('same-repo', { cwd: worktreeCwd, repoRoot: currentRoot });
    save('other-repo', { cwd: foreignCwd, repoRoot: foreignRoot });
    save('daemon-local', { cwd: worktreeCwd, repoRoot: currentRoot, source: 'daemon' });
    const { ctx, lines, host, requestResume } = context(picker);
    const pending = resumeCmd.handler(ctx, '');
    const text = picker ? host.frames[0] ?? '' : lines.join('\n');
    expect(text).toContain('same-repo');
    expect(text).not.toContain('other-repo');
    expect(text).not.toContain('daemon-local');
    expect(text).toContain('1 from other projects hidden');
    expect(text).not.toMatch(/none (saved here|in this directory)/);
    expectCurrentLookup();
    // Stored roots do not need per-session git lookups.
    expect(resolveRepoRootSync).toHaveBeenCalledTimes(1);
    if (picker) host.press('return');
    expect(await pending).toBe('continue');
    if (picker) {
      expect(requestResume).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ resumeId: 'sdk-same-repo' }));
      expect(host.frames).toHaveLength(2);
      expect(host.exits).toBe(2);
    } else expect(requestResume).not.toHaveBeenCalled();
  });

  it('global fallback includes foreign CLI sessions, never local or foreign daemon sessions', async () => {
    save('daemon-local', { cwd: worktreeCwd, repoRoot: currentRoot, source: 'daemon' });
    save('daemon-foreign', { cwd: foreignCwd, repoRoot: foreignRoot, source: 'daemon' });
    save('foreign-cli', { cwd: foreignCwd, repoRoot: foreignRoot });
    const { ctx, lines, host, requestResume } = context(picker);
    const pending = resumeCmd.handler(ctx, '');
    const text = picker ? host.frames[0] ?? '' : lines.join('\n');
    expect(text).toContain(picker ? 'all directories (none saved here)' : 'Saved sessions — all (none in this directory)');
    expect(text).toContain('foreign-cli');
    expect(text).not.toContain('daemon-local');
    expect(text).not.toContain('daemon-foreign');
    expectCurrentLookup();
    if (picker) host.press('return');
    expect(await pending).toBe('continue');
    if (picker) {
      expect(requestResume).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ resumeId: 'sdk-foreign-cli' }));
      expect(host.exits).toBe(2);
    } else expect(requestResume).not.toHaveBeenCalled();
  });

  it.each([false, true])('handles an empty non-daemon list (saved daemon=%s)', async (hasDaemon) => {
    if (hasDaemon) save('daemon-only', { cwd: worktreeCwd, repoRoot: currentRoot, source: 'daemon' });
    const { ctx, lines, host, requestResume } = context(picker);
    const pending = resumeCmd.handler(ctx, '');
    // Empty pickers must resolve without installing a controller. If a daemon
    // leaks through, cancel it before asserting so the regression fails promptly.
    const frames = [...host.frames];
    if (host.controller) host.press('escape');
    expect(await pending).toBe('continue');
    expect(frames).toEqual([]);
    expect(requestResume).not.toHaveBeenCalled();
    expect(host.frames).toEqual([]);
    expect(host.exits).toBe(0);
    const text = lines.join('\n');
    expect(text).not.toContain('daemon-only');
    if (!hasDaemon) {
      expect(text).toContain('No saved sessions found');
      expect(resolveRepoRootSync).not.toHaveBeenCalled();
    } else {
      expectCurrentLookup();
      if (!picker) expect(text).toContain('Saved sessions — all (none in this directory)');
    }
  });
});

describe('/resume legacy repo-root cache', () => {
  it('shows a legacy session without cwd or repoRoot only via global fallback', async () => {
    save('legacy-unscoped', {});
    const { ctx, lines, requestResume } = context(false);
    await resumeCmd.handler(ctx, '');
    const text = lines.join('\n');
    expect(text).toContain('Saved sessions — all (none in this directory)');
    expect(text).toContain('legacy-unscoped');
    expectCurrentLookup();
    expect(resolveRepoRootSync).toHaveBeenCalledTimes(1);
    expect(requestResume).not.toHaveBeenCalled();
  });

  it('resolves a shared legacy cwd once and includes it without triggering global fallback', async () => {
    save('legacy-a', { cwd: worktreeCwd });
    save('legacy-b', { cwd: worktreeCwd });
    save('legacy-foreign', { cwd: foreignCwd });
    save('legacy-no-cwd', {});
    const { ctx, lines, requestResume } = context(false);
    await resumeCmd.handler(ctx, '');
    const text = lines.join('\n');
    expect(text).toContain('legacy-a');
    expect(text).toContain('legacy-b');
    expect(text).not.toContain('legacy-foreign');
    expect(text).not.toContain('legacy-no-cwd');
    expect(text).toContain('2 from other projects hidden');
    expect(resolveRepoRootSync).toHaveBeenCalledTimes(3);
    expect(resolveRepoRootSync).toHaveBeenCalledWith({ cwd: worktreeCwd, mode: 'git-common-dir' });
    expect(resolveRepoRootSync).toHaveBeenCalledWith({ cwd: foreignCwd, mode: 'git-common-dir' });
    expect(requestResume).not.toHaveBeenCalled();
  });

  it('caches failed legacy lookups and keeps unresolvable sessions out of the local list', async () => {
    const missingCwd = join(home, 'deleted-worktree');
    save('local', { cwd: worktreeCwd, repoRoot: currentRoot });
    save('missing-a', { cwd: missingCwd });
    save('missing-b', { cwd: missingCwd });
    const { ctx, lines } = context(false);
    await resumeCmd.handler(ctx, '');
    const text = lines.join('\n');
    expect(text).toContain('local');
    expect(text).not.toContain('missing-a');
    expect(text).not.toContain('missing-b');
    expect(text).toContain('2 from other projects hidden');
    expect(resolveRepoRootSync).toHaveBeenCalledTimes(2);
    expect(resolveRepoRootSync).toHaveBeenCalledWith({ cwd: missingCwd, mode: 'git-common-dir' });
  });
});
