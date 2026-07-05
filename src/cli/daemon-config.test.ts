/**
 * Tests for the `daemon` block in afk.config.json.
 *
 * Daemon Gap B Wave 1 Lane B: extends ConfigFileSchema with a nested
 * `daemon: { task?: string; taskId?: string }` and asserts loadConfig()
 * round-trips the new field correctly.
 *
 * Strategy mirrors tests/paths-separation.test.ts: redirect HOME to a
 * tmpdir so getJsonConfigPath() resolves under our fake home, then write
 * the config there. Also chdir into the tmp home so the first lookup
 * (process.cwd()/afk.config.json) misses cleanly. dotenv is mocked the
 * same way as tests/config.test.ts to keep the repo's local .env from
 * leaking into test env.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, _resetConfigCache } from './config.js';
import { useUnsetAfkHome } from '../__test-utils__/unset-afk-home.js';

vi.mock('dotenv', () => ({
  default: { config: () => ({ parsed: {} }) },
  config: () => ({ parsed: {} }),
}));

// This suite writes afk.config.json under $HOME/.afk/config and expects
// loadConfig() to find it via the unset-AFK_HOME fallback — drop the global
// sentinel AFK_HOME per test; HOME is redirected to a tmp dir below.
useUnsetAfkHome();

let tmpHome: string;
let originalHome: string | undefined;
let originalCwd: string;
let savedOauthToken: string | undefined;

function writeJsonConfig(contents: string): void {
  const cfgDir = join(tmpHome, '.afk', 'config');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'afk.config.json'), contents, 'utf-8');
}

beforeEach(() => {
  // Each test writes a different afk.config.json under a per-case tmpHome —
  // invalidate the disk-tier cache so loadConfig() actually rereads.
  _resetConfigCache();
  originalHome = process.env['HOME'];
  originalCwd = process.cwd();
  tmpHome = join(tmpdir(), `afk-daemon-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env['HOME'] = tmpHome;
  // chdir into tmpHome so the cwd lookup (process.cwd()/afk.config.json)
  // misses cleanly even if the repo cwd happens to have one. The legacy
  // path getLegacyJsonConfigPath() also resolves via homedir(), so it
  // points inside tmpHome and stays out of the real ~/.afk.config.json.
  process.chdir(tmpHome);

  // Match tests/config.test.ts isolation: clear any model/key env that
  // the outer process may have leaked in so loadConfig has a known floor.
  savedOauthToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  delete process.env['AFK_MODEL'];
  delete process.env['CLAUDE_MODEL'];
  delete process.env['AFK_MAX_TOKENS'];
  delete process.env['AFK_TEMPERATURE'];
  delete process.env['AFK_SYSTEM_PROMPT'];
  process.env['ANTHROPIC_API_KEY'] = 'test-api-key-12345';
});

afterEach(() => {
  process.chdir(originalCwd);
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  if (originalHome !== undefined) process.env['HOME'] = originalHome;
  else delete process.env['HOME'];

  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  delete process.env['AFK_MODEL'];
  delete process.env['CLAUDE_MODEL'];
  delete process.env['AFK_MAX_TOKENS'];
  delete process.env['AFK_TEMPERATURE'];
  delete process.env['AFK_SYSTEM_PROMPT'];
  if (savedOauthToken !== undefined) process.env['CLAUDE_CODE_OAUTH_TOKEN'] = savedOauthToken;
});

describe('loadConfig — daemon block round-trip', () => {
  it('round-trips daemon.task from afk.config.json', () => {
    writeJsonConfig(JSON.stringify({ daemon: { task: '/foo bar' } }));
    const config = loadConfig();
    expect(config.daemon).toBeDefined();
    expect(config.daemon?.task).toBe('/foo bar');
    expect(config.daemon?.taskId).toBeUndefined();
  });

  it('round-trips daemon.taskId from afk.config.json', () => {
    writeJsonConfig(JSON.stringify({ daemon: { taskId: 'my-id' } }));
    const config = loadConfig();
    expect(config.daemon).toBeDefined();
    expect(config.daemon?.taskId).toBe('my-id');
    expect(config.daemon?.task).toBeUndefined();
  });

  it('round-trips both daemon.task and daemon.taskId', () => {
    writeJsonConfig(JSON.stringify({ daemon: { task: '/x', taskId: 'y' } }));
    const config = loadConfig();
    expect(config.daemon).toBeDefined();
    expect(config.daemon?.task).toBe('/x');
    expect(config.daemon?.taskId).toBe('y');
  });

  it('leaves daemon undefined when the config file has no daemon field', () => {
    writeJsonConfig(JSON.stringify({ model: 'sonnet' }));
    const config = loadConfig();
    expect(config.daemon).toBeUndefined();
  });

  it('leaves daemon undefined when no config file exists at all', () => {
    // Intentionally write no file — only the tmp HOME redirection is set up.
    const config = loadConfig();
    expect(config.daemon).toBeUndefined();
  });
});
