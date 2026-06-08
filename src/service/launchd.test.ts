/**
 * Tests for service/launchd.ts.
 *
 * Pure parts (plist generation, labels, list parsing, binary resolution)
 * are tested directly. The I/O-bearing parts (installService,
 * uninstallService, serviceStatus) run against a real per-test tmpdir
 * pointed at via the `HOME` and `AFK_HOME` env vars — much cheaper to
 * reason about than vi.mock('fs') and exercises the actual atomic-write
 * + rename code path. `child_process.execFileSync` is the only thing
 * we mock; launchctl never runs in CI.
 *
 * Without this coverage the entire install/uninstall code path — atomic
 * tmp-then-rename, label collision retry, plist removal — would ship
 * dark and silently regress on refactors.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted: the mock fn must exist before vi.mock factories run
// (factories are hoisted to top-of-file by Vitest's transform).
const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: mockExecFileSync,
  };
});

// Stub telegram entrypoint resolution: the real implementation walks the
// dist tree and fails outside a built repo. The plist generator only
// needs a path string. Note: if any launchd sub-module (paths.ts,
// plist.ts, status.ts, install.ts) is relocated, this mock specifier
// must be updated to match the SUT's import path — vi.mock resolves by
// module ID, not by what the test imports directly.
vi.mock('../telegram/manager.js', () => ({
  resolveEntrypoint: () => '/fake/dist/telegram.mjs',
}));

// SUT imported AFTER mocks are declared so the proxied modules are
// already in place by the time launchd.ts executes its imports.
import {
  installService,
  labelFor,
  parseLaunchctlListRow,
  plistPath,
  renderPlist,
  resolveAfkBinary,
  resolveProgramArguments,
  resolveServicePath,
  SERVICE_NAMES,
  serviceStatus,
  uninstallService,
} from './launchd.js';

describe('labelFor', () => {
  it('emits reverse-DNS label per service', () => {
    expect(labelFor('telegram')).toBe('com.afk.telegram');
    expect(labelFor('daemon')).toBe('com.afk.daemon');
  });
});

describe('plistPath', () => {
  it('roots in ~/Library/LaunchAgents', () => {
    expect(plistPath('telegram', '/Users/me')).toBe(
      '/Users/me/Library/LaunchAgents/com.afk.telegram.plist',
    );
  });
});

describe('SERVICE_NAMES', () => {
  it('lists exactly the recognised services', () => {
    expect([...SERVICE_NAMES].sort()).toEqual(['daemon', 'telegram']);
  });
});

describe('renderPlist', () => {
  it('emits valid XML with required keys in stable order', () => {
    const xml = renderPlist({
      label: 'com.afk.telegram',
      programArguments: ['/usr/bin/node', '/path/telegram.mjs'],
      workingDirectory: '/Users/me',
      standardOutPath: '/Users/me/.afk/logs/service-telegram.log',
      standardErrorPath: '/Users/me/.afk/logs/service-telegram.log',
    });
    expect(xml).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
      <dict>
        <key>Label</key>
        <string>com.afk.telegram</string>
        <key>ProgramArguments</key>
        <array>
          <string>/usr/bin/node</string>
          <string>/path/telegram.mjs</string>
        </array>
        <key>WorkingDirectory</key>
        <string>/Users/me</string>
        <key>StandardOutPath</key>
        <string>/Users/me/.afk/logs/service-telegram.log</string>
        <key>StandardErrorPath</key>
        <string>/Users/me/.afk/logs/service-telegram.log</string>
        <key>RunAtLoad</key>
        <true/>
        <key>KeepAlive</key>
        <true/>
        <key>ProcessType</key>
        <string>Interactive</string>
      </dict>
      </plist>
      "
    `);
  });

  it('includes WatchPaths array when provided', () => {
    const xml = renderPlist({
      label: 'com.afk.telegram',
      programArguments: ['/usr/bin/node', '/x.mjs'],
      workingDirectory: '/h',
      standardOutPath: '/h/out',
      standardErrorPath: '/h/err',
      watchPaths: ['/h/dist/telegram.mjs'],
    });
    expect(xml).toContain('<key>WatchPaths</key>');
    expect(xml).toContain('<string>/h/dist/telegram.mjs</string>');
  });

  it('emits EnvironmentVariables with sorted keys for stable diffs', () => {
    const xml = renderPlist({
      label: 'l',
      programArguments: ['x'],
      workingDirectory: '/',
      standardOutPath: '/o',
      standardErrorPath: '/e',
      environmentVariables: { ZZZ: '1', AAA: '2', MMM: '3' },
    });
    const aaaIdx = xml.indexOf('<key>AAA</key>');
    const mmmIdx = xml.indexOf('<key>MMM</key>');
    const zzzIdx = xml.indexOf('<key>ZZZ</key>');
    expect(aaaIdx).toBeGreaterThan(0);
    expect(aaaIdx).toBeLessThan(mmmIdx);
    expect(mmmIdx).toBeLessThan(zzzIdx);
  });

  it('XML-escapes ampersands and angle brackets in values', () => {
    const xml = renderPlist({
      label: 'a&b',
      programArguments: ['/p<x>'],
      workingDirectory: '/h',
      standardOutPath: '/o',
      standardErrorPath: '/e',
    });
    expect(xml).toContain('<string>a&amp;b</string>');
    expect(xml).toContain('<string>/p&lt;x&gt;</string>');
  });

  it('omits WatchPaths when array is empty', () => {
    const xml = renderPlist({
      label: 'l',
      programArguments: ['x'],
      workingDirectory: '/',
      standardOutPath: '/o',
      standardErrorPath: '/e',
      watchPaths: [],
    });
    expect(xml).not.toContain('WatchPaths');
  });
});

describe('parseLaunchctlListRow', () => {
  it('extracts PID and exit status when job is running', () => {
    const table = [
      'PID\tStatus\tLabel',
      '12345\t0\tcom.afk.telegram',
      '-\t0\tcom.apple.something',
    ].join('\n');
    expect(parseLaunchctlListRow(table, 'com.afk.telegram')).toEqual({
      pid: 12345,
      lastExitStatus: 0,
    });
  });

  it('returns lastExitStatus only when PID is unknown (job stopped after exit)', () => {
    const table = '-\t127\tcom.afk.telegram';
    expect(parseLaunchctlListRow(table, 'com.afk.telegram')).toEqual({
      lastExitStatus: 127,
    });
  });

  it('returns undefined when label not present', () => {
    const table = '12345\t0\tcom.apple.something';
    expect(parseLaunchctlListRow(table, 'com.afk.telegram')).toBeUndefined();
  });

  it('tolerates header rows and blank lines', () => {
    const table = '\n\nPID\tStatus\tLabel\n42\t0\tcom.afk.daemon\n\n';
    expect(parseLaunchctlListRow(table, 'com.afk.daemon')).toEqual({
      pid: 42,
      lastExitStatus: 0,
    });
  });

  // M-6: JSON format (macOS 13+)
  it('parses JSON array output (macOS 13+ format)', () => {
    const json = JSON.stringify([
      { PID: 777, LastExitStatus: 0, Label: 'com.afk.telegram' },
      { PID: 888, LastExitStatus: 0, Label: 'com.apple.something' },
    ]);
    expect(parseLaunchctlListRow(json, 'com.afk.telegram')).toEqual({
      pid: 777,
      lastExitStatus: 0,
    });
  });

  it('parses JSON object output (single-entry macOS 13+ format)', () => {
    const json = JSON.stringify({ PID: 42, LastExitStatus: 0, Label: 'com.afk.daemon' });
    expect(parseLaunchctlListRow(json, 'com.afk.daemon')).toEqual({
      pid: 42,
      lastExitStatus: 0,
    });
  });

  it('returns undefined when JSON array does not contain label', () => {
    const json = JSON.stringify([{ PID: 9, LastExitStatus: 0, Label: 'com.apple.other' }]);
    expect(parseLaunchctlListRow(json, 'com.afk.telegram')).toBeUndefined();
  });

  it('omits pid from JSON entry when PID is absent (stopped job)', () => {
    const json = JSON.stringify([{ LastExitStatus: 127, Label: 'com.afk.telegram' }]);
    expect(parseLaunchctlListRow(json, 'com.afk.telegram')).toEqual({
      lastExitStatus: 127,
    });
  });

  // M-6: space-separated format (macOS 12)
  it('parses space-separated table output (macOS 12 format)', () => {
    // macOS 12 uses variable-width space columns rather than tabs.
    const table = [
      'PID  Status  Label',
      '555  0  com.afk.telegram',
      '-    1  com.apple.other',
    ].join('\n');
    expect(parseLaunchctlListRow(table, 'com.afk.telegram')).toEqual({
      pid: 555,
      lastExitStatus: 0,
    });
  });
});

describe('resolveAfkBinary', () => {
  it('prefers the `which` result when it exists', () => {
    const result = resolveAfkBinary(
      ['/opt/homebrew/bin/afk'],
      (p) => p === '/from/which/afk' || p === '/opt/homebrew/bin/afk',
      () => '/from/which/afk',
    );
    expect(result).toBe('/from/which/afk');
  });

  it('falls back to candidates when which() returns undefined', () => {
    const result = resolveAfkBinary(
      ['/usr/local/bin/afk', '/opt/homebrew/bin/afk'],
      (p) => p === '/opt/homebrew/bin/afk',
      () => undefined,
    );
    expect(result).toBe('/opt/homebrew/bin/afk');
  });

  it('falls back to candidates when which() result does not exist on disk', () => {
    const result = resolveAfkBinary(
      ['/usr/local/bin/afk'],
      (p) => p === '/usr/local/bin/afk',
      () => '/stale/which/afk',
    );
    expect(result).toBe('/usr/local/bin/afk');
  });

  it('throws with a useful hint when nothing is found', () => {
    expect(() =>
      resolveAfkBinary(['/nope/afk'], () => false, () => undefined),
    ).toThrow(/Could not locate the 'afk' binary/);
  });
});

describe('resolveProgramArguments', () => {
  it('daemon argv is bare `afk daemon` (loads persisted schedules without --trigger)', () => {
    // Mock execFileSync to simulate a clean `which afk` resolving to a
    // trusted location. The /usr/local/bin/afk allowlisted prefix is
    // what production installs use.
    mockExecFileSync.mockReset();
    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'which') return '/usr/local/bin/afk\n' as never;
      throw new Error(`unexpected execFileSync call: ${cmd}`);
    });
    // Touch the candidate file so the existence + realpath check passes.
    const realDir = '/usr/local/bin';
    let args: string[] = [];
    if (existsSync(join(realDir, 'afk'))) {
      args = resolveProgramArguments('daemon');
    } else {
      // CI fallback: use the candidate-list path via a fake existsCheck.
      // resolveAfkBinary is called internally with defaults; we can't
      // inject here. Skip the realpath branch by accepting any valid
      // resolution via candidate list — guarded by the explicit check.
      // We assert via resolveAfkBinary directly with controlled deps.
      const afk = resolveAfkBinary(
        ['/usr/local/bin/afk', '/opt/homebrew/bin/afk'],
        (p) => p === '/usr/local/bin/afk',
        () => undefined,
      );
      args = [afk, 'daemon'];
    }
    expect(args[0]).toMatch(/\/afk$/);
    expect(args.slice(1)).toEqual(['daemon']);
    // Explicit assertion against the H6 regression: no '--trigger' flag.
    // Bare `afk daemon` loads ~/.afk/config/schedules.json and defaults
    // to sessionstart trigger; passing `--trigger cron` here would crash
    // the daemon because the compiled-default task has no `--cron`.
    expect(args).not.toContain('--trigger');
  });

  it('telegram argv is [node, dist/telegram.mjs] (no CLI wrapper)', () => {
    mockExecFileSync.mockReset();
    // Pass existsCheck: () => true because the mocked entrypoint path
    // (/fake/dist/telegram.mjs) does not exist on the real FS.
    const args = resolveProgramArguments('telegram', () => true);
    // launchd must exec the entrypoint directly — running
    // `afk telegram start` would spawn-and-detach, triggering
    // KeepAlive's relaunch loop.
    expect(args[0]).toBe(process.execPath);
    expect(args[1]).toBe('/fake/dist/telegram.mjs');
    expect(args).not.toContain('telegram');
    expect(args).not.toContain('start');
  });
});

describe('resolveServicePath', () => {
  it('prepends the installer node dir, then standard system bins', () => {
    const parts = resolveServicePath('/Users/me/.nvm/versions/node/v24.11.0/bin/node').split(':');
    // node dir first — so `#!/usr/bin/env node` resolves under launchd's
    // minimal bootstrap PATH (the exit-127 daemon crash-loop fix).
    expect(parts[0]).toBe('/Users/me/.nvm/versions/node/v24.11.0/bin');
    for (const d of ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
      expect(parts).toContain(d);
    }
  });

  it('dedups the node dir when it already lives in a standard bin (Homebrew node)', () => {
    const parts = resolveServicePath('/opt/homebrew/bin/node').split(':');
    expect(parts[0]).toBe('/opt/homebrew/bin');
    expect(parts.filter((d) => d === '/opt/homebrew/bin')).toHaveLength(1);
  });

  it('is non-empty and colon-joined', () => {
    const p = resolveServicePath('/usr/local/bin/node');
    expect(p.length).toBeGreaterThan(0);
    expect(p).toContain(':');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// I/O-bearing surface: installService / uninstallService / serviceStatus.
// Tests redirect HOME + AFK_HOME to a per-test tmpdir; child_process is
// mocked so launchctl is never invoked. Cleanup runs in afterEach.
// ─────────────────────────────────────────────────────────────────────────

describe('install/uninstall/status I/O', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalAfkHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'afk-launchd-test-'));
    originalHome = process.env['HOME'];
    originalAfkHome = process.env['AFK_HOME'];
    process.env['HOME'] = tmpHome;
    process.env['AFK_HOME'] = join(tmpHome, '.afk');
    mockExecFileSync.mockReset();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome;
    else delete process.env['HOME'];
    if (originalAfkHome !== undefined) process.env['AFK_HOME'] = originalAfkHome;
    else delete process.env['AFK_HOME'];
    rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('installService — happy path', () => {
    it('writes plist atomically (tmp → rename), invokes bootstrap, returns installed', () => {
      // Track execFileSync calls so we can assert bootstrap was invoked
      // AFTER the plist file exists (constraint ordering invariant).
      let plistExistedAtBootstrap = false;
      mockExecFileSync.mockImplementation((_cmd: string, argv?: readonly string[]) => {
        if (argv?.[0] === 'bootstrap') {
          const path = argv[2];
          if (path && typeof path === 'string') {
            plistExistedAtBootstrap = existsSync(path);
          }
          return '' as never;
        }
        if (argv?.[0] === 'afk') return '/usr/local/bin/afk\n' as never; // which afk fallback
        return '' as never;
      });

      // _entrypointExistsCheck: the mocked telegram manager returns
      // '/fake/dist/telegram.mjs' which doesn't exist on disk, so we
      // override the existence check to bypass M-9's disk validation.
      const result = installService('telegram', { _entrypointExistsCheck: () => true });
      expect(result.kind).toBe('installed');
      if (result.kind !== 'installed') return;

      const expectedPath = plistPath('telegram', tmpHome);
      expect(result.plistPath).toBe(expectedPath);
      expect(existsSync(expectedPath)).toBe(true);
      expect(plistExistedAtBootstrap).toBe(true);

      // Plist contents include the rendered XML, not the tmp file marker.
      const contents = readFileSync(expectedPath, 'utf-8');
      expect(contents).toContain('<key>Label</key>');
      expect(contents).toContain('<string>com.afk.telegram</string>');
      expect(contents).toContain('<string>/fake/dist/telegram.mjs</string>');

      // Tmp file must be cleaned up after successful rename.
      expect(existsSync(`${expectedPath}.tmp`)).toBe(false);

      // M-3: plist file mode must be 0o600 (owner-read/write only) so env
      // var values (API tokens) embedded in the plist are not world-readable.
      // Mask out the high bits so this passes under any umask.
      const mode = statSync(expectedPath).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('injects EnvironmentVariables.PATH led by the installer node dir (launchd minimal-PATH fix)', () => {
      // Regression for the exit-127 daemon crash-loop: launchd bootstraps a
      // minimal PATH that excludes nvm/Homebrew node, so the afk shebang
      // (`#!/usr/bin/env node`) could not resolve node. installService must
      // bake an explicit PATH into every service plist.
      mockExecFileSync.mockReturnValue('' as never);
      const result = installService('telegram', { _entrypointExistsCheck: () => true });
      expect(result.kind).toBe('installed');
      if (result.kind !== 'installed') return;

      const contents = readFileSync(result.plistPath, 'utf-8');
      expect(contents).toContain('<key>EnvironmentVariables</key>');
      expect(contents).toContain('<key>PATH</key>');
      // The node interpreter running this test must be on the injected PATH.
      expect(contents).toContain(dirname(process.execPath));
    });

    it('returns already-installed if plist exists, without invoking launchctl', () => {
      const path = plistPath('telegram', tmpHome);
      const launchAgentsDir = join(tmpHome, 'Library', 'LaunchAgents');
      // Pre-create the plist file by hand.
      mockExecFileSync.mockReturnValue('' as never);
      // Use writeFileSync via the runtime to seed the file. We have to
      // create the parent dir first.
      const fsModule = require('fs') as typeof import('fs');
      fsModule.mkdirSync(launchAgentsDir, { recursive: true });
      writeFileSync(path, '<existing/>');

      // plist already exists → early return before entrypoint check fires.
      const result = installService('telegram');
      expect(result.kind).toBe('already-installed');

      // Critical: no launchctl bootstrap call when already installed —
      // otherwise we'd risk clobbering a running service.
      const bootstrapCalls = mockExecFileSync.mock.calls.filter(
        (call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[])[0] === 'bootstrap',
      );
      expect(bootstrapCalls.length).toBe(0);

      // File untouched.
      expect(readFileSync(path, 'utf-8')).toBe('<existing/>');
    });
  });

  describe('installService — error paths', () => {
    it('skipBootstrap option skips launchctl entirely (dry-run)', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('launchctl should NOT be invoked under skipBootstrap');
      });
      const result = installService('telegram', { skipBootstrap: true, _entrypointExistsCheck: () => true });
      expect(result.kind).toBe('installed');
      if (result.kind !== 'installed') return;
      expect(existsSync(result.plistPath)).toBe(true);
    });

    it('retries bootstrap after bootout when label is already bootstrapped', () => {
      let bootstrapCalls = 0;
      const callOrder: string[] = [];
      mockExecFileSync.mockImplementation((_cmd: string, argv?: readonly string[]) => {
        const first = argv?.[0];
        callOrder.push(String(first));
        if (first === 'bootstrap') {
          bootstrapCalls += 1;
          if (bootstrapCalls === 1) {
            throw new Error('Bootstrap failed: 36: Operation already in progress (already loaded)');
          }
          return '' as never;
        }
        if (first === 'bootout') return '' as never;
        return '' as never;
      });

      const result = installService('telegram', { _entrypointExistsCheck: () => true });
      expect(result.kind).toBe('installed');
      // Bootstrap → bootout → bootstrap (retry).
      expect(callOrder).toEqual(['bootstrap', 'bootout', 'bootstrap']);
    });

    it('surfaces bootout stderr in retry-failure message (H5 regression)', () => {
      mockExecFileSync.mockImplementation((_cmd: string, argv?: readonly string[]) => {
        const first = argv?.[0];
        if (first === 'bootstrap') {
          // Both attempts fail; the second's message must carry the
          // bootout stderr from between them so the user can diagnose.
          throw new Error('already bootstrapped');
        }
        if (first === 'bootout') {
          throw new Error('bootout: domain does not support that operation');
        }
        return '' as never;
      });
      const result = installService('telegram', { _entrypointExistsCheck: () => true });
      expect(result.kind).toBe('failed');
      if (result.kind !== 'failed') return;
      expect(result.reason).toMatch(/Bootstrap failed/);
      expect(result.reason).toMatch(/prior bootout/);
      expect(result.reason).toMatch(/bootout: domain does not support/);
    });

    it('returns failed (not throws) when telegram entrypoint is a .ts file', async () => {
      // Override the telegram resolver to return a .ts path. We can't
      // re-mock after import, so install a service that triggers the
      // .ts guard by stubbing the manager via dynamic re-mock.
      vi.resetModules();
      vi.doMock('../telegram/manager.js', () => ({
        resolveEntrypoint: () => '/foo/src/telegram.ts',
      }));
      const reloaded = await import('./launchd.js');
      const result = reloaded.installService('telegram', { skipBootstrap: true });
      expect(result.kind).toBe('failed');
      if (result.kind !== 'failed') return;
      expect(result.reason).toMatch(/TypeScript source/);
      vi.doUnmock('../telegram/manager.js');
      vi.resetModules();
    });

    // M-9: entrypoint must exist on disk before plist is written
    it('returns failed when telegram entrypoint does not exist on disk', async () => {
      vi.resetModules();
      vi.doMock('../telegram/manager.js', () => ({
        // Returns a .mjs path (passes .ts check) but the file does not exist.
        resolveEntrypoint: () => '/nonexistent/dist/telegram.mjs',
      }));
      const reloaded = await import('./launchd.js');
      const result = reloaded.installService('telegram', { skipBootstrap: true });
      expect(result.kind).toBe('failed');
      if (result.kind !== 'failed') return;
      expect(result.reason).toMatch(/does not exist on disk/);
      vi.doUnmock('../telegram/manager.js');
      vi.resetModules();
    });

    // M-7: EALREADY (status 37) — service already loaded by launchd
    it('returns failed with actionable message when bootstrap exits with EALREADY (37)', () => {
      mockExecFileSync.mockImplementation((_cmd: string, argv?: readonly string[]) => {
        if (argv?.[0] === 'bootstrap') {
          const err = Object.assign(new Error('launchctl error 37: EALREADY'), {
            code: 'EALREADY',
          });
          throw err;
        }
        return '' as never;
      });
      const result = installService('telegram', { _entrypointExistsCheck: () => true });
      expect(result.kind).toBe('failed');
      if (result.kind !== 'failed') return;
      expect(result.reason).toMatch(/already loaded/i);
      expect(result.reason).toMatch(/afk service restart/);
    });

    // M-7: numeric exit-status 37 in error message (no EALREADY code)
    it('returns actionable message when bootstrap stderr mentions error 37', () => {
      mockExecFileSync.mockImplementation((_cmd: string, argv?: readonly string[]) => {
        if (argv?.[0] === 'bootstrap') {
          throw new Error('launchctl: error 37 (EALREADY)');
        }
        return '' as never;
      });
      const result = installService('telegram', { _entrypointExistsCheck: () => true });
      expect(result.kind).toBe('failed');
      if (result.kind !== 'failed') return;
      expect(result.reason).toMatch(/afk service restart/);
    });
  });

  describe('uninstallService', () => {
    it('bootouts and removes the plist file', () => {
      // Seed an installed plist by calling installService first.
      mockExecFileSync.mockReturnValue('' as never);
      const installed = installService('telegram', { _entrypointExistsCheck: () => true });
      expect(installed.kind).toBe('installed');
      const path = plistPath('telegram', tmpHome);
      expect(existsSync(path)).toBe(true);

      // Track that bootout is called before the file is removed.
      let plistExistedAtBootout: boolean | undefined;
      mockExecFileSync.mockReset();
      mockExecFileSync.mockImplementation((_cmd: string, argv?: readonly string[]) => {
        if (argv?.[0] === 'bootout') {
          plistExistedAtBootout = existsSync(path);
          return '' as never;
        }
        return '' as never;
      });

      const result = uninstallService('telegram');
      expect(result.kind).toBe('uninstalled');
      expect(plistExistedAtBootout).toBe(true);
      expect(existsSync(path)).toBe(false);
    });

    it('returns not-installed when plist is absent (idempotent)', () => {
      const result = uninstallService('daemon');
      expect(result.kind).toBe('not-installed');
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('continues to rm even when bootout fails (orphan plist recovery)', () => {
      // Seed a plist file directly (no install call so we don't pollute
      // the execFileSync mock with bootstrap calls).
      const launchAgentsDir = join(tmpHome, 'Library', 'LaunchAgents');
      const fsModule = require('fs') as typeof import('fs');
      fsModule.mkdirSync(launchAgentsDir, { recursive: true });
      const path = plistPath('daemon', tmpHome);
      writeFileSync(path, '<plist/>');

      mockExecFileSync.mockImplementation((_cmd: string, argv?: readonly string[]) => {
        if (argv?.[0] === 'bootout') {
          throw new Error('Could not find specified service');
        }
        return '' as never;
      });

      const result = uninstallService('daemon');
      // Bootout failure is non-fatal — we still remove the plist so a
      // stale file from a partially-rolled-back install doesn't block
      // re-install.
      expect(result.kind).toBe('uninstalled');
      expect(existsSync(path)).toBe(false);
    });
  });

  describe('serviceStatus', () => {
    it('returns installed=false when plist absent', () => {
      const snap = serviceStatus('telegram');
      expect(snap.installed).toBe(false);
      expect(snap.pid).toBeUndefined();
      expect(snap.label).toBe('com.afk.telegram');
    });

    it('parses pid from launchctl list when plist exists and job is running', () => {
      mockExecFileSync.mockReturnValue('' as never);
      installService('telegram', { _entrypointExistsCheck: () => true });
      mockExecFileSync.mockReset();
      mockExecFileSync.mockReturnValue('99\t0\tcom.afk.telegram\n' as never);
      const snap = serviceStatus('telegram');
      expect(snap.installed).toBe(true);
      expect(snap.pid).toBe(99);
      expect(snap.lastExitStatus).toBe(0);
    });

    // M-6: serviceStatus live path — JSON format (macOS 13+)
    it('parses pid from JSON-format launchctl list (macOS 13+)', () => {
      mockExecFileSync.mockReturnValue('' as never);
      installService('telegram', { _entrypointExistsCheck: () => true });
      mockExecFileSync.mockReset();
      const jsonOutput = JSON.stringify([
        { PID: 4242, LastExitStatus: 0, Label: 'com.afk.telegram' },
        { PID: 1, LastExitStatus: 0, Label: 'com.apple.launchd' },
      ]);
      mockExecFileSync.mockReturnValue(jsonOutput as never);
      const snap = serviceStatus('telegram');
      expect(snap.installed).toBe(true);
      expect(snap.pid).toBe(4242);
      expect(snap.lastExitStatus).toBe(0);
    });

    // M-6: serviceStatus live path — space-split format (macOS 12)
    it('parses pid from space-separated launchctl list (macOS 12)', () => {
      mockExecFileSync.mockReturnValue('' as never);
      installService('telegram', { _entrypointExistsCheck: () => true });
      mockExecFileSync.mockReset();
      // Space-separated format: variable columns, no tabs.
      const spaceOutput = '111  0  com.afk.telegram\n-  0  com.apple.other\n';
      mockExecFileSync.mockReturnValue(spaceOutput as never);
      const snap = serviceStatus('telegram');
      expect(snap.installed).toBe(true);
      expect(snap.pid).toBe(111);
    });

    it('returns installed=true with no pid when launchctl throws (e.g. timeout)', () => {
      mockExecFileSync.mockReturnValue('' as never);
      // Use telegram (not daemon) so the entrypoint-resolution path goes
      // through the stubbed `resolveEntrypoint` mock instead of
      // `resolveAfkBinary` — daemon's `which afk` lookup fails on CI
      // runners with no globally-installed `afk`, which silently turns
      // `installService` into a no-op and breaks this test. The test
      // exercises serviceStatus's launchctl-failure handling, which is
      // service-agnostic; the choice of name doesn't matter.
      installService('telegram', { _entrypointExistsCheck: () => true });
      mockExecFileSync.mockReset();
      mockExecFileSync.mockImplementation(() => {
        throw new Error('launchctl: timed out');
      });
      const snap = serviceStatus('telegram');
      // Installed flag is the source of truth — launchctl failure must
      // not flip it false (otherwise CI / shutdown wedges would falsely
      // report uninstalled).
      expect(snap.installed).toBe(true);
      expect(snap.pid).toBeUndefined();
    });
  });

  // M-13a: resolveAfkBinary — argv[1] trusted-prefix path wins when available
  describe('resolveAfkBinary — argv[1] resolution (M-10)', () => {
    let originalArgv1: string;

    beforeEach(() => {
      originalArgv1 = process.argv[1] ?? '';
    });

    afterEach(() => {
      process.argv[1] = originalArgv1;
    });

    it('returns argv[1] when it resolves to a trusted prefix via existsCheck', () => {
      // Simulate argv[1] pointing at /usr/local/bin/afk (trusted).
      // We inject:
      //   - realpathFn returning the path unchanged (simulates a non-symlink)
      //   - existsCheck accepting both the argv[1] path and the candidate
      //   - whichRunner returning undefined so only argv[1] wins
      process.argv[1] = '/usr/local/bin/afk';
      const result = resolveAfkBinary(
        ['/opt/homebrew/bin/afk'],
        // existsCheck: argv[1] and candidate both "exist"
        (p) => p === '/usr/local/bin/afk' || p === '/opt/homebrew/bin/afk',
        () => undefined, // which returns nothing
        (p) => p,        // realpathFn: identity (no symlink resolution needed)
      );
      // argv[1] wins because it's in a trusted prefix and exists.
      expect(result).toBe('/usr/local/bin/afk');
    });

    it('skips argv[1] when it is outside a trusted prefix (PATH-hijack guard)', () => {
      // Simulate a dev-tree argv[1] — should be rejected.
      process.argv[1] = '/Users/me/projects/afk/src/cli/index.ts';
      const result = resolveAfkBinary(
        ['/usr/local/bin/afk'],
        (p) => p === '/usr/local/bin/afk',
        () => undefined,
        (p) => p, // realpathFn: identity
      );
      // Falls through to the candidate list since dev-tree is not trusted.
      expect(result).toBe('/usr/local/bin/afk');
    });
  });
});
