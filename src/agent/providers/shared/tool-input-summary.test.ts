import { describe, it, expect } from 'vitest';
import { summarizeToolInput } from './tool-input-summary.js';

/**
 * Regression coverage for the "0 clue what the agent is running" bug: a
 * multi-line bash command rendered as a bare `$ bash cd <dir>` because the
 * summarizer kept only `command.split('\n')[0]`. The summary is display-only
 * (full fidelity lives in toolInputRaw), so it flattens the whole command to
 * one line instead of dropping everything after the first newline.
 */
describe('summarizeToolInput — bash command flattening', () => {
  it('flattens a multi-line command instead of keeping only the first line', () => {
    // The exact screenshot shape: `cd <dir>` on its own line, real work below.
    const out = summarizeToolInput('bash', {
      command: 'cd agent-afk\ngrep -rn "injection blocks" src/',
    });
    // Leading-space contract (facets/derive.ts relies on it) is preserved.
    expect(out.startsWith(' ')).toBe(true);
    // The meaningful verb now survives — previously discarded at the first \n.
    expect(out).toContain('grep -rn "injection blocks" src/');
    // No raw newline leaks into the one-line label.
    expect(out).not.toContain('\n');
  });

  it('drops line-continuation backslashes so `cd && \\<newline> cmd` reads as one command', () => {
    const out = summarizeToolInput('bash', {
      command: 'cd agent-afk && \\\n  grep -rn "foo" src/',
    });
    // Backslash-newline collapses to a single space (no stray `\` or double space).
    expect(out).toBe(' cd agent-afk && grep -rn "foo" src/');
  });

  it('collapses arbitrary interior whitespace runs to single spaces', () => {
    const out = summarizeToolInput('bash', {
      command: 'echo   a\t\tb\n\n   c',
    });
    expect(out).toBe(' echo a b c');
  });

  it('leaves a single-line command intact (still contains the whole command)', () => {
    const out = summarizeToolInput('bash', { command: 'echo hello' });
    expect(out).toBe(' echo hello');
  });

  it('does NOT strip the `cd <dir> &&` wrapper at this layer (display layer owns that)', () => {
    // stripBashCdPrefix lives in the CLI tool-lane formatter; the provider
    // summary preserves the full flattened command including the cd wrapper.
    const out = summarizeToolInput('bash', {
      command: 'cd agent-afk && git status',
    });
    expect(out).toBe(' cd agent-afk && git status');
  });

  it('caps a pathological long one-liner with an ellipsis', () => {
    const long = 'echo ' + 'x'.repeat(400);
    const out = summarizeToolInput('bash', { command: long });
    // ' ' + 160 chars (159 + '…').
    expect(out.length).toBe(1 + 160);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith(' echo ')).toBe(true);
  });

  it('reads the `cmd` alias as well as `command`', () => {
    const out = summarizeToolInput('bash', { cmd: 'ls -la\npwd' });
    expect(out).toBe(' ls -la pwd');
  });
});

describe('summarizeToolInput — other tool shapes unchanged', () => {
  it('surfaces file paths with a leading space', () => {
    expect(summarizeToolInput('read_file', { file_path: '/tmp/x.ts' })).toBe(' /tmp/x.ts');
    expect(summarizeToolInput('read_file', { path: '/tmp/x.ts' })).toBe(' /tmp/x.ts');
  });

  it('surfaces a query/pattern/url/description with a leading space', () => {
    expect(summarizeToolInput('grep', { pattern: 'foo' })).toBe(' foo');
    expect(summarizeToolInput('web_scrape', { url: 'https://x.com' })).toBe(' https://x.com');
  });

  it('wraps a skill name in parens', () => {
    expect(summarizeToolInput('skill', { name: 'diagnose' })).toBe('(diagnose)');
  });

  it('returns empty string for non-object / empty input', () => {
    expect(summarizeToolInput('bash', undefined)).toBe('');
    expect(summarizeToolInput('bash', 'not-an-object')).toBe('');
    expect(summarizeToolInput('bash', {})).toBe('');
  });
});
