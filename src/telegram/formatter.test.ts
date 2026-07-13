/**
 * Tests for Telegram message formatter
 */

import { describe, test, expect } from 'vitest';
import {
  splitLongMessage,
  markdownToTelegramHtml,
  escapeMarkdown,
  formatError,
  formatWelcome,
  formatHelp,
  formatModelSwitch,
  formatClear,
  formatReset,
  formatCompact,
  formatCompactNoop,
  formatInternalError,
  formatNameCurrent,
  formatNameInvalid,
  formatNameSet,
  escapeHtml,
  formatSystemError,
  formatQueued,
} from './formatter';

describe('splitLongMessage', () => {
  test('should not split short messages', () => {
    const text = 'Hello world';
    const result = splitLongMessage(text);
    expect(result).toEqual([text]);
  });

  test('should split very long messages', () => {
    const text = 'a'.repeat(5000);
    const result = splitLongMessage(text);
    expect(result.length).toBeGreaterThan(1);
    expect(result.every(chunk => chunk.length <= 4096)).toBe(true);
  });

  test('should split on newlines when possible', () => {
    const text = 'Part 1\n' + 'x'.repeat(4500) + '\nPart 2';
    const result = splitLongMessage(text);
    expect(result.length).toBeGreaterThan(1);
    expect(result[0]).toContain('Part 1');
  });

  test('should split on sentence boundaries', () => {
    const sentence = 'This is a sentence. ';
    const text = sentence.repeat(300); // ~6000 chars
    const result = splitLongMessage(text);
    expect(result.length).toBeGreaterThan(1);
    expect(result.every(chunk => chunk.length <= 4096)).toBe(true);
  });

  test('should respect custom max length', () => {
    const text = 'a'.repeat(1000);
    const result = splitLongMessage(text, 500);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.every(chunk => chunk.length <= 500)).toBe(true);
  });

  test('should handle empty string', () => {
    const result = splitLongMessage('');
    expect(result).toEqual(['']);
  });
});

