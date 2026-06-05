/**
 * Tests for src/paths.ts — user-scope directory helpers and legacy migration.
 *
 * Points HOME at a tmp dir so nothing touches the real ~/.afk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getAfkHome,
  getAfkConfigDir,
  getAfkStateDir,
  getAfkCacheDir,
  getLogsDir,
  getSessionsDir,
  getTodosDir,
  getDaemonStateDir,
  getEnvConfigPath,
  getJsonConfigPath,
  getLegacyEnvConfigPath,
  getLegacyJsonConfigPath,
  ensureSessionsMigrated,
  ensureTodosMigrated,
  getSkillsDir,
  getAgentFrameworkDir,
  assertSafeJobId,
  getBgJobsRoot,
  getBgJobDir,
  getBgJobLog,
  getBgJobMeta,
} from './paths.js';

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env['HOME'];
  tmpHome = join(tmpdir(), `afk-paths-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env['HOME'] = tmpHome;
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  if (originalHome !== undefined) process.env['HOME'] = originalHome;
  else delete process.env['HOME'];
  delete process.env['AFK_HOME'];
});

describe('paths — directory resolution', () => {
  it('getAfkHome returns ~/.afk', () => {
    expect(getAfkHome()).toBe(join(tmpHome, '.afk'));
  });

  it('getAfkHome respects AFK_HOME env var', () => {
    const customHome = join(tmpHome, 'custom-afk');
    process.env['AFK_HOME'] = customHome;
    expect(getAfkHome()).toBe(customHome);
    delete process.env['AFK_HOME'];
  });

  it('AFK_HOME cascades to derived helpers', () => {
    const customHome = join(tmpHome, 'custom-afk');
    process.env['AFK_HOME'] = customHome;
    expect(getSkillsDir()).toBe(join(customHome, 'skills'));
    expect(getAgentFrameworkDir()).toBe(join(customHome, 'agent-framework'));
    delete process.env['AFK_HOME'];
  });

  it('config/state/cache/logs dirs nest under ~/.afk', () => {
    expect(getAfkConfigDir()).toBe(join(tmpHome, '.afk', 'config'));
    expect(getAfkStateDir()).toBe(join(tmpHome, '.afk', 'state'));
    expect(getAfkCacheDir()).toBe(join(tmpHome, '.afk', 'cache'));
    expect(getLogsDir()).toBe(join(tmpHome, '.afk', 'logs'));
  });

  it('sessions and todos live under state/', () => {
    expect(getSessionsDir()).toBe(join(tmpHome, '.afk', 'state', 'sessions'));
    expect(getTodosDir()).toBe(join(tmpHome, '.afk', 'state', 'todos'));
  });

  it('daemon state dir defaults to agent-afk@default', () => {
    expect(getDaemonStateDir()).toBe(
      join(tmpHome, '.afk', 'state', 'daemon', 'agent-afk@default')
    );
  });

  it('daemon state dir honors a custom instance id', () => {
    expect(getDaemonStateDir('nightly')).toBe(
      join(tmpHome, '.afk', 'state', 'daemon', 'agent-afk@nightly')
    );
  });

  it('config files live inside config/', () => {
    expect(getEnvConfigPath()).toBe(join(tmpHome, '.afk', 'config', 'afk.env'));
    expect(getJsonConfigPath()).toBe(join(tmpHome, '.afk', 'config', 'afk.config.json'));
  });

  it('legacy config paths sit flat in home', () => {
    expect(getLegacyEnvConfigPath()).toBe(join(tmpHome, '.afk.env'));
    expect(getLegacyJsonConfigPath()).toBe(join(tmpHome, '.afk.config.json'));
  });
});

describe('paths — legacy migration', () => {
  it('ensureSessionsMigrated is a no-op when nothing to migrate', () => {
    ensureSessionsMigrated();
    expect(existsSync(getSessionsDir())).toBe(false);
  });

  it('ensureSessionsMigrated moves ~/.afk/sessions → ~/.afk/state/sessions', () => {
    const legacy = join(tmpHome, '.afk', 'sessions');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'old.json'), '{"hello":"world"}');

    ensureSessionsMigrated();

    expect(existsSync(legacy)).toBe(false);
    const moved = join(getSessionsDir(), 'old.json');
    expect(existsSync(moved)).toBe(true);
    expect(JSON.parse(readFileSync(moved, 'utf-8'))).toEqual({ hello: 'world' });
  });

  it('ensureSessionsMigrated leaves new path alone when both old and new exist', () => {
    const legacy = join(tmpHome, '.afk', 'sessions');
    const modern = getSessionsDir();
    mkdirSync(legacy, { recursive: true });
    mkdirSync(modern, { recursive: true });
    writeFileSync(join(legacy, 'old.json'), '"legacy"');
    writeFileSync(join(modern, 'new.json'), '"modern"');

    ensureSessionsMigrated();

    // New path preserved verbatim; legacy left in place (user can clean up).
    expect(existsSync(join(modern, 'new.json'))).toBe(true);
    expect(readFileSync(join(modern, 'new.json'), 'utf-8')).toBe('"modern"');
    expect(existsSync(join(legacy, 'old.json'))).toBe(true);
  });

  it('ensureTodosMigrated moves ~/.afk/todos → ~/.afk/state/todos', () => {
    const legacy = join(tmpHome, '.afk', 'todos');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'session-1.json'), '{"items":[]}');

    ensureTodosMigrated();

    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(getTodosDir(), 'session-1.json'))).toBe(true);
  });
});

describe('assertSafeJobId and bg job path accessors', () => {
  // Tests use the suite-level tmpHome/HOME override from the outer beforeEach
  // so getBgJobsRoot resolves to a sandbox. The validator itself is pure.

  describe('assertSafeJobId', () => {
    it('accepts the canonical bg-<base36>-<counter> format', () => {
      expect(() => assertSafeJobId('bg-abc123-42')).not.toThrow();
      expect(() => assertSafeJobId('bg-lz5x7q9w-1')).not.toThrow();
    });

    it('accepts simple alphanumeric ids', () => {
      expect(() => assertSafeJobId('job1')).not.toThrow();
      expect(() => assertSafeJobId('JOB_42')).not.toThrow();
      expect(() => assertSafeJobId('a')).not.toThrow();
    });

    it.each([
      ['empty string', ''],
      ['traversal: ../..', '../..'],
      ['traversal: ../../etc/passwd', '../../etc/passwd'],
      ['deeper traversal', '../../../../../etc/passwd'],
      ['forward slash', 'bg/abc'],
      ['back slash', 'bg\\abc'],
      ['null byte', 'bg\u0000abc'],
      ['leading dot', '.hidden'],
      ['parent ref', '..'],
      ['just dot', '.'],
      ['space', 'bg abc'],
      ['unicode', 'bg-α'],
      ['absolute path', '/etc/passwd'],
      ['windows absolute', 'C:\\Windows\\System32'],
      ['url-encoded slash', 'bg%2Fabc'],
    ])('rejects %s', (_label, payload) => {
      expect(() => assertSafeJobId(payload)).toThrow(/Invalid jobId/);
    });

    it('rejects payloads longer than 128 chars', () => {
      const long = 'a'.repeat(129);
      expect(() => assertSafeJobId(long)).toThrow(/exceeds 128/);
    });

    it('accepts exactly 128 chars', () => {
      expect(() => assertSafeJobId('a'.repeat(128))).not.toThrow();
    });
  });

  describe('bg job path accessors guard against traversal', () => {
    it('getBgJobDir throws on traversal attempt', () => {
      expect(() => getBgJobDir('../../etc/passwd')).toThrow(/Invalid jobId/);
    });

    it('getBgJobLog throws on traversal attempt', () => {
      expect(() => getBgJobLog('../../etc/passwd')).toThrow(/Invalid jobId/);
    });

    it('getBgJobMeta throws on traversal attempt', () => {
      expect(() => getBgJobMeta('../../etc/passwd')).toThrow(/Invalid jobId/);
    });

    it('confirms traversal payload would have escaped if unguarded', () => {
      // Sanity check: without the guard, path.join would resolve to an
      // attacker-controlled location outside the bg jobs root.
      const root = getBgJobsRoot();
      const escaped = join(root, '../../etc/passwd');
      // The resolved path should NOT contain '/state/bg/' as a suffix near the leaf
      expect(escaped.includes('/etc/passwd')).toBe(true);
    });

    it('valid jobIds resolve to paths under the bg jobs root', () => {
      const root = getBgJobsRoot();
      expect(getBgJobDir('bg-abc-1').startsWith(root + '/')).toBe(true);
      expect(getBgJobLog('bg-abc-1').startsWith(root + '/')).toBe(true);
      expect(getBgJobMeta('bg-abc-1').startsWith(root + '/')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// F1 — AFK_HOME validation
// ---------------------------------------------------------------------------

describe('getAfkHome — AFK_HOME validation (F1)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws when AFK_HOME is "/" (filesystem root)', () => {
    vi.stubEnv('AFK_HOME', '/');
    expect(() => getAfkHome()).toThrow(/AFK_HOME must be an absolute path that is not \//);
  });

  it('throws when AFK_HOME is a relative path', () => {
    vi.stubEnv('AFK_HOME', 'relative/path');
    expect(() => getAfkHome()).toThrow(/AFK_HOME must be an absolute path that is not \//);
  });

  it('returns the value when AFK_HOME is a valid absolute non-root path', () => {
    vi.stubEnv('AFK_HOME', '/tmp/afk-test');
    expect(getAfkHome()).toBe('/tmp/afk-test');
  });
});

// F5 tests live in paths-exdev.test.ts (requires vi.mock hoisting in isolation).
