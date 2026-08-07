/**
 * Tests for the Telegram config-file → env override path.
 *
 * These functions were previously private to src/telegram.ts, which calls
 * main() at module load — importing them in a test booted a bot, so they had
 * no coverage at all despite gating which bot token the daemon runs on.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseEnvFile,
  applyTelegramFileOverrides,
  maskOverrideValue,
  TELEGRAM_FILE_AUTHORITATIVE_KEYS,
} from './env-file-overrides.js';

let dir: string;
const saved: Record<string, string | undefined> = {};

function writeEnv(contents: string): string {
  const p = join(dir, 'afk.env');
  writeFileSync(p, contents, 'utf-8');
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'afk-env-overrides-'));
  for (const key of TELEGRAM_FILE_AUTHORITATIVE_KEYS) {
    saved[key] = process.env[key]; // audit-env-access: allow — test save/restore over fixed allowlist
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of TELEGRAM_FILE_AUTHORITATIVE_KEYS) {
    const prior = saved[key];
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('parseEnvFile', () => {
  it('returns an empty map for a missing file', () => {
    expect(parseEnvFile(join(dir, 'nope.env')).size).toBe(0);
  });

  it('parses key=value pairs', () => {
    const p = writeEnv('TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_VERBOSE=1\n');
    const parsed = parseEnvFile(p);
    expect(parsed.get('TELEGRAM_BOT_TOKEN')).toBe('123:abc');
    expect(parsed.get('TELEGRAM_VERBOSE')).toBe('1');
  });

  it('skips comments and blank lines', () => {
    const p = writeEnv('# a comment\n\n  \nTELEGRAM_VERBOSE=1\n');
    expect([...parseEnvFile(p).keys()]).toEqual(['TELEGRAM_VERBOSE']);
  });

  it('strips matching surrounding quotes', () => {
    const p = writeEnv(`A="dq"\nB='sq'\n`);
    const parsed = parseEnvFile(p);
    expect(parsed.get('A')).toBe('dq');
    expect(parsed.get('B')).toBe('sq');
  });

  it('leaves mismatched quotes intact', () => {
    const p = writeEnv(`A="unbalanced\n`);
    expect(parseEnvFile(p).get('A')).toBe('"unbalanced');
  });

  it('keeps `=` characters inside the value', () => {
    const p = writeEnv('A=b=c=d\n');
    expect(parseEnvFile(p).get('A')).toBe('b=c=d');
  });

  it('ignores lines with no `=`', () => {
    const p = writeEnv('JUNK\nA=1\n');
    expect([...parseEnvFile(p).keys()]).toEqual(['A']);
  });
});

describe('maskOverrideValue', () => {
  it('keeps the bot-id prefix and redacts the secret half of a token', () => {
    expect(maskOverrideValue('TELEGRAM_BOT_TOKEN', '12345:AbCdEfSecret')).toBe('12345:***');
  });

  it('redacts all but a short prefix for a colonless token', () => {
    expect(maskOverrideValue('TELEGRAM_BOT_TOKEN', 'malformedtoken')).toBe('malf***');
  });

  it('passes non-token keys through unchanged', () => {
    expect(maskOverrideValue('TELEGRAM_VERBOSE', '1')).toBe('1');
  });
});

describe('applyTelegramFileOverrides', () => {
  it('file value beats a disagreeing shell value (inverts dotenv precedence)', () => {
    process.env['TELEGRAM_VERBOSE'] = 'shell';
    applyTelegramFileOverrides(writeEnv('TELEGRAM_VERBOSE=file\n'), () => {});
    expect(process.env['TELEGRAM_VERBOSE']).toBe('file');
  });

  it('leaves the shell value alone for keys absent from the file', () => {
    process.env['TELEGRAM_VERBOSE'] = 'shell';
    applyTelegramFileOverrides(writeEnv('TELEGRAM_DATA_DIR=/tmp/x\n'), () => {});
    expect(process.env['TELEGRAM_VERBOSE']).toBe('shell');
    expect(process.env['TELEGRAM_DATA_DIR']).toBe('/tmp/x');
  });

  it('logs a masked notice only when the file actually overrides a shell value', () => {
    const log = vi.fn();
    process.env['TELEGRAM_BOT_TOKEN'] = '999:ShellSecret';
    applyTelegramFileOverrides(writeEnv('TELEGRAM_BOT_TOKEN=123:FileSecret\n'), log);
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0]?.[0] as string;
    expect(line).toContain('123:***');
    expect(line).toContain('999:***');
    expect(line).not.toContain('FileSecret');
    expect(line).not.toContain('ShellSecret');
  });

  it('does not log when the shell value already agrees', () => {
    const log = vi.fn();
    process.env['TELEGRAM_VERBOSE'] = 'same';
    applyTelegramFileOverrides(writeEnv('TELEGRAM_VERBOSE=same\n'), log);
    expect(log).not.toHaveBeenCalled();
    expect(process.env['TELEGRAM_VERBOSE']).toBe('same');
  });

  it('does not log when the shell had no prior value', () => {
    const log = vi.fn();
    applyTelegramFileOverrides(writeEnv('TELEGRAM_VERBOSE=file\n'), log);
    expect(log).not.toHaveBeenCalled();
    expect(process.env['TELEGRAM_VERBOSE']).toBe('file');
  });

  it('ignores non-authoritative keys present in the file', () => {
    applyTelegramFileOverrides(writeEnv('ANTHROPIC_API_KEY=sk-should-not-apply\n'), () => {});
    expect(process.env['ANTHROPIC_API_KEY']).not.toBe('sk-should-not-apply');
  });

  it('is a no-op when the file does not exist', () => {
    process.env['TELEGRAM_VERBOSE'] = 'shell';
    applyTelegramFileOverrides(join(dir, 'missing.env'), () => {});
    expect(process.env['TELEGRAM_VERBOSE']).toBe('shell');
  });
});