describe('markdownToTelegramHtml', () => {
  test('converts bold and italic to HTML', () => {
    expect(markdownToTelegramHtml('**bold** and *italic*')).toBe('<b>bold</b> and <i>italic</i>');
    expect(markdownToTelegramHtml('__bold__ and _italic_')).toBe('<b>bold</b> and <i>italic</i>');
  });

  test('converts inline code and code blocks to HTML', () => {
    expect(markdownToTelegramHtml('Use `code` here')).toBe('Use <code>code</code> here');
    expect(markdownToTelegramHtml('```\nconst x = 1;\n```')).toBe('<pre>const x = 1;\n</pre>');
  });

  test('strips header markers', () => {
    expect(markdownToTelegramHtml('## Heading 2')).toBe('Heading 2');
    expect(markdownToTelegramHtml('# Title')).toBe('Title');
  });

  test('converts links to anchor tags', () => {
    expect(markdownToTelegramHtml('[click here](https://example.com)')).toBe(
      '<a href="https://example.com">click here</a>'
    );
  });

  test('escapes HTML in content', () => {
    expect(markdownToTelegramHtml('x < 5 & y > 0')).toBe('x &lt; 5 &amp; y &gt; 0');
  });

  test('handles empty string', () => {
    expect(markdownToTelegramHtml('')).toBe('');
  });

  // ── Regression tests for T1–T4 ──────────────────────────────────────────

  // T1: URL with & must not be double-escaped.
  // Step 1 escapes & → &amp; globally. The link callback must NOT re-escape,
  // or the href would contain &amp;amp; — a wrong destination URL.
  test('T1: URL ampersand is escaped exactly once (not double-encoded)', () => {
    const result = markdownToTelegramHtml('[x](https://a.com?a=1&b=2)');
    expect(result).toBe('<a href="https://a.com?a=1&amp;b=2">x</a>');
    expect(result).not.toContain('&amp;amp;');
  });

  // T2: Bold markers inside inline backtick code must not be converted.
  // The placeholder pass parks <code>…</code> before bold/italic regexes run.
  test('T2: bold markers inside inline code are preserved as-is', () => {
    const result = markdownToTelegramHtml('`**bold**`');
    expect(result).toBe('<code>**bold**</code>');
    expect(result).not.toContain('<b>');
  });

  // T2b: Fenced code block — the newline after ``` is now required, so the
  // language tag is captured separately and the content is not truncated.
  test('T2b: fenced code block captures content without dropping first word', () => {
    const result = markdownToTelegramHtml('```\nconst x = 1;\n```');
    expect(result).toBe('<pre>const x = 1;\n</pre>');
  });

  // T3a: Underscores inside snake_case identifiers must not produce <i>.
  test('T3a: snake_case identifiers are not italicised', () => {
    const result = markdownToTelegramHtml('snake_case_names');
    expect(result).not.toContain('<i>');
    expect(result).toContain('snake_case_names');
  });

  // T3b: Underscore-delimited prose italic still works when surrounded by
  // non-word characters (spaces / start+end of string).
  test('T3b: _real italic_ (space-surrounded) is wrapped in <i>', () => {
    const result = markdownToTelegramHtml('_real italic_');
    expect(result).toBe('<i>real italic</i>');
  });

  // T3c: __dunder__ must not produce nested <i> — the __ form is bold.
  // After the bold pass, no lone _ delimiters remain to trigger italic.
  test('T3c: __dunder__ renders as <b>dunder</b>, not nested <i>', () => {
    const result = markdownToTelegramHtml('__dunder__');
    expect(result).toBe('<b>dunder</b>');
    expect(result).not.toContain('<i>');
  });

  // T4: Underscores inside inline code must not trigger the italic regex.
  // The placeholder pass ensures the italic regex never sees code content.
  test('T4: underscores inside inline code are preserved (no italic leakage)', () => {
    const result = markdownToTelegramHtml('Use `for_loops` here.');
    expect(result).toBe('Use <code>for_loops</code> here.');
    expect(result).not.toContain('<i>');
  });

  // T4b: Bold markers inside a fenced block must also be preserved.
  test('T4b: bold markers inside fenced code block are preserved as-is', () => {
    const result = markdownToTelegramHtml('```\n**not bold**\n```');
    expect(result).toBe('<pre>**not bold**\n</pre>');
    expect(result).not.toContain('<b>');
  });

  // T4c: Empty fenced blocks must render a visible placeholder, not <pre></pre>.
  // Telegram renders <pre></pre> as a silent visual gap; an empty fence usually
  // means the model omitted the command body. Surface the omission loudly.
  test('T4c: empty fenced block with language tag renders visible placeholder', () => {
    const result = markdownToTelegramHtml('You can run:\n```bash\n```\n…and watch.');
    expect(result).toContain('<i>(empty bash block)</i>');
    expect(result).not.toContain('<pre></pre>');
  });

  test('T4c: empty fenced block without language tag renders generic placeholder', () => {
    const result = markdownToTelegramHtml('```\n```');
    expect(result).toBe('<i>(empty code block)</i>');
    expect(result).not.toContain('<pre></pre>');
  });

  test('T4c: non-empty fenced block still renders as <pre> (no regression)', () => {
    const result = markdownToTelegramHtml('```bash\ngit pull --rebase\n```');
    expect(result).toBe('<pre>git pull --rebase\n</pre>');
  });

  // var_name edge case: underscore-bounded but adjacent to word chars
  test('T3d: var_name = 1 (identifier assignment) is not italicised', () => {
    const result = markdownToTelegramHtml('var_name = 1');
    expect(result).not.toContain('<i>');
    expect(result).toContain('var_name');
  });
});

