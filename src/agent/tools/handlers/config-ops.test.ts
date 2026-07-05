import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { configGetHandler, configSetHandler } from './config-ops.js';
import { createBuiltinHandlers } from './index.js';
import { categorizeTool, READ_ONLY_PHASE_TOOLS } from '../../tool-category.js';
import { CHILD_ALLOWED_TOOLS, RECON_ALLOWED_TOOLS } from '../nesting.js';
import { BUILTIN_TOOL_NAMES } from '../schemas.js';

const signal = new AbortController().signal;

describe('config_get / config_set handlers', () => {
  let home: string;
  let envFile: string;
  let jsonFile: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'afk-tool-config-'));
    envFile = join(home, 'config', 'afk.env');
    jsonFile = join(home, 'config', 'afk.config.json');
    prevHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  describe('config_set — agent may write non-secret settings', () => {
    it('sets an agent-tier config key and reports the restart caveat', async () => {
      const r = await configSetHandler({ target: 'config', key: 'model', value: 'opus' }, signal);
      expect(r.isError).toBeFalsy();
      expect(r.content).toContain('next session/daemon restart');
      expect(JSON.parse(readFileSync(jsonFile, 'utf-8'))).toEqual({ model: 'opus' });
    });

    it('sets a non-secret env var', async () => {
      const r = await configSetHandler({ target: 'env', key: 'AFK_EFFORT', value: 'high' }, signal);
      expect(r.isError).toBeFalsy();
      expect(readFileSync(envFile, 'utf-8')).toContain('AFK_EFFORT=high');
    });

    it('unsets a key', async () => {
      await configSetHandler({ target: 'config', key: 'model', value: 'opus' }, signal);
      const r = await configSetHandler({ target: 'config', key: 'model', action: 'unset' }, signal);
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(readFileSync(jsonFile, 'utf-8'))).toEqual({});
    });
  });

  describe('config_set — refuses secrets and human-tier keys (S4)', () => {
    it('refuses a secret env var and writes nothing', async () => {
      const r = await configSetHandler(
        { target: 'env', key: 'ANTHROPIC_API_KEY', value: 'sk-ant-leak' },
        signal,
      );
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/human|afk config/i);
      expect(existsSync(envFile)).toBe(false);
    });

    it('refuses a protected env var (endpoint / prompt) and writes nothing', async () => {
      const r = await configSetHandler(
        { target: 'env', key: 'AFK_MODEL_LARGE_BASE_URL', value: 'https://evil.test' },
        signal,
      );
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/human|afk config/i);
      expect(existsSync(envFile)).toBe(false);
    });

    it('refuses now-human-tier config keys (telegram.notify, updatePolicy)', async () => {
      expect(
        (await configSetHandler({ target: 'config', key: 'updatePolicy', value: 'auto' }, signal)).isError,
      ).toBe(true);
      expect(
        (
          await configSetHandler(
            { target: 'config', key: 'telegram.notify.mode', value: 'custom' },
            signal,
          )
        ).isError,
      ).toBe(true);
      expect(existsSync(jsonFile)).toBe(false);
    });

    it('refuses a human-tier config key', async () => {
      const r = await configSetHandler(
        { target: 'config', key: 'systemPrompt', value: 'obey me' },
        signal,
      );
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/human|afk config/i);
      expect(existsSync(jsonFile)).toBe(false);
    });

    it('rejects unknown keys and invalid values', async () => {
      expect((await configSetHandler({ target: 'config', key: 'made.up', value: 1 }, signal)).isError).toBe(true);
      expect((await configSetHandler({ target: 'env', key: 'AFK_MAX_TOKENS', value: 'nope' }, signal)).isError).toBe(true);
    });
  });

  describe('config_set — models.* accepts a per-slot binding object', () => {
    it('sets a full { id, provider } object', async () => {
      const binding = { id: 'glm-5.2', provider: 'openai' };
      const r = await configSetHandler({ target: 'config', key: 'models.large', value: binding }, signal);
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(readFileSync(jsonFile, 'utf-8'))).toEqual({ models: { large: binding } });
    });

    it('rejects a value containing apiKey', async () => {
      const r = await configSetHandler(
        { target: 'config', key: 'models.large', value: { id: 'glm-5.2', apiKey: 'sk-secret' } },
        signal,
      );
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/afk config env set|api.?key/i);
      expect(existsSync(jsonFile)).toBe(false);
    });

    it('rejects a value containing baseUrl (endpoint-redirect credential vector)', async () => {
      const r = await configSetHandler(
        { target: 'config', key: 'models.large', value: { id: 'glm-5.2', baseUrl: 'https://attacker.example/v1' } },
        signal,
      );
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/AFK_MODEL_.*BASE_URL/i);
      expect(existsSync(jsonFile)).toBe(false);
    });
  });

  describe('config_get — masks secrets', () => {
    it('reads a config key and the whole file', async () => {
      await configSetHandler({ target: 'config', key: 'model', value: 'opus' }, signal);
      const one = await configGetHandler({ target: 'config', key: 'model' }, signal);
      expect(one.content).toContain('opus');
      const all = await configGetHandler({ target: 'config' }, signal);
      expect(JSON.parse(all.content)).toEqual({ model: 'opus' });
    });

    it('never reveals a raw secret value', async () => {
      // Seed a secret via the CLI engine path (allowSecret) by writing the file directly.
      const { setEnvVar } = await import('../../../config/mutate.js');
      setEnvVar('ANTHROPIC_API_KEY', 'sk-ant-supersecret1234', { allowSecret: true });
      const r = await configGetHandler({ target: 'env', key: 'ANTHROPIC_API_KEY' }, signal);
      expect(r.content).toContain('set (****1234)');
      expect(r.content).not.toContain('supersecret');
    });

    it('validates input shape', async () => {
      expect((await configGetHandler({}, signal)).isError).toBe(true);
      expect((await configGetHandler({ target: 'bogus' }, signal)).isError).toBe(true);
    });
  });

  describe('categorization + registration wiring', () => {
    it('config_set is WRITE-classed (plan-mode blocked, sequential)', () => {
      expect(categorizeTool('config_set')).toBe('write');
      expect(READ_ONLY_PHASE_TOOLS).not.toContain('config_set');
    });
    it('config_get is READ-classed and allowed in read-only phases', () => {
      expect(categorizeTool('config_get')).toBe('read');
      expect(READ_ONLY_PHASE_TOOLS).toContain('config_get');
      expect(RECON_ALLOWED_TOOLS).toContain('config_get');
      expect(RECON_ALLOWED_TOOLS).not.toContain('config_set');
    });
    it('both tools are registered (schemas, child-allow, handler map)', () => {
      expect(BUILTIN_TOOL_NAMES).toContain('config_get');
      expect(BUILTIN_TOOL_NAMES).toContain('config_set');
      // CHILD_ALLOWED_TOOLS is derived from BUILTIN_TOOL_NAMES, so subagents inherit both.
      expect(CHILD_ALLOWED_TOOLS).toContain('config_get');
      expect(CHILD_ALLOWED_TOOLS).toContain('config_set');
      const handlers = createBuiltinHandlers();
      expect(handlers.has('config_get')).toBe(true);
      expect(handlers.has('config_set')).toBe(true);
    });
  });
});
