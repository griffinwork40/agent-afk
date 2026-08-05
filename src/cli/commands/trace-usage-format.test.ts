/**
 * Unit tests for closure-event cache-usage rendering.
 *
 * @module cli/commands/trace-usage-format.test
 */

import { describe, it, expect } from 'vitest';
import { formatCacheUsage } from './trace-usage-format.js';

describe('formatCacheUsage', () => {
  it('renders read, write, and hit rate when cache activity exists', () => {
    const out = formatCacheUsage({ cacheRead: 9000, cacheCreation: 1000 });
    expect(out).toContain('r=9.0k');
    expect(out).toContain('w=1.0k');
    expect(out).toContain('hit=90%');
  });

  it('reports a 0% hit rate for a cold session that only wrote', () => {
    // The signature of a prefix that keeps getting invalidated: every call
    // writes, none reads. This is the case the renderer exists to surface.
    expect(formatCacheUsage({ cacheRead: 0, cacheCreation: 50_000 })).toContain('hit=0%');
  });

  it('reports 100% for a fully warm call', () => {
    expect(formatCacheUsage({ cacheRead: 50_000, cacheCreation: 0 })).toContain('hit=100%');
  });

  it('renders nothing when the session used no cache', () => {
    // Uncached and pre-cache-era traces must render exactly as before.
    expect(formatCacheUsage({ input: 100, output: 50 })).toBe('');
    expect(formatCacheUsage({ cacheRead: 0, cacheCreation: 0 })).toBe('');
    expect(formatCacheUsage(undefined)).toBe('');
  });

  it('treats missing cache fields as zero rather than NaN', () => {
    const out = formatCacheUsage({ cacheRead: 1000 });
    expect(out).toContain('w=0');
    expect(out).not.toContain('NaN');
  });

  it('scales token counts through k and m suffixes', () => {
    expect(formatCacheUsage({ cacheRead: 999, cacheCreation: 0 })).toContain('r=999');
    expect(formatCacheUsage({ cacheRead: 2_500_000, cacheCreation: 0 })).toContain('r=2.5m');
  });
});
