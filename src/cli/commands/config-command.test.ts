import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Secret entry must not require a real TTY in tests — stub the masked prompt.
vi.mock('../../utils/prompt-secret.js', () => ({
  promptSecret: vi.fn(async () => 'sk-ant-mocked9999'),
}));

import { registerConfigCommand } from './config-command.js';

describe('afk config CLI', () => {
  let home: string;
  let envFile: string;
  let jsonFile: string;
  let prevHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  function run(...args: string[]): Promise<unknown> {
    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program);
    return program.parseAsync(['node', 'afk', 'config', ...args]);
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'afk-cli-config-'));
    envFile = join(home, 'config', 'afk.env');
    jsonFile = join(home, 'config', 'afk.config.json');
    prevHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = home;
    process.exitCode = 0;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = prevHome;
    process.exitCode = 0;
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(home, { recursive: true, force: true });
  });

  it('config set writes an agent-tier key to afk.config.json', async () => {
    await run('set', 'model', 'opus');
    expect(JSON.parse(readFileSync(jsonFile, 'utf-8'))).toEqual({ model: 'opus' });
    expect(process.exitCode).toBe(0);
  });

  it('config set coerces and clamps via the engine', async () => {
    await run('set', 'maxSummaryCallsPerSession', '9999');
    expect(JSON.parse(readFileSync(jsonFile, 'utf-8')).maxSummaryCallsPerSession).toBe(500);
  });

  it('config set allows human-tier keys from the CLI', async () => {
    await run('set', 'systemPrompt', 'be concise');
    expect(JSON.parse(readFileSync(jsonFile, 'utf-8')).systemPrompt).toBe('be concise');
  });

  it('config get reads a key and the whole file', async () => {
    await run('set', 'model', 'opus');
    logSpy.mockClear();
    await run('get', 'model', '--json');
    expect(logSpy.mock.calls.flat().join('')).toContain('"opus"');
  });

  it('config unset removes a key', async () => {
    await run('set', 'model', 'opus');
    await run('unset', 'model');
    expect(JSON.parse(readFileSync(jsonFile, 'utf-8'))).toEqual({});
  });

  it('rejects an unknown config key with exit code 2', async () => {
    await run('set', 'bogus.key', '1');
    expect(process.exitCode).toBe(2);
    expect(existsSync(jsonFile)).toBe(false);
  });

  it('config env set writes a non-secret var', async () => {
    await run('env', 'set', 'AFK_EFFORT', 'high');
    expect(readFileSync(envFile, 'utf-8')).toContain('AFK_EFFORT=high');
  });

  it('config env set routes secrets through the masked prompt and ignores positional value', async () => {
    const { promptSecret } = await import('../../utils/prompt-secret.js');
    await run('env', 'set', 'ANTHROPIC_API_KEY', 'sk-SHOULD-BE-IGNORED');
    expect(promptSecret).toHaveBeenCalled();
    const contents = readFileSync(envFile, 'utf-8');
    expect(contents).toContain('ANTHROPIC_API_KEY=sk-ant-mocked9999');
    expect(contents).not.toContain('SHOULD-BE-IGNORED');
  });

  it('config env get masks secret values', async () => {
    await run('env', 'set', 'ANTHROPIC_API_KEY');
    logSpy.mockClear();
    await run('env', 'get', 'ANTHROPIC_API_KEY');
    const out = logSpy.mock.calls.flat().join('');
    expect(out).toContain('set (****9999)');
    expect(out).not.toContain('sk-ant-mocked9999');
  });

  it('config env unset removes a var', async () => {
    await run('env', 'set', 'AFK_EFFORT', 'high');
    await run('env', 'unset', 'AFK_EFFORT');
    expect(readFileSync(envFile, 'utf-8')).not.toContain('AFK_EFFORT');
  });
});
