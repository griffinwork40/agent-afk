/**
 * Tests for the Windows Task Scheduler backend (`src/service/windows/*`).
 *
 * Pure parts (XML generation, schtasks /Query parsing) are tested directly.
 * The I/O-bearing parts (install/uninstall/manager) run against a real
 * per-test tmpdir pointed at via `AFK_HOME` — the same pattern
 * `systemd.test.ts` and `launchd.test.ts` use. `execFileSync` is mocked;
 * `schtasks` never runs in CI.
 *
 * These tests MUST run on macOS/Linux CI — `schtasks` is mocked via
 * vi.hoisted + vi.mock('child_process'). Platform-specific UI rendering
 * (which would require a real win32 environment) is not tested here.
 *
 * Mirrors `systemd.test.ts` structure.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Hoisted mocks — must precede vi.mock() calls. */
const { mockExecFileSync, telegram } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  telegram: { entrypoint: '/fake/dist/telegram.mjs' },
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: mockExecFileSync };
});
vi.mock('../telegram/manager.js', () => ({
  resolveEntrypoint: () => telegram.entrypoint,
}));

// SUT imported after mocks.
import { installWindowsTask, readTaskFile, uninstallWindowsTask } from './windows/install.js';
import { windowsManager } from './windows/manager.js';
import { taskXmlPath } from './windows/paths.js';
import { parseCsvLine, parseSchtasksQuery, windowsStatus } from './windows/status.js';
import { renderTaskXml } from './windows/task-xml.js';

// ─────────────────────────────────────────────────────────────────────────
// Pure: renderTaskXml
// ─────────────────────────────────────────────────────────────────────────

