import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { getConfiguredFallbackModel } from './fallback-model.js';
import { resetJsonConfigCache } from '../../cli/config/json-tier.js';
import { parseJsonConfigFile, validatedValueView } from '../../cli/config/json-tier-parse.js';
import { setConfigValue } from '../../config/mutate.js';
import { getAtPath } from '../../config/settable-keys.js';
import { getJsonConfigPath } from '../../paths.js';
import { rmSyncRetry } from '../../__test-utils__/rm-sync-retry.js';

/** Write the user-global afk.config.json (AFK_HOME is redirected per test file). */
function writeUserConfig(json: unknown): void {
  const p = getJsonConfigPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(json));
}

describe('getConfiguredFallbackModel (models.fallback)', () => {
  beforeEach(() => resetJsonConfigCache());
  afterEach(() => {
    writeUserConfig({});
    resetJsonConfigCache();
  });

  it('returns undefined when models.fallback is unset', () => {
    writeUserConfig({ models: { small: 'gpt-4o-mini' } });
    expect(getConfiguredFallbackModel()).toBeUndefined();
  });

  it('returns undefined when models.fallback is empty / whitespace', () => {
    writeUserConfig({ models: { fallback: '   ' } });
    expect(getConfiguredFallbackModel()).toBeUndefined();
  });

  it('returns an identity alias verbatim (resolution happens downstream)', () => {
    writeUserConfig({ models: { fallback: 'sonnet' } });
    expect(getConfiguredFallbackModel()).toBe('sonnet');
  });

  it('returns a tier name verbatim so slot credentials apply downstream', () => {
    writeUserConfig({ models: { fallback: 'local' } });
    expect(getConfiguredFallbackModel()).toBe('local');
  });

  it('returns a raw model id (trimmed)', () => {
    writeUserConfig({ models: { fallback: '  gpt-5.6-sol  ' } });
    expect(getConfiguredFallbackModel()).toBe('gpt-5.6-sol');
  });

  it('accepts the object form and returns its id', () => {
    writeUserConfig({ models: { fallback: { id: 'claude-haiku-5-5', provider: 'anthropic' } } });
    expect(getConfiguredFallbackModel()).toBe('claude-haiku-5-5');
  });

  it('does not create a model slot: other slot bindings are unaffected', () => {
    writeUserConfig({ models: { fallback: 'sonnet' } });
    const parsed = parseJsonConfigFile(getJsonConfigPath());
    expect(parsed?.modelsPartial).toEqual({});
  });
});

describe('models.fallback round-trip through the config writer', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-fallback-'));
  });
  afterEach(() => rmSyncRetry(dir));

  it('setConfigValue writes it and the loader parses it back', () => {
    const file = join(dir, 'afk.config.json');
    setConfigValue('models.fallback', 'sonnet', { filePath: file });
    const parsed = parseJsonConfigFile(file);
    expect(parsed?.config.fallbackModel).toBe('sonnet');
    // `/config` provenance reads the validated view at the dotted path.
    expect(getAtPath(validatedValueView(parsed!), 'models.fallback')).toBe('sonnet');
  });
});
