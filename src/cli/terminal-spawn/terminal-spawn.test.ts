/**
 * Tests for the terminal-spawn module.
 *
 * Detection and command construction are pure and tested exhaustively. The
 * executor (trySpawnTab) is tested with an injected `run` so the decision
 * logic is verified WITHOUT launching any real terminal.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectTerminal } from './detect.js';
import { planSpawn, resolveResumeInvocation } from './spawners.js';
import { trySpawnTab, type RunFn } from './index.js';

describe('detectTerminal', () => {
  it('detects each terminal by its signature env var', () => {
    expect(detectTerminal({ TMUX: '/tmp/tmux-1/default,123,0' })).toBe('tmux');
    expect(detectTerminal({ KITTY_WINDOW_ID: '1' })).toBe('kitty');
    expect(detectTerminal({ WEZTERM_PANE: '0' })).toBe('wezterm');
    expect(detectTerminal({ WT_SESSION: 'guid' })).toBe('windows-terminal');
    expect(detectTerminal({ KONSOLE_DBUS_SERVICE: ':1.42' })).toBe('konsole');
    expect(detectTerminal({ GNOME_TERMINAL_SCREEN: '/org/x' })).toBe('gnome-terminal');
    expect(detectTerminal({ TERM_PROGRAM: 'iTerm.app' })).toBe('iterm2');
    expect(detectTerminal({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('apple-terminal');
    expect(detectTerminal({ TERM_PROGRAM: 'vscode' })).toBe('vscode');
    expect(detectTerminal({ TERM_PROGRAM: 'Hyper' })).toBe('hyper');
    expect(detectTerminal({ TERM: 'xterm-ghostty' })).toBe('ghostty');
    expect(detectTerminal({ GHOSTTY_RESOURCES_DIR: '/x' })).toBe('ghostty');
    expect(detectTerminal({ TERM: 'alacritty' })).toBe('alacritty');
    expect(detectTerminal({ VTE_VERSION: '6800' })).toBe('gnome-terminal');
  });

  it('returns unknown when no signal is present', () => {
    expect(detectTerminal({})).toBe('unknown');
    expect(detectTerminal({ TERM: 'xterm-256color' })).toBe('unknown');
  });

  it('lets tmux win when nested inside another terminal (order invariant)', () => {
    // A user in tmux inside Ghostty has BOTH set — tmux must win.
    expect(detectTerminal({ TMUX: 'x', TERM: 'xterm-ghostty', TERM_PROGRAM: 'iTerm.app' })).toBe('tmux');
  });
});

describe('resolveResumeInvocation', () => {
  let origArgv1: string | undefined;
  beforeEach(() => { origArgv1 = process.argv[1]; });
  afterEach(() => { if (origArgv1 !== undefined) process.argv[1] = origArgv1; });

  it('builds an argv pointing at the running node + script with resume + model', () => {
    process.argv[1] = '/opt/afk/dist/cli.mjs';
    const inv = resolveResumeInvocation('fork-123', 'opus', '/work/dir');
    expect(inv.argv[0]).toBe(process.execPath);
    expect(inv.argv).toContain('interactive');
    expect(inv.argv).toContain('--resume');
    expect(inv.argv).toContain('fork-123');
    expect(inv.argv).toContain('--model');
    expect(inv.argv).toContain('opus');
    expect(inv.cwd).toBe('/work/dir');
    expect(inv.spawnable).toBe(true);
    expect(inv.shellCommand).toContain('--resume fork-123');
  });

  it('omits --model when model is empty', () => {
    process.argv[1] = '/opt/afk/dist/cli.mjs';
    const inv = resolveResumeInvocation('f', '' as unknown as 'sonnet', '/d');
    expect(inv.argv).not.toContain('--model');
  });

  it('is not spawnable from a TypeScript (tsx dev) entrypoint', () => {
    process.argv[1] = '/repo/src/cli/index.ts';
    expect(resolveResumeInvocation('f', 'sonnet', '/d').spawnable).toBe(false);
  });
});

describe('planSpawn', () => {
  const inv = resolveResumeInvocation('fork-9', 'sonnet', '/w');

  it('plans a clean tmux new-window with -c cwd', () => {
    const p = planSpawn('tmux', inv);
    expect(p.capability).toBe('tab');
    expect(p.exec).toEqual({ cmd: 'tmux', args: ['new-window', '-c', '/w', inv.shellCommand] });
  });

  it('plans wezterm cli spawn with --cwd and argv', () => {
    const p = planSpawn('wezterm', inv);
    expect(p.exec!.cmd).toBe('wezterm');
    expect(p.exec!.args.slice(0, 4)).toEqual(['cli', 'spawn', '--cwd', '/w']);
    expect(p.exec!.args).toContain('--');
  });

  it('plans kitten @ launch --type=tab', () => {
    const p = planSpawn('kitty', inv);
    expect(p.exec!.cmd).toBe('kitten');
    expect(p.exec!.args.slice(0, 4)).toEqual(['@', 'launch', '--type=tab', '--cwd=/w']);
  });

  it('plans wt new-tab with -d cwd', () => {
    const p = planSpawn('windows-terminal', inv);
    expect(p.exec!.args.slice(0, 5)).toEqual(['-w', '0', 'new-tab', '-d', '/w']);
  });

  it('plans osascript for iTerm (tab) and Terminal (window)', () => {
    const iterm = planSpawn('iterm2', inv);
    expect(iterm.capability).toBe('tab');
    expect(iterm.exec!.cmd).toBe('osascript');
    expect(iterm.exec!.args[1]).toContain('tell application "iTerm"');

    const term = planSpawn('apple-terminal', inv);
    expect(term.capability).toBe('window');
    expect(term.exec!.args[1]).toContain('do script');
  });

  it('plans Ghostty via osascript on macOS, but declines on Linux', () => {
    expect(planSpawn('ghostty', inv, 'darwin').capability).toBe('tab');
    expect(planSpawn('ghostty', inv, 'darwin').exec!.args[1]).toContain('tell application "Ghostty"');
    expect(planSpawn('ghostty', inv, 'linux').capability).toBe('none');
    expect(planSpawn('ghostty', inv, 'linux').exec).toBeUndefined();
  });

  it('declines (capability none) for vscode / alacritty / hyper / unknown', () => {
    for (const kind of ['vscode', 'alacritty', 'hyper', 'unknown'] as const) {
      const p = planSpawn(kind, inv);
      expect(p.capability).toBe('none');
      expect(p.exec).toBeUndefined();
    }
  });
});

describe('trySpawnTab', () => {
  let origArgv1: string | undefined;
  beforeEach(() => { origArgv1 = process.argv[1]; process.argv[1] = '/opt/afk/dist/cli.mjs'; });
  afterEach(() => { if (origArgv1 !== undefined) process.argv[1] = origArgv1; });

  const base = { forkId: 'fork-1', model: 'sonnet' as const, cwd: '/w' };

  it('refuses to spawn on a non-interactive surface (Telegram/daemon)', () => {
    const out = trySpawnTab({ ...base, interactive: false, env: { TMUX: 'x' }, run: () => ({ status: 0 }) });
    expect(out.spawned).toBe(false);
    expect(out.reason).toBe('non-interactive-surface');
  });

  it('declines when the terminal has no safe tab mechanism', () => {
    const out = trySpawnTab({ ...base, interactive: true, env: { TERM_PROGRAM: 'vscode' }, run: () => ({ status: 0 }) });
    expect(out.spawned).toBe(false);
    expect(out.kind).toBe('vscode');
    expect(out.reason).toBe('no-tab-mechanism');
  });

  it('spawns via the planned command and reports success', () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const run: RunFn = (cmd, args) => { calls.push({ cmd, args }); return { status: 0 }; };
    const out = trySpawnTab({ ...base, interactive: true, env: { TMUX: 'x' }, run });
    expect(out).toMatchObject({ spawned: true, kind: 'tmux', capability: 'tab' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('tmux');
    expect(calls[0]!.args[0]).toBe('new-window');
  });

  it('reports failure (not a false success) when the spawn command errors', () => {
    const run: RunFn = () => ({ status: null, error: new Error('ENOENT') });
    const out = trySpawnTab({ ...base, interactive: true, env: { WEZTERM_PANE: '0' }, run });
    expect(out.spawned).toBe(false);
    expect(out.reason).toContain('ENOENT');
  });

  it('reports failure on a non-zero exit', () => {
    const run: RunFn = () => ({ status: 1 });
    const out = trySpawnTab({ ...base, interactive: true, env: { TMUX: 'x' }, run });
    expect(out.spawned).toBe(false);
    expect(out.reason).toBe('exited 1');
  });

  it('declines to spawn from a dev (.ts) entrypoint', () => {
    process.argv[1] = '/repo/src/cli/index.ts';
    const out = trySpawnTab({ ...base, interactive: true, env: { TMUX: 'x' }, run: () => ({ status: 0 }) });
    expect(out.spawned).toBe(false);
    expect(out.reason).toBe('dev-entrypoint');
  });

  it('exercises the real spawn path and fails cleanly when the binary is absent', () => {
    // No injected run → real spawnSync. WT_SESSION selects Windows Terminal
    // (`wt`), which does not exist on the macOS/Linux test hosts, so the spawn
    // fails with ENOENT rather than opening any window. Verifies the
    // never-throws contract end-to-end through the default runner.
    const out = trySpawnTab({ ...base, interactive: true, env: { WT_SESSION: 'guid' } });
    expect(out.kind).toBe('windows-terminal');
    if (process.platform !== 'win32') {
      expect(out.spawned).toBe(false);
    }
  });
});
