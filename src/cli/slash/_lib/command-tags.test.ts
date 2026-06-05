/**
 * Tests for src/cli/slash/_lib/command-tags.ts
 */

import { describe, it, expect } from 'vitest';
import { COMMAND_NAME_TAG, COMMAND_MESSAGE_TAG, COMMAND_ARGS_TAG, formatCommandBreadcrumb, stripCommandTags, extractSkillTag } from './command-tags.js';

describe('command-tags', () => {
  it('exports tag constants with correct string values', () => {
    expect(COMMAND_NAME_TAG).toBe('command-name');
    expect(COMMAND_MESSAGE_TAG).toBe('command-message');
    expect(COMMAND_ARGS_TAG).toBe('command-args');
  });

  it('formatCommandBreadcrumb returns the exact expected format with 12-space indentation', () => {
    const result = formatCommandBreadcrumb('parallelize', 'foo bar');
    const expected = `<command-name>/parallelize</command-name>
            <command-message>parallelize</command-message>
            <command-args>foo bar</command-args>`;
    expect(result).toBe(expected);
  });

  it('formatCommandBreadcrumb with empty args includes empty args tag', () => {
    const result = formatCommandBreadcrumb('mint', '');
    const expected = `<command-name>/mint</command-name>
            <command-message>mint</command-message>
            <command-args></command-args>`;
    expect(result).toBe(expected);
  });

  it('formatCommandBreadcrumb does not escape special chars in args', () => {
    const result = formatCommandBreadcrumb('test', '<bad>');
    expect(result).toContain('<bad>');
    expect(result).toContain('<command-args><bad></command-args>');
  });
});

