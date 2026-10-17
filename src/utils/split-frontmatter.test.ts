/**
 * Unit tests for src/utils/split-frontmatter.ts
 *
 * Covers all boundary cases that caused parser divergence in #3841:
 *   - Normal round-trip
 *   - Closer at EOF with no trailing newline
 *   - `----` in the body (markdown HR must NOT be treated as a closer)
 *   - CRLF line endings
 *   - Opener without exactly `---\n` (`----`, `---title`, no newline)
 *   - Unterminated frontmatter (no closer)
 */

import { describe, it, expect } from 'vitest';
import { splitFrontmatter } from './split-frontmatter.js';

describe('splitFrontmatter — happy path', () => {
  it('splits a typical SKILL.md document', () => {
    const content = '---\nname: my-skill\ndescription: Does stuff.\n---\n# Body\n\nSome text.\n';
    const result = splitFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result?.yaml).toBe('name: my-skill\ndescription: Does stuff.');
    expect(result?.body).toBe('# Body\n\nSome text.\n');
  });

  it('returns empty body string when nothing follows the closer', () => {
    const content = '---\nname: x\n---\n';
    const result = splitFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result?.yaml).toBe('name: x');
    expect(result?.body).toBe('');
  });
});

describe('splitFrontmatter — closer at EOF (no trailing newline) [#3841 divergence 1]', () => {
  it('accepts a closer that is the very last line with no trailing newline', () => {
    // parseSkillMd used to return null here; tool-injector accepted it.
    // Canonical: accept it.
    const content = '---\nname: x\n---';
    const result = splitFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result?.yaml).toBe('name: x');
    expect(result?.body).toBe('');
  });

  it('accepts closer with trailing spaces then EOF', () => {
    const content = '---\nname: x\n---   ';
    const result = splitFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result?.yaml).toBe('name: x');
  });
});

describe('splitFrontmatter — ---- in body must NOT be a closer [#3841 divergence 3]', () => {
  it('does not mistake a `----` line in the body for the closer', () => {
    const content = '---\nname: x\n---\nbody line\n----\nmore body\n';
    const result = splitFrontmatter(content);
    expect(result).not.toBeNull();
    // The closer is `---\n` after the frontmatter; `----` is in the body.
    expect(result?.yaml).toBe('name: x');
    expect(result?.body).toBe('body line\n----\nmore body\n');
  });

  it('does not mistake a `---word` line in the body for the closer', () => {
    const content = '---\nname: x\n---\nbody\n---notaclose\nrest\n';
    const result = splitFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result?.yaml).toBe('name: x');
    expect(result?.body).toBe('body\n---notaclose\nrest\n');
  });
});

describe('splitFrontmatter — CRLF line endings [#3841]', () => {
  it('accepts CRLF opener and closer', () => {
    const content = '---\r\nname: x\r\n---\r\nbody\r\n';
    const result = splitFrontmatter(content);
    expect(result).not.toBeNull();
    // yaml preserves the CRLF that was inside (before the \n--- closer anchor)
    expect(result?.yaml).toBe('name: x\r');
    expect(result?.body).toBe('body\r\n');
  });

  it('accepts CRLF opener, LF closer', () => {
    const content = '---\r\nname: x\n---\nbody\n';
    const result = splitFrontmatter(content);
    expect(result).not.toBeNull();
  });
});

describe('splitFrontmatter — bad opener [#3841 divergence 2]', () => {
  it('returns null for `----` opener (four dashes)', () => {
    // parseAgentMarkdown used to accept this (startsWith("---")); canonical: reject.
    const content = '----\nname: x\n---\nbody\n';
    expect(splitFrontmatter(content)).toBeNull();
  });

  it('returns null for `---title` opener (text immediately after dashes)', () => {
    const content = '---title\nname: x\n---\nbody\n';
    expect(splitFrontmatter(content)).toBeNull();
  });

  it('returns null when file does not start with ---', () => {
    expect(splitFrontmatter('# Just a markdown file\n')).toBeNull();
    expect(splitFrontmatter('')).toBeNull();
  });

  it('returns null when opener has no newline (bare --- at EOF)', () => {
    expect(splitFrontmatter('---')).toBeNull();
  });
});

describe('splitFrontmatter — unterminated frontmatter', () => {
  it('returns null when there is no closing ---', () => {
    const content = '---\nname: x\nno closer here\n';
    expect(splitFrontmatter(content)).toBeNull();
  });

  it('returns null for opener-only document (---\\n with no body or closer)', () => {
    // Regression for #3885: '---\n' has a valid opener but no closer at all.
    expect(splitFrontmatter('---\n')).toBeNull();
  });
});

describe('splitFrontmatter — closer with trailing whitespace', () => {
  it('accepts closer with trailing tab', () => {
    const content = '---\nname: x\n---\t\nbody\n';
    const result = splitFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result?.yaml).toBe('name: x');
    expect(result?.body).toBe('body\n');
  });
});
