import { describe, expect, it } from 'vitest';
import { sanitizeSlug } from '../tools/handlers/worktree-managed.js';
import {
  ISOLATED_SLUG_SUFFIX_LENGTH,
  MAX_TASK_SLUG_LENGTH,
  buildIsolatedSlug,
  cleanTaskSlug,
  randomSlugSuffix,
} from './isolated-slug.js';

describe('cleanTaskSlug', () => {
  it('lowercases and collapses non-alphanumerics (including dots) to single hyphens', () => {
    expect(cleanTaskSlug('Issue #4112: Telegram..Retry')).toBe('issue-4112-telegram-retry');
  });

  it('trims leading and trailing hyphens', () => {
    expect(cleanTaskSlug('--docs pass--')).toBe('docs-pass');
  });

  it('truncates to the max length and drops a trailing hyphen left by the cut', () => {
    const raw = `${'a'.repeat(MAX_TASK_SLUG_LENGTH - 1)}-bbbb`;
    const out = cleanTaskSlug(raw);
    expect(out).toBe('a'.repeat(MAX_TASK_SLUG_LENGTH - 1));
    expect(out.length).toBeLessThanOrEqual(MAX_TASK_SLUG_LENGTH);
  });

  it('returns empty when nothing usable remains', () => {
    expect(cleanTaskSlug('!!! ... ///')).toBe('');
  });
});

describe('randomSlugSuffix', () => {
  it('is fixed-length base36', () => {
    for (let i = 0; i < 20; i++) {
      expect(randomSlugSuffix()).toMatch(new RegExp(`^[a-z0-9]{${ISOLATED_SLUG_SUFFIX_LENGTH}}$`));
    }
  });
});

describe('buildIsolatedSlug', () => {
  it('uses the cleaned task slug plus suffix when supplied', () => {
    expect(buildIsolatedSlug({ taskSlug: 'Issue 4112 telegram retry', idPrefix: 'x', counter: 3, suffix: 'abc123' }))
      .toBe('iso-issue-4112-telegram-retry-abc123');
  });

  it('keeps the suffix intact for very long task slugs and stays <= 80 chars', () => {
    const slug = buildIsolatedSlug({ taskSlug: 'word-'.repeat(60), idPrefix: 'x', counter: 1 });
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug).toMatch(/^iso-[a-z0-9-]+[a-z0-9]-[a-z0-9]{6}$/);
    expect(slug).not.toMatch(/--/);
    // sanitizeSlug's 80-char slice is a no-op, so the suffix survives.
    expect(sanitizeSlug(slug)).toBe(slug);
  });

  it('falls back to the legacy shape when the task slug cleans to empty', () => {
    expect(buildIsolatedSlug({ taskSlug: '***', idPrefix: 'agent-tool', counter: 2, suffix: 'zz9zz9' }))
      .toBe('iso-agent-tool-2-zz9zz9');
  });

  it('produces exactly the legacy shape when task slug is absent', () => {
    expect(buildIsolatedSlug({ idPrefix: 'general-purpose', counter: 2, suffix: 'dliav9' }))
      .toBe('iso-general-purpose-2-dliav9');
    expect(buildIsolatedSlug({ idPrefix: 'compose-A', counter: 42 })).toMatch(/^iso-compose-A-42-[a-z0-9]{6}$/);
  });
});
