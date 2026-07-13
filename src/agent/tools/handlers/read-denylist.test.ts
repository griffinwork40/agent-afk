/**
 * Unit tests for the read-denylist shared utility.
 *
 * Covers:
 * - Credential stores (~/.ssh, ~/.aws, ~/.gnupg, ~/.afk/config, ~/.npmrc,
 *   ~/.docker/config.json) are read-denied.
 * - Deliberate divergence from the WRITE denylist: ~/.afk/STATE is NOT denied
 *   (forks must read skill-preflight/todos/transcripts — #544/#547/#554), and
 *   /etc is not blanket-denied (only specific secret files).
 * - Symlink bypass is blocked: a symlink pointing into ~/.ssh is dereferenced.
 * - Custom AFK_READ_DENYLIST entries are applied (with cache reset).
 *
 * @module agent/tools/handlers/read-denylist.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  isReadDenied,
  assertNotReadDenied,
  getReadDenylist,
  BUILTIN_READ_DENYLIST,
  _resetReadDenylistCacheForTests,
} from './read-denylist.js';

let tmpDir: string;

beforeEach(() => {
  _resetReadDenylistCacheForTests();
  tmpDir = join(tmpdir(), `afk-read-denylist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  delete process.env['AFK_READ_DENYLIST'];
  _resetReadDenylistCacheForTests();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('isReadDenied — credential stores', () => {
  const credPaths = [
    join(homedir(), '.ssh', 'id_rsa'),
    join(homedir(), '.aws', 'credentials'),
    join(homedir(), '.gnupg', 'secring.gpg'),
    join(homedir(), '.afk', 'config', 'afk.env'),
    join(homedir(), '.npmrc'),
    join(homedir(), '.docker', 'config.json'),
  ];

  for (const p of credPaths) {
    it(`denies ${p.replace(homedir(), '~')}`, () => {
      expect(isReadDenied(p).denied).toBe(true);
    });
  }

  it('every BUILTIN_READ_DENYLIST entry triggers the guard', () => {
    for (const entry of BUILTIN_READ_DENYLIST) {
      expect(isReadDenied(join(entry, 'probe')).denied).toBe(true);
    }
  });
});

describe('isReadDenied — deliberate divergence from the write denylist', () => {
  it('does NOT deny ~/.afk/state (forks must read skill-preflight/todos/transcripts)', () => {
    expect(isReadDenied(join(homedir(), '.afk', 'state', 'skill-preflight', 's', 'pr.diff')).denied).toBe(false);
    expect(isReadDenied(join(homedir(), '.afk', 'state', 'todos', 't.json')).denied).toBe(false);
  });

  it('DOES deny ~/.afk/config (afk.env credentials)', () => {
    expect(isReadDenied(join(homedir(), '.afk', 'config', 'afk.env')).denied).toBe(true);
    expect(isReadDenied(join(homedir(), '.afk', 'config', 'mcp.json')).denied).toBe(true);
  });

  it('does NOT blanket-deny /etc (ordinary system reads stay allowed)', () => {
    expect(isReadDenied('/etc/hosts').denied).toBe(false);
    expect(isReadDenied('/etc/resolv.conf').denied).toBe(false);
  });

  it('DOES deny the enumerated secret system files', () => {
    expect(isReadDenied('/etc/shadow').denied).toBe(true);
    expect(isReadDenied('/etc/sudoers').denied).toBe(true);
  });

  it('does NOT deny an ordinary project path', () => {
    expect(isReadDenied(join(tmpDir, 'src', 'index.ts')).denied).toBe(false);
    expect(isReadDenied('/tmp/some-repo/package.json').denied).toBe(false);
  });
});

describe('assertNotReadDenied', () => {
  it('throws for a credential path, with the handler name in the message', () => {
    expect(() => assertNotReadDenied(join(homedir(), '.ssh', 'id_rsa'), 'grep')).toThrow(/grep/);
    expect(() => assertNotReadDenied(join(homedir(), '.ssh', 'id_rsa'))).toThrow(
      /refusing to read protected path/,
    );
  });

  it('does not throw for a normal path', () => {
    expect(() => assertNotReadDenied(join(tmpDir, 'ok.ts'))).not.toThrow();
  });
});

describe('read-denylist — symlink dereference', () => {
  it('blocks a read through a symlink that resolves to ~/.ssh', () => {
    const sshDir = join(homedir(), '.ssh');
    if (!existsSync(sshDir)) return; // dangling symlink can't resolve — vacuous on this runner
    const linkPath = join(tmpDir, 'ssh-link');
    symlinkSync(sshDir, linkPath);
    expect(isReadDenied(join(linkPath, 'id_rsa')).denied).toBe(true);
  });
});

describe('read-denylist — AFK_READ_DENYLIST extras', () => {
  it('applies a custom colon-separated denylist entry (built-ins still apply)', () => {
    const projectSecret = join(tmpDir, 'secrets');
    mkdirSync(projectSecret, { recursive: true });
    process.env['AFK_READ_DENYLIST'] = projectSecret;
    _resetReadDenylistCacheForTests();

    expect(isReadDenied(join(projectSecret, '.env')).denied).toBe(true);
    // Built-ins are unaffected by the custom list.
    expect(isReadDenied(join(homedir(), '.ssh', 'id_rsa')).denied).toBe(true);
    // The resolved list contains the custom entry.
    expect(getReadDenylist().some((p) => p.includes('secrets'))).toBe(true);
  });
});