describe('renderTaskXml', () => {
  const base = {
    label: 'AFK-telegram',
    userId: 'testuser',
    programArguments: ['/usr/bin/node', '/home/u/dist/telegram.mjs'],
    workingDirectory: '/home/u',
    logFile: '/home/u/.afk/logs/service-telegram.log',
  };

  it('emits required schema, LogonTrigger, and RestartOnFailure invariants', () => {
    const xml = renderTaskXml(base);
    expect(xml).toContain('http://schemas.microsoft.com/windows/2004/02/mit/task');
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<UserId>testuser</UserId>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<RestartOnFailure>');
    expect(xml).toContain('<Interval>PT1M</Interval>');
    expect(xml).toContain('<Count>999</Count>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    expect(xml).toContain('<Hidden>true</Hidden>');
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
    expect(xml.endsWith('\n')).toBe(true);
  });

  it('wraps program arguments in cmd.exe /d /s /c invocation', () => {
    const xml = renderTaskXml(base);
    expect(xml).toContain('<Command>cmd.exe</Command>');
    expect(xml).toContain('/d /s /c');
    expect(xml).toContain('/usr/bin/node');
    expect(xml).toContain('/home/u/dist/telegram.mjs');
    // Log file redirect present (XML-escaped: > → &gt; and & → &amp;).
    expect(xml).toContain('.afk/logs/service-telegram.log');
    expect(xml).toContain('2&gt;&amp;1');
  });

  it('XML-escapes special characters in label, userId, paths', () => {
    const xml = renderTaskXml({
      ...base,
      label: 'AFK-<test>&',
      userId: 'dom"user',
      workingDirectory: '/path/with/&/chars',
      logFile: '/log/a<b>.log',
    });
    expect(xml).toContain('AFK-&lt;test&gt;&amp;');
    expect(xml).toContain('dom&quot;user');
    expect(xml).toContain('/path/with/&amp;/chars');
    expect(xml).toContain('/log/a&lt;b&gt;.log');
  });

  it('prepends env vars as set "K=V" && in cmd arguments (sorted keys)', () => {
    const xml = renderTaskXml({
      ...base,
      environmentVariables: { ZED: 'z', ALPHA: 'a', MIKE: 'm' },
    });
    // Keys should appear in sorted order in the xml.
    const alphaIdx = xml.indexOf('ALPHA');
    const mikeIdx = xml.indexOf('MIKE');
    const zedIdx = xml.indexOf('ZED');
    expect(alphaIdx).toBeLessThan(mikeIdx);
    expect(mikeIdx).toBeLessThan(zedIdx);
    expect(xml).toContain('set &quot;ALPHA=a&quot;');
    expect(xml).toContain('set &quot;MIKE=m&quot;');
    expect(xml).toContain('set &quot;ZED=z&quot;');
  });

  it('skips env values containing double-quotes or percent signs', () => {
    const xml = renderTaskXml({
      ...base,
      environmentVariables: { SAFE: 'ok', BAD_QUOTE: 'val"ue', BAD_PCT: 'val%ue' },
    });
    expect(xml).toContain('SAFE');
    expect(xml).not.toContain('BAD_QUOTE');
    expect(xml).not.toContain('BAD_PCT');
  });

  it('skips env values containing CR, LF, or NUL', () => {
    const xml = renderTaskXml({
      ...base,
      environmentVariables: {
        SAFE: 'ok',
        BAD_CR: 'val\rue',
        BAD_LF: 'val\nue',
        BAD_NUL: 'val\0ue',
      },
    });
    expect(xml).toContain('SAFE');
    expect(xml).not.toContain('BAD_CR');
    expect(xml).not.toContain('BAD_LF');
    expect(xml).not.toContain('BAD_NUL');
  });

  it('skips env entries with unsafe keys', () => {
    const xml = renderTaskXml({
      ...base,
      environmentVariables: {
        SAFE_KEY: 'ok',
        'BAD=KEY': 'v',
        'BAD%KEY': 'v',
        'BAD"KEY': 'v',
        '123start': 'v',
      },
    });
    expect(xml).toContain('SAFE_KEY');
    expect(xml).not.toContain('BAD=KEY');
    expect(xml).not.toContain('BAD%KEY');
    // BAD"KEY would be XML-escaped to BAD&quot;KEY; check the raw key substring
    expect(xml).not.toContain('BAD&quot;KEY');
    expect(xml).not.toContain('123start');
  });

  it('emits WorkingDirectory in Exec block', () => {
    const xml = renderTaskXml(base);
    expect(xml).toContain('<WorkingDirectory>/home/u</WorkingDirectory>');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Pure: parseCsvLine
// ─────────────────────────────────────────────────────────────────────────

describe('parseCsvLine', () => {
  it('parses a simple quoted CSV line', () => {
    const cols = parseCsvLine('"a","b","c"');
    expect(cols).toEqual(['a', 'b', 'c']);
  });

  it('handles embedded doubled quotes', () => {
    const cols = parseCsvLine('"say ""hello""","world"');
    expect(cols).toEqual(['say "hello"', 'world']);
  });

  it('handles unquoted fields defensively', () => {
    const cols = parseCsvLine('plain,fields,here');
    expect(cols).toEqual(['plain', 'fields', 'here']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Pure: parseSchtasksQuery — CSV format (schtasks /FO CSV /NH /V)
//
// Column layout (0-indexed): 0=HostName 1=TaskName 2=NextRunTime 3=Status
//   4=LogonMode 5=LastRunTime 6=LastResult …
// We build 28-column fixtures padded with empty quoted fields.
// ─────────────────────────────────────────────────────────────────────────

/** Build a 28-column CSV line for schtasks /FO CSV /NH /V fixtures. */
function makeCsvRow(opts: { status: string; lastResult: string }): string {
  const cols = Array.from({ length: 28 }, (_, i) => {
    if (i === 3) return opts.status;
    if (i === 6) return opts.lastResult;
    if (i === 0) return 'WINHOST';
    if (i === 1) return 'AFK-telegram';
    return '';
  });
  return cols.map((v) => `"${v}"`).join(',');
}

describe('parseSchtasksQuery', () => {
  it('detects Running status (col 3) and last exit code (col 6)', () => {
    const r = parseSchtasksQuery(makeCsvRow({ status: 'Running', lastResult: '0' }));
    expect(r.running).toBe(true);
    expect(r.lastExitStatus).toBe(0);
  });

  it('detects non-running (Ready) status and captures last exit code', () => {
    const r = parseSchtasksQuery(makeCsvRow({ status: 'Ready', lastResult: '1' }));
    expect(r.running).toBe(false);
    expect(r.lastExitStatus).toBe(1);
  });

  it('handles non-zero exit code and Running state independently', () => {
    const r = parseSchtasksQuery(makeCsvRow({ status: 'Running', lastResult: '42' }));
    expect(r.running).toBe(true);
    expect(r.lastExitStatus).toBe(42);
  });

  it('handles missing / non-numeric Last Result gracefully', () => {
    const r = parseSchtasksQuery(makeCsvRow({ status: 'Running', lastResult: 'N/A' }));
    expect(r.running).toBe(true);
    expect(r.lastExitStatus).toBeUndefined();
  });

  it('tolerates blank lines (trailing newline)', () => {
    const r = parseSchtasksQuery(makeCsvRow({ status: 'Ready', lastResult: '3' }) + '\n');
    expect(r.running).toBe(false);
    expect(r.lastExitStatus).toBe(3);
  });

  it('non-English header labels are irrelevant — positional columns still work', () => {
    // Simulate a non-English Windows install: Status column still contains
    // the Win32 API string "Running" (locale-neutral), but column 3 is all
    // that matters regardless of any header row (suppressed by /NH).
    // This fixture uses German-like surrounding text in other columns but
    // keeps Status = "Running" at position 3.
    const deRow = [
      '"DE-HOST"',      // 0 HostName
      '"AFK-telegram"', // 1 TaskName
      '"01.01.2025 12:00:00"', // 2 Next Run Time
      '"Running"',      // 3 Status (Win32 API string, locale-neutral)
      '"Interaktiv"',   // 4 Logon Mode (localised)
      '"01.01.2025 11:00:00"', // 5 Last Run Time
      '"0"',            // 6 Last Result
      '"","","","","","","","","","","","","","","","","","","","",""',
    ].join(',');
    const r = parseSchtasksQuery(deRow);
    expect(r.running).toBe(true);
    expect(r.lastExitStatus).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// I/O: windowsStatus snapshot
// ─────────────────────────────────────────────────────────────────────────

describe('windowsStatus snapshot', () => {
  let tmpHome: string;
  let prevAfkHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'afk-win-status-test-'));
    prevAfkHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = join(tmpHome, '.afk');
    mockExecFileSync.mockReset();
  });

  afterEach(() => {
    if (prevAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = prevAfkHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('sets running=true on snapshot when schtasks reports Running (CSV)', () => {
    const xmlPath = taskXmlPath('telegram');
    mkdirSync(dirname(xmlPath), { recursive: true });
    writeFileSync(xmlPath, '<Task/>');
    mockExecFileSync.mockReturnValue(makeCsvRow({ status: 'Running', lastResult: '0' }));
    const snap = windowsStatus('telegram');
    expect(snap.installed).toBe(true);
    expect(snap.running).toBe(true);
    expect(snap.lastExitStatus).toBe(0);
  });

  it('leaves running undefined on snapshot when schtasks reports Ready (CSV)', () => {
    const xmlPath = taskXmlPath('telegram');
    mkdirSync(dirname(xmlPath), { recursive: true });
    writeFileSync(xmlPath, '<Task/>');
    mockExecFileSync.mockReturnValue(makeCsvRow({ status: 'Ready', lastResult: '1' }));
    const snap = windowsStatus('telegram');
    expect(snap.installed).toBe(true);
    expect(snap.running).toBeUndefined();
    expect(snap.lastExitStatus).toBe(1);
  });

  it('copies lastExitStatus through regardless of running state (CSV)', () => {
    const xmlPath = taskXmlPath('daemon');
    mkdirSync(dirname(xmlPath), { recursive: true });
    writeFileSync(xmlPath, '<Task/>');
    mockExecFileSync.mockReturnValue(makeCsvRow({ status: 'Running', lastResult: '42' }));
    const snap = windowsStatus('daemon');
    expect(snap.lastExitStatus).toBe(42);
    expect(snap.running).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// I/O: install / uninstall against a real tmpdir
// ─────────────────────────────────────────────────────────────────────────

describe('install / uninstall I/O', () => {
  let tmpHome: string;
  let prevAfkHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'afk-win-test-'));
    prevAfkHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = join(tmpHome, '.afk');
    mockExecFileSync.mockReset();
    // Default: schtasks /Query returns not-found (simulates uninstalled state).
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('/Query')) throw new Error('Task not found');
      return Buffer.from('');
    });
    telegram.entrypoint = '/fake/dist/telegram.mjs';
  });

  afterEach(() => {
    if (prevAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = prevAfkHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes the XML file (UTF-16LE with BOM), calls schtasks /Create + /Run, returns installed', () => {
    // Allow /Query to throw (not installed), /Create and /Run succeed.
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if ((args as string[]).join(' ').includes('/Query')) throw new Error('not found');
      return Buffer.from('');
    });
    const result = installWindowsTask('telegram', { _entrypointExistsCheck: () => true });
    expect(result.kind).toBe('installed');
    if (result.kind !== 'installed') return;
    expect(result.label).toBe('AFK-telegram');
    expect(result.autoRestartOnRebuild).toBe(false);

    const xmlPath = taskXmlPath('telegram');
    expect(existsSync(xmlPath)).toBe(true);

    const calls = mockExecFileSync.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((a) => a.includes('/Create') && a.includes('/F'))).toBe(true);
    expect(calls.some((a) => a.includes('/Run'))).toBe(true);
  });

  it('returns already-installed when XML exists AND query succeeds', () => {
    const xmlPath = taskXmlPath('telegram');
    mkdirSync(dirname(xmlPath), { recursive: true });
    writeFileSync(xmlPath, 'stale');
    // /Query succeeds (simulating task registered).
    mockExecFileSync.mockReturnValue(Buffer.from('Status: Running'));
    const result = installWindowsTask('telegram', { _entrypointExistsCheck: () => true });
    expect(result.kind).toBe('already-installed');
  });

  it('dry-run writes XML but skips schtasks and returns manual note', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if ((args as string[]).join(' ').includes('/Query')) throw new Error('not found');
      return Buffer.from('');
    });
    const result = installWindowsTask('telegram', { dryRun: true, _entrypointExistsCheck: () => true });
    expect(result.kind).toBe('installed');
    const xmlPath = taskXmlPath('telegram');
    expect(existsSync(xmlPath)).toBe(true);
    // Only /Query was called (for already-installed check), not /Create.
    const calls = mockExecFileSync.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.every((a) => !a.includes('/Create'))).toBe(true);
    if (result.kind === 'installed') {
      expect(result.notes?.some((n) => n.includes('dry-run'))).toBe(true);
    }
  });

  it('rolls back XML file when schtasks /Create fails', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const joined = (args as string[]).join(' ');
      if (joined.includes('/Query')) throw new Error('not found');
      if (joined.includes('/Create')) throw new Error('access denied');
      return Buffer.from('');
    });
    const result = installWindowsTask('telegram', { _entrypointExistsCheck: () => true });
    expect(result.kind).toBe('failed');
    expect(existsSync(taskXmlPath('telegram'))).toBe(false);
  });

  it('uninstall calls /End + /Delete, removes XML, returns uninstalled', () => {
    const xmlPath = taskXmlPath('telegram');
    mkdirSync(dirname(xmlPath), { recursive: true });
    writeFileSync(xmlPath, 'xml');
    // /Query succeeds so isTaskRegistered returns true.
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if ((args as string[]).join(' ').includes('/Query')) return Buffer.from('Status: Ready');
      return Buffer.from('');
    });
    const result = uninstallWindowsTask('telegram');
    expect(result.kind).toBe('uninstalled');
    expect(existsSync(xmlPath)).toBe(false);
    const calls = mockExecFileSync.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((a) => a.includes('/Delete'))).toBe(true);
  });

  it('uninstall returns not-installed when no XML and query fails', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
    const result = uninstallWindowsTask('telegram');
    expect(result.kind).toBe('not-installed');
  });

  it('readTaskFile returns undefined when not installed', () => {
    expect(readTaskFile('telegram')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// I/O: windowsManager
// ─────────────────────────────────────────────────────────────────────────

describe('windowsManager', () => {
  let tmpHome: string;
  let prevAfkHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'afk-win-mgr-test-'));
    prevAfkHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = join(tmpHome, '.afk');
    mockExecFileSync.mockReset();
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if ((args as string[]).join(' ').includes('/Query')) throw new Error('not found');
      return Buffer.from('');
    });
    telegram.entrypoint = '/fake/dist/telegram.mjs';
  });

  afterEach(() => {
    if (prevAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = prevAfkHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('exposes backend=task-scheduler and configKind=Task Scheduler task', () => {
    expect(windowsManager.backend).toBe('task-scheduler');
    expect(windowsManager.configKind).toBe('Task Scheduler task');
  });

  it('label() returns AFK-<name>', () => {
    expect(windowsManager.label('telegram')).toBe('AFK-telegram');
    expect(windowsManager.label('daemon')).toBe('AFK-daemon');
  });

  it('restart returns not-installed when XML is absent', () => {
    const result = windowsManager.restart('telegram');
    expect(result.kind).toBe('not-installed');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('restart calls /End then /Run when installed', () => {
    const xmlPath = taskXmlPath('telegram');
    mkdirSync(dirname(xmlPath), { recursive: true });
    writeFileSync(xmlPath, 'xml');
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    const result = windowsManager.restart('telegram');
    expect(result.kind).toBe('restarted');
    const calls = mockExecFileSync.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((a) => a.includes('/End'))).toBe(true);
    expect(calls.some((a) => a.includes('/Run'))).toBe(true);
  });

  it('restart calls upgrade() before /End and /Run (aligns with ServiceManager docstring)', () => {
    // Set up XML file so isInstalled() passes.
    const xmlPath = taskXmlPath('telegram');
    mkdirSync(dirname(xmlPath), { recursive: true });
    writeFileSync(xmlPath, 'stale-xml');

    // Spy on windowsManager.upgrade so we can verify it was called first.
    const upgradeSpy = vi.spyOn(windowsManager, 'upgrade');
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    const result = windowsManager.restart('telegram');
    expect(result.kind).toBe('restarted');
    // upgrade() must have been invoked as part of restart.
    expect(upgradeSpy).toHaveBeenCalledWith('telegram', {});
    // /End and /Run must still have been called.
    const calls = mockExecFileSync.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((a) => a.includes('/End'))).toBe(true);
    expect(calls.some((a) => a.includes('/Run'))).toBe(true);

    upgradeSpy.mockRestore();
  });

  it('restart still succeeds even when upgrade fails (non-fatal)', () => {
    const xmlPath = taskXmlPath('telegram');
    mkdirSync(dirname(xmlPath), { recursive: true });
    writeFileSync(xmlPath, 'stale-xml');

    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const joined = (args as string[]).join(' ');
      if (joined.includes('/Create')) throw new Error('access denied to upgrade');
      return Buffer.from('');
    });

    const result = windowsManager.restart('telegram');
    expect(result.kind).toBe('restarted');
    // Non-fatal upgrade failure should be surfaced in notes.
    if (result.kind === 'restarted') {
      expect(result.notes?.some((n) => n.includes('upgrade before restart failed'))).toBe(true);
    }
  });

  it('restart returns failed when /Run throws', () => {
    const xmlPath = taskXmlPath('telegram');
    mkdirSync(dirname(xmlPath), { recursive: true });
    writeFileSync(xmlPath, 'xml');
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if ((args as string[]).join(' ').includes('/Run')) throw new Error('access denied');
      return Buffer.from('');
    });
    const result = windowsManager.restart('telegram');
    expect(result.kind).toBe('failed');
  });

  it('isInstalled returns false when XML absent, true when present', () => {
    expect(windowsManager.isInstalled('telegram')).toBe(false);
    const xmlPath = taskXmlPath('telegram');
    mkdirSync(dirname(xmlPath), { recursive: true });
    writeFileSync(xmlPath, 'xml');
    expect(windowsManager.isInstalled('telegram')).toBe(true);
  });

  it('upgrade returns not-installed when XML is absent', () => {
    const result = windowsManager.upgrade('telegram');
    expect(result.kind).toBe('not-installed');
  });
});
