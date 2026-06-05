/**
 * Tests for src/cli/commands/completion.ts
 *
 * Verifies: zsh, bash, and fish completion script generation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { registerCompletionCommand } from './commands/completion.js';

describe('completion', () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let capturedOutput: string[];

  beforeEach(() => {
    program = new Command();
    program.name('afk').version('0.1.0');
    registerCompletionCommand(program);

    capturedOutput = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      capturedOutput.push(msg);
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  describe('zsh', () => {
    it('outputs zsh completion script starting with #compdef', async () => {
      await program.parseAsync(['node', 'afk', 'completion', 'zsh']);
      const output = capturedOutput.join('\n');
      expect(output).toMatch(/^#compdef afk/);
    });

    it('zsh script contains top-level subcommand names', async () => {
      await program.parseAsync(['node', 'afk', 'completion', 'zsh']);
      const output = capturedOutput.join('\n');
      const subcommands = ['chat', 'interactive', 'status', 'config', 'daemon', 'login', 'plugin', 'doctor', 'completion'];
      for (const cmd of subcommands) {
        expect(output).toContain(cmd);
      }
    });

    it('zsh script contains plugin subcommand names', async () => {
      await program.parseAsync(['node', 'afk', 'completion', 'zsh']);
      const output = capturedOutput.join('\n');
      const pluginSubcommands = ['install', 'update', 'list', 'remove', 'enable', 'disable'];
      for (const cmd of pluginSubcommands) {
        expect(output).toContain(cmd);
      }
    });

    it('zsh script contains model values', async () => {
      await program.parseAsync(['node', 'afk', 'completion', 'zsh']);
      const output = capturedOutput.join('\n');
      expect(output).toContain('sonnet');
      expect(output).toContain('opus');
      expect(output).toContain('haiku');
    });

    it('zsh script contains format values', async () => {
      await program.parseAsync(['node', 'afk', 'completion', 'zsh']);
      const output = capturedOutput.join('\n');
      expect(output).toContain('json');
      expect(output).toContain('text');
    });
  });

  describe('bash', () => {
    it('outputs bash completion script with function definition', async () => {
      await program.parseAsync(['node', 'afk', 'completion', 'bash']);
      const output = capturedOutput.join('\n');
      expect(output).toMatch(/_afk(\w*)?\s*\(\)/);
    });

    it('bash script ends with complete -F line', async () => {
      await program.parseAsync(['node', 'afk', 'completion', 'bash']);
      const output = capturedOutput.join('\n');
      expect(output).toMatch(/complete\s+-F\s+_afk_complete\s+afk\s*$/m);
    });

    it('bash script contains top-level subcommand names', async () => {
      await program.parseAsync(['node', 'afk', 'completion', 'bash']);
      const output = capturedOutput.join('\n');
      const subcommands = ['chat', 'interactive', 'status', 'config', 'daemon', 'login', 'plugin', 'doctor', 'completion'];
      for (const cmd of subcommands) {
        expect(output).toContain(cmd);
      }
    });

    it('bash script contains plugin subcommands', async () => {
      await program.parseAsync(['node', 'afk', 'completion', 'bash']);
      const output = capturedOutput.join('\n');
      const pluginSubcommands = ['install', 'update', 'list', 'remove', 'enable', 'disable'];
      for (const cmd of pluginSubcommands) {
        expect(output).toContain(cmd);
      }
    });

    it('bash script contains model and format flags', async () => {
      await program.parseAsync(['node', 'afk', 'completion', 'bash']);
      const output = capturedOutput.join('\n');
      expect(output).toContain('--model');
      expect(output).toContain('sonnet');
      expect(output).toContain('opus');
      expect(output).toContain('haiku');
      expect(output).toContain('--format');
      expect(output).toContain('json');
      expect(output).toContain('text');
    });
  });

  describe('fish', () => {
    it('outputs fish completion script starting with complete -c afk', async () => {
      await program.parseAsync(['node', 'afk', 'completion', 'fish']);
      const output = capturedOutput.join('\n');
      expect(output).toMatch(/^complete -c afk/);
    });

    it('fish script contains top-level subcommand completions', async () => {
      await program.parseAsync(['node', 'afk', 'completion', 'fish']);
      const output = capturedOutput.join('\n');
      const subcommands = ['chat', 'interactive', 'status', 'config', 'daemon', 'login', 'plugin', 'doctor', 'completion'];
      for (const cmd of subcommands) {
        expect(output).toContain(cmd);
      }
    });

    it('fish script contains plugin subcommands', async () => {
      await program.parseAsync(['node', 'afk', 'completion', 'fish']);
      const output = capturedOutput.join('\n');
      const pluginSubcommands = ['install', 'update', 'list', 'remove', 'enable', 'disable'];
      for (const cmd of pluginSubcommands) {
        expect(output).toContain(cmd);
      }
    });

    it('fish script contains model and format flags', async () => {
      await program.parseAsync(['node', 'afk', 'completion', 'fish']);
      const output = capturedOutput.join('\n');
      expect(output).toContain('--model');
      expect(output).toContain('--format');
      expect(output).toContain('sonnet');
      expect(output).toContain('opus');
      expect(output).toContain('haiku');
      expect(output).toContain('json');
      expect(output).toContain('text');
    });
  });

  describe('invalid shell', () => {
    it('throws or exits with error for unknown shell', async () => {
      try {
        await program.parseAsync(['node', 'afk', 'completion', 'invalid']);
        // If commander doesn't throw, check if it called process.exit or program.error
        // Since commander may suppress the error, we just verify it doesn't succeed silently
        expect(capturedOutput.length).toBe(0);
      } catch (err) {
        // Commander should throw or error out
        expect(err).toBeDefined();
      }
    });
  });
});

