import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../display.js';
import { statusBadge, type BadgeStatus } from './status-badge.js';

const ALL_STATUSES: BadgeStatus[] = ['running', 'done', 'error', 'blocked', 'warn'];

describe('statusBadge', () => {
  it.each(ALL_STATUSES)('returns a non-empty string for status "%s"', (status) => {
    const result = statusBadge(status);
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it.each(ALL_STATUSES)('strips to a non-empty plain glyph for status "%s"', (status) => {
    const plain = stripAnsi(statusBadge(status));
    // After stripping ANSI the glyph itself must survive
    expect(plain.length).toBeGreaterThan(0);
  });

  it('renders the correct glyph for "done"', () => {
    expect(stripAnsi(statusBadge('done'))).toBe('✓');
  });

  it('renders the correct glyph for "error"', () => {
    expect(stripAnsi(statusBadge('error'))).toBe('✗');
  });

  it('renders the correct glyph for "blocked"', () => {
    expect(stripAnsi(statusBadge('blocked'))).toBe('⊘');
  });

  it('renders the correct glyph for "warn"', () => {
    expect(stripAnsi(statusBadge('warn'))).toBe('⚠');
  });

  it('renders the correct glyph for "running"', () => {
    expect(stripAnsi(statusBadge('running'))).toBe('●');
  });

  it('done and error render different glyphs', () => {
    expect(stripAnsi(statusBadge('done'))).not.toBe(stripAnsi(statusBadge('error')));
  });

  it('error and blocked render different glyphs', () => {
    expect(stripAnsi(statusBadge('error'))).not.toBe(stripAnsi(statusBadge('blocked')));
  });

  it('all statuses render distinct glyphs', () => {
    const glyphs = ALL_STATUSES.map((s) => stripAnsi(statusBadge(s)));
    const unique = new Set(glyphs);
    expect(unique.size).toBe(ALL_STATUSES.length);
  });
});
