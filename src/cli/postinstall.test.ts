import { describe, it, expect, beforeAll } from 'vitest';

type DetectPathGapFn = (
  prefix: string,
  pathEnv: string,
) => { onPath: boolean; binDir: string };

let detectPathGap: DetectPathGapFn;

beforeAll(async () => {
  // Dynamic import avoids TypeScript transform issues with plain .mjs files.
  const mod = await import('../../scripts/postinstall.mjs');
  detectPathGap = mod.detectPathGap as DetectPathGapFn;
});

describe('detectPathGap', () => {
  it('returns onPath: true when binDir is already on PATH', () => {
    const result = detectPathGap('/usr/local', '/usr/local/bin:/usr/bin:/bin');
    expect(result.onPath).toBe(true);
    expect(result.binDir).toBe('/usr/local/bin');
  });

  it('returns onPath: false when binDir is not on PATH', () => {
    const result = detectPathGap('/usr/local', '/usr/bin:/bin');
    expect(result.onPath).toBe(false);
    expect(result.binDir).toBe('/usr/local/bin');
  });

  it('normalizes trailing slash on prefix', () => {
    const result = detectPathGap('/usr/local/', '/usr/local/bin:/usr/bin');
    expect(result.onPath).toBe(true);
    expect(result.binDir).toBe('/usr/local/bin');
  });

  it('normalizes trailing slash on PATH entries', () => {
    const result = detectPathGap('/usr/local', '/usr/local/bin/:/usr/bin');
    expect(result.onPath).toBe(true);
    expect(result.binDir).toBe('/usr/local/bin');
  });

  it('handles empty PATH gracefully', () => {
    const result = detectPathGap('/usr/local', '');
    expect(result.onPath).toBe(false);
    expect(result.binDir).toBe('/usr/local/bin');
  });

  it('handles single matching PATH entry', () => {
    const result = detectPathGap('/home/user/.npm-global', '/home/user/.npm-global/bin');
    expect(result.onPath).toBe(true);
    expect(result.binDir).toBe('/home/user/.npm-global/bin');
  });

  it('does not falsely match a prefix substring', () => {
    // /usr/local should not match /usr/local-extra/bin
    const result = detectPathGap('/usr/local', '/usr/local-extra/bin:/usr/bin');
    expect(result.onPath).toBe(false);
  });

  it('returns correct binDir for a home-scoped npm prefix', () => {
    const result = detectPathGap('/Users/alice/.npm-global', '/usr/bin');
    expect(result.binDir).toBe('/Users/alice/.npm-global/bin');
    expect(result.onPath).toBe(false);
  });
});
