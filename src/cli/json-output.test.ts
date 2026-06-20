import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { registerStatusCommand } from './commands/status.js';
import { registerConfigCommand } from './commands/config-command.js';
import { registerPluginCommand } from './commands/plugin.js';
import type { PluginCommandDeps } from './commands/plugin.js';

describe('CLI JSON output', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let capturedOutput: string[];

  beforeEach(() => {
    capturedOutput = [];
    consoleSpy = vi.spyOn(console, 'log').mockImplementation((message: string) => {
      capturedOutput.push(message);
    });
    // Provide a fake API key so anthropic-direct provider doesn't throw
    // during construction. The session will fail on the actual API call
    // but the status command still produces structured output.
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-fake-key-for-status-test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['ANTHROPIC_API_KEY'];
  });

  describe('status command', () => {
    it('should output text by default (non-JSON)', async () => {
      const program = new Command();
      registerStatusCommand(program);

      try {
        await program.parseAsync(['node', 'test', 'status']);
      } catch (err) {
        // Expected to fail due to missing API key, but we still check output
      }

      expect(capturedOutput.length).toBeGreaterThan(0);
      const joined = capturedOutput.join('');
      expect(() => JSON.parse(joined)).toThrow();
    });

    it('should output JSON with --format json flag', async () => {
      const program = new Command();
      registerStatusCommand(program);

      try {
        await program.parseAsync(['node', 'test', 'status', '--format', 'json']);
      } catch (err) {
        // Expected to fail due to missing API key, but we check output
      }

      const joined = capturedOutput.join('');
      const parsed = JSON.parse(joined);

      expect(parsed).toHaveProperty('providers');
      expect(parsed.providers).toHaveProperty('anthropic');
      expect(parsed.providers).toHaveProperty('codex');
      expect(parsed.providers.anthropic).toHaveProperty('ok');
      expect(parsed.providers.anthropic).toHaveProperty('source');
      expect(parsed.providers.codex).toHaveProperty('ok');
      expect(parsed.providers.codex).toHaveProperty('source');
      expect(parsed).toHaveProperty('model');
      expect(parsed).toHaveProperty('bypass');
      expect(parsed).toHaveProperty('permissionMode');
      expect(typeof parsed.bypass).toBe('boolean');
    });
  });

  describe('config command', () => {
    it('should output text by default (non-JSON)', async () => {
      const program = new Command();
      registerConfigCommand(program);

      await program.parseAsync(['node', 'test', 'config']);

      expect(capturedOutput.length).toBeGreaterThan(0);
      const joined = capturedOutput.join('');
      expect(() => JSON.parse(joined)).toThrow();
    });

    it('should output JSON with --format json flag', async () => {
      const program = new Command();
      registerConfigCommand(program);

      await program.parseAsync(['node', 'test', 'config', '--format', 'json']);

      const joined = capturedOutput.join('');
      const parsed = JSON.parse(joined);

      expect(parsed).toHaveProperty('model');
      expect(parsed).toHaveProperty('provider');
      expect(parsed).toHaveProperty('apiKey');
      expect(parsed.apiKey).toHaveProperty('present');
      expect(parsed.apiKey).toHaveProperty('source');
      expect(parsed).toHaveProperty('thinking');
      expect(parsed).toHaveProperty('effort');
      expect(parsed).toHaveProperty('bypass');
      expect(parsed).toHaveProperty('permissionMode');
      expect(typeof parsed.bypass).toBe('boolean');
      expect(parsed).toHaveProperty('raw_env');
      expect(parsed.raw_env).toHaveProperty('AFK_MODEL');
      expect(parsed.raw_env).toHaveProperty('AFK_THINKING');
      expect(parsed.raw_env).toHaveProperty('AFK_EFFORT');
      expect(parsed.raw_env).toHaveProperty('ANTHROPIC_API_KEY');
      expect(parsed.raw_env).toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
      expect(parsed.raw_env).toHaveProperty('OPENAI_API_KEY');
      expect(parsed.raw_env).toHaveProperty('CODEX_API_KEY');

      // Ensure no actual key values are in raw_env
      const envValues = Object.values(parsed.raw_env);
      expect(envValues).not.toContain('sk-');
      expect(envValues).not.toContain('pk-');
    });
  });

  describe('plugin list command', () => {
    it('should output text by default (non-JSON)', async () => {
      const deps: PluginCommandDeps = {
        logger: { log: (msg: string) => capturedOutput.push(msg), error: console.error },
      };

      const program = new Command();
      registerPluginCommand(program, deps);

      await program.parseAsync(['node', 'test', 'plugin', 'list']);

      expect(capturedOutput.length).toBeGreaterThan(0);
      const joined = capturedOutput.join('');
      expect(() => JSON.parse(joined)).toThrow();
    });

    it('should output JSON with --format json flag', async () => {
      const deps: PluginCommandDeps = {
        logger: { log: (msg: string) => capturedOutput.push(msg), error: console.error },
      };

      const program = new Command();
      registerPluginCommand(program, deps);

      await program.parseAsync(['node', 'test', 'plugin', 'list', '--format', 'json']);

      const joined = capturedOutput.join('');
      const parsed = JSON.parse(joined);

      expect(parsed).toHaveProperty('plugins');
      expect(Array.isArray(parsed.plugins)).toBe(true);

      // If plugins exist, check their shape
      if (parsed.plugins.length > 0) {
        for (const plugin of parsed.plugins) {
          expect(plugin).toHaveProperty('name');
          expect(plugin).toHaveProperty('enabled');
          expect(plugin).toHaveProperty('source');
        }
      }
    });
  });
});
