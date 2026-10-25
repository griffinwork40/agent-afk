import { describe, expect, it } from 'vitest';
import { humanizeTitle, sessionDisplayTitle } from './session-title';

describe('sessionDisplayTitle', () => {
  it('shows an explicit /name verbatim', () => {
    expect(sessionDisplayTitle({ title: 'smoke-stage3', titleExplicit: true }, 'New session')).toBe('smoke-stage3');
  });
  it('humanizes a derived first-prompt slug', () => {
    expect(sessionDisplayTitle({ title: 'do-not-use-any-tools-write' }, 'New session')).toBe('Do not use any tools write');
  });
  it('passes through a derived title that already has spaces', () => {
    expect(sessionDisplayTitle({ title: 'Fix the build please' }, 'x')).toBe('Fix the build please');
  });
  it('falls back when untitled', () => {
    expect(sessionDisplayTitle({}, 'New session')).toBe('New session');
  });
  it('humanizeTitle handles snake_case', () => {
    expect(humanizeTitle('ended_session')).toBe('Ended session');
  });
});
