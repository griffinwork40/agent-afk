/**
 * Tests for the cd-on-exit marker file used by `afk shell-init`.
 *
 * The contract under test is observable filesystem state: the marker file
 * exists with the recorded path after `recordCdIntent`, and is removed
 * after `clearCdIntent`. AFK_HOME is redirected at a tmpdir per test so
 * runs are isolated and the user's real ~/.afk/ state is untouched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearCdIntent,
  getCdIntentPath,
  recordCdIntent,
  SHELL_WRAPPER_ENV_VAR,
  shellWrapperActive,
} from './cd-on-exit.js';

describe('cd-on-exit', () => {
  let tmp: string;
  let prevAfkHome: string | undefined;
  let prevWrapper: string | undefined;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'afk-cd-intent-')));
    prevAfkHome = process.env['AFK_HOME'];
    prevWrapper = process.env[SHELL_WRAPPER_ENV_VAR];
    process.env['AFK_HOME'] = tmp;
    delete process.env[SHELL_WRAPPER_ENV_VAR];
  });

  afterEach(() => {
    if (prevAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = prevAfkHome;
    if (prevWrapper === undefined) delete process.env[SHELL_WRAPPER_ENV_VAR];
    else process.env[SHELL_WRAPPER_ENV_VAR] = prevWrapper;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('getCdIntentPath resolves under $AFK_HOME/state/', () => {
    expect(getCdIntentPath()).toBe(join(tmp, 'state', 'last-cwd'));
  });

  it('recordCdIntent writes the target path to the marker file', () => {
    recordCdIntent('/some/worktree/path');
    expect(existsSync(getCdIntentPath())).toBe(true);
    expect(readFileSync(getCdIntentPath(), 'utf8')).toBe('/some/worktree/path');
  });

  it('recordCdIntent creates the state dir if missing', () => {
    // $AFK_HOME/state/ does not yet exist
    expect(existsSync(join(tmp, 'state'))).toBe(false);
    recordCdIntent('/another/path');
    expect(existsSync(getCdIntentPath())).toBe(true);
  });

  it('recordCdIntent overwrites prior contents', () => {
    recordCdIntent('/first');
    recordCdIntent('/second');
    expect(readFileSync(getCdIntentPath(), 'utf8')).toBe('/second');
  });

  it('clearCdIntent removes an existing marker file', () => {
    recordCdIntent('/some/path');
    expect(existsSync(getCdIntentPath())).toBe(true);
    clearCdIntent();
    expect(existsSync(getCdIntentPath())).toBe(false);
  });

  it('clearCdIntent is a no-op when no marker exists', () => {
    expect(existsSync(getCdIntentPath())).toBe(false);
    expect(() => clearCdIntent()).not.toThrow();
  });

  it('clearCdIntent removes a symlink at the marker path without touching the symlink target', () => {
    // clearCdIntent uses rmSync({force: true}) which handles symlinks by
    // removing the symlink itself. A future refactor to unlinkSync would
    // also work correctly, but this test documents the contract explicitly
    // so a regression (e.g. rmdir or recursive delete) fails loudly.
    //
    // Contract: only the marker symlink is removed, NOT the file it points at.
    const stateDir = join(tmp, 'state');
    mkdirSync(stateDir, { recursive: true });
    const markerPath = getCdIntentPath();

    // Create a real target file that the symlink points at.
    const realTarget = join(tmp, 'symlink-target.txt');
    writeFileSync(realTarget, 'target contents', 'utf8');

    // Place a symlink at the marker location pointing to the real target.
    symlinkSync(realTarget, markerPath);
    expect(lstatSync(markerPath).isSymbolicLink()).toBe(true);

    clearCdIntent();

    // The symlink is gone.
    expect(existsSync(markerPath)).toBe(false);
    // The symlink TARGET is intact.
    expect(existsSync(realTarget)).toBe(true);
    expect(readFileSync(realTarget, 'utf8')).toBe('target contents');
  });

  it('recordCdIntent swallows write failures (e.g. read-only state dir)', () => {
    // Pre-create the state dir as a file, so mkdirSync({recursive: true})
    // on the parent succeeds but writeFileSync to last-cwd fails because
    // a path component is a file, not a directory.
    const stateDir = join(tmp, 'state');
    mkdirSync(dirname(stateDir), { recursive: true });
    writeFileSync(stateDir, 'not-a-dir', 'utf8');
    // Should not throw — best-effort contract.
    expect(() => recordCdIntent('/x')).not.toThrow();
  });

  it('recordCdIntent rejects a relative path (would resolve against shell cwd)', () => {
    expect(() => recordCdIntent('relative/path')).toThrow(/absolute/);
    expect(() => recordCdIntent('./also-relative')).toThrow(/absolute/);
    expect(() => recordCdIntent('')).toThrow(/absolute/);
  });

  it('recordCdIntent rejects paths containing newline / CR / NUL', () => {
    // POSIX allows \n in filenames, but $(cat marker) silently truncates
    // to the first line, landing the user in the wrong directory.
    expect(() => recordCdIntent('/has/new\nline')).toThrow(/newline/);
    expect(() => recordCdIntent('/has/c\rriage')).toThrow(/newline/);
    expect(() => recordCdIntent('/has/n\0ul')).toThrow(/newline/);
  });

  it('recordCdIntent succeeds on paths with spaces, $, backticks, single-quotes', () => {
    // Robustness: a legitimate $AFK_HOME like /Users/Jane Doe/.afk produces
    // a worktree path with spaces. Recording it must not corrupt the file
    // (the wrapper escapes the marker path at read time).
    const weird = '/Users/Jane Doe/.afk/path with $var and `tick` and \'quote\'';
    expect(() => recordCdIntent(weird)).not.toThrow();
    expect(readFileSync(getCdIntentPath(), 'utf8')).toBe(weird);
  });

  it('recordCdIntent writes atomically (no zero-byte marker on a fresh state dir)', () => {
    // The atomic-write contract: at no observable point should the marker
    // exist with a partial / empty content. Verify the final state.
    recordCdIntent('/atomic/test');
    expect(readFileSync(getCdIntentPath(), 'utf8')).toBe('/atomic/test');
    // No leftover tmp files in the state dir.
    const stateDir = join(tmp, 'state');
    const entries = readdirSync(stateDir);
    const tmps = entries.filter((e) => e.startsWith('last-cwd.tmp.'));
    expect(tmps).toEqual([]);
  });

  it('recordCdIntent cleans up the tmp file when rename fails', () => {
    // Force rename failure by pre-creating the target as a directory
    // (rename(2) refuses to overwrite a non-empty directory).
    const target = getCdIntentPath();
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'sentinel'), 'x', 'utf8'); // non-empty
    // Best-effort: must not throw, and must not leave a tmp file behind.
    expect(() => recordCdIntent('/x')).not.toThrow();
    const entries = readdirSync(join(tmp, 'state'));
    const tmps = entries.filter((e) => e.startsWith('last-cwd.tmp.'));
    expect(tmps).toEqual([]);
  });

  it('clearCdIntent swallows rm failures', () => {
    // No file present, rmSync with force: true is silent; this just
    // documents that the function never throws even on weird states.
    expect(() => clearCdIntent()).not.toThrow();
  });

  it('shellWrapperActive returns true when AFK_SHELL_WRAPPER=1', () => {
    process.env[SHELL_WRAPPER_ENV_VAR] = '1';
    expect(shellWrapperActive()).toBe(true);
  });

  it('shellWrapperActive returns true when AFK_SHELL_WRAPPER=true', () => {
    process.env[SHELL_WRAPPER_ENV_VAR] = 'true';
    expect(shellWrapperActive()).toBe(true);
  });

  it('shellWrapperActive returns false when env var is unset', () => {
    delete process.env[SHELL_WRAPPER_ENV_VAR];
    expect(shellWrapperActive()).toBe(false);
  });

  it('shellWrapperActive returns false for unrecognized values', () => {
    process.env[SHELL_WRAPPER_ENV_VAR] = 'yes';
    expect(shellWrapperActive()).toBe(false);
    process.env[SHELL_WRAPPER_ENV_VAR] = '0';
    expect(shellWrapperActive()).toBe(false);
  });
});

// Local dirname helper to avoid an extra import on the type-checker.
function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