describe('stripCommandTags', () => {
  it('strips command-name tags', () => {
    expect(stripCommandTags('<command-name>/ship</command-name>')).toBe('');
  });

  it('strips command-message tags', () => {
    expect(stripCommandTags('<command-message>ship</command-message>')).toBe('');
  });

  it('strips command-args tags', () => {
    expect(stripCommandTags('<command-args>some args</command-args>')).toBe('');
  });

  it('strips all three tag types from a full breadcrumb', () => {
    const breadcrumb = formatCommandBreadcrumb('ship', 'my args');
    expect(stripCommandTags(breadcrumb)).toBe('');
  });

  it('preserves surrounding content', () => {
    const input = 'before <command-name>/ship</command-name> after';
    expect(stripCommandTags(input)).toBe('before  after');
  });

  it('passes through strings with no tags', () => {
    expect(stripCommandTags('hello world')).toBe('hello world');
    expect(stripCommandTags('')).toBe('');
  });

  it('strips tags with multiline content', () => {
    expect(stripCommandTags('<command-args>line1\nline2</command-args>')).toBe('');
  });

  it('preserves non-command XML tags', () => {
    const input = '<system-reminder>keep this</system-reminder>';
    expect(stripCommandTags(input)).toBe('<system-reminder>keep this</system-reminder>');
  });

  it('preserves paragraph breaks (double newlines) in content', () => {
    const input = 'First paragraph.\n\nSecond paragraph.';
    expect(stripCommandTags(input)).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('preserves paragraph breaks around command tags', () => {
    const input = '<command-name>/ship</command-name>\n\nFirst paragraph.\n\nSecond paragraph.';
    expect(stripCommandTags(input)).toBe('First paragraph.\n\nSecond paragraph.');
  });
});

describe('extractSkillTag', () => {
  it('detects and strips opening skill tag', () => {
    const result = extractSkillTag('<ship>\nI will do things.', 'ship');
    expect(result.found).toBe(true);
    expect(result.text).toBe('I will do things.');
  });

  it('strips closing skill tag', () => {
    const result = extractSkillTag('Done with work.\n</ship>', 'ship');
    expect(result.found).toBe(false);
    expect(result.text).toBe('Done with work.');
  });

  it('strips both opening and closing tags', () => {
    const result = extractSkillTag('<ship>\nContent here.\n</ship>', 'ship');
    expect(result.found).toBe(true);
    expect(result.text).toBe('Content here.');
  });

  it('returns unchanged text when no tag is present', () => {
    const result = extractSkillTag('Normal content.', 'ship');
    expect(result.found).toBe(false);
    expect(result.text).toBe('Normal content.');
  });

  it('handles tag on same line as content', () => {
    const result = extractSkillTag('<ship>Inline content', 'ship');
    expect(result.found).toBe(true);
    expect(result.text).toBe('Inline content');
  });

  it('does not match a different skill name', () => {
    const result = extractSkillTag('<mint>Content</mint>', 'ship');
    expect(result.found).toBe(false);
    expect(result.text).toBe('<mint>Content</mint>');
  });

  it('handles hyphenated skill names', () => {
    const result = extractSkillTag('<ground-state>\nRunning.', 'ground-state');
    expect(result.found).toBe(true);
    expect(result.text).toBe('Running.');
  });

  it('preserves paragraph breaks in skill content', () => {
    const result = extractSkillTag('<ship>\nFirst.\n\nSecond.\n</ship>', 'ship');
    expect(result.found).toBe(true);
    expect(result.text).toBe('First.\n\nSecond.');
  });
});

// ─── Streaming-chunk safety regression tests ─────────────────────────────────
//
// Root cause: the old /^\n+/ and /\n+$/ whole-string trims in stripCommandTags
// and extractSkillTag were called per-delta inside the streaming orchestrator.
// Local OpenAI-compatible servers (e.g. mlx_lm.server running Qwen3) emit
// tokens char-by-char, so an isolated '\n' delta was common. Those trims turned
// '\n' → '' which caused the orchestrator's `if (!cleaned) return;` guard to
// discard the delta entirely, collapsing all paragraph breaks into one block.
// Anthropic streams bundle tokens so this rarely surfaced there.
//
// The fix: newline cleanup is now scoped to the immediate neighbourhood of a
// matched tag (via \n* in the regex), not the full string. These tests lock in
// that contract for both functions.

describe('streaming-chunk safety — stripCommandTags', () => {
  it('preserves an isolated newline delta (the core regression)', () => {
    // A lone '\n' has no command tags — must come through unchanged.
    expect(stripCommandTags('\n')).toBe('\n');
  });

  it('preserves a double-newline paragraph-break delta', () => {
    expect(stripCommandTags('\n\n')).toBe('\n\n');
  });

  it('preserves a newline-only chunk between two prose deltas', () => {
    // Simulate orchestrator accumulating: 'word' + '\n' + 'word'
    const chunks = ['First line', '\n', 'Second line'];
    const result = chunks.map(stripCommandTags).join('');
    expect(result).toBe('First line\nSecond line');
  });

  it('eats newlines adjacent to a command tag but keeps outer content', () => {
    // Tag surrounded by newlines on both sides — newlines belong to the tag, not content
    const input = 'Preamble\n<command-name>/ship</command-name>\nBody text';
    expect(stripCommandTags(input)).toBe('Preamble\nBody text');
  });

  it('strips a full breadcrumb block at stream start without leaving leading newline', () => {
    const breadcrumb = formatCommandBreadcrumb('mint', 'my idea');
    const input = breadcrumb + '\nHere is the response.';
    expect(stripCommandTags(input)).toBe('Here is the response.');
  });

  it('does not trim trailing newline when no tags are present', () => {
    // Content that ends with '\n' should be preserved — the renderer owns
    // trailing-newline decisions, not stripCommandTags.
    expect(stripCommandTags('Line one.\n')).toBe('Line one.\n');
  });
});

describe('streaming-chunk safety — extractSkillTag', () => {
  it('preserves an isolated newline delta when no skill tag is present', () => {
    const result = extractSkillTag('\n', 'ship');
    expect(result.found).toBe(false);
    expect(result.text).toBe('\n');
  });

  it('preserves a double-newline delta when no skill tag is present', () => {
    const result = extractSkillTag('\n\n', 'ship');
    expect(result.found).toBe(false);
    expect(result.text).toBe('\n\n');
  });

  it('eats newline after opening tag but not unrelated later newlines', () => {
    // Opening tag emitted as its own delta: '<ship>\n'
    // The \n right after the tag belongs to the tag; the paragraph break does not.
    const result = extractSkillTag('<ship>\nLine one.\n\nLine two.', 'ship');
    expect(result.found).toBe(true);
    expect(result.text).toBe('Line one.\n\nLine two.');
  });

  it('does not trim trailing newline on tag-free content delta', () => {
    const result = extractSkillTag('Paragraph ends here.\n', 'ship');
    expect(result.found).toBe(false);
    expect(result.text).toBe('Paragraph ends here.\n');
  });
});
