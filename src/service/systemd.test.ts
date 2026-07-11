/**
 * Tests for the systemd `--user` backend (`src/service/systemd/*`).
 *
 * Pure parts (unit-file generation, `systemctl show` parsing) are tested
 * directly. The I/O-bearing parts (install/uninstall) run against a real
 * per-test tmpdir pointed at via `HOME` + `AFK_HOME` — the same pattern
 * `launchd.test.ts` uses (cheaper to reason about than vi.mock('fs') and
 * it exercises the real atomic-write + rename path). `execFileSync` is the
 * only mock; `systemctl` never runs in CI.
 *
 * Mirrors `launchd.test.ts`: if any systemd sub-module is relocated, the
 * `vi.mock('../telegram/manager.js')` specifier below must track the SUT's
 * import path — vi.mock resolves by module ID, not by test-side import.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFileSync, telegram } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  // Mutable so a test can point the resolved entrypoint at a dev-tree path
  // (under $HOME) to exercise the .path-unit auto-restart branch.
  telegram: { entrypoint: '/fake/dist/telegram.mjs' },
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: mockExecFileSync };
});
vi.mock('../telegram/manager.js', () => ({
  resolveEntrypoint: () => telegram.entrypoint,
}));

// SUT imported after mocks are declared.
import {
  installSystemdService,
  readUnitFile,
  uninstallSystemdService,
} from './systemd/install.js';
import { pathUnitPath, unitPath } from './systemd/paths.js';
import { parseSystemctlShow } from './systemd/status.js';
import { renderPathUnit, renderServiceUnit } from './systemd/unit.js';

// ─────────────────────────────────────────────────────────────────────────
// Pure: unit-file generation
// ─────────────────────────────────────────────────────────────────────────

describe('renderServiceUnit', () => {
  it('emits the three sections with KeepAlive-equivalent + start-on-login invariants', () => {
    const unit = renderServiceUnit({
      description: 'AFK telegram service',
      execStart: ['/usr/bin/node', '/home/u/dist/telegram.mjs'],
      workingDirectory: '/home/u',
      logFile: '/home/u/.afk/logs/service-telegram.log',
      environmentVariables: { PATH: '/opt/node/bin:/usr/bin' },
    });
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('Type=simple');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('ExecStart="/usr/bin/node" "/home/u/dist/telegram.mjs"');
    expect(unit).toContain('StandardOutput=append:/home/u/.afk/logs/service-telegram.log');
    expect(unit).toContain('Environment="PATH=/opt/node/bin:/usr/bin"');
    expect(unit.endsWith('\n')).toBe(true);
  });

  it('sorts environment keys for stable diffs', () => {
    const unit = renderServiceUnit({
      description: 'd',
      execStart: ['/x'],
      workingDirectory: '/',
      logFile: '/l',
      environmentVariables: { ZED: '1', ALPHA: '2', MIKE: '3' },
    });
    const order = ['ALPHA', 'MIKE', 'ZED'].map((k) => unit.indexOf(`Environment="${k}=`));
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
  });

  it('omits Environment lines when none provided', () => {
    const unit = renderServiceUnit({ description: 'd', execStart: ['/x'], workingDirectory: '/', logFile: '/l' });
    expect(unit).not.toContain('Environment=');
  });

  it('escapes double quotes and backslashes in exec args and env values', () => {
    const unit = renderServiceUnit({
      description: 'd',
      execStart: ['/bin/x', 'a "b" c', 'back\\slash'],
      workingDirectory: '/',
      logFile: '/l',
      environmentVariables: { K: 'v"q\\z' },
    });
    expect(unit).toContain('"a \\"b\\" c"');
    expect(unit).toContain('"back\\\\slash"');
    expect(unit).toContain('Environment="K=v\\"q\\\\z"');
  });
});

describe('renderPathUnit', () => {
  it('emits [Path] with PathModified + paired Unit + install target', () => {
    const unit = renderPathUnit({
      description: 'AFK telegram rebuild watch',
      pathModified: ['/home/u/dev/dist/telegram.mjs'],
      unit: 'afk-telegram.service',
    });
    expect(unit).toContain('[Path]');
    expect(unit).toContain('PathModified=/home/u/dev/dist/telegram.mjs');
    expect(unit).toContain('Unit=afk-telegram.service');
    expect(unit).toContain('WantedBy=default.target');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Pure: systemctl show parsing
// ─────────────────────────────────────────────────────────────────────────

describe('parseSystemctlShow', () => {
  it('extracts pid when MainPID > 0', () => {
    const r = parseSystemctlShow('MainPID=4242\nExecMainStatus=0\nActiveState=active\nLoadState=loaded\n');
    expect(r.pid).toBe(4242);
    expect(r.lastExitStatus).toBe(0);
    expect(r.activeState).toBe('active');
    expect(r.loadState).toBe('loaded');
  });

  it('omits pid when MainPID=0 (stopped) but keeps last exit status', () => {
    const r = parseSystemctlShow('MainPID=0\nExecMainStatus=3\nActiveState=failed\n');
    expect(r.pid).toBeUndefined();
    expect(r.lastExitStatus).toBe(3);
    expect(r.activeState).toBe('failed');
  });

  it('tolerates blank lines and unknown keys', () => {
    const r = parseSystemctlShow('\nFoo=bar\nMainPID=7\n\nBaz=\n');
    expect(r.pid).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// I/O: install / uninstall against a real tmpdir
// ─────────────────────────────────────────────────────────────────────────

describe('install / uninstall I/O', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevAfkHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'afk-systemd-test-'));
    prevHome = process.env['HOME'];
    prevAfkHome = process.env['AFK_HOME'];
    process.env['HOME'] = tmpHome;
    process.env['AFK_HOME'] = join(tmpHome, '.afk');
    mockExecFileSync.mockReset();
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    telegram.entrypoint = '/fake/dist/telegram.mjs';
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    if (prevAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = prevAfkHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes the .service unit, runs daemon-reload + enable --now, returns installed', () => {
    const result = installSystemdService('telegram', { _entrypointExistsCheck: () => true });
    expect(result.kind).toBe('installed');
    if (result.kind !== 'installed') return;
    expect(result.label).toBe('afk-telegram.service');
    expect(result.autoRestartOnRebuild).toBe(false);

    const p = unitPath('telegram');
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, 'utf-8');
    expect(content).toContain('[Service]');
    expect(content).toContain('Restart=always');
    expect(content).toContain('/fake/dist/telegram.mjs');

    const calls = mockExecFileSync.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((a) => a.includes('--user daemon-reload'))).toBe(true);
    expect(calls.some((a) => a.includes('--user enable --now afk-telegram.service'))).toBe(true);
    // linger advice surfaced
    expect(result.notes?.some((n) => n.includes('enable-linger'))).toBe(true);
  });

  it('returns already-installed if the unit exists, without touching systemctl', () => {
    const p = unitPath('telegram');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, 'stale');
    const result = installSystemdService('telegram', { _entrypointExistsCheck: () => true });
    expect(result.kind).toBe('already-installed');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('dry-run writes the unit but skips systemctl and returns manual-load + linger notes', () => {
    const result = installSystemdService('telegram', { dryRun: true, _entrypointExistsCheck: () => true });
    expect(result.kind).toBe('installed');
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(existsSync(unitPath('telegram'))).toBe(true);
    if (result.kind === 'installed') {
      expect(result.notes?.some((n) => n.includes('systemctl --user daemon-reload'))).toBe(true);
      expect(result.notes?.some((n) => n.includes('enable-linger'))).toBe(true);
    }
  });

  it('emits a companion .path unit + enables it for a dev-tree entrypoint', () => {
    telegram.entrypoint = join(homedir(), 'dev', 'agent-afk', 'dist', 'telegram.mjs');
    const result = installSystemdService('telegram', { _entrypointExistsCheck: () => true });
    expect(result.kind).toBe('installed');
    if (result.kind === 'installed') expect(result.autoRestartOnRebuild).toBe(true);
    const pp = pathUnitPath('telegram');
    expect(existsSync(pp)).toBe(true);
    const content = readFileSync(pp, 'utf-8');
    expect(content).toContain('[Path]');
    expect(content).toContain('Unit=afk-telegram.service');
    const calls = mockExecFileSync.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((a) => a.includes('--user enable --now afk-telegram.path'))).toBe(true);
  });

  it('uninstall disables the unit, removes the file, daemon-reloads, returns uninstalled', () => {
    const p = unitPath('telegram');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, 'unit');
    const result = uninstallSystemdService('telegram');
    expect(result.kind).toBe('uninstalled');
    expect(existsSync(p)).toBe(false);
    const calls = mockExecFileSync.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((a) => a.includes('--user disable --now afk-telegram.service'))).toBe(true);
    expect(calls.some((a) => a.includes('--user daemon-reload'))).toBe(true);
  });

  it('uninstall returns not-installed when no unit file exists', () => {
    const result = uninstallSystemdService('telegram');
    expect(result.kind).toBe('not-installed');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('readUnitFile returns contents when installed, undefined otherwise', () => {
    expect(readUnitFile('telegram')).toBeUndefined();
    const p = unitPath('telegram');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, 'hello-unit');
    expect(readUnitFile('telegram')).toBe('hello-unit');
  });
});
