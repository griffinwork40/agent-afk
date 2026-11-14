/**
 * Shell-free spawn-argument construction (#4293 review S-1/C-1). The win32
 * branch is a pure function with platform/lookup/readFile injected, so it is
 * exercised on every host; CI Windows is the only real Windows check.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { buildSpawnCommand } from './client-process.js';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const BIN_DIR = 'C:\\Users\\Jane Doe\\.afk\\cache\\lsp-servers\\typescript\\node_modules\\.bin';
const SHIM = path.win32.join(BIN_DIR, 'typescript-language-server.cmd');
/** Body of a current npm cmd-shim. */
const SHIM_TEXT = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\typescript-language-server\\lib\\cli.mjs" %*',
].join('\r\n');

describe('buildSpawnCommand', () => {
  it('POSIX: passes command and args through unchanged', () => {
    expect(buildSpawnCommand('/usr/bin/tsls', ['--stdio'], { platform: 'linux' }))
      .toEqual({ file: '/usr/bin/tsls', args: ['--stdio'] });
    expect(buildSpawnCommand('gopls', [], { platform: 'darwin', lookup: () => { throw new Error('no'); } }))
      .toEqual({ file: 'gopls', args: [] });
  });

  it('win32: resolves an npm .cmd shim (path with spaces) to node + JS entry', () => {
    const cmd = buildSpawnCommand(SHIM, ['--stdio'], {
      platform: 'win32', execPath: NODE, readFile: () => SHIM_TEXT,
    });
    expect(cmd.file).toBe(NODE);
    expect(cmd.args).toEqual([
      path.win32.join(BIN_DIR, '..', 'typescript-language-server', 'lib', 'cli.mjs'),
      '--stdio',
    ]);
  });

  it('win32: understands the older %~dp0\\ shim form', () => {
    const cmd = buildSpawnCommand(SHIM, [], {
      platform: 'win32', execPath: NODE,
      readFile: () => '@"%~dp0\\node.exe"  "%~dp0\\..\\pyright\\langserver.index.js" %*',
    });
    expect(cmd.args[0]).toBe(path.win32.join(BIN_DIR, '..', 'pyright', 'langserver.index.js'));
  });

  it('win32: resolves a bare PATH name to its shim before parsing it', () => {
    const cmd = buildSpawnCommand('typescript-language-server', ['--stdio'], {
      platform: 'win32', execPath: NODE, readFile: () => SHIM_TEXT,
      lookup: (bin, platform) => (platform === 'win32' && bin === 'typescript-language-server' ? SHIM : undefined),
    });
    expect(cmd.file).toBe(NODE);
    expect(cmd.args[1]).toBe('--stdio');
  });

  it('win32: a resolved .exe is spawned directly', () => {
    const exe = 'C:\\tools\\gopls.exe';
    expect(buildSpawnCommand('gopls', [], { platform: 'win32', lookup: () => exe }))
      .toEqual({ file: exe, args: [] });
  });

  it('win32: refuses a .cmd that is not an npm shim (never falls back to a shell)', () => {
    expect(() => buildSpawnCommand('C:\\x\\evil.cmd', [], {
      platform: 'win32', readFile: () => 'calc.exe & del *',
    })).toThrow(/not an npm shim/);
    expect(() => buildSpawnCommand('C:\\x\\a.bat', [], {
      platform: 'win32', readFile: () => '"%dp0%\\..\\x\\run.exe" %*',
    })).toThrow(/not an npm shim/);
  });
});
