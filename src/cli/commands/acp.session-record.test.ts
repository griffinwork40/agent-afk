/**
 * Per-session ACP record (profile §2): real files under a temp state dir.
 *
 * @module cli/commands/acp.session-record.test
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env.js';
import { getAcpSessionRecordPath } from '../../paths.journal.js';
import { readAcpSessionRecord, writeAcpSessionRecord } from './acp.session-record.js';

let state: string;

/** Directory link; where Windows refuses a symlink (EPERM without the privilege) a junction is used. */
function linkDir(target: string, link: string): void {
  try {
    symlinkSync(target, link, 'dir');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    symlinkSync(target, link, 'junction');
  }
}

beforeEach(() => {
  state = mkdtempSync(path.join(os.tmpdir(), 'acp-record-'));
  vi.spyOn(env, 'AFK_STATE_DIR', 'get').mockReturnValue(state);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(state, { recursive: true, force: true });
});

describe('getAcpSessionRecordPath', () => {
  it('is one file per id under the ACP state directory', () => {
    expect(getAcpSessionRecordPath('abc-1')).toBe(path.join(state, 'acp', 'sessions', 'abc-1.json'));
  });

  it.each(['', '.', '..', '../x', 'a/b', 'a\\b', 'a.json', 'x'.repeat(129), 'a\0b'])('rejects unsafe id %j', (id) => {
    expect(() => getAcpSessionRecordPath(id)).toThrow(/Invalid ACP session id/);
    expect(() => writeAcpSessionRecord(id, { cwd: state })).toThrow(/Invalid ACP session id/);
    expect(() => readAcpSessionRecord(id)).toThrow(/Invalid ACP session id/);
  });
});

describe('writeAcpSessionRecord / readAcpSessionRecord', () => {
  it('round-trips the cwd and creates the parent directory', () => {
    writeAcpSessionRecord('s1', { cwd: '/ws' });
    expect(readAcpSessionRecord('s1')).toEqual({ cwd: '/ws' });
  });

  it('writes the file owner-only', () => {
    writeAcpSessionRecord('s1', { cwd: '/ws' });
    const mode = statSync(getAcpSessionRecordPath('s1')).mode & 0o777;
    // POSIX permission bits are not represented on Windows.
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
    else expect(mode & 0o400).toBe(0o400);
  });

  it('returns undefined only when the record does not exist', () => {
    expect(readAcpSessionRecord('missing')).toBeUndefined();
  });

  it.each(['not json', '[]', 'null', '{}', '{"cwd":""}', '{"cwd":3}'])('throws on a malformed record %j', (raw) => {
    mkdirSync(path.dirname(getAcpSessionRecordPath('bad')), { recursive: true });
    writeFileSync(getAcpSessionRecordPath('bad'), raw);
    expect(() => readAcpSessionRecord('bad')).toThrow();
  });

  it('throws when the record exists but cannot be read', () => {
    mkdirSync(getAcpSessionRecordPath('dir'), { recursive: true });
    expect(() => readAcpSessionRecord('dir')).toThrow();
  });

  it('throws, on every platform, when a parent of the record path is a file', () => {
    mkdirSync(path.join(state, 'acp'), { recursive: true });
    writeFileSync(path.join(state, 'acp', 'sessions'), 'not a directory');
    expect(() => readAcpSessionRecord('blocked-1')).toThrow();
  });

  it('returns undefined when the sessions directory does not exist yet', () => {
    expect(readAcpSessionRecord('fresh-1')).toBeUndefined();
  });

  it('a sessions directory that is a link to a directory is not treated as blocked', () => {
    const real = path.join(state, 'real-sessions');
    mkdirSync(real);
    mkdirSync(path.join(state, 'acp'));
    linkDir(real, path.join(state, 'acp', 'sessions'));
    expect(readAcpSessionRecord('via-link-1')).toBeUndefined();
    writeAcpSessionRecord('via-link-2', { cwd: path.join(state, 'project') });
    expect(readAcpSessionRecord('via-link-2')).toEqual({ cwd: path.join(state, 'project') });
  });

  it('a state directory reached through a link, with no acp tree yet, is not treated as blocked', () => {
    const realState = path.join(state, 'real-state');
    mkdirSync(realState);
    const linked = path.join(state, 'state-link');
    linkDir(realState, linked);
    vi.spyOn(env, 'AFK_STATE_DIR', 'get').mockReturnValue(linked);
    expect(readAcpSessionRecord('fresh-2')).toBeUndefined();
  });

  it('throws when the write fails', () => {
    mkdirSync(path.join(state, 'acp'), { recursive: true });
    writeFileSync(path.join(state, 'acp', 'sessions'), 'not a directory');
    expect(() => writeAcpSessionRecord('s1', { cwd: '/ws' })).toThrow();
  });

  it('two interleaved creators cannot remove each other\'s record', () => {
    // Process A writes its record, process B writes its own in between, A rewrites.
    writeAcpSessionRecord('a', { cwd: '/a' });
    writeAcpSessionRecord('b', { cwd: '/b' });
    writeAcpSessionRecord('a', { cwd: '/a' });
    expect(readAcpSessionRecord('a')).toEqual({ cwd: '/a' });
    expect(readAcpSessionRecord('b')).toEqual({ cwd: '/b' });
  });
});
