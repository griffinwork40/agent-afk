/**
 * Tests for `src/service/windows/argv.ts` — win32 argv resolution for the
 * Task Scheduler backend. Pure (all fs/process access is injected), so it
 * runs on every CI platform.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { telegram } = vi.hoisted(() => ({ telegram: { entrypoint: 'C:\\afk\\dist\\telegram.mjs' } }));
vi.mock('../telegram/manager.js', () => ({ resolveEntrypoint: () => telegram.entrypoint }));

import { resolveWindowsProgramArguments } from './windows/argv.js';
import { renderWindowsTask } from './windows/install.js';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const CLI = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\agent-afk\\dist\\cli.mjs';
const identity = (p: string): string => p;

describe('resolveWindowsProgramArguments', () => {
  it('daemon: runs the current CLI script under process.execPath (no POSIX afk lookup)', () => {
    const argv = resolveWindowsProgramArguments('daemon', {
      argv1: CLI,
      execPath: NODE,
      realpathFn: identity,
      existsCheck: () => true,
    });
    expect(argv).toEqual([NODE, CLI, 'daemon']);
  });

  it('daemon: refuses a TypeScript source entry', () => {
    expect(() =>
      resolveWindowsProgramArguments('daemon', {
        argv1: 'C:\\dev\\src\\cli.ts',
        execPath: NODE,
        realpathFn: identity,
        existsCheck: () => true,
      }),
    ).toThrow(/TypeScript source/);
  });

  it('daemon: refuses a non-JS or missing entry', () => {
    expect(() =>
      resolveWindowsProgramArguments('daemon', {
        argv1: 'C:\\npm\\afk.cmd',
        execPath: NODE,
        realpathFn: identity,
        existsCheck: () => true,
      }),
    ).toThrow(/not a JavaScript file/);
    expect(() =>
      resolveWindowsProgramArguments('daemon', {
        argv1: CLI,
        execPath: NODE,
        realpathFn: identity,
        existsCheck: () => false,
      }),
    ).toThrow(/not a JavaScript file/);
  });

  it('daemon: throws when argv[1] is empty or unresolvable', () => {
    expect(() => resolveWindowsProgramArguments('daemon', { argv1: undefined })).toThrow(/argv\[1\]/);
    expect(() =>
      resolveWindowsProgramArguments('daemon', {
        argv1: CLI,
        realpathFn: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toThrow(/Could not resolve/);
  });

  it('telegram: delegates to the shared [execPath, entry] shape', () => {
    const argv = resolveWindowsProgramArguments('telegram', { existsCheck: () => true });
    expect(argv).toEqual([process.execPath, telegram.entrypoint]);
  });
});

describe('renderWindowsTask', () => {
  let tmpHome: string;
  let prevAfkHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'afk-win-argv-'));
    prevAfkHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = join(tmpHome, '.afk');
  });

  afterEach(() => {
    if (prevAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = prevAfkHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('does not inject a PATH override (task inherits the user environment)', () => {
    const xml = renderWindowsTask('telegram', { _entrypointExistsCheck: () => true });
    expect(xml).not.toContain('set &quot;PATH=');
    expect(xml).toContain(telegram.entrypoint.replace(/\\/g, '\\'));
  });

  it('passes explicit environment entries through as set segments', () => {
    const xml = renderWindowsTask('telegram', {
      _entrypointExistsCheck: () => true,
      environment: { AFK_FOO: 'bar' },
    });
    expect(xml).toContain('set &quot;AFK_FOO=bar&quot; &amp;&amp;');
  });
});
