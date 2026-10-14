/**
 * Tests for plugin userConfig manifest parsing, env-var building, and option validation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  normaliseOptionKey,
  readUserConfigSchema,
  buildOptionEnv,
  validateOptionKey,
} from './plugin-user-config.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'plugin-uc-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Write a plugin manifest under `<dir>/.claude-plugin/plugin.json`. */
function writeManifest(dir: string, content: object): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(content), 'utf8');
}

// ---------------------------------------------------------------------------
// normaliseOptionKey
// ---------------------------------------------------------------------------

describe('normaliseOptionKey', () => {
  it('uppercases plain alpha keys', () => {
    expect(normaliseOptionKey('provider')).toBe('PROVIDER');
    expect(normaliseOptionKey('apiKey')).toBe('APIKEY');
  });

  it('replaces hyphens and dots with underscores', () => {
    expect(normaliseOptionKey('api-key')).toBe('API_KEY');
    expect(normaliseOptionKey('my.option')).toBe('MY_OPTION');
  });

  it('replaces spaces and special chars with underscores', () => {
    expect(normaliseOptionKey('my option!')).toBe('MY_OPTION_');
  });

  it('preserves underscores and digits', () => {
    expect(normaliseOptionKey('MY_KEY_2')).toBe('MY_KEY_2');
  });
});

// ---------------------------------------------------------------------------
// readUserConfigSchema
// ---------------------------------------------------------------------------

describe('readUserConfigSchema', () => {
  it('returns empty object for missing manifest', () => {
    const dir = join(tmp, 'no-manifest');
    mkdirSync(dir);
    expect(readUserConfigSchema(dir)).toEqual({});
  });

  it('returns empty object for manifest with no userConfig', () => {
    writeManifest(tmp, { name: 'test', version: '1.0.0' });
    expect(readUserConfigSchema(tmp)).toEqual({});
  });

  it('parses full field descriptors', () => {
    writeManifest(tmp, {
      name: 'test',
      userConfig: {
        provider: { type: 'string', description: 'LLM provider', default: 'anthropic' },
        apiKey: { type: 'string', sensitive: true },
        timeout: { type: 'string' },
      },
    });
    const schema = readUserConfigSchema(tmp);
    expect(schema['provider']).toEqual({
      type: 'string',
      description: 'LLM provider',
      default: 'anthropic',
    });
    expect(schema['apiKey']).toEqual({ type: 'string', sensitive: true });
    expect(schema['timeout']).toEqual({ type: 'string' });
  });

  it('throws on collision between two keys that normalise to the same name', () => {
    writeManifest(tmp, {
      name: 'test',
      userConfig: {
        provider: {},
        PROVIDER: {},
      },
    });
    expect(() => readUserConfigSchema(tmp)).toThrow(/collision/);
  });

  it('returns empty when userConfig is not an object', () => {
    writeManifest(tmp, { name: 'test', userConfig: 'invalid' });
    expect(readUserConfigSchema(tmp)).toEqual({});
  });

  it('returns empty for malformed JSON', () => {
    mkdirSync(join(tmp, '.claude-plugin'), { recursive: true });
    writeFileSync(join(tmp, '.claude-plugin', 'plugin.json'), '{not valid json}', 'utf8');
    expect(readUserConfigSchema(tmp)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// buildOptionEnv
// ---------------------------------------------------------------------------

describe('buildOptionEnv', () => {
  it('exports stored value as CLAUDE_PLUGIN_OPTION_<KEY>', () => {
    const schema = { provider: { type: 'string' } };
    const env = buildOptionEnv(schema, { provider: 'openai' });
    expect(env['CLAUDE_PLUGIN_OPTION_PROVIDER']).toBe('openai');
  });

  it('exports default when no stored value exists', () => {
    const schema = { provider: { default: 'anthropic' } };
    const env = buildOptionEnv(schema, undefined);
    expect(env['CLAUDE_PLUGIN_OPTION_PROVIDER']).toBe('anthropic');
  });

  it('prefers stored value over default', () => {
    const schema = { provider: { default: 'anthropic' } };
    const env = buildOptionEnv(schema, { provider: 'openai' });
    expect(env['CLAUDE_PLUGIN_OPTION_PROVIDER']).toBe('openai');
  });

  it('does not export sensitive fields', () => {
    const schema = {
      provider: { type: 'string' },
      apiKey: { type: 'string', sensitive: true },
    };
    const env = buildOptionEnv(schema, { provider: 'openai', apiKey: 'sk-abc' });
    expect(env['CLAUDE_PLUGIN_OPTION_PROVIDER']).toBe('openai');
    expect(env['CLAUDE_PLUGIN_OPTION_APIKEY']).toBeUndefined();
  });

  it('does not export sensitive defaults either', () => {
    const schema = { apiKey: { sensitive: true, default: 'fallback' } };
    const env = buildOptionEnv(schema, undefined);
    expect(env['CLAUDE_PLUGIN_OPTION_APIKEY']).toBeUndefined();
  });

  it('skips stale stored keys not in the schema', () => {
    const schema = { provider: {} };
    const env = buildOptionEnv(schema, { provider: 'openai', staleKey: 'value' });
    // staleKey is not in schema — it should not appear in env
    expect(Object.keys(env)).toEqual(['CLAUDE_PLUGIN_OPTION_PROVIDER']);
  });

  it('exports nothing when no stored value and no default', () => {
    const schema = { provider: {} };
    const env = buildOptionEnv(schema, undefined);
    expect(Object.keys(env)).toHaveLength(0);
  });

  it('normalises hyphened keys to underscores', () => {
    const schema = { 'api-key': {} };
    const env = buildOptionEnv(schema, { 'api-key': 'val' });
    expect(env['CLAUDE_PLUGIN_OPTION_API_KEY']).toBe('val');
  });

  it('exports stored empty string instead of falling back to default', () => {
    const schema = { provider: { default: 'anthropic' } };
    const env = buildOptionEnv(schema, { provider: '' });
    expect(env['CLAUDE_PLUGIN_OPTION_PROVIDER']).toBe('');
  });
});

// ---------------------------------------------------------------------------
// validateOptionKey
// ---------------------------------------------------------------------------

describe('validateOptionKey', () => {
  const schema = {
    provider: { type: 'string' },
    apiKey: { type: 'string', sensitive: true },
  };

  it('returns "ok" for a valid, non-sensitive key', () => {
    expect(validateOptionKey('provider', schema)).toBe('ok');
  });

  it('returns error string for undeclared key', () => {
    const result = validateOptionKey('unknown', schema);
    expect(result).not.toBe('ok');
    expect(result).toContain('"unknown"');
    expect(result).toMatch(/not declared/);
  });

  it('returns error string for sensitive key', () => {
    const result = validateOptionKey('apiKey', schema);
    expect(result).not.toBe('ok');
    expect(result).toMatch(/sensitive/);
  });

  it('lists declared keys in error message when key is missing', () => {
    const result = validateOptionKey('missing', schema);
    expect(result).toContain('provider');
    expect(result).toContain('apiKey');
  });

  it('mentions #2459 for sensitive keys', () => {
    const result = validateOptionKey('apiKey', schema);
    expect(result).toContain('#2459');
  });
});