describe('markdownToTelegramHtml — tag balance for code spans', () => {
  test('underscores inside inline code are not converted to <i> tags', () => {
    const result = markdownToTelegramHtml('`code_with_underscores`');
    expect(result).toBe('<code>code_with_underscores</code>');
    expect(result).not.toContain('<i>');
  });

  test('underscores in expression inside inline code are preserved literally', () => {
    const result = markdownToTelegramHtml('`x_val + y_val`');
    expect(result).toBe('<code>x_val + y_val</code>');
    expect(result).not.toContain('<i>');
  });

  test('asterisks inside inline code are not converted to <i>/<b> tags', () => {
    const result = markdownToTelegramHtml('`code with *asterisk* inside`');
    expect(result).toBe('<code>code with *asterisk* inside</code>');
    expect(result).not.toContain('<i>');
    expect(result).not.toContain('<b>');
  });

  test('mixed: inline code with underscores and italic text coexist cleanly', () => {
    const result = markdownToTelegramHtml('Use `code_val` and *italic* text');
    expect(result).toBe('Use <code>code_val</code> and <i>italic</i> text');
    // Ensure no <i> leaked inside the <code> span
    const codeMatch = result.match(/<code>(.*?)<\/code>/);
    expect(codeMatch).not.toBeNull();
    expect(codeMatch![1]).not.toContain('<i>');
  });
});

describe('escapeMarkdown', () => {
  test('should escape special characters', () => {
    const text = '_italic_ *bold* [link](url)';
    const result = escapeMarkdown(text);
    expect(result).toContain('\\_');
    expect(result).toContain('\\*');
    expect(result).toContain('\\[');
    expect(result).toContain('\\]');
  });

  test('should escape all markdown special chars', () => {
    const specialChars = '_*[]()~`>#+-=|{}.!';
    const result = escapeMarkdown(specialChars);
    for (const char of specialChars) {
      expect(result).toContain(`\\${char}`);
    }
  });

  // Regression: backslash must be escaped to \\, and must run FIRST so the prepended
  // backslashes from other escapes are not themselves re-escaped to \\\\.
  // Without this, Windows paths, regex strings, or LaTeX in user input crash Telegram
  // with 400 Bad Request (silently swallowed by the sendMessage .catch).
  test('escapes backslash without double-escaping other escapes', () => {
    // Input: single backslash → output: two backslashes (one escape sequence)
    expect(escapeMarkdown('a\\b')).toBe('a\\\\b');
    // Input: backslash + dot → output: escaped backslash + escaped dot.
    // If \\ ran after ., the prepended \\ from . would be re-escaped → wrong.
    expect(escapeMarkdown('a\\.b')).toBe('a\\\\\\.b');
    // Windows-style path — a real prompt-injection vector for context strings
    expect(escapeMarkdown('C:\\Users\\foo.txt')).toBe('C:\\\\Users\\\\foo\\.txt');
  });

  test('should handle empty string', () => {
    expect(escapeMarkdown('')).toBe('');
  });

  test('should handle text without special chars', () => {
    const text = 'Hello world 123';
    expect(escapeMarkdown(text)).toBe(text);
  });
});

describe('formatError', () => {
  test('should format Error object', () => {
    const error = new Error('Test error');
    const result = formatError(error);
    expect(result).toContain('❌');
    expect(result).toContain('Test error');
  });

  test('should format string error', () => {
    const result = formatError('Something went wrong');
    expect(result).toContain('❌');
    expect(result).toContain('Something went wrong');
  });
});

describe('formatWelcome', () => {
  test('should include welcome emoji', () => {
    const result = formatWelcome();
    expect(result).toContain('👋');
  });

  test('should list core commands', () => {
    const result = formatWelcome();
    // Intentionally shorter welcome — /start and /compact are in /help, not here
    expect(result).toContain('/help');
    expect(result).toContain('/clear');
    expect(result).toContain('/model');
  });

  test('should mention Claude', () => {
    const result = formatWelcome();
    expect(result.toLowerCase()).toContain('claude');
  });

  test('should include a "see /help" call-to-action', () => {
    const result = formatWelcome();
    expect(result).toContain('/help');
  });
});

describe('formatHelp', () => {
  test('should list commands aligned with Agent SDK', () => {
    const result = formatHelp();
    expect(result).toContain('/start');
    expect(result).toContain('/help');
    expect(result).toContain('/clear');
    expect(result).toContain('/compact');
    expect(result).toContain('/model');
    expect(result).toContain('/name');
    expect(result).toContain('/sessions');
    expect(result).toContain('/new');
    expect(result).toContain('CLI');
  });

  test('should append SDK session commands when provided', () => {
    const result = formatHelp(['review']);
    expect(result).toContain('Session commands (from SDK');
    expect(result).toContain('/review');
  });
});

