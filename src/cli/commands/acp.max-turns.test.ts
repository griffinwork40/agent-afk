/**
 * `afk acp --max-turns`: a negative or non-numeric value is a CLI error before
 * the server starts; 0 stays "no cap".
 *
 * @module cli/commands/acp.max-turns.test
 */
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./acp.server.js', () => ({ runAcpServer: vi.fn(async () => undefined), exitAfterServer: vi.fn(async () => undefined) }));

import { runAcpServer } from './acp.server.js';
import { parseMaxTurns, registerAcpCommand } from './acp.js';

function program(): { cmd: Command; errors: string[] } {
  const errors: string[] = [];
  const cmd = new Command().exitOverride().configureOutput({ writeErr: (s) => { errors.push(s); }, writeOut: () => {} });
  registerAcpCommand(cmd);
  cmd.commands[0]!.exitOverride().configureOutput({ writeErr: (s) => { errors.push(s); }, writeOut: () => {} });
  return { cmd, errors };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('--max-turns validation', () => {
  it.each(['-1', 'abc', '1.5', '', ' ', '2x', '1e3', '99999999999999999999'])('rejects %j before the server starts', async (value) => {
    const { cmd, errors } = program();
    await expect(cmd.parseAsync(['node', 'afk', 'acp', '--max-turns', value])).rejects.toThrow();
    expect(errors.join('')).toMatch(/--max-turns must be a non-negative integer/);
    expect(runAcpServer).not.toHaveBeenCalled();
  });

  it.each([['0', 0], ['3', 3], ['007', 7]])('accepts %j as %d', async (value, expected) => {
    const { cmd } = program();
    await cmd.parseAsync(['node', 'afk', 'acp', '--max-turns', value]);
    expect(vi.mocked(runAcpServer).mock.calls[0]![0]).toMatchObject({ maxTurns: expected });
  });

  it('defaults to 0 (no cap) when omitted', async () => {
    const { cmd } = program();
    await cmd.parseAsync(['node', 'afk', 'acp']);
    expect(vi.mocked(runAcpServer).mock.calls[0]![0]).toMatchObject({ maxTurns: 0 });
  });

  it('parseMaxTurns normalises a valid value', () => {
    expect(parseMaxTurns(' 12 ')).toBe('12');
    expect(() => parseMaxTurns('-0')).toThrow();
  });
});
