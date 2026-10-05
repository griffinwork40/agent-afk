import { describe, expect, it } from 'vitest';
import { findLocusMatches, resolveLocusPath } from './resolve.js';

const FILES = [
  'src/agent/providers/anthropic-direct.test.ts',
  'src/agent/providers/openai-compatible/index.ts',
  'src/cli/config.test.ts',
  'src/index.ts',
];

describe('resolveLocusPath', () => {
  it('returns an exact repo-relative match unchanged', () => {
    expect(resolveLocusPath('src/index.ts', FILES)).toBe('src/index.ts');
  });

  it('resolves a partial path by suffix', () => {
    expect(resolveLocusPath('openai-compatible/index.ts', FILES)).toBe(
      'src/agent/providers/openai-compatible/index.ts',
    );
  });

  it('resolves a bare basename', () => {
    expect(resolveLocusPath('anthropic-direct.test.ts', FILES)).toBe(
      'src/agent/providers/anthropic-direct.test.ts',
    );
  });

  it('prefers the exact match over a suffix match of the same name', () => {
    expect(resolveLocusPath('src/index.ts', [...FILES, 'dashboard/src/index.ts'])).toBe('src/index.ts');
  });

  it('returns undefined when nothing tracked matches', () => {
    expect(resolveLocusPath('gone.ts', FILES)).toBeUndefined();
  });
});

describe('resolveLocusPath — ambiguity', () => {
  const MULTI = ['src/browser/config.test.ts', 'src/cli/config.test.ts', 'src/index.ts'];

  it('refuses a bare name that matches several tracked files', () => {
    expect(resolveLocusPath('config.test.ts', MULTI)).toBeUndefined();
    expect(findLocusMatches('config.test.ts', MULTI)).toHaveLength(2);
  });

  it('still resolves a disambiguating partial path', () => {
    expect(resolveLocusPath('cli/config.test.ts', MULTI)).toBe('src/cli/config.test.ts');
  });
});
