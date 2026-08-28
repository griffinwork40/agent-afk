import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../display.js';
import { errorCard } from './error-card.js';

describe('errorCard', () => {
  it('renders with default ERROR title', () => {
    const result = stripAnsi(errorCard({ body: 'Something went wrong' }));
    expect(result).toContain('ERROR');
    expect(result).toContain('Something went wrong');
  });

  it('renders with custom title', () => {
    const result = stripAnsi(
      errorCard({ title: 'RATE LIMIT', body: 'Too many requests' }),
    );
    expect(result).toContain('RATE LIMIT');
    expect(result).toContain('Too many requests');
  });

  it('renders multi-line body', () => {
    const result = stripAnsi(
      errorCard({ body: ['Line one', 'Line two', 'Line three'] }),
    );
    expect(result).toContain('Line one');
    expect(result).toContain('Line two');
    expect(result).toContain('Line three');
  });

  it('renders hint when provided', () => {
    const result = stripAnsi(
      errorCard({
        body: 'Connection refused',
        hint: 'Check that the server is running',
      }),
    );
    expect(result).toContain('Connection refused');
    expect(result).toContain('Check that the server is running');
  });

  it('omits hint when not provided', () => {
    const result = errorCard({ body: 'Oops' });
    // Should still render without error
    expect(stripAnsi(result)).toContain('Oops');
  });

  it('has bordered output (rounded corners)', () => {
    const result = errorCard({ body: 'test' });
    expect(result).toContain('╭');
    expect(result).toContain('╰');
  });
});
