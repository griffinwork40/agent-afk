import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../display.js';
import { streamProgress } from './stream-progress.js';

describe('streamProgress', () => {
  it('renders spinner, label, and elapsed', () => {
    const result = stripAnsi(
      streamProgress({
        label: 'Generating…',
        spinnerFrame: 0,
        elapsedMs: 4700,
      }),
    );
    expect(result).toContain('⠋');
    expect(result).toContain('Generating…');
    expect(result).toContain('4s');
  });

  it('cycles spinner frames', () => {
    const frame0 = stripAnsi(
      streamProgress({ label: 'test', spinnerFrame: 0, elapsedMs: 1000 }),
    );
    const frame3 = stripAnsi(
      streamProgress({ label: 'test', spinnerFrame: 3, elapsedMs: 1000 }),
    );
    expect(frame0).toContain('⠋');
    expect(frame3).toContain('⠸');
  });

  it('wraps spinner frames modulo length', () => {
    const result = stripAnsi(
      streamProgress({ label: 'test', spinnerFrame: 10, elapsedMs: 1000 }),
    );
    // 10 % 10 = 0 → first frame
    expect(result).toContain('⠋');
  });

  it('renders token count when provided', () => {
    const result = stripAnsi(
      streamProgress({
        label: 'Streaming…',
        spinnerFrame: 0,
        elapsedMs: 2000,
        tokenCount: 1234,
      }),
    );
    expect(result).toContain('1.2k tokens');
  });

  it('renders raw count for small numbers', () => {
    const result = stripAnsi(
      streamProgress({
        label: 'test',
        spinnerFrame: 0,
        elapsedMs: 1000,
        tokenCount: 42,
      }),
    );
    expect(result).toContain('42 tokens');
  });

  it('uses .toFixed(1) just below the 10k boundary', () => {
    const result = stripAnsi(
      streamProgress({ label: 'test', spinnerFrame: 0, elapsedMs: 1000, tokenCount: 9999 }),
    );
    expect(result).toContain('10.0k tokens');
  });

  it('uses Math.round at exactly the 10k boundary', () => {
    const result = stripAnsi(
      streamProgress({ label: 'test', spinnerFrame: 0, elapsedMs: 1000, tokenCount: 10000 }),
    );
    expect(result).toContain('10k tokens');
    expect(result).not.toContain('10.0k');
  });

  it('renders 99999 as "100k tokens" not "100.0k tokens"', () => {
    const result = stripAnsi(
      streamProgress({ label: 'test', spinnerFrame: 0, elapsedMs: 1000, tokenCount: 99999 }),
    );
    expect(result).toContain('100k tokens');
    expect(result).not.toContain('100.0k');
  });

  it('renders 100000 as "100k tokens"', () => {
    const result = stripAnsi(
      streamProgress({ label: 'test', spinnerFrame: 0, elapsedMs: 1000, tokenCount: 100000 }),
    );
    expect(result).toContain('100k tokens');
  });

  it('renders M suffix for large counts', () => {
    const result = stripAnsi(
      streamProgress({
        label: 'test',
        spinnerFrame: 0,
        elapsedMs: 1000,
        tokenCount: 1_500_000,
      }),
    );
    expect(result).toContain('1.5M tokens');
  });

  it('renders cost when provided', () => {
    const result = stripAnsi(
      streamProgress({
        label: 'test',
        spinnerFrame: 0,
        elapsedMs: 1000,
        costCents: 4.5,
      }),
    );
    expect(result).toContain('$0.04');
  });

  it('renders sub-cent cost with 4 decimal places', () => {
    const result = stripAnsi(
      streamProgress({
        label: 'test',
        spinnerFrame: 0,
        elapsedMs: 1000,
        costCents: 0.5,
      }),
    );
    expect(result).toContain('$0.0050');
  });

  it('renders large cost as whole dollars', () => {
    const result = stripAnsi(
      streamProgress({
        label: 'test',
        spinnerFrame: 0,
        elapsedMs: 1000,
        costCents: 300,
      }),
    );
    expect(result).toContain('$3');
    expect(result).not.toContain('$3.');
  });

  it('omits cost when zero', () => {
    const result = stripAnsi(
      streamProgress({
        label: 'test',
        spinnerFrame: 0,
        elapsedMs: 1000,
        costCents: 0,
      }),
    );
    expect(result).not.toContain('$');
  });

  it('formats sub-second elapsed as <1s', () => {
    const result = stripAnsi(
      streamProgress({ label: 'test', spinnerFrame: 0, elapsedMs: 200 }),
    );
    expect(result).toContain('<1s');
  });
});
