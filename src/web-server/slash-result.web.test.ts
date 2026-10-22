/**
 * Unit tests for the web SlashResult → CommandControl mapping.
 */
import { describe, it, expect } from 'vitest';
import { normalizeSlashResult } from './slash-result.web.js';

describe('normalizeSlashResult', () => {
  it("'continue' → { kind: 'continue' }", () => {
    expect(normalizeSlashResult('continue')).toEqual({ kind: 'continue' });
  });

  it("'exit' → { kind: 'exit' }", () => {
    expect(normalizeSlashResult('exit')).toEqual({ kind: 'exit' });
  });

  it("'forward' → { kind: 'forward' }", () => {
    expect(normalizeSlashResult('forward')).toEqual({ kind: 'forward' });
  });

  it("{ rerun } → { kind: 'rerun', input }", () => {
    expect(normalizeSlashResult({ rerun: 'my cmd' })).toEqual({ kind: 'rerun', input: 'my cmd' });
  });

  it("{ kind: 'submit' } → { kind: 'submit', message }", () => {
    expect(normalizeSlashResult({ kind: 'submit', message: 'hello' })).toEqual({ kind: 'submit', message: 'hello' });
  });

  it("{ kind: 'prefill' } → { kind: 'prefill', message }", () => {
    expect(normalizeSlashResult({ kind: 'prefill', message: 'world' })).toEqual({ kind: 'prefill', message: 'world' });
  });

  it('unknown object falls back to continue', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeSlashResult({ kind: 'unknown' } as any)).toEqual({ kind: 'continue' });
  });
});