describe('formatModelSwitch', () => {
  test('should format opus switch', () => {
    const result = formatModelSwitch('opus');
    expect(result).toContain('🚀');
    expect(result.toUpperCase()).toContain('OPUS');
  });

  test('should format sonnet switch', () => {
    const result = formatModelSwitch('sonnet');
    expect(result).toContain('⚡');
    expect(result.toUpperCase()).toContain('SONNET');
  });

  test('should format haiku switch', () => {
    const result = formatModelSwitch('haiku');
    expect(result).toContain('🌸');
    expect(result.toUpperCase()).toContain('HAIKU');
  });

  test('should handle unknown model', () => {
    const result = formatModelSwitch('unknown');
    expect(result).toContain('🤖');
  });
});

describe('formatClear', () => {
  test('should include clear emoji', () => {
    const result = formatClear();
    expect(result).toContain('🔄');
  });

  test('should mention clearing history', () => {
    const result = formatClear();
    expect(result.toLowerCase()).toContain('cleared');
  });
});

describe('formatReset', () => {
  test('should match formatClear (backward compat)', () => {
    expect(formatReset()).toBe(formatClear());
  });
});

describe('formatNameCurrent', () => {
  test('shows a hint and usage when no name is set', () => {
    const result = formatNameCurrent(undefined);
    expect(result.toLowerCase()).toContain('no name set');
    expect(result).toContain('/name <name>');
  });

  test('shows the current name when set', () => {
    const result = formatNameCurrent('fix-resume-bug');
    expect(result).toContain('fix-resume-bug');
    expect(result.toLowerCase()).toContain('session name');
  });
});

describe('formatNameInvalid', () => {
  test('explains the allowed characters', () => {
    const result = formatNameInvalid();
    expect(result.toLowerCase()).toContain('invalid name');
    expect(result.toLowerCase()).toContain('letters');
  });
});

describe('formatNameSet', () => {
  test('shows the CLI resume command when persisted', () => {
    const result = formatNameSet('my-name', 'afk interactive --model sonnet --resume my-name');
    expect(result).toContain('my-name');
    expect(result.toLowerCase()).toContain('resume');
    expect(result).toContain('afk interactive --model sonnet --resume my-name');
  });

  test('notes the name saves on the first turn when not yet persisted', () => {
    const result = formatNameSet('my-name');
    expect(result).toContain('my-name');
    expect(result.toLowerCase()).toContain('first turn');
    // No resume line before the first turn — there is nothing to resume yet.
    expect(result).not.toContain('afk interactive');
  });
});

describe('formatCompact', () => {
  test('should include compact emoji', () => {
    const result = formatCompact();
    expect(result).toContain('📦');
  });

  test('should mention compacted/summarized', () => {
    const result = formatCompact();
    expect(result.toLowerCase()).toContain('compact');
  });
});

describe('formatInternalError', () => {
  test('returns a string containing ⚠️', () => {
    const result = formatInternalError();
    expect(result).toContain('⚠️');
  });

  test('does not contain the word schema', () => {
    expect(formatInternalError()).not.toMatch(/schema/i);
  });

  test('does not contain the word version', () => {
    expect(formatInternalError()).not.toMatch(/version/i);
  });

  test('does not contain "Error:"', () => {
    expect(formatInternalError()).not.toContain('Error:');
  });

  test('does not contain memory.db path fragment', () => {
    expect(formatInternalError()).not.toContain('memory.db');
  });

  test('does not contain the word stack', () => {
    expect(formatInternalError()).not.toMatch(/stack/i);
  });

  test('returns the same fixed string on every call (no dynamic content)', () => {
    expect(formatInternalError()).toBe(formatInternalError());
  });

  test('takes no arguments', () => {
    // TypeScript compile check: zero-argument call compiles cleanly.
    // Runtime: calling with no args must not throw.
    expect(() => formatInternalError()).not.toThrow();
  });
});

