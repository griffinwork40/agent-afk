/**
 * Unit tests for buildVerificationResultTail in verification-patterns.ts.
 *
 * All tests are pure (no I/O). redactSecrets is the real implementation so
 * that the redaction contract is tested end-to-end here rather than mocked.
 */

import { describe, it, expect } from 'vitest';
import { buildVerificationResultTail, RESULT_TAIL_CHARS } from './verification-patterns.js';

// ---------------------------------------------------------------------------
// Non-verification tools → undefined
// ---------------------------------------------------------------------------

describe('buildVerificationResultTail — non-verification tools', () => {
  it('returns undefined for a non-verification bash command', () => {
    expect(buildVerificationResultTail('bash', 'ls -la', 'file1.ts\nfile2.ts')).toBeUndefined();
  });

  it('returns undefined for read_file regardless of content', () => {
    expect(buildVerificationResultTail('read_file', '/src/foo.ts', 'const x = 1;')).toBeUndefined();
  });

  it('returns undefined for write_file', () => {
    expect(buildVerificationResultTail('write_file', '', 'ok')).toBeUndefined();
  });

  it('returns undefined when rawContent is empty even for a verification command', () => {
    expect(buildVerificationResultTail('bash', 'pnpm test', '')).toBeUndefined();
  });

  it('returns undefined when rawContent is empty for test_run', () => {
    expect(buildVerificationResultTail('test_run', '', '')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Verification commands detected via isVerificationCommand
// ---------------------------------------------------------------------------

describe('buildVerificationResultTail — verification command detection', () => {
  const shortOutput = 'Tests  5 passed (5)';

  it('recognises pnpm test', () => {
    expect(buildVerificationResultTail('bash', 'pnpm test', shortOutput)).toBeDefined();
  });

  it('recognises pnpm lint', () => {
    expect(buildVerificationResultTail('bash', 'pnpm lint', shortOutput)).toBeDefined();
  });

  it('recognises pnpm build', () => {
    expect(buildVerificationResultTail('bash', 'pnpm build', shortOutput)).toBeDefined();
  });

  it('recognises vitest', () => {
    expect(buildVerificationResultTail('bash', 'npx vitest run', shortOutput)).toBeDefined();
  });

  it('recognises tsc', () => {
    expect(buildVerificationResultTail('bash', 'tsc --noEmit', shortOutput)).toBeDefined();
  });

  it('always recognises test_run regardless of input', () => {
    expect(buildVerificationResultTail('test_run', '', shortOutput)).toBeDefined();
    expect(buildVerificationResultTail('test_run', 'anything', shortOutput)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Short content (≤ RESULT_TAIL_CHARS) — returned verbatim (after redaction)
// ---------------------------------------------------------------------------

describe('buildVerificationResultTail — short content', () => {
  it('returns the full content when it fits within RESULT_TAIL_CHARS', () => {
    const output = 'Tests  3 passed (3)';
    const result = buildVerificationResultTail('bash', 'pnpm test', output);
    expect(result).toBe(output);
    expect(result!.length).toBeLessThanOrEqual(RESULT_TAIL_CHARS);
  });

  it('returns content within RESULT_TAIL_CHARS when content is exactly that long', () => {
    // Use realistic test output lines rather than repeated chars (which
    // redactSecrets may treat as a secret pattern).
    const line = 'ok | 1 passed\n';
    const output = line.repeat(Math.floor(RESULT_TAIL_CHARS / line.length)).slice(0, RESULT_TAIL_CHARS);
    const result = buildVerificationResultTail('test_run', '', output);
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(RESULT_TAIL_CHARS);
  });
});

// ---------------------------------------------------------------------------
// Long content (> RESULT_TAIL_CHARS) — sliced to last RESULT_TAIL_CHARS chars
// ---------------------------------------------------------------------------

describe('buildVerificationResultTail — long content slicing', () => {
  it('slices to the last RESULT_TAIL_CHARS characters when rawContent is long', () => {
    // Pad with realistic output lines so redactSecrets does not mangle the content.
    const suffix = '10 passed (10)';
    const padding = 'ok\n'.repeat(200);
    const rawContent = padding + suffix;
    const result = buildVerificationResultTail('bash', 'pnpm test', rawContent);
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(RESULT_TAIL_CHARS);
    expect(result).toContain(suffix);
  });

  it('takes from the tail end of long content (last RESULT_TAIL_CHARS chars)', () => {
    // Build content where only the very last characters contain the terminal
    // summary line. The tail suffix is the last char of rawContent, so it
    // must appear in slice(-RESULT_TAIL_CHARS). Use a suffix long enough to
    // survive redactSecrets unchanged (plain word, not a secret pattern).
    const suffix = ' done: 3 passed, 0 failed';
    // Pad to well over RESULT_TAIL_CHARS with realistic-looking lines.
    const filler = 'running suite\n'.repeat(30); // 420 chars >> 240
    const rawContent = filler + suffix;
    expect(rawContent.length).toBeGreaterThan(RESULT_TAIL_CHARS);
    const result = buildVerificationResultTail('test_run', '', rawContent);
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(RESULT_TAIL_CHARS);
    // The terminal summary must appear because it is at the very end.
    expect(result).toContain(suffix);
  });
});

// ---------------------------------------------------------------------------
// tailPreview path — preferred over rawContent when non-empty
// ---------------------------------------------------------------------------

describe('buildVerificationResultTail — tailPreview parameter', () => {
  it('uses tailPreview (joined) when provided and non-empty', () => {
    const rawContent = 'x'.repeat(500) + '\nignored suffix';
    const tailPreview = ['Tests  7 passed (7)', ''];
    const result = buildVerificationResultTail('bash', 'pnpm test', rawContent, tailPreview);
    expect(result).toBeDefined();
    // Should contain the tailPreview content, not the rawContent suffix
    expect(result).toContain('Tests  7 passed (7)');
    expect(result).not.toContain('ignored suffix');
  });

  it('joins tailPreview lines with newline', () => {
    const lines = ['line one', 'line two', 'Tests  2 passed (2)'];
    const result = buildVerificationResultTail('bash', 'pnpm test', 'anything', lines);
    expect(result).toContain('line one\nline two\nTests  2 passed (2)');
  });

  it('falls back to rawContent when tailPreview is an empty array', () => {
    const rawContent = 'Tests  4 passed (4)';
    const result = buildVerificationResultTail('bash', 'pnpm test', rawContent, []);
    // empty tailPreview → fall back to rawContent
    expect(result).toBe(rawContent);
  });

  it('falls back to rawContent when tailPreview is undefined', () => {
    const rawContent = 'Tests  4 passed (4)';
    const result = buildVerificationResultTail('bash', 'pnpm test', rawContent, undefined);
    expect(result).toBe(rawContent);
  });

  it('slices a long tailPreview join to RESULT_TAIL_CHARS', () => {
    // Use realistic lines to avoid redactSecrets mangling repeated-char content.
    const longLine = 'ok | 1 passed\n'.repeat(20); // well over RESULT_TAIL_CHARS
    const lines = [longLine, '1 passed (1)'];
    const result = buildVerificationResultTail('bash', 'pnpm test', 'ignored', lines);
    expect(result!.length).toBeLessThanOrEqual(RESULT_TAIL_CHARS);
    expect(result).toContain('1 passed (1)');
  });
});

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

describe('buildVerificationResultTail — secret redaction', () => {
  it('redacts an Anthropic-style API key in the tail', () => {
    const secret = 'sk-ant-' + 'A'.repeat(30);
    const rawContent = `pnpm test\n${secret}\nTests  5 passed (5)`;
    const result = buildVerificationResultTail('bash', 'pnpm test', rawContent);
    expect(result).toBeDefined();
    expect(result).not.toContain(secret);
    expect(result).toContain('[REDACTED]');
  });

  it('redacts secrets in tailPreview lines', () => {
    const secret = 'sk-ant-' + 'B'.repeat(30);
    const lines = [secret, 'Tests  3 passed (3)'];
    const result = buildVerificationResultTail('bash', 'pnpm test', 'ignored', lines);
    expect(result).not.toContain(secret);
    expect(result).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// Behavioural parity: stream path vs journal path produce same tail
// ---------------------------------------------------------------------------

describe('buildVerificationResultTail — stream vs journal parity', () => {
  it('produces the same tail whether called with or without tailPreview when content is short', () => {
    const content = 'Tests  2 passed (2)';
    const streamResult = buildVerificationResultTail('bash', 'pnpm test', content, [content]);
    const journalResult = buildVerificationResultTail('bash', 'pnpm test', content);
    // Both should equal the content (short, no slice needed)
    expect(streamResult).toBe(content);
    expect(journalResult).toBe(content);
    expect(streamResult).toBe(journalResult);
  });
});
