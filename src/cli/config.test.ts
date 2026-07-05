/**
 * Tests for config loader
 * 
 * Run with: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import {
  loadConfig,
  isValidModel,
  getModelId,
  _resetConfigCache,
  resolveCliPermissionMode,
  DEFAULT_CLI_PERMISSION_MODE,
} from './config.js';
import {
  DEFAULT_SLOT_BINDINGS,
  getSlotBindings,
  resetSlotBindings,
  resolveModelInput,
} from '../agent/session/model-slots.js';
import { resolveSuggestGhost } from './commands/interactive/repl-loop.js';

// Mock dotenv to prevent .env from polluting test env. The repo's .env
// contains CLAUDE_MODEL=opus_1m for local dev — without this mock, the
// first loadConfig() call would load it and break isolation for tests
// that assert default behavior. (Discovered as a regression introduced
// when CLAUDE_MODEL was added as an AFK_MODEL fallback in d33ca21.)
vi.mock('dotenv', () => ({
  default: { config: () => ({ parsed: {} }) },
  config: () => ({ parsed: {} }),
}));

// Mock the keychain fallback so a real Claude Code-credentials entry on the
// dev machine doesn't leak into tests asserting "no credential" behavior.
// Two mock paths are needed: the re-export shim (./keychain.js, used by some
// tests that import it directly) and the canonical source
// (../agent/auth/keychain.js, used by credential-resolver.ts).
vi.mock('./keychain.js', () => ({
  loadClaudeCodeOauthToken: () => undefined,
}));
vi.mock('../agent/auth/keychain.js', () => ({
  loadClaudeCodeOauthToken: () => undefined,
  refreshClaudeCodeOauthToken: () => Promise.resolve(undefined),
  parseAccountIdentifier: () => undefined,
}));

// ESM: `fs` named exports are non-configurable so vi.spyOn cannot redefine
// them per-test. Instead we hoist a module-level factory mock here and use
// vi.mocked() per-test to swap in AFK.md-specific behaviour while delegating
// all other paths to the real fs implementation.
//
// IMPORTANT: vi.mock factories are hoisted to the top of the file by Vitest's
// transform. This means any variables declared in the file body are NOT yet
// initialized when the factory runs. We use `__realFs` exposed on the mock
// module itself to give tests access to the real implementations without
// a separate captured variable that would create a TDZ error.
vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...real,
    // Expose real impls on a side-channel key so tests can delegate without
    // calling through the proxy (which would cause infinite recursion).
    __realExistsSync: real.existsSync,
    __realReadFileSync: real.readFileSync,
    existsSync: vi.fn(real.existsSync),
    readFileSync: vi.fn(real.readFileSync),
  };
});

import * as fs from 'fs';

// Access the real implementations via the side-channel key exposed by the mock.
const realFsModule = fs as typeof fs & {
  __realExistsSync: typeof fs.existsSync;
  __realReadFileSync: typeof fs.readFileSync;
};

describe('Config Loader', () => {
  describe('isValidModel', () => {
    it('should validate correct model names', () => {
      expect(isValidModel('opus')).toBe(true);
      expect(isValidModel('opus_1m')).toBe(true);
      expect(isValidModel('sonnet')).toBe(true);
      expect(isValidModel('sonnet_1m')).toBe(true);
      expect(isValidModel('haiku')).toBe(true);
      expect(isValidModel('fable')).toBe(true);
    });

    it('should reject invalid model names', () => {
      expect(isValidModel('invalid')).toBe(false);
      expect(isValidModel('gpt-4')).toBe(false);
      expect(isValidModel('')).toBe(false);
    });
  });

  describe('getModelId', () => {
    it('should return correct model IDs', () => {
      expect(getModelId('opus')).toBe('claude-opus-4-8');
      expect(getModelId('opus_1m')).toBe('claude-opus-4-8');
      expect(getModelId('sonnet')).toBe('claude-sonnet-5');
      expect(getModelId('sonnet_1m')).toBe('claude-sonnet-5');
      expect(getModelId('haiku')).toBe('claude-haiku-4-5-20251001');
      expect(getModelId('fable')).toBe('claude-fable-5');
    });
  });

  describe('loadConfig', () => {
    let savedOauthToken: string | undefined;

    beforeEach(() => {
      // Reset the disk-tier cache so per-test env/fixture changes are
      // observed. `loadConfig()` memoizes JSON config + AFK.md across
      // calls within a process; without this, the first test's read of
      // a missing file would freeze "no config" for every subsequent test.
      _resetConfigCache();
      // Save and clear CLAUDE_CODE_OAUTH_TOKEN to isolate tests
      savedOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      // Clear any model/limit overrides that may have leaked in from the
      // outer process env (e.g. agent-afk's own .env loaded at CLI start
      // sets CLAUDE_MODEL=opus_1m for local dev). The dotenv mock above
      // prevents fresh loads, but loadConfig reads process.env directly,
      // so anything already present must be cleared here too. Mirrors
      // afterEach so every test starts from a known-empty model env.
      delete process.env.AFK_MODEL;
      delete process.env.CLAUDE_MODEL;
      delete process.env.AFK_MAX_TOKENS;
      delete process.env.AFK_TEMPERATURE;
      // Set minimal required env var for tests
      process.env.ANTHROPIC_API_KEY = 'test-api-key-12345';
    });

    afterEach(() => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.AFK_MODEL;
      delete process.env.CLAUDE_MODEL;
      delete process.env.AFK_MAX_TOKENS;
      delete process.env.AFK_TEMPERATURE;
      // Restore original token
      if (savedOauthToken !== undefined) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauthToken;
      }
    });

    it('should load with defaults when no config exists', () => {
      const config = loadConfig();
      
      expect(config.apiKey).toBe('test-api-key-12345');
      expect(config.model).toBe('sonnet');
      expect(config.maxTokens).toBe(4096);
      expect(config.temperature).toBe(1.0);
    });

    it('should override defaults with CLI args', () => {
      const config = loadConfig({
        model: 'opus',
        maxTokens: 2000,
        temperature: 0.5,
      });

      expect(config.model).toBe('opus');
      expect(config.maxTokens).toBe(2000);
      expect(config.temperature).toBe(0.5);
    });

    it('should return an undefined apiKey when no Anthropic credentials are set', () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

      // Intentionally no longer throws — callers select the provider by
      // model family and the right auth surface is picked up there.
      const config = loadConfig();
      expect(config.apiKey).toBeUndefined();
      expect(config.model).toBe('sonnet');
    });

    it('should load from environment variables', () => {
      process.env.AFK_MODEL = 'haiku';
      process.env.AFK_MAX_TOKENS = '8192';
      process.env.AFK_TEMPERATURE = '0.7';

      const config = loadConfig();

      expect(config.model).toBe('haiku');
      expect(config.maxTokens).toBe(8192);
      expect(config.temperature).toBe(0.7);
    });

    it('prefers AFK_MODEL over CLAUDE_MODEL', () => {
      process.env.AFK_MODEL = 'haiku';
      process.env.CLAUDE_MODEL = 'opus';

      const config = loadConfig();
      expect(config.model).toBe('haiku');

      delete process.env.CLAUDE_MODEL;
    });

    it('falls back to CLAUDE_MODEL when AFK_MODEL is unset', () => {
      delete process.env.AFK_MODEL;
      process.env.CLAUDE_MODEL = 'opus';

      const config = loadConfig();
      expect(config.model).toBe('opus');

      delete process.env.CLAUDE_MODEL;
    });

    it('accepts arbitrary non-Claude model ids (e.g. gpt-5.4)', () => {
      process.env.AFK_MODEL = 'gpt-5.4';

      const config = loadConfig();
      expect(config.model).toBe('gpt-5.4');
    });

    it('loads without an Anthropic API key when model is gpt-5.4', () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      process.env.AFK_MODEL = 'gpt-5.4';

      const config = loadConfig();
      expect(config.apiKey).toBeUndefined();
      expect(config.model).toBe('gpt-5.4');
    });

    describe('Anthropic credential leak guard (provider-aware)', () => {
      // Regression: before the provider-aware gate in loadConfig(), a stale
      // Claude Code keychain entry (or `ANTHROPIC_API_KEY` left in env) would
      // be stuffed into `config.apiKey` regardless of which provider the model
      // resolves to. The openai-compatible provider's `resolveOpenAIAuth()`
      // would then short-circuit on the non-empty `config.apiKey` and send
      // `Authorization: Bearer sk-ant-oat01-…` to OpenAI-compatible endpoints,
      // 401-ing — surfaced to the user as a misleading "Verify
      // ANTHROPIC_API_KEY" error message because the generic auth-error
      // mapper assumes Anthropic.

      it('does NOT set config.apiKey when AFK_PROVIDER=openai-compatible, even if ANTHROPIC_API_KEY is set', () => {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-stale-claude-key';
        process.env.AFK_PROVIDER = 'openai-compatible';
        process.env.AFK_MODEL = 'qwen3.5-plus';

        try {
          const config = loadConfig();
          expect(config.apiKey).toBeUndefined();
          expect(config.model).toBe('qwen3.5-plus');
        } finally {
          delete process.env.AFK_PROVIDER;
        }
      });

      it('does NOT set config.apiKey when AFK_OPENAI_BASE_URL hints openai-compatible and the model is unknown', () => {
        // Tier 4 env-hint path: unknown model name + AFK_OPENAI_BASE_URL set
        // → providerForModel resolves to openai-compatible, so the Anthropic
        // credential MUST NOT leak in.
        process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-stale-claude-key';
        process.env.AFK_OPENAI_BASE_URL = 'https://opencode.ai/zen/go/v1';
        process.env.AFK_MODEL = 'qwen3.5-plus';

        try {
          const config = loadConfig();
          expect(config.apiKey).toBeUndefined();
        } finally {
          delete process.env.AFK_OPENAI_BASE_URL;
        }
      });

      it('does NOT leak a Claude Code keychain OAuth token to the openai-compatible provider', async () => {
        // Simulate the production scenario: env has no ANTHROPIC_API_KEY but
        // the macOS keychain has a `Claude Code-credentials` entry from a
        // prior `claude login`. Without the provider-aware gate, that token
        // ends up in config.apiKey and the OpenAI SDK uses it as Bearer.
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        process.env.AFK_PROVIDER = 'openai-compatible';
        process.env.AFK_MODEL = 'qwen3.5-plus';

        // Override the keychain mock for just this test.
        const keychainMod = await import('./keychain.js');
        const original = keychainMod.loadClaudeCodeOauthToken;
        (keychainMod as { loadClaudeCodeOauthToken: () => string | undefined }).loadClaudeCodeOauthToken =
          () => 'sk-ant-oat01-stale-keychain-token';

        try {
          const config = loadConfig();
          expect(config.apiKey).toBeUndefined();
        } finally {
          (keychainMod as { loadClaudeCodeOauthToken: () => string | undefined }).loadClaudeCodeOauthToken = original;
          delete process.env.AFK_PROVIDER;
        }
      });

      it('STILL sets config.apiKey from Anthropic credential when the resolved provider is anthropic-direct', () => {
        // Positive control: gating must not break the happy path.
        process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-valid-anthropic-key';
        process.env.AFK_MODEL = 'sonnet';

        const config = loadConfig();
        expect(config.apiKey).toBe('sk-ant-api03-valid-anthropic-key');
      });
    });

    describe('local-server mode (AFK_LOCAL_BASE_URL)', () => {
      afterEach(() => {
        delete process.env['AFK_LOCAL_BASE_URL'];
        delete process.env['AFK_LOCAL_API_KEY'];
      });

      it('threads AFK_LOCAL_BASE_URL into config.baseUrl', () => {
        process.env['AFK_LOCAL_BASE_URL'] = 'http://127.0.0.1:8080';
        const config = loadConfig({ model: 'local-qwen-3-6' });
        expect(config.baseUrl).toBe('http://127.0.0.1:8080');
      });

      it('forces apiKey to "local" placeholder, never forwarding a real ANTHROPIC_API_KEY', () => {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-real-secret';
        process.env['AFK_LOCAL_BASE_URL'] = 'http://127.0.0.1:8080';

        const config = loadConfig({ model: 'local-qwen-3-6' });
        // Real key must be replaced so it can't leak to the local shim.
        expect(config.apiKey).not.toBe('sk-ant-api03-real-secret');
        expect(config.apiKey).toBe('local');
      });

      it('honors AFK_LOCAL_API_KEY when set', () => {
        process.env['AFK_LOCAL_BASE_URL'] = 'http://127.0.0.1:8080';
        process.env['AFK_LOCAL_API_KEY'] = 'my-shim-secret';

        const config = loadConfig({ model: 'local-qwen-3-6' });
        expect(config.apiKey).toBe('my-shim-secret');
      });

      it('does NOT activate local mode when AFK_LOCAL_BASE_URL is unset', () => {
        const config = loadConfig({ model: 'claude-sonnet-5' });
        expect(config.baseUrl).toBeUndefined();
        expect(config.apiKey).toBe('test-api-key-12345');
      });

      it('throws when a local-* model is requested without AFK_LOCAL_BASE_URL', () => {
        expect(() => loadConfig({ model: 'local-qwen-3-6' })).toThrow(
          /AFK_LOCAL_BASE_URL/,
        );
      });

      it('local-* model with AFK_LOCAL_BASE_URL set does not throw', () => {
        process.env['AFK_LOCAL_BASE_URL'] = 'http://127.0.0.1:8080';
        expect(() => loadConfig({ model: 'local-qwen-3-6' })).not.toThrow();
      });
    });
  });

  describe('AFK.md auto-discovery', () => {
    // Use vi.mocked() on the module-level vi.mock('fs') factory defined at the
    // top of this file. ESM named exports are non-configurable so vi.spyOn
    // cannot redefine them per-test; the factory approach works instead.
    const mockedExistsSync = () => vi.mocked(fs.existsSync);
    const mockedReadFileSync = () => vi.mocked(fs.readFileSync);

    beforeEach(() => {
      // AFK.md cases mutate fs mocks per test — invalidate the disk-tier
      // cache so loadConfig() actually re-walks under the new mock.
      _resetConfigCache();
      // Reset to real implementations before each test.
      mockedExistsSync().mockImplementation(realFsModule.__realExistsSync);
      mockedReadFileSync().mockImplementation(realFsModule.__realReadFileSync);
      // Wipe any prior model/prompt env that could bleed in from sibling tests.
      delete process.env['AFK_SYSTEM_PROMPT'];
      delete process.env.AFK_MODEL;
      delete process.env.CLAUDE_MODEL;
      delete process.env.AFK_MAX_TOKENS;
      delete process.env.AFK_TEMPERATURE;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    });

    afterEach(() => {
      // Restore real implementations so other describe blocks are unaffected.
      mockedExistsSync().mockImplementation(realFsModule.__realExistsSync);
      mockedReadFileSync().mockImplementation(realFsModule.__realReadFileSync);
      delete process.env['AFK_SYSTEM_PROMPT'];
    });

    it('loads cwd/AFK.md as systemPrompt when no env or JSON config is set', () => {
      const cwdAfkMd = join(process.cwd(), 'AFK.md');
      mockedExistsSync().mockImplementation((p) => {
        if (String(p).endsWith('AFK.md')) return String(p) === cwdAfkMd;
        return realFsModule.__realExistsSync(p as fs.PathLike);
      });
      mockedReadFileSync().mockImplementation((p, ...args) => {
        if (String(p) === cwdAfkMd) return 'You are a helpful assistant from AFK.md';
        return (realFsModule.__realReadFileSync as Function)(p, ...args);
      });

      const config = loadConfig();
      expect(config.systemPrompt).toBe('You are a helpful assistant from AFK.md');
      expect(config.systemPromptSource).toBe(`afk-md:${cwdAfkMd}`);
    });

    it('falls back to ~/.afk/AFK.md when cwd/AFK.md is absent', () => {
      // Mirror getAfkHome() precedence: the global test setup
      // (redirect-paths-env.ts) points AFK_HOME at a tmp sentinel, so the
      // user-scope AFK.md resolves under it; fall back to $HOME/.afk only
      // if the redirect is opted out.
      const homeAfkMd = join(
        process.env['AFK_HOME'] ??
          join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '', '.afk'),
        'AFK.md',
      );
      mockedExistsSync().mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith('AFK.md')) return s === homeAfkMd;
        return realFsModule.__realExistsSync(p as fs.PathLike);
      });
      mockedReadFileSync().mockImplementation((p, ...args) => {
        if (String(p) === homeAfkMd) return 'User-scope system prompt';
        return (realFsModule.__realReadFileSync as Function)(p, ...args);
      });

      const config = loadConfig();
      expect(config.systemPrompt).toBe('User-scope system prompt');
      expect(config.systemPromptSource).toBe(`afk-md:${homeAfkMd}`);
    });

    it('prefers cwd/AFK.md over ~/.afk/AFK.md when both exist', () => {
      const cwdAfkMd = join(process.cwd(), 'AFK.md');
      mockedExistsSync().mockImplementation((p) => {
        if (String(p).endsWith('AFK.md')) return true; // both exist
        return realFsModule.__realExistsSync(p as fs.PathLike);
      });
      mockedReadFileSync().mockImplementation((p, ...args) => {
        if (String(p).endsWith('AFK.md')) {
          return String(p) === cwdAfkMd ? 'cwd content wins' : 'user-scope content';
        }
        return (realFsModule.__realReadFileSync as Function)(p, ...args);
      });

      const config = loadConfig();
      expect(config.systemPrompt).toBe('cwd content wins');
      expect(config.systemPromptSource).toBe(`afk-md:${cwdAfkMd}`);
    });

    it('ignores AFK.md when AFK_SYSTEM_PROMPT env is set', () => {
      process.env['AFK_SYSTEM_PROMPT'] = 'env-wins';
      mockedExistsSync().mockImplementation((p) => {
        if (String(p).endsWith('AFK.md')) return true;
        return realFsModule.__realExistsSync(p as fs.PathLike);
      });
      mockedReadFileSync().mockImplementation((p, ...args) => {
        if (String(p).endsWith('AFK.md')) return 'should be ignored';
        return (realFsModule.__realReadFileSync as Function)(p, ...args);
      });

      const config = loadConfig();
      expect(config.systemPrompt).toBe('env-wins');
      expect(config.systemPromptSource).toBe('env:AFK_SYSTEM_PROMPT');
    });

    it('ignores AFK.md when afk.config.json sets systemPrompt', () => {
      const cwdConfigJson = join(process.cwd(), 'afk.config.json');
      mockedExistsSync().mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith('AFK.md')) return true;
        if (s === cwdConfigJson) return true;
        return realFsModule.__realExistsSync(p as fs.PathLike);
      });
      mockedReadFileSync().mockImplementation((p, ...args) => {
        const s = String(p);
        if (s === cwdConfigJson) return JSON.stringify({ systemPrompt: 'json-config-wins' });
        if (s.endsWith('AFK.md')) return 'should be ignored';
        return (realFsModule.__realReadFileSync as Function)(p, ...args);
      });

      const config = loadConfig();
      expect(config.systemPrompt).toBe('json-config-wins');
      expect(config.systemPromptSource).toBe(`file:${cwdConfigJson}`);
    });

    it('treats empty or whitespace-only AFK.md as absent', () => {
      mockedExistsSync().mockImplementation((p) => {
        if (String(p).endsWith('AFK.md')) return true;
        return realFsModule.__realExistsSync(p as fs.PathLike);
      });
      mockedReadFileSync().mockImplementation((p, ...args) => {
        if (String(p).endsWith('AFK.md')) return '   \n\t  '; // whitespace-only
        return (realFsModule.__realReadFileSync as Function)(p, ...args);
      });

      const config = loadConfig();
      expect(config.systemPrompt).toBeUndefined();
      expect(config.systemPromptSource).toBeUndefined();
    });

    it('does not throw when no AFK.md exists anywhere', () => {
      mockedExistsSync().mockImplementation((p) => {
        if (String(p).endsWith('AFK.md')) return false;
        return realFsModule.__realExistsSync(p as fs.PathLike);
      });

      expect(() => loadConfig()).not.toThrow();
      const config = loadConfig();
      expect(config.systemPrompt).toBeUndefined();
      expect(config.systemPromptSource).toBeUndefined();
    });
  });

  describe('model slots (afk.config.json models block)', () => {
    const mockedExistsSync = () => vi.mocked(fs.existsSync);
    const mockedReadFileSync = () => vi.mocked(fs.readFileSync);
    const cwdConfigJson = join(process.cwd(), 'afk.config.json');

    const ENV = [
      'AFK_MODEL', 'CLAUDE_MODEL',
      'AFK_MODEL_SMALL', 'AFK_MODEL_MEDIUM', 'AFK_MODEL_LARGE',
      'AFK_MODEL_LOCAL', 'AFK_MODEL_LOCAL_BASE_URL', 'AFK_MODEL_LOCAL_API_KEY',
    ];

    function mockConfig(json: unknown): void {
      mockedExistsSync().mockImplementation((p) => {
        const s = String(p);
        if (s === cwdConfigJson) return true;
        if (s.endsWith('AFK.md') || s.endsWith('afk.config.json')) return false;
        return realFsModule.__realExistsSync(p as fs.PathLike);
      });
      mockedReadFileSync().mockImplementation((p, ...args) => {
        if (String(p) === cwdConfigJson) return JSON.stringify(json);
        return (realFsModule.__realReadFileSync as Function)(p, ...args);
      });
    }

    beforeEach(() => {
      _resetConfigCache();
      resetSlotBindings();
      for (const k of ENV) delete process.env[k];
    });

    afterEach(() => {
      _resetConfigCache();
      resetSlotBindings();
      for (const k of ENV) delete process.env[k];
      mockedExistsSync().mockImplementation(realFsModule.__realExistsSync);
      mockedReadFileSync().mockImplementation(realFsModule.__realReadFileSync);
    });

    it('defaults to the built-in tier bindings when no models block is present', () => {
      mockConfig({});
      const config = loadConfig();
      expect(config.models).toEqual(DEFAULT_SLOT_BINDINGS);
      expect(getSlotBindings()).toEqual(DEFAULT_SLOT_BINDINGS);
    });

    it('parses bare-string and object bindings and installs them globally', () => {
      mockConfig({
        models: {
          small: 'gpt-4o-mini',
          medium: { id: 'claude-sonnet-5', name: 'balanced' },
        },
      });
      const config = loadConfig();
      expect(config.models?.small).toEqual({ id: 'gpt-4o-mini' });
      expect(config.models?.medium).toEqual({ id: 'claude-sonnet-5', name: 'balanced' });
      expect(config.models?.large).toEqual(DEFAULT_SLOT_BINDINGS.large);
      // Installed process-globally → the resolver sees the rebinding + custom name.
      expect(resolveModelInput('small')).toBe('gpt-4o-mini');
      expect(resolveModelInput('balanced')).toBe('claude-sonnet-5');
    });

    it('lets AFK_MODEL_* env override the file binding', () => {
      process.env.AFK_MODEL_SMALL = 'o4-mini';
      mockConfig({ models: { small: { id: 'gpt-4o-mini', name: 'fast' } } });
      const config = loadConfig();
      expect(config.models?.small).toEqual({ id: 'o4-mini', name: 'fast' });
      expect(resolveModelInput('fast')).toBe('o4-mini');
    });
  });

  describe('telegram.verifyDone (afk.config.json parsing)', () => {
    const mockedExistsSync = () => vi.mocked(fs.existsSync);
    const mockedReadFileSync = () => vi.mocked(fs.readFileSync);
    const cwdConfigJson = join(process.cwd(), 'afk.config.json');

    function mockConfig(json: unknown): void {
      mockedExistsSync().mockImplementation((p) => {
        const s = String(p);
        if (s === cwdConfigJson) return true;
        if (s.endsWith('AFK.md') || s.endsWith('afk.config.json')) return false;
        return realFsModule.__realExistsSync(p as fs.PathLike);
      });
      mockedReadFileSync().mockImplementation((p, ...args) => {
        if (String(p) === cwdConfigJson) return JSON.stringify(json);
        return (realFsModule.__realReadFileSync as Function)(p, ...args);
      });
    }

    beforeEach(() => {
      _resetConfigCache();
    });

    afterEach(() => {
      _resetConfigCache();
      mockedExistsSync().mockImplementation(realFsModule.__realExistsSync);
      mockedReadFileSync().mockImplementation(realFsModule.__realReadFileSync);
    });

    it('parses telegram.verifyDone: true', () => {
      mockConfig({ telegram: { verifyDone: true } });
      expect(loadConfig().telegram?.verifyDone).toBe(true);
    });

    it('parses telegram.verifyDone: false', () => {
      mockConfig({ telegram: { verifyDone: false } });
      expect(loadConfig().telegram?.verifyDone).toBe(false);
    });

    it('defaults to undefined (off) when verifyDone is absent', () => {
      mockConfig({ telegram: { notify: { mode: 'primary' } } });
      expect(loadConfig().telegram?.verifyDone).toBeUndefined();
    });

    it('ignores a non-boolean verifyDone (defensive parse → undefined)', () => {
      mockConfig({ telegram: { verifyDone: 'yes' } });
      expect(loadConfig().telegram?.verifyDone).toBeUndefined();
    });
  });
});

describe('resolveSuggestGhost (pure precedence function)', () => {
  it('denylist parse: env set to falsy values → false', () => {
    expect(resolveSuggestGhost('0', undefined)).toBe(false);
    expect(resolveSuggestGhost('false', undefined)).toBe(false);
    expect(resolveSuggestGhost('off', undefined)).toBe(false);
    expect(resolveSuggestGhost('no', undefined)).toBe(false);
    expect(resolveSuggestGhost('FALSE', undefined)).toBe(false); // case-insensitive
    expect(resolveSuggestGhost('OFF', undefined)).toBe(false);
    expect(resolveSuggestGhost('No', undefined)).toBe(false);
  });

  it('denylist parse: env set to truthy/other values → true', () => {
    expect(resolveSuggestGhost('1', undefined)).toBe(true);
    expect(resolveSuggestGhost('true', undefined)).toBe(true);
    expect(resolveSuggestGhost('on', undefined)).toBe(true);
    expect(resolveSuggestGhost('yes', undefined)).toBe(true);
    expect(resolveSuggestGhost('anything-else', undefined)).toBe(true); // denylist, not allowlist
    expect(resolveSuggestGhost('', undefined)).toBe(true); // empty string is NOT in denylist
  });

  it('default-on when both undefined', () => {
    expect(resolveSuggestGhost(undefined, undefined)).toBe(true);
  });

  it('JSON fallback when env unset', () => {
    expect(resolveSuggestGhost(undefined, false)).toBe(false);
    expect(resolveSuggestGhost(undefined, true)).toBe(true);
  });

  it('env beats JSON config', () => {
    expect(resolveSuggestGhost('1', false)).toBe(true);  // env truthy overrides JSON false
    expect(resolveSuggestGhost('0', true)).toBe(false);  // env denylist overrides JSON true
  });
});

describe('loadConfig() — interactive.suggestGhost JSON integration', () => {
  const mockedExistsSync = () => vi.mocked(fs.existsSync);
  const mockedReadFileSync = () => vi.mocked(fs.readFileSync);

  beforeEach(() => {
    _resetConfigCache();
    mockedExistsSync().mockImplementation(realFsModule.__realExistsSync);
    mockedReadFileSync().mockImplementation(realFsModule.__realReadFileSync);
  });

  afterEach(() => {
    mockedExistsSync().mockImplementation(realFsModule.__realExistsSync);
    mockedReadFileSync().mockImplementation(realFsModule.__realReadFileSync);
    _resetConfigCache();
  });

  it('surfaces interactive.suggestGhost: false from JSON config', () => {
    mockedExistsSync().mockImplementation((p) => {
      if (String(p).endsWith('afk.config.json')) return true;
      return realFsModule.__realExistsSync(p as fs.PathLike);
    });
    mockedReadFileSync().mockImplementation((p, ...args) => {
      if (String(p).endsWith('afk.config.json')) {
        return JSON.stringify({ interactive: { suggestGhost: false } });
      }
      return (realFsModule.__realReadFileSync as Function)(p, ...args);
    });
    const config = loadConfig();
    expect(config.interactive?.suggestGhost).toBe(false);
  });

  it('leaves interactive.suggestGhost undefined when not set in JSON', () => {
    mockedExistsSync().mockImplementation((p) => {
      if (String(p).endsWith('afk.config.json')) return true;
      return realFsModule.__realExistsSync(p as fs.PathLike);
    });
    mockedReadFileSync().mockImplementation((p, ...args) => {
      if (String(p).endsWith('afk.config.json')) {
        return JSON.stringify({ interactive: { worktreeAutoname: true } });
      }
      return (realFsModule.__realReadFileSync as Function)(p, ...args);
    });
    const config = loadConfig();
    expect(config.interactive?.suggestGhost).toBeUndefined();
  });
});

describe('loadConfig() — permissionMode default (new-install bypass)', () => {
  const mockedExistsSync = () => vi.mocked(fs.existsSync);
  const mockedReadFileSync = () => vi.mocked(fs.readFileSync);
  const cwdConfigJson = join(process.cwd(), 'afk.config.json');

  // Isolate from the dev machine's real afk.config.json / AFK.md: only the
  // cwd afk.config.json "exists", with the supplied JSON body.
  function mockConfig(json: unknown): void {
    mockedExistsSync().mockImplementation((p) => {
      const s = String(p);
      if (s === cwdConfigJson) return true;
      if (s.endsWith('AFK.md') || s.endsWith('afk.config.json')) return false;
      return realFsModule.__realExistsSync(p as fs.PathLike);
    });
    mockedReadFileSync().mockImplementation((p, ...args) => {
      if (String(p) === cwdConfigJson) return JSON.stringify(json);
      return (realFsModule.__realReadFileSync as Function)(p, ...args);
    });
  }

  beforeEach(() => {
    _resetConfigCache();
    process.env.ANTHROPIC_API_KEY = 'test-api-key-12345';
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    mockedExistsSync().mockImplementation(realFsModule.__realExistsSync);
    mockedReadFileSync().mockImplementation(realFsModule.__realReadFileSync);
    _resetConfigCache();
  });

  it('defaults to bypassPermissions when afk.config.json sets no permissionMode', () => {
    mockConfig({});
    expect(loadConfig().permissionMode).toBe('bypassPermissions');
    // The exported constant is the single source of truth.
    expect(DEFAULT_CLI_PERMISSION_MODE).toBe('bypassPermissions');
    expect(loadConfig().permissionMode).toBe(DEFAULT_CLI_PERMISSION_MODE);
  });

  it('honors an explicit permissionMode: "default" (re-enable containment)', () => {
    mockConfig({ permissionMode: 'default' });
    expect(loadConfig().permissionMode).toBe('default');
  });

  it('honors an explicit permissionMode: "plan"', () => {
    mockConfig({ permissionMode: 'plan' });
    expect(loadConfig().permissionMode).toBe('plan');
  });

  it('falls back to the bypass default when permissionMode is garbage (invalid ignored)', () => {
    mockConfig({ permissionMode: 'totally-not-a-mode' });
    expect(loadConfig().permissionMode).toBe('bypassPermissions');
  });

  it('an explicit overrides.permissionMode still wins over the default', () => {
    mockConfig({});
    expect(loadConfig({ permissionMode: 'default' }).permissionMode).toBe('default');
  });

  it('resolveCliPermissionMode() returns the bypass default when unset, and the config value when set', () => {
    mockConfig({});
    expect(resolveCliPermissionMode()).toBe('bypassPermissions');
    _resetConfigCache();
    mockConfig({ permissionMode: 'plan' });
    expect(resolveCliPermissionMode()).toBe('plan');
  });
});