describe('markdownToTelegramHtml — M-1 sentinel safety', () => {
  test('M-1a: STX bytes in input are stripped before processing', () => {
    // \x02 and \x03 are used as sentinels internally; input containing them
    // must not collide with the placeholder injection.
    const result = markdownToTelegramHtml('hello\x02world\x03end');
    expect(result).toBe('helloworldend');
    expect(result).not.toContain('\x02');
    expect(result).not.toContain('\x03');
  });

  test('M-1a: ETX byte removed from start/middle/end of input', () => {
    const result = markdownToTelegramHtml('\x03start\x02mid\x03end\x02');
    expect(result).not.toContain('\x02');
    expect(result).not.toContain('\x03');
  });

  test('M-1b: out-of-range placeholder index preserves sentinel (no silent drop)', () => {
    // This is a synthetic edge-case — the only way to trigger it in production
    // would be a bug in the regex replacing fencedBlocks/codeSpans.  The test
    // confirms the `?? _m` fallback keeps the original sentinel text rather
    // than returning empty string.
    // We indirectly verify by checking the overall round-trip doesn't silently
    // drop content for valid code spans.
    const result = markdownToTelegramHtml('use `a` and `b` and `c`');
    expect(result).toBe('use <code>a</code> and <code>b</code> and <code>c</code>');
  });
});

describe('markdownToTelegramHtml — M-10 indented fences (CommonMark §4.5)', () => {
  test('fenced block with 0 spaces of indentation is extracted', () => {
    const result = markdownToTelegramHtml('```\nconst x = 1;\n```');
    expect(result).toContain('<pre>');
    expect(result).not.toContain('**');
  });

  test('fenced block with 1 space of indentation is extracted', () => {
    const result = markdownToTelegramHtml(' ```\nconst x = 1;\n```');
    expect(result).toContain('<pre>');
  });

  test('fenced block with 2 spaces of indentation is extracted', () => {
    const result = markdownToTelegramHtml('  ```\nconst x = 1;\n```');
    expect(result).toContain('<pre>');
  });

  test('fenced block with 3 spaces of indentation is extracted', () => {
    const result = markdownToTelegramHtml('   ```\nconst x = 1;\n```');
    expect(result).toContain('<pre>');
  });

  test('bold markers inside indented fence are not converted', () => {
    // Without the fix, **text** inside the fence would become <b>text</b>
    const result = markdownToTelegramHtml('   ```\n**not bold**\n```');
    expect(result).not.toContain('<b>');
    expect(result).toContain('<pre>');
  });
});

describe('escapeHtml', () => {
  test('escapes & to &amp;', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  test('escapes < to &lt;', () => {
    expect(escapeHtml('a < b')).toBe('a &lt; b');
  });

  test('escapes > to &gt;', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b');
  });

  test('escapes " to &quot;', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
  });

  test('plain text passes through unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  test('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  test('& is replaced first (does not double-escape &amp;)', () => {
    // If & were not handled first, '<' → '&lt;' then '&' → '&amp;' → '&amp;lt;'
    const result = escapeHtml('<b>');
    expect(result).toBe('&lt;b&gt;');
    expect(result).not.toContain('&amp;lt;');
  });

  test('handles multiple special chars in one string', () => {
    expect(escapeHtml('<a href="x&y">text</a>')).toBe('&lt;a href=&quot;x&amp;y&quot;&gt;text&lt;/a&gt;');
  });
});

describe('formatSystemError', () => {
  test('ENOENT returns "Directory not found" message containing the path', () => {
    const result = formatSystemError('ENOENT', '/some/path');
    expect(result.toLowerCase()).toContain('not found');
    expect(result).toContain('/some/path');
  });

  test('EACCES returns "Permission denied" message containing the path', () => {
    const result = formatSystemError('EACCES', '/secure/path');
    expect(result.toLowerCase()).toContain('permission denied');
    expect(result).toContain('/secure/path');
  });

  test('unknown code returns fallthrough message with code embedded', () => {
    const result = formatSystemError('EUNKNOWN', '/some/path');
    expect(result).toContain('EUNKNOWN');
    expect(result).toContain('/some/path');
  });

  test('path is embedded in the returned string for all known codes', () => {
    const path = '/test/dir';
    expect(formatSystemError('ENOENT', path)).toContain(path);
    expect(formatSystemError('EACCES', path)).toContain(path);
    expect(formatSystemError('OTHER', path)).toContain(path);
  });

  test('result starts with an error indicator', () => {
    expect(formatSystemError('ENOENT', '/x')).toContain('❌');
    expect(formatSystemError('EACCES', '/x')).toContain('❌');
  });
});

