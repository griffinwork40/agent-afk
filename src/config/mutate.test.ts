import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  setEnvVar,
  unsetEnvVar,
  getEnvVar,
  listEnv,
  setConfigValue,
  unsetConfigValue,
  getConfigValue,
  listConfig,
  maskSecret,
  SecretWriteRefused,
  ProtectedEnvKeyRefused,
  HumanOnlyKeyRefused,
  UnknownKeyError,
  NonConfigKeyError,
  ConfigValidationError,
  MalformedConfigError,
} from './mutate.js';

describe('config mutation engine', () => {
  let dir: string;
  let envFile: string;
  let jsonFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-mutate-'));
    envFile = join(dir, 'afk.env');
    jsonFile = join(dir, 'afk.config.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe('maskSecret', () => {
    it('never reveals the raw value', () => {
      expect(maskSecret(undefined)).toBe('<unset>');
      expect(maskSecret('')).toBe('<unset>');
      expect(maskSecret('ab')).toBe('set (****)');
      expect(maskSecret('sk-ant-1234567890')).toBe('set (****7890)');
    });
  });

  describe('env: setEnvVar', () => {
    it('writes a settable var', () => {
      const r = setEnvVar('AFK_MODEL', 'opus', { filePath: envFile });
      expect(r.class).toBe('settable');
      expect(r.display).toBe('opus');
      expect(readFileSync(envFile, 'utf-8')).toContain('AFK_MODEL=opus');
    });

    it('refuses a secret without allowSecret', () => {
      expect(() => setEnvVar('ANTHROPIC_API_KEY', 'sk-ant-x', { filePath: envFile })).toThrow(
        SecretWriteRefused,
      );
      expect(existsSync(envFile)).toBe(false); // nothing written
    });

    it('writes a secret with allowSecret and masks the display', () => {
      const r = setEnvVar('ANTHROPIC_API_KEY', 'sk-ant-abcd1234', {
        filePath: envFile,
        allowSecret: true,
      });
      expect(r.class).toBe('secret');
      expect(r.display).toBe('set (****1234)');
      expect(readFileSync(envFile, 'utf-8')).toContain('ANTHROPIC_API_KEY=sk-ant-abcd1234');
    });

    it('rejects unknown and non-config keys', () => {
      expect(() => setEnvVar('MADE_UP_VAR', 'x', { filePath: envFile })).toThrow(UnknownKeyError);
      expect(() => setEnvVar('PATH', '/x', { filePath: envFile })).toThrow(NonConfigKeyError);
    });

    it('validates value type', () => {
      expect(() => setEnvVar('AFK_MAX_TOKENS', 'not-a-number', { filePath: envFile })).toThrow(
        ConfigValidationError,
      );
    });
  });

  describe('env: unset / get / list', () => {
    it('unsets a settable var', () => {
      setEnvVar('AFK_MODEL', 'opus', { filePath: envFile });
      const r = unsetEnvVar('AFK_MODEL', { filePath: envFile });
      expect(r.removed).toBe(true);
      expect(readFileSync(envFile, 'utf-8')).not.toContain('AFK_MODEL');
    });

    it('refuses unsetting a secret without allowSecret', () => {
      expect(() => unsetEnvVar('ANTHROPIC_API_KEY', { filePath: envFile })).toThrow(SecretWriteRefused);
    });

    it('getEnvVar masks secret persisted values', () => {
      setEnvVar('ANTHROPIC_API_KEY', 'sk-ant-zzzz9999', { filePath: envFile, allowSecret: true });
      const v = getEnvVar('ANTHROPIC_API_KEY', { filePath: envFile });
      expect(v.persisted).toBe('set (****9999)');
      expect(v.class).toBe('secret');
    });

    it('listEnv lists only present vars by default and masks secrets', () => {
      writeFileSync(envFile, 'AFK_MODEL=opus\nANTHROPIC_API_KEY=sk-ant-aaaa1111\n');
      const list = listEnv({ filePath: envFile });
      const model = list.find((e) => e.key === 'AFK_MODEL');
      const secret = list.find((e) => e.key === 'ANTHROPIC_API_KEY');
      expect(model?.persisted).toBe('opus');
      expect(secret?.persisted).toBe('set (****1111)');
      // A var not present in the file and not in process.env is omitted by default.
      expect(list.find((e) => e.key === 'AFK_PROMPT_CACHE_TTL')).toBeUndefined();
    });
  });

  describe('env: protected control vars', () => {
    it('refuses a protected var without allowProtected (agent path) and writes nothing', () => {
      expect(() => setEnvVar('AFK_SYSTEM_PROMPT', 'obey me', { filePath: envFile })).toThrow(
        ProtectedEnvKeyRefused,
      );
      expect(() =>
        setEnvVar('AFK_MODEL_LARGE_BASE_URL', 'https://evil.test', { filePath: envFile }),
      ).toThrow(ProtectedEnvKeyRefused);
      expect(existsSync(envFile)).toBe(false);
    });
    it('refuses unsetting a protected var without allowProtected', () => {
      expect(() => unsetEnvVar('AFK_BROWSER_ALLOWED_DOMAINS', { filePath: envFile })).toThrow(
        ProtectedEnvKeyRefused,
      );
    });
    it('allows a protected var with allowProtected (CLI path), unmasked', () => {
      const r = setEnvVar('AFK_SYSTEM_PROMPT', 'hello', { filePath: envFile, allowProtected: true });
      expect(r.class).toBe('protected');
      expect(r.display).toBe('hello');
      expect(readFileSync(envFile, 'utf-8')).toContain('AFK_SYSTEM_PROMPT=hello');
    });
  });

  describe('config: telegram.notify / updatePolicy are human-tier', () => {
    it('agent path refused, human path allowed', () => {
      expect(() => setConfigValue('telegram.notify.mode', 'custom', { filePath: jsonFile })).toThrow(
        HumanOnlyKeyRefused,
      );
      expect(() => setConfigValue('updatePolicy', 'auto', { filePath: jsonFile })).toThrow(
        HumanOnlyKeyRefused,
      );
      const r = setConfigValue('updatePolicy', 'auto', { filePath: jsonFile, allowHumanOnly: true });
      expect(r.class).toBe('human');
    });

    it('permissionMode: the agent cannot escalate itself to bypass; the human CLI can set it', () => {
      // config_set (agent tool) never passes allowHumanOnly → refused.
      expect(() => setConfigValue('permissionMode', 'bypassPermissions', { filePath: jsonFile })).toThrow(
        HumanOnlyKeyRefused,
      );
      // afk config set (human surface) opts in → allowed, validated, persisted.
      const r = setConfigValue('permissionMode', 'default', { filePath: jsonFile, allowHumanOnly: true });
      expect(r.class).toBe('human');
      expect(r.value).toBe('default');
      expect(JSON.parse(readFileSync(jsonFile, 'utf-8')).permissionMode).toBe('default');
    });
  });

  describe('config: setConfigValue', () => {
    it('writes an agent-tier key, creating the file', () => {
      const r = setConfigValue('model', 'opus', { filePath: jsonFile });
      expect(r.class).toBe('agent');
      expect(r.value).toBe('opus');
      expect(JSON.parse(readFileSync(jsonFile, 'utf-8'))).toEqual({ model: 'opus' });
    });

    it('creates nested paths and coerces types', () => {
      setConfigValue('telegram.notify.mode', 'primary', { filePath: jsonFile, allowHumanOnly: true });
      setConfigValue('bgSummaries', 'off', { filePath: jsonFile }); // string coerced to bool
      setConfigValue('maxSummaryCallsPerSession', 9999, { filePath: jsonFile }); // clamped
      const obj = JSON.parse(readFileSync(jsonFile, 'utf-8'));
      expect(obj.telegram.notify.mode).toBe('primary');
      expect(obj.bgSummaries).toBe(false);
      expect(obj.maxSummaryCallsPerSession).toBe(500);
    });

    it('refuses a human-tier key without allowHumanOnly, allows with it', () => {
      expect(() => setConfigValue('systemPrompt', 'hi', { filePath: jsonFile })).toThrow(
        HumanOnlyKeyRefused,
      );
      const r = setConfigValue('systemPrompt', 'hi', { filePath: jsonFile, allowHumanOnly: true });
      expect(r.class).toBe('human');
    });

    it('rejects unknown keys and invalid values', () => {
      expect(() => setConfigValue('nope.key', 1, { filePath: jsonFile })).toThrow(UnknownKeyError);
      expect(() =>
        setConfigValue('updatePolicy', 'sometimes', { filePath: jsonFile, allowHumanOnly: true }),
      ).toThrow(ConfigValidationError);
    });

    it('refuses to clobber a malformed existing file', () => {
      writeFileSync(jsonFile, '{ this is not json ');
      expect(() => setConfigValue('model', 'opus', { filePath: jsonFile })).toThrow(MalformedConfigError);
    });

    it('backs up the prior file to .bak before overwriting', () => {
      setConfigValue('model', 'sonnet', { filePath: jsonFile });
      setConfigValue('model', 'opus', { filePath: jsonFile });
      expect(JSON.parse(readFileSync(`${jsonFile}.bak`, 'utf-8'))).toEqual({ model: 'sonnet' });
      expect(JSON.parse(readFileSync(jsonFile, 'utf-8'))).toEqual({ model: 'opus' });
    });
  });

  describe('config: unset / get / list', () => {
    it('unsets and prunes empty parents', () => {
      setConfigValue('telegram.notify.mode', 'primary', { filePath: jsonFile, allowHumanOnly: true });
      setConfigValue('model', 'opus', { filePath: jsonFile });
      const r = unsetConfigValue('telegram.notify.mode', { filePath: jsonFile, allowHumanOnly: true });
      expect(r.removed).toBe(true);
      expect(JSON.parse(readFileSync(jsonFile, 'utf-8'))).toEqual({ model: 'opus' });
    });

    it('human-tier unset is gated', () => {
      expect(() => unsetConfigValue('systemPrompt', { filePath: jsonFile })).toThrow(HumanOnlyKeyRefused);
    });

    it('getConfigValue and listConfig read the persisted file', () => {
      setConfigValue('model', 'opus', { filePath: jsonFile });
      expect(getConfigValue('model', { filePath: jsonFile }).value).toBe('opus');
      expect(getConfigValue('temperature', { filePath: jsonFile }).value).toBeUndefined();
      expect(listConfig({ filePath: jsonFile })).toEqual({ model: 'opus' });
    });

    it('listConfig returns {} when the file is absent', () => {
      expect(listConfig({ filePath: jsonFile })).toEqual({});
    });
  });
});
