// Contract: regression coverage for the env tier's "blank ambient value must
// not shadow an env file" precedence rule.
//
// History: a shell profile containing `export OPENAI_API_KEY=""` permanently
// masked the real key in `~/.afk/config/afk.env`, because dotenv's
// `override: false` skip is presence-based (`key in process.env`) rather than
// value-based. The OpenAI auth resolver then fell through to
// `~/.codex/auth.json` and told the operator to "set OPENAI_API_KEY" — a key
// they had already set. `src/cli/config.test.ts` mocks dotenv wholesale, so the
// real load path had no coverage; these tests exercise it directly.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { _clearBlankEnvShadows, _resetBlankEnvShadowWarnCache } from './env-tier.js';

const TRACKED_KEYS = [
  'OPENAI_API_KEY',
  'AFK_BLANK_SHADOW_PROBE',
  'AFK_REAL_AMBIENT_PROBE',
  'AFK_HOME',
] as const;

let tmpRoot: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'afk-env-tier-'));
  saved = {};
  for (const k of TRACKED_KEYS) saved[k] = process.env[k];
  _resetBlankEnvShadowWarnCache();
  // Silence the one-shot operator warning; asserted explicitly where relevant.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of TRACKED_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeEnvFile(contents: string): string {
  const p = join(tmpRoot, 'afk.env');
  writeFileSync(p, contents, 'utf8');
  return p;
}

describe('_clearBlankEnvShadows', () => {
  it('unshadows a blank ambient value when the file supplies a real one', () => {
    process.env['OPENAI_API_KEY'] = '';
    const p = writeEnvFile('OPENAI_API_KEY=sk-real-value\n');

    expect(_clearBlankEnvShadows(p)).toEqual(['OPENAI_API_KEY']);
    // Deleted (not blanked) so dotenv's presence check sees it as absent.
    expect('OPENAI_API_KEY' in process.env).toBe(false);
  });

  it('treats a whitespace-only ambient value as blank', () => {
    process.env['AFK_BLANK_SHADOW_PROBE'] = '   ';
    const p = writeEnvFile('AFK_BLANK_SHADOW_PROBE=real\n');

    expect(_clearBlankEnvShadows(p)).toEqual(['AFK_BLANK_SHADOW_PROBE']);
    expect('AFK_BLANK_SHADOW_PROBE' in process.env).toBe(false);
  });

  it('leaves a real ambient value untouched (standard dotenv precedence)', () => {
    process.env['AFK_REAL_AMBIENT_PROBE'] = 'ambient-wins';
    const p = writeEnvFile('AFK_REAL_AMBIENT_PROBE=file-value\n');

    expect(_clearBlankEnvShadows(p)).toEqual([]);
    expect(process.env['AFK_REAL_AMBIENT_PROBE']).toBe('ambient-wins');
  });

  it('is a no-op when the file value is also blank', () => {
    process.env['AFK_BLANK_SHADOW_PROBE'] = '';
    const p = writeEnvFile('AFK_BLANK_SHADOW_PROBE=\n');

    expect(_clearBlankEnvShadows(p)).toEqual([]);
    expect(process.env['AFK_BLANK_SHADOW_PROBE']).toBe('');
  });

  it('ignores keys the file does not define', () => {
    process.env['OPENAI_API_KEY'] = '';
    const p = writeEnvFile('SOMETHING_ELSE=1\n');

    expect(_clearBlankEnvShadows(p)).toEqual([]);
    expect(process.env['OPENAI_API_KEY']).toBe('');
  });

  it('returns [] for an unreadable file instead of throwing', () => {
    expect(_clearBlankEnvShadows(join(tmpRoot, 'does-not-exist.env'))).toEqual([]);
  });
});

describe('loadEnvConfig (real dotenv path)', () => {
  it('loads the afk.env key even when the shell exports it blank', async () => {
    // Reproduces the reported failure: blank shell export + real afk.env key.
    const home = join(tmpRoot, 'afkhome');
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(
      join(home, 'config', 'afk.env'),
      'OPENAI_API_KEY=sk-from-afk-env\n',
      'utf8',
    );
    process.env['AFK_HOME'] = home;
    process.env['OPENAI_API_KEY'] = '';

    // Fresh module instance: `dotenvLoaded` is a deliberate one-shot latch.
    vi.resetModules();
    const mod = await import('./env-tier.js');
    mod.loadEnvConfig();

    expect(process.env['OPENAI_API_KEY']).toBe('sk-from-afk-env');
  });

  it('still lets a real shell value win over afk.env', async () => {
    const home = join(tmpRoot, 'afkhome2');
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(
      join(home, 'config', 'afk.env'),
      'OPENAI_API_KEY=sk-from-afk-env\n',
      'utf8',
    );
    process.env['AFK_HOME'] = home;
    process.env['OPENAI_API_KEY'] = 'sk-from-shell';

    vi.resetModules();
    const mod = await import('./env-tier.js');
    mod.loadEnvConfig();

    expect(process.env['OPENAI_API_KEY']).toBe('sk-from-shell');
  });
});