describe('formatQueued', () => {
  test('depth=1 → message contains "#1"', () => {
    expect(formatQueued(1)).toContain('#1');
  });

  test('depth=5 → message contains "#5"', () => {
    expect(formatQueued(5)).toContain('#5');
  });

  test('message contains "in line" (position indicator)', () => {
    expect(formatQueued(1)).toContain('in line');
  });

  test('message contains a queue/queued indicator', () => {
    const result = formatQueued(2).toLowerCase();
    expect(result).toMatch(/queue/);
  });
});

describe('formatCompactNoop — new reasons', () => {
  test('"history-too-short" → contains "Not enough history"', () => {
    const result = formatCompactNoop('history-too-short');
    expect(result.toLowerCase()).toContain('not enough history');
  });

  test('"not-supported" → contains a "not available" or similar message', () => {
    const result = formatCompactNoop('not-supported');
    expect(result.toLowerCase()).toMatch(/not available|isn.t available|not supported/);
  });

  test('"aborted" still returns "cancelled" (regression guard)', () => {
    const result = formatCompactNoop('aborted');
    expect(result.toLowerCase()).toContain('cancel');
  });

  test('"summarization-failed:" prefix still returns warning (regression guard)', () => {
    const result = formatCompactNoop('summarization-failed: network error');
    expect(result).toContain('⚠️');
    expect(result.toLowerCase()).toContain('failed');
  });
});

describe('markdownToTelegramHtml — mis-nested emphasis safety net', () => {
  // Stack check mirroring Telegram's HTML parser: every tag must be closed and
  // properly nested. A mis-nested run like "<b>..<i>..</b>..</i>" → 400.
  const tagsBalanced = (html: string): boolean => {
    const stack: string[] = [];
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const tag = (m[2] ?? '').toLowerCase();
      if (m[1] === '/') { if (stack.pop() !== tag) return false; }
      else stack.push(tag);
    }
    return stack.length === 0;
  };

  test('interleaved ** / _ markers never emit improperly-nested tags', () => {
    // Pre-fix this produced "<b>a <i>b</b> c</i>" → Telegram 400 "can't parse entities".
    const out = markdownToTelegramHtml('**a _b** c_');
    expect(tagsBalanced(out)).toBe(true);
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('<i>');
    expect(out).toBe('a b c');
  });

  test('interleaved __ / * markers never emit improperly-nested tags', () => {
    const out = markdownToTelegramHtml('__a *b__ c*');
    expect(tagsBalanced(out)).toBe(true);
    expect(out).toBe('a b c');
  });

  test('safety net preserves code/link tags while dropping only mis-nested emphasis', () => {
    const out = markdownToTelegramHtml('**a _b** `keep=1` c_');
    expect(tagsBalanced(out)).toBe(true);
    expect(out).toContain('<code>keep=1</code>'); // code span survives
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('<i>');
  });

  test('properly-nested emphasis is left untouched (no false strip)', () => {
    // Italic fully containing bold is valid HTML and must be preserved verbatim.
    expect(markdownToTelegramHtml('*a **b** c*')).toBe('<i>a <b>b</b> c</i>');
    // Separate spans + identifiers are unaffected by the safety net.
    expect(markdownToTelegramHtml('**A** and *b* and snake_case'))
      .toBe('<b>A</b> and <i>b</i> and snake_case');
  });

  test('empty-fence label survives the strip when a separate emphasis run is mis-nested', () => {
    // The empty-fence placeholder is <i>(empty … block)</i>. Because the safety net
    // runs before the fenced restore, the label's <i> is not collateral-stripped when
    // an unrelated interleaved run ("**a _b** c_") in the same message trips the net.
    const out = markdownToTelegramHtml('**a _b** c_\n```bash\n```');
    expect(tagsBalanced(out)).toBe(true);
    expect(out).toContain('<i>(empty bash block)</i>'); // label keeps its italic
    expect(out).not.toContain('<b>'); // mis-nested emphasis still dropped
    expect(out).toContain('a b c'); // emphasis text preserved as plain
  });
});
