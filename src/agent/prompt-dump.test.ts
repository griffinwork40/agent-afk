/**
 * Tests for src/agent/session/prompt-dump.ts — system prompt provenance tracking.
 *
 * Covers:
 * - deriveResolution: classify all systemPrompt shapes (undefined, string, string[], preset)
 * - dumpIfEnabled: env-driven dispatch (disabled, stderr, file-append)
 * - File I/O: parent dir creation, JSONL append, write failures
 * - Security: system prompt & options.system redaction + warning banner
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  deriveResolution,
  dumpIfEnabled,
  redactInlineSecrets,
  DUMP_FILE_BANNER,
  type DumpPayload,
} from './session/prompt-dump.js';

describe('deriveResolution', () => {
  it('handles undefined systemPrompt', () => {
    const resolution = deriveResolution(undefined);
    expect(resolution.kind).toBe('undefined');
    expect(resolution.note).toBe('SDK uses minimal prompt; claude_code preset NOT loaded');
    expect(resolution.append).toBeUndefined();
  });

  it('handles null systemPrompt', () => {
    const resolution = deriveResolution(null);
    expect(resolution.kind).toBe('undefined');
    expect(resolution.note).toBe('SDK uses minimal prompt; claude_code preset NOT loaded');
  });

  it('handles string systemPrompt', () => {
    const resolution = deriveResolution('custom prompt string');
    expect(resolution.kind).toBe('custom-string');
    expect(resolution.note).toBe('SDK uses this string as full system prompt; claude_code preset NOT loaded');
    expect(resolution.append).toBeUndefined();
  });

  it('handles string[] systemPrompt', () => {
    const resolution = deriveResolution(['part1', 'part2']);
    expect(resolution.kind).toBe('custom-string-array');
    expect(resolution.note).toBe('SDK uses array as full system prompt with cache boundaries; claude_code preset NOT loaded');
  });

  it('handles preset claude_code without append/excludeDynamicSections', () => {
    const systemPrompt = { type: 'preset', preset: 'claude_code' };
    const resolution = deriveResolution(systemPrompt);
    expect(resolution.kind).toBe('preset-claude-code');
    expect(resolution.note).toBe('claude_code preset loaded');
    expect(resolution.append).toBeUndefined();
    expect(resolution.excludeDynamicSections).toBeUndefined();
  });

  it('handles preset claude_code with append string', () => {
    const systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      append: 'extra appended text',
    };
    const resolution = deriveResolution(systemPrompt);
    expect(resolution.kind).toBe('preset-claude-code');
    expect(resolution.note).toBe('claude_code preset loaded');
    expect(resolution.append).toEqual({ length: 'extra appended text'.length });
  });

  it('handles preset claude_code with excludeDynamicSections', () => {
    const systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      excludeDynamicSections: true,
    };
    const resolution = deriveResolution(systemPrompt);
    expect(resolution.kind).toBe('preset-claude-code');
    expect(resolution.excludeDynamicSections).toBe(true);
  });

  it('handles preset claude_code with both append and excludeDynamicSections', () => {
    const systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      append: 'appended',
      excludeDynamicSections: true,
    };
    const resolution = deriveResolution(systemPrompt);
    expect(resolution.kind).toBe('preset-claude-code');
    expect(resolution.append).toEqual({ length: 8 });
    expect(resolution.excludeDynamicSections).toBe(true);
  });

  it('handles unrecognized object shape', () => {
    const systemPrompt = { someRandomField: 'value' };
    const resolution = deriveResolution(systemPrompt);
    expect(resolution.kind).toBe('custom-string');
    expect(resolution.note).toBe('Unrecognized systemPrompt shape; treated as opaque');
  });

  it('handles empty string', () => {
    const resolution = deriveResolution('');
    expect(resolution.kind).toBe('custom-string');
    expect(resolution.note).toBe('SDK uses this string as full system prompt; claude_code preset NOT loaded');
  });

  it('handles empty array', () => {
    const resolution = deriveResolution([]);
    expect(resolution.kind).toBe('custom-string-array');
    expect(resolution.note).toBe('SDK uses array as full system prompt with cache boundaries; claude_code preset NOT loaded');
  });
});

describe('dumpIfEnabled', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['AFK_DUMP_PROMPT'];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv !== undefined) {
      process.env['AFK_DUMP_PROMPT'] = originalEnv;
    } else {
      delete process.env['AFK_DUMP_PROMPT'];
    }
  });

  it('is a no-op when AFK_DUMP_PROMPT is unset', () => {
    delete process.env['AFK_DUMP_PROMPT'];
    const payload: DumpPayload = {
      prompt: 'test',
      options: {},
      provenance: {},
    };
    dumpIfEnabled(payload);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when AFK_DUMP_PROMPT is empty string', () => {
    process.env['AFK_DUMP_PROMPT'] = '';
    const payload: DumpPayload = {
      prompt: 'test',
      options: {},
      provenance: {},
    };
    dumpIfEnabled(payload);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when AFK_DUMP_PROMPT is "0"', () => {
    process.env['AFK_DUMP_PROMPT'] = '0';
    const payload: DumpPayload = {
      prompt: 'test',
      options: {},
      provenance: {},
    };
    dumpIfEnabled(payload);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when AFK_DUMP_PROMPT is "false"', () => {
    process.env['AFK_DUMP_PROMPT'] = 'false';
    const payload: DumpPayload = {
      prompt: 'test',
      options: {},
      provenance: {},
    };
    dumpIfEnabled(payload);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('redacts secret-looking keys in options.env before dumping', () => {
    process.env['AFK_DUMP_PROMPT'] = '1';
    const payload: DumpPayload = {
      prompt: 'test',
      options: {
        model: 'claude-sonnet',
        env: {
          PATH: '/usr/bin',
          HOME: '/home/x',
          ANTHROPIC_API_KEY: 'sk-ant-verysecret-xyz',
          CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-abc',
          GITHUB_TOKEN: 'ghp_abc',
          SOME_PASSWORD: 'hunter2',
          SOME_SECRET: 'shh',
        },
      },
      provenance: {},
    };
    dumpIfEnabled(payload);

    const output = stderrSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).not.toContain('sk-ant-verysecret-xyz');
    expect(output).not.toContain('oauth-secret-abc');
    expect(output).not.toContain('ghp_abc');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('shh');
    // Non-secret keys preserved
    expect(output).toContain('/usr/bin');
    expect(output).toContain('/home/x');
    // Redaction marker with the original length present
    expect(output).toMatch(/<REDACTED length=\d+>/);
  });

  it('does not mutate the original options object', () => {
    process.env['AFK_DUMP_PROMPT'] = '1';
    const originalOptions = {
      env: { ANTHROPIC_API_KEY: 'sk-ant-real-key-dont-touch' },
    };
    const payload: DumpPayload = {
      prompt: 'test',
      options: originalOptions,
      provenance: {},
    };
    dumpIfEnabled(payload);
    expect(originalOptions.env.ANTHROPIC_API_KEY).toBe('sk-ant-real-key-dont-touch');
  });

  it('writes to stderr when AFK_DUMP_PROMPT is "1"', () => {
    process.env['AFK_DUMP_PROMPT'] = '1';
    const payload: DumpPayload = {
      prompt: { message: 'test' },
      options: { model: 'claude-3-sonnet' },
      provenance: { model: { source: 'env:ANTHROPIC_MODEL' } },
    };
    dumpIfEnabled(payload);

    expect(stderrSpy).toHaveBeenCalled();
    const calls = stderrSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // Filter to the JSON payload call (starts with '{'), skipping the warning line
    const jsonCall = calls.map((c) => c[0] as string).find((s) => s.trimStart().startsWith('{'));
    expect(jsonCall).toBeDefined();
    const obj = JSON.parse(jsonCall!);
    expect(obj.timestamp).toBeDefined();
    expect(obj.prompt).toEqual({ message: 'test' });
    expect(obj.options).toEqual({ model: 'claude-3-sonnet' });
    expect(obj.provenance).toEqual({ model: { source: 'env:ANTHROPIC_MODEL' } });
    expect(obj.resolution).toBeDefined();
  });

  it('writes to stderr when AFK_DUMP_PROMPT is "true" (case-insensitive)', () => {
    process.env['AFK_DUMP_PROMPT'] = 'True';
    const payload: DumpPayload = {
      prompt: 'test',
      options: {},
      provenance: {},
    };
    dumpIfEnabled(payload);

    expect(stderrSpy).toHaveBeenCalled();
  });

  it('writes to stderr when AFK_DUMP_PROMPT is "stderr" (case-insensitive)', () => {
    process.env['AFK_DUMP_PROMPT'] = 'STDERR';
    const payload: DumpPayload = {
      prompt: 'test',
      options: {},
      provenance: {},
    };
    dumpIfEnabled(payload);

    expect(stderrSpy).toHaveBeenCalled();
  });

  it('includes ISO timestamp in stderr output', () => {
    process.env['AFK_DUMP_PROMPT'] = '1';
    const before = new Date().toISOString();
    const payload: DumpPayload = {
      prompt: 'test',
      options: {},
      provenance: {},
    };
    dumpIfEnabled(payload);
    const after = new Date().toISOString();

    const jsonCall = stderrSpy.mock.calls.map((c) => c[0] as string).find((s) => s.trimStart().startsWith('{'));
    expect(jsonCall).toBeDefined();
    const obj = JSON.parse(jsonCall!);
    expect(obj.timestamp).toBeDefined();
    const ts = new Date(obj.timestamp).toISOString();
    expect(ts >= before && ts <= after).toBe(true);
  });

  it('includes resolution in stderr output', () => {
    process.env['AFK_DUMP_PROMPT'] = '1';
    const payload: DumpPayload = {
      prompt: 'test',
      options: { systemPrompt: 'custom' },
      provenance: {},
    };
    dumpIfEnabled(payload);

    const jsonCall = stderrSpy.mock.calls.map((c) => c[0] as string).find((s) => s.trimStart().startsWith('{'));
    expect(jsonCall).toBeDefined();
    const obj = JSON.parse(jsonCall!);
    expect(obj.resolution).toEqual({
      kind: 'custom-string',
      note: 'SDK uses this string as full system prompt; claude_code preset NOT loaded',
    });
  });

  it('writes JSONL to file when AFK_DUMP_PROMPT is a file path', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'afk-dump-'));
    const filePath = join(tmpDir, 'dump.jsonl');
    process.env['AFK_DUMP_PROMPT'] = filePath;

    const payload: DumpPayload = {
      prompt: { message: 'test1' },
      options: { model: 'claude-3-sonnet' },
      provenance: {},
    };
    dumpIfEnabled(payload);

    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    // File mode: first line is the banner comment, rest are JSONL entries
    const jsonLines = content.split('\n').filter((l) => l.trimStart().startsWith('{'));
    expect(jsonLines.length).toBeGreaterThanOrEqual(1);
    const obj = JSON.parse(jsonLines[0]);
    expect(obj.prompt).toEqual({ message: 'test1' });

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends multiple JSONL lines to file', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'afk-dump-'));
    const filePath = join(tmpDir, 'dump.jsonl');
    process.env['AFK_DUMP_PROMPT'] = filePath;

    const payload1: DumpPayload = {
      prompt: { message: 'test1' },
      options: {},
      provenance: {},
    };
    dumpIfEnabled(payload1);

    const payload2: DumpPayload = {
      prompt: { message: 'test2' },
      options: {},
      provenance: {},
    };
    dumpIfEnabled(payload2);

    const content = readFileSync(filePath, 'utf-8');
    // File mode: first line is banner comment, remaining lines are JSONL entries
    const jsonLines = content.split('\n').filter((l) => l.trimStart().startsWith('{'));
    expect(jsonLines.length).toBe(2);
    expect(JSON.parse(jsonLines[0]).prompt).toEqual({ message: 'test1' });
    expect(JSON.parse(jsonLines[1]).prompt).toEqual({ message: 'test2' });

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates parent directories for file path', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'afk-dump-'));
    const filePath = join(tmpDir, 'sub', 'nested', 'dump.jsonl');
    process.env['AFK_DUMP_PROMPT'] = filePath;

    const payload: DumpPayload = {
      prompt: 'test',
      options: {},
      provenance: {},
    };
    dumpIfEnabled(payload);

    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(join(tmpDir, 'sub', 'nested'))).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not throw when write fails; logs to stderr instead', () => {
    // Try to write to a read-only location. On Unix, /dev/full always fills.
    // On macOS/Linux this is more portable than trying to make a dir read-only.
    const readOnlyPath = '/dev/full';
    process.env['AFK_DUMP_PROMPT'] = readOnlyPath;

    const payload: DumpPayload = {
      prompt: 'test',
      options: {},
      provenance: {},
    };

    // Should not throw
    expect(() => dumpIfEnabled(payload)).not.toThrow();

    // Should have logged an error to stderr
    const stderrCalls = stderrSpy.mock.calls.map((c) => c[0] as string);
    const hasError = stderrCalls.some((call) => call.includes('[prompt-dump]'));
    expect(hasError).toBe(true);
  });

  it('relative file paths are resolved relative to cwd', () => {
    const originalCwd = process.cwd();
    const tmpDir = mkdtempSync(join(tmpdir(), 'afk-dump-'));
    const relPath = 'relative-dump.jsonl';

    try {
      // Change to tmpdir so relative path resolves there
      process.chdir(tmpDir);
      process.env['AFK_DUMP_PROMPT'] = relPath;

      const payload: DumpPayload = {
        prompt: 'test',
        options: {},
        provenance: {},
      };
      dumpIfEnabled(payload);

      const absPath = join(tmpDir, relPath);
      expect(existsSync(absPath)).toBe(true);
    } finally {
      process.chdir(originalCwd);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not mutate input payload', () => {
    process.env['AFK_DUMP_PROMPT'] = '1';
    const payload: DumpPayload = {
      prompt: { message: 'test' },
      options: { model: 'claude-3-sonnet' },
      provenance: { model: { source: 'env:ANTHROPIC_MODEL' } },
    };

    const payloadBefore = JSON.stringify(payload);
    dumpIfEnabled(payload);
    const payloadAfter = JSON.stringify(payload);

    expect(payloadAfter).toBe(payloadBefore);
  });

  it('reads env var fresh on each call', () => {
    // Test that env var is read fresh by setting it before first call
    // and unsetting before second call
    process.env['AFK_DUMP_PROMPT'] = '1';
    const spy1 = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const payload: DumpPayload = {
      prompt: 'test',
      options: {},
      provenance: {},
    };

    dumpIfEnabled(payload);
    expect(spy1).toHaveBeenCalled();

    spy1.mockRestore();

    // Now unset env var
    delete process.env['AFK_DUMP_PROMPT'];
    const spy2 = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    dumpIfEnabled(payload);
    expect(spy2).not.toHaveBeenCalled();

    spy2.mockRestore();
  });

  // --- Security: system prompt redaction ---

  it('redacts sk-ant-* keys in options.system (assembled system prompt)', () => {
    process.env['AFK_DUMP_PROMPT'] = '1';
    const secretKey = 'sk-ant-api03-supersecretkey1234567890abcdef';
    const payload: DumpPayload = {
      prompt: 'test',
      options: {
        model: 'claude-sonnet',
        system: `You are a helpful assistant.\n\nANTHROPIC_API_KEY=${secretKey}\n`,
      },
      provenance: {},
    };
    dumpIfEnabled(payload);

    const output = stderrSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).not.toContain(secretKey);
    expect(output).toMatch(/<REDACTED/);
  });

  it('redacts Bearer tokens in options.system', () => {
    process.env['AFK_DUMP_PROMPT'] = '1';
    const payload: DumpPayload = {
      prompt: 'test',
      options: {
        system: 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.somepayload',
      },
      provenance: {},
    };
    dumpIfEnabled(payload);

    const output = stderrSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.somepayload');
    expect(output).toMatch(/<REDACTED Bearer/);
  });

  it('emits stderr warning on every active call', () => {
    process.env['AFK_DUMP_PROMPT'] = '1';
    const payload: DumpPayload = { prompt: 'test', options: {}, provenance: {} };
    dumpIfEnabled(payload);

    const output = stderrSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('[--dump-prompt] WARNING');
    expect(output).toContain('secrets');
  });

  it('prepends warning banner in file mode', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'afk-dump-'));
    const filePath = join(tmpDir, 'dump.jsonl');
    process.env['AFK_DUMP_PROMPT'] = filePath;

    const payload: DumpPayload = { prompt: 'test', options: {}, provenance: {} };
    dumpIfEnabled(payload);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain(DUMP_FILE_BANNER.trim());
    expect(content).toContain('AFK PROMPT DUMP');
    expect(content).toContain('secrets');

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('redactInlineSecrets', () => {
  it('redacts sk-ant-* keys', () => {
    const text = 'api key is sk-ant-api03-supersecretkey1234567890abcdef end';
    const result = redactInlineSecrets(text);
    expect(result).not.toContain('sk-ant-api03-supersecretkey1234567890abcdef');
    expect(result).toContain('<REDACTED sk-ant');
    expect(result).toContain('api key is');
    expect(result).toContain('end');
  });

  it('redacts Bearer tokens', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig';
    const result = redactInlineSecrets(text);
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(result).toContain('<REDACTED Bearer');
  });

  it('redacts AKIA keys', () => {
    const text = 'AWS key: AKIAIOSFODNN7EXAMPLE rest of text';
    const result = redactInlineSecrets(text);
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result).toContain('<REDACTED AKIA');
  });

  it('redacts xox tokens', () => {
    const text = 'slack: xoxb-12345678-12345678901-abcdefghijklmnopqrstuvwx rest';
    const result = redactInlineSecrets(text);
    expect(result).not.toContain('xoxb-12345678-12345678901-abcdefghijklmnopqrstuvwx');
    expect(result).toContain('<REDACTED xox token');
  });

  it('redacts KEY=value with high-entropy value', () => {
    const text = 'export MY_SECRET_KEY=supersecretvalueatleast16chars rest';
    const result = redactInlineSecrets(text);
    expect(result).not.toContain('supersecretvalueatleast16chars');
    expect(result).toContain('<REDACTED length=');
  });

  it('does not redact short values in KEY=value', () => {
    // Values <16 chars should not be redacted by the KEY=value pattern
    const text = 'MY_SECRET_KEY=short rest';
    const result = redactInlineSecrets(text);
    // 'short' is only 5 chars — below threshold
    expect(result).toBe(text);
  });

  it('returns unchanged text when no secrets present', () => {
    const text = 'This is plain text with no secrets.';
    expect(redactInlineSecrets(text)).toBe(text);
  });

  // Issue #214: assert non-null capture groups produce correct length in marker

  it('redacts openai_api_key=<non-sk value> with correct length in marker', () => {
    // Use a value that does NOT start with "sk-" to avoid the sk- pattern firing first,
    // so the mixed-case KEY=value pattern is exercised and its length marker verified.
    const secret = 'abcdefghijklmnop1234567890'; // 26 chars, no sk- prefix
    const text = `openai_api_key=${secret}`;
    const result = redactInlineSecrets(text);
    expect(result).not.toContain(secret);
    expect(result).toContain(`openai_api_key=<REDACTED length=${secret.length}>`);
  });

  it('redacts TELEGRAM_BOT_TOKEN=<value> (uppercase) with correct length in marker', () => {
    // Value ≥16 chars but not matching the Telegram-specific pattern (no colon structure)
    const secret = 'abcdefghijklmnopqrstuvwxyz123456';
    const text = `TELEGRAM_BOT_TOKEN=${secret}`;
    const result = redactInlineSecrets(text);
    expect(result).not.toContain(secret);
    // Either the Telegram-specific pattern or the uppercase KEY=value pattern fires — either way redacted
    expect(result).toMatch(/TELEGRAM_BOT_TOKEN=<REDACTED|<REDACTED Telegram token/);
  });

  it('redacts mixed-case Api_Token=<value> with correct length in marker', () => {
    const secret = 'xxxxxxxxxxxxxxxx'; // exactly 16 chars
    const text = `Api_Token=${secret}`;
    const result = redactInlineSecrets(text);
    expect(result).not.toContain(secret);
    expect(result).toContain(`Api_Token=<REDACTED length=${secret.length}>`);
  });

  it('does NOT redact KEY=short (value under 16 chars)', () => {
    const text = 'MY_API_KEY=short';
    const result = redactInlineSecrets(text);
    expect(result).toBe(text);
  });
});
