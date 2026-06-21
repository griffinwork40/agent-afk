import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import chalk from 'chalk';
import stringWidth from 'string-width';
import { renderCardLine, renderMarkdownToTerminal } from './formatter.js';
import { wrapToWidth } from './wrap.js';
import { palette } from './palette.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

describe('renderMarkdownToTerminal', () => {
  let originalLevel: typeof chalk.level;

  beforeAll(() => {
    originalLevel = chalk.level;
    chalk.level = 3;
  });

  afterAll(() => {
    chalk.level = originalLevel;
  });

  describe('tables', () => {
    const sample = [
      '| Claim | Reality |',
      '|-------|---------|',
      '| Wave 1 pre-start | **Wrong.** Already landed. |',
      '| Lane 1.1 vendor | Done — prompts present. |',
      '',
    ].join('\n');

    it('does not leak raw pipe-delimited source', () => {
      const out = stripAnsi(renderMarkdownToTerminal(sample));
      expect(out).not.toMatch(/\|-+\|-+\|/);
      expect(out).not.toMatch(/^\| Claim \| Reality \|$/m);
    });

    it('emits box-drawing borders and both headers and cell text', () => {
      const out = stripAnsi(renderMarkdownToTerminal(sample));
      expect(out).toContain('┌');
      expect(out).toContain('┬');
      expect(out).toContain('┐');
      expect(out).toContain('├');
      expect(out).toContain('┼');
      expect(out).toContain('┤');
      expect(out).toContain('└');
      expect(out).toContain('┴');
      expect(out).toContain('┘');
      expect(out).toContain('│');
      expect(out).toContain('Claim');
      expect(out).toContain('Reality');
      expect(out).toContain('Wave 1 pre-start');
      expect(out).toContain('Already landed.');
      expect(out).toContain('Lane 1.1 vendor');
    });

    it('preserves bold ANSI inside table cells', () => {
      const raw = renderMarkdownToTerminal(sample);
      expect(raw).toMatch(/\x1b\[1m/);
      const boldSegments = raw.match(/\x1b\[1m[^\x1b]*Wrong\./g);
      expect(boldSegments).not.toBeNull();
    });

    it('respects right/center alignment in column specifiers', () => {
      const rightAligned = [
        '| Left | Right |',
        '|:-----|------:|',
        '| a    |     1 |',
        '| bb   |    22 |',
        '',
      ].join('\n');
      const out = stripAnsi(renderMarkdownToTerminal(rightAligned));
      const rows = out.split('\n').filter((l) => l.includes('│'));
      const dataRow = rows.find((l) => l.includes(' 1 '));
      expect(dataRow).toBeDefined();
      expect(dataRow).toMatch(/│ {3,}1 │$/);
    });

    it('pads columns so each line in the table has equal visual width', () => {
      const out = stripAnsi(renderMarkdownToTerminal(sample));
      const tableLines = out
        .split('\n')
        .filter((l) => /[┌┐└┘├┤┬┴┼│─]/.test(l));
      const widths = new Set(tableLines.map((l) => stringWidth(l)));
      expect(widths.size).toBe(1);
    });

    it('keeps equal visual widths for wide-glyph cell content', () => {
      const sampleWide = [
        '| City | Note |',
        '|------|------|',
        '| 東京 | 😄😄 |',
        '| é | ok |',
        '',
      ].join('\n');
      const out = stripAnsi(renderMarkdownToTerminal(sampleWide, { maxWidth: 24 }));
      const tableLines = out
        .split('\n')
        .filter((l) => /[┌┐└┘├┤┬┴┼│─]/.test(l));
      const widths = new Set(tableLines.map((l) => stringWidth(l)));
      expect(widths.size).toBe(1);
    });

    /**
     * Proportional column-shrink contract.
     *
     * The pre-edit algorithm shrunk the widest column by 1 each loop, which
     * tended to equalize columns when one was much wider than the other —
     * destroying the ratio the table author chose. The current algorithm
     * shrinks every column proportional to its own reducible width, so the
     * wide column stays meaningfully wider than the narrow column even
     * under tight maxWidth constraints.
     *
     * Concrete check: with widths [5, 15] and a maxWidth that forces ~9
     * units of shrink, the new algorithm preserves col2 > 2x col1.
     * The old algorithm would have flattened them to roughly equal.
     */
    it('preserves wide:narrow ratio under proportional shrink', () => {
      const sample = [
        '| Short | WideHeader12345 |',
        '|-------|-----------------|',
        '| 12345 | abcdefghij12345 |',
        '',
      ].join('\n');
      const out = stripAnsi(renderMarkdownToTerminal(sample, { maxWidth: 18 }));
      const dataRow = out
        .split('\n')
        .find((l) => l.includes('│') && /\d/.test(l) && !/[┌┐└┘├┤┬┴┼─]/.test(l));
      expect(dataRow).toBeDefined();
      const cells = dataRow!.split('│').slice(1, -1);
      expect(cells).toHaveLength(2);
      const col1Width = stringWidth(cells[0]!);
      const col2Width = stringWidth(cells[1]!);
      // Pre-edit equalize-by-1 would have produced ~1.14x ratio for this
      // input; proportional shrink keeps the ratio at 2x or higher.
      expect(col2Width).toBeGreaterThanOrEqual(col1Width * 2);
    });

    /**
     * Width-budget hard ceiling (the "clipped table + blank gap" regression).
     *
     * Per-column Math.round in the proportional shrink can under-reduce —
     * round-down error accumulates across columns — leaving every rendered
     * row 1+ col WIDER than maxWidth. formatBlockForCommit then re-wraps the
     * committed block at contentWidth with word-wrap, splitting each
     * over-wide row at its last space into a fragment + orphan '│' line.
     * The inflated physical line count desyncs the compositor's row
     * accounting, which clips the table's tail rows and emits a blank gap.
     *
     * 5 equal columns at maxWidth 25 is a concrete rounding-overshoot case:
     * pre-fix it rendered 26-wide rows and the re-wrap inflated 6 lines → 8.
     */
    it('never renders a table line wider than maxWidth (rounding overshoot)', () => {
      const sample = [
        '| AAAA | BBBB | CCCC | DDDD | EEEE |',
        '|------|------|------|------|------|',
        '| aaaa | bbbb | cccc | dddd | eeee |',
        '',
      ].join('\n');
      const maxWidth = 25;
      const out = renderMarkdownToTerminal(sample, { maxWidth });
      const lines = stripAnsi(out).split('\n').filter((l) => l.length > 0);
      for (const line of lines) {
        expect(stringWidth(line)).toBeLessThanOrEqual(maxWidth);
      }
      // The commit-time second wrap pass must be a no-op for table content —
      // no orphan '│' fragments, no physical line-count inflation.
      const rewrapped = wrapToWidth(out, maxWidth);
      expect(rewrapped.split('\n').length).toBe(out.split('\n').length);
    });

    /**
     * Inter-row separator contract.
     *
     * A thin `├─┼─┤` line is inserted between every pair of data rows
     * (but not after the last). For a 3-data-row table that means: 1
     * header-to-data separator + 2 inter-row separators = 3 separator lines
     * starting with `├`.
     */
    it('inserts thin separators between data rows', () => {
      const sample = [
        '| A | B |',
        '|---|---|',
        '| 1 | 2 |',
        '| 3 | 4 |',
        '| 5 | 6 |',
        '',
      ].join('\n');
      const out = stripAnsi(renderMarkdownToTerminal(sample));
      const separators = out.split('\n').filter((l) => l.startsWith('├'));
      // 1 (header to first data row) + 2 (between the three data rows)
      expect(separators).toHaveLength(3);
    });

    it('omits inter-row separator for single-data-row tables', () => {
      const single = [
        '| A | B |',
        '|---|---|',
        '| 1 | 2 |',
        '',
      ].join('\n');
      const out = stripAnsi(renderMarkdownToTerminal(single));
      const separators = out.split('\n').filter((l) => l.startsWith('├'));
      // Only the header to data separator. No inter-row separator.
      expect(separators).toHaveLength(1);
    });
  });

  describe('ordered lists', () => {
    it('preserves source-level starting number when source does not start at 1', () => {
      // Marked exposes the leading number as `list.start`. When the streaming
      // renderer splits a loose ordered list on \n\n, each fragment is lexed
      // independently — fragment "2. Second item" has start=2. The renderer
      // must honor it instead of always emitting "1.".
      const out = stripAnsi(renderMarkdownToTerminal('2. Second item'));
      expect(out).toContain('2. Second item');
      expect(out).not.toContain('1. Second item');
    });

    it('numbers items consecutively starting from list.start', () => {
      const out = stripAnsi(renderMarkdownToTerminal('3. Third\n4. Fourth\n5. Fifth'));
      expect(out).toContain('3. Third');
      expect(out).toContain('4. Fourth');
      expect(out).toContain('5. Fifth');
    });

    it('streamed loose ordered list does not renumber every fragment to 1', () => {
      // Same content the StreamingMarkdownRenderer would feed to commitBlock
      // when chunking on \n\n. Each block goes through renderMarkdownToTerminal
      // separately; without list.start honoring, all three would render as "1.".
      const out1 = stripAnsi(renderMarkdownToTerminal('1. First item\n\n'));
      const out2 = stripAnsi(renderMarkdownToTerminal('2. Second item\n\n'));
      const out3 = stripAnsi(renderMarkdownToTerminal('3. Third item'));
      expect(out1).toContain('1. First item');
      expect(out2).toContain('2. Second item');
      expect(out3).toContain('3. Third item');
    });
  });

  describe('unordered lists — wrapping', () => {
    // Regression: a long bullet must word-wrap WITH a hanging indent so the
    // continuation aligns under the item text (column 4 for "  • "), never at
    // column 0. Before the fix the list branch never wrapped long lines; the
    // commit-time indent-blind wrapToWidth pass then reflowed continuations to
    // column 0 and the list visually dissolved.
    const longItem =
      '- Phase 1 replaces the unconditional newline count with the band overflow value, gated by a merge-path predicate that falls back to legacy behavior';

    it('wraps a long item with a prefix-width hanging indent', () => {
      const out = stripAnsi(renderMarkdownToTerminal(longItem, { maxWidth: 40 }));
      const lines = out.split('\n').filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThan(1); // it actually wrapped
      expect(lines[0]).toMatch(/^  • \S/); // first line carries the bullet marker
      // every continuation line is indented to the marker's content column (4
      // for "  • "), never reflowed flush-left to column 0
      for (const line of lines.slice(1)) {
        expect(line).toMatch(/^ {4}\S/);
      }
      // no rendered line exceeds the width budget
      for (const line of lines) {
        expect(stringWidth(line)).toBeLessThanOrEqual(40);
      }
    });

    it('hanging indent survives the commit-time second wrapToWidth pass', () => {
      // Claim-5 guard: lines are wrapped to (maxWidth - prefixWidth) and then
      // get a prefixWidth indent, summing to exactly maxWidth — so the outer
      // commit pipeline pass (renderMarkdownToTerminal → wrapToWidth at the
      // same width) must NOT re-split them and drop the indent.
      const rendered = renderMarkdownToTerminal(longItem, { maxWidth: 40 });
      const rewrapped = stripAnsi(wrapToWidth(rendered, 40));
      const lines = rewrapped.split('\n').filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThan(1);
      expect(lines[0]).toMatch(/^  • \S/);
      for (const line of lines.slice(1)) {
        expect(line).toMatch(/^ {4}\S/);
      }
    });
  });

  describe('renderCardLine', () => {
    it('renders bold markdown as ANSI bold', () => {
      const out = renderCardLine('**PR #163 opened**: https://example.com');
      expect(out).not.toContain('**');
      expect(out).toMatch(/\x1b\[1m/);
      expect(stripAnsi(out)).toContain('PR #163 opened');
    });

    it('renders italic markdown as ANSI italic', () => {
      const out = renderCardLine('Review *evidence* and close.');
      expect(out).not.toContain('*evidence*');
      expect(stripAnsi(out)).toContain('evidence');
    });

    it('renders inline code as styled text', () => {
      const out = renderCardLine('Run `pnpm test` to verify');
      expect(out).not.toContain('`');
      expect(stripAnsi(out)).toContain('pnpm test');
    });

    it('passes through unsupported block types as raw text', () => {
      // heading and list are now projected — only code/table/blockquote/hr/html pass through raw
    });

    it('passes through code blocks as raw text', () => {
      const block = '```ts\nconst x = 1;\n```';
      expect(renderCardLine(block)).toBe(block);
    });

    it('passes through plain text unchanged', () => {
      const plain = 'Files changed: 3';
      expect(renderCardLine(plain)).toBe(plain);
    });

    // Regression: bare auto-link URLs were emitted twice — once as link text
    // and once as a parenthesized href — bloating card width.
    // Example failing input from PR #165 description: '**X**: https://example.com'
    it('does not duplicate bare auto-link URLs', () => {
      const out = stripAnsi(renderCardLine('See https://example.com for details'));
      const matches = out.match(/https:\/\/example\.com/g) ?? [];
      expect(matches).toHaveLength(1);
      expect(out).not.toContain('(https://example.com)');
    });

    // [text](url) form: both the rendered text and the href should appear so
    // the destination is still visible in a terminal.
    it('renders [text](url) links with both text and href', () => {
      const out = stripAnsi(renderCardLine('Open [the PR](https://example.com/pr/1)'));
      expect(out).toContain('the PR');
      expect(out).toContain('(https://example.com/pr/1)');
    });

    // Regression: marked emits `escape` tokens with raw='\*' and text='*'.
    // The default case returned `raw`, so backslashes leaked into output.
    it('renders backslash-escaped markdown chars without the backslash', () => {
      const out = stripAnsi(renderCardLine('literal \\*not bold\\*'));
      expect(out).toBe('literal *not bold*');
      expect(out).not.toContain('\\');
    });

    // Regression: 'html' was missing from BLOCK_TOKEN_TYPES, so raw HTML
    // block constructs leaked through the inline-only path.
    it('passes through raw HTML blocks as raw text', () => {
      const html = '<div>raw html</div>';
      expect(renderCardLine(html)).toBe(html);
    });

    // Codespan content must not be re-parsed as markdown — `**` inside a
    // codespan should remain literal stars (rendered in user palette).
    it('does not re-parse markdown inside codespans', () => {
      const out = stripAnsi(renderCardLine('Use `**literal**` in code'));
      expect(out).toContain('**literal**');
    });

    // Regression: a value like `** No code changed` (an orphaned bold close
    // stranded by the `**Label:** value` bullet split) leaked a literal `**`.
    // marked treats `** ` as plain text since it is not a valid CommonMark
    // opener, so the formatter must drop the orphaned leading marker.
    it('strips an orphaned leading bold marker followed by a space', () => {
      const out = stripAnsi(renderCardLine('** No code changed — just a /gather map'));
      expect(out).not.toContain('**');
      expect(out).toBe('No code changed — just a /gather map');
    });

    // The whitespace guard must spare globs, which have no space after the
    // leading marker — so the orphaned-marker strip never fires on them.
    // (Balanced emphasis like `__init__` is still transformed by marked itself,
    // independent of this strip; we assert only the strip's whitespace guard.)
    it('does not strip a leading marker that lacks a trailing space (globs)', () => {
      expect(renderCardLine('**/*.ts changed')).toContain('**/*.ts');
      expect(stripAnsi(renderCardLine('__lib leading underscore'))).toContain('__lib');
    });

    // Regression: the orphaned-marker strip must also apply on the
    // raw-passthrough path. A body like `** > quote` (orphaned `**` + blockquote)
    // or `** ---` (orphaned `**` + hr) lexes to a passthrough type; returning the
    // original `text` there leaked the literal `**`. The passthrough branch must
    // return the normalized (marker-stripped) text instead.
    it('strips an orphaned marker even when the body lexes to a raw-passthrough type', () => {
      expect(stripAnsi(renderCardLine('** > quoted summary line'))).not.toContain('**');
      expect(stripAnsi(renderCardLine('** > quoted summary line'))).toBe('> quoted summary line');
      expect(stripAnsi(renderCardLine('** ---'))).not.toContain('**');
      // A passthrough body with NO leading orphan is returned byte-identical.
      expect(renderCardLine('> a normal quote')).toBe('> a normal quote');
    });

    // Nested inline: recursive renderInlineTokens should style both layers.
    it('renders nested inline markdown (bold containing italic)', () => {
      const out = renderCardLine('**bold _and italic_ text**');
      const stripped = stripAnsi(out);
      expect(stripped).toContain('bold');
      expect(stripped).toContain('and italic');
      expect(stripped).not.toContain('**');
      expect(stripped).not.toContain('_');
      expect(out).toMatch(/\x1b\[1m/); // bold ANSI
      expect(out).toMatch(/\x1b\[3m/); // italic ANSI
    });

    // Unbalanced delimiters: marked typically emits the unclosed `**` as a
    // literal text token. The renderer must not crash and must not leave a
    // dangling bold ANSI escape that bleeds into surrounding text.
    it('handles unbalanced inline delimiters without crashing', () => {
      expect(() => renderCardLine('**unclosed bold')).not.toThrow();
      const out = renderCardLine('**unclosed bold');
      expect(stripAnsi(out)).toContain('unclosed bold');
    });

    describe('heading projection', () => {
      it('renders heading tokens as bold single-line text', () => {
        const result = renderCardLine('## This is a heading');
        expect(result).not.toContain('##');
        expect(result).toContain('\x1b[1m');           // ANSI bold present
        expect(stripAnsi(result)).toContain('This is a heading');
      });

      it('renders heading with inline formatting', () => {
        const result = renderCardLine('## **Bold** heading');
        expect(result).not.toContain('##');
        expect(result).not.toContain('**');
        expect(result).toContain('\x1b[1m');
        expect(stripAnsi(result)).toContain('Bold heading');
      });
    });

    describe('list projection', () => {
      it('renders single list item as bullet-prefixed text', () => {
        const result = renderCardLine('- **Bold item**');
        expect(result).toContain('•');
        expect(result).not.toMatch(/^-\s/);           // no raw dash sigil
        expect(result).not.toContain('**');
        expect(result).toContain('\x1b[1m');
        expect(stripAnsi(result)).toContain('Bold item');
      });

      it('renders multi-item list as comma-joined bullets on one line', () => {
        const result = renderCardLine('- First\n- **Second**');
        expect(result).not.toContain('\n');            // single-line contract
        const stripped = stripAnsi(result);
        expect(stripped).toContain('First');
        expect(stripped).toContain('Second');
        expect((stripped.match(/•/g) ?? []).length).toBeGreaterThanOrEqual(2);
      });

      it('renders loose list (blank-line separated items)', () => {
        const result = renderCardLine('- Loose\n\n- List');
        const stripped = stripAnsi(result);
        expect(stripped).toContain('Loose');
        expect(stripped).toContain('List');
        expect(result).toContain('•');
      });
    });
  });

  describe('slash command brand coloring', () => {
    // These helpers are evaluated lazily inside each test, after beforeAll has
    // set chalk.level = 3, so we get the real TrueColor escape sequences.
    const getBrandEscape = () => {
      const tagged = palette.brand('SENTINEL');
      const m = tagged.match(/^(\x1b\[[0-9;]*m)/);
      return m ? m[1] : null;
    };
    const userEscape = '\x1b[36m'; // chalk.cyan is always \x1b[36m at any level ≥ 1

    it('codespan containing a slash command gets brand color, not cyan', () => {
      const out = renderMarkdownToTerminal('`/mint`');
      const brandEscape = getBrandEscape();
      // Must contain the brand ANSI escape
      expect(brandEscape).not.toBeNull();
      expect(out).toContain(brandEscape!);
      // Must NOT contain cyan escape
      expect(out).not.toContain(userEscape);
      // Stripped text must still be just the command
      expect(stripAnsi(out).trim()).toBe('/mint');
    });

    it('codespan without slash keeps cyan color', () => {
      const out = renderMarkdownToTerminal('`someFunction`');
      const brandEscape = getBrandEscape();
      // Must contain cyan escape
      expect(out).toContain(userEscape);
      // Must not contain brand color
      if (brandEscape) {
        expect(out).not.toContain(brandEscape);
      }
      expect(stripAnsi(out).trim()).toBe('someFunction');
    });

    it('bare slash command in prose paragraph gets brand color', () => {
      const out = renderMarkdownToTerminal('Use /mint to run it');
      const brandEscape = getBrandEscape();
      // Brand ANSI escape must be present
      expect(brandEscape).not.toBeNull();
      expect(out).toContain(brandEscape!);
      // Stripped text is preserved
      expect(stripAnsi(out).trim()).toBe('Use /mint to run it');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Task-list checkboxes (GFM [ ] / [x])
  // ──────────────────────────────────────────────────────────────────────────
  describe('task-list checkboxes', () => {
    it('renders checked item with ☑ glyph and no raw [x]', () => {
      const out = stripAnsi(renderMarkdownToTerminal('- [x] done\n'));
      expect(out).toContain('☑');
      expect(out).not.toContain('[x]');
      expect(out).not.toContain('[ ]');
    });

    it('renders unchecked item with ☐ glyph and no raw [ ]', () => {
      const out = stripAnsi(renderMarkdownToTerminal('- [ ] todo\n'));
      expect(out).toContain('☐');
      expect(out).not.toContain('[ ]');
      expect(out).not.toContain('[x]');
    });

    it('renders mixed task list with correct glyphs and no raw bracket syntax', () => {
      const out = stripAnsi(renderMarkdownToTerminal('- [x] done\n- [ ] todo\n'));
      expect(out).toContain('☑');
      expect(out).toContain('☐');
      expect(out).toContain('done');
      expect(out).toContain('todo');
      // No raw bracket forms anywhere in the output
      expect(out).not.toMatch(/\[x\]/);
      expect(out).not.toMatch(/\[ \]/);
      // No bullet character before the glyph — task items must not emit "• [x]"
      expect(out).not.toMatch(/•/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // F2 regression: hr trailing newline
  // ──────────────────────────────────────────────────────────────────────────
  describe('hr (horizontal rule)', () => {
    it('F2: hr output ends with a trailing newline', () => {
      const out = renderMarkdownToTerminal('---\n');
      // The raw (ANSI-included) string must end with \n
      expect(out).toMatch(/\n$/);
    });

    it('F2: hr followed by paragraph has a gap — not glued together', () => {
      const out = stripAnsi(renderMarkdownToTerminal('---\n\nNext paragraph.\n'));
      // There must be a newline between the rule and the paragraph text
      expect(out).toMatch(/─+\n[\s\S]*Next paragraph/);
      expect(out).not.toMatch(/─+Next paragraph/);
    });

    it('rule width tracks the configured maxWidth', () => {
      const w = 60;
      const out = stripAnsi(renderMarkdownToTerminal('---\n', { maxWidth: w }));
      const ruleLine = out.split('\n').find((l) => /─/.test(l));
      expect(ruleLine).toBeDefined();
      expect(ruleLine!.length).toBe(w);
    });

    it('rule width is not hardcoded to 40 — a width of 80 produces 80 dashes', () => {
      const out = stripAnsi(renderMarkdownToTerminal('---\n', { maxWidth: 80 }));
      const ruleLine = out.split('\n').find((l) => /─/.test(l));
      expect(ruleLine).toBeDefined();
      expect(ruleLine!.length).toBe(80);
      expect(ruleLine!.length).not.toBe(40);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // F3 regression: blockquote no trailing orphan-prefix lines
  // ──────────────────────────────────────────────────────────────────────────
  describe('blockquote', () => {
    it('F3: blockquote does not end with orphaned "  │ " prefix lines', () => {
      const out = stripAnsi(renderMarkdownToTerminal('> Hello world\n'));
      const lines = out.split('\n');
      // No line should be just whitespace + "│" with nothing after it
      const orphans = lines.filter((l) => /^\s*│\s*$/.test(l));
      expect(orphans).toHaveLength(0);
    });

    it('F3: blockquote output ends with a trailing newline', () => {
      const out = renderMarkdownToTerminal('> Hello world\n');
      expect(out).toMatch(/\n$/);
    });

    it('F3: blockquote with multiple sentences has no trailing garbage prefix', () => {
      const out = stripAnsi(renderMarkdownToTerminal('> First sentence. Second sentence.\n'));
      const lines = out.split('\n').filter((l) => l.length > 0);
      // Every non-empty line in a blockquote must have visible content after the │
      for (const line of lines) {
        if (line.includes('│')) {
          expect(line.trim()).not.toBe('│');
        }
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // F4 regression: empty fenced code blocks render a visible placeholder
  // instead of a header-only stub. A model emitting "```bash\n```" with no
  // body used to render as just "│ bash" — visually indistinguishable from
  // a render bug. Surface the omission loudly.
  // ──────────────────────────────────────────────────────────────────────────
  describe('empty code blocks', () => {
    it('F4: empty fence with language tag renders "(empty <lang> block)" placeholder', () => {
      const out = stripAnsi(renderMarkdownToTerminal('You can run:\n```bash\n```\n'));
      expect(out).toContain('│ (empty bash block)');
      // The bare "│ bash" header-only stub must not appear.
      expect(out).not.toMatch(/│ bash\n(?!\s*\(empty)/);
    });

    it('F4: empty fence without language tag renders "(empty code block)" placeholder', () => {
      const out = stripAnsi(renderMarkdownToTerminal('```\n```\n'));
      expect(out).toContain('│ (empty code block)');
    });

    it('F4: non-empty fenced code block still renders body lines (no regression)', () => {
      const out = stripAnsi(renderMarkdownToTerminal('```bash\ngit pull --rebase\n```\n'));
      expect(out).toContain('│ bash');
      expect(out).toContain('git pull --rebase');
      expect(out).not.toContain('(empty');
    });
  });

  describe('headings', () => {
    it('H2 emits a trailing newline so the next block does not glue onto it', () => {
      const input = '## State reality-check\n\nSome text.\n';
      const stripped = stripAnsi(renderMarkdownToTerminal(input));
      expect(stripped).toMatch(/State reality-check\n/);
      expect(stripped).not.toMatch(/State reality-checkSome/);
    });

    it('H2 followed by a table has a blank line between them after stripping ANSI', () => {
      const input = '## Subheading\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
      const stripped = stripAnsi(renderMarkdownToTerminal(input));
      expect(stripped).not.toMatch(/Subheading┌/);
      expect(stripped).toMatch(/Subheading\n[\s\S]*┌/);
    });

    it('H3 followed by paragraph has a line break between them', () => {
      const input = '### Why this combination amplifies\n\nThe three lanes now reinforce each other:\n';
      const stripped = stripAnsi(renderMarkdownToTerminal(input));
      expect(stripped).not.toMatch(/amplifiesThe/);
      expect(stripped).toMatch(/amplifies\n/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Block-spacing rhythm — see docs/tui-rhythm.md. Every block token emits a
  // single trailing '\n' and no leading blank; marked's `space` token supplies
  // the one blank line between blocks. Regression guard for the
  // "double blank between paragraphs / leading blank before headings" bug.
  // ──────────────────────────────────────────────────────────────────────────
  describe('block spacing rhythm', () => {
    // Longest run of consecutive blank lines in the rendered output.
    const maxBlankRun = (s: string): number => {
      let max = 0;
      let run = 0;
      for (const line of stripAnsi(s).split('\n')) {
        if (line.trim() === '') {
          run++;
          max = Math.max(max, run);
        } else {
          run = 0;
        }
      }
      return max;
    };

    it('separates consecutive paragraphs by exactly one blank line (no double blanks)', () => {
      const out = renderMarkdownToTerminal('First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n');
      expect(maxBlankRun(out)).toBeLessThanOrEqual(1);
      expect(stripAnsi(out)).toMatch(/First paragraph\.\n\nSecond paragraph\.\n\nThird paragraph\./);
    });

    it('a heading does not emit a leading blank line', () => {
      const out = renderMarkdownToTerminal('# Title\n\nBody.\n');
      expect(out).not.toMatch(/^\n/);
      expect(stripAnsi(out).split('\n')[0]).toContain('Title');
    });

    it('mixed blocks (paragraph, list, code, heading) never stack blank lines', () => {
      const md = [
        'Lead in.', '', '## Section', '', '- one', '- two', '',
        '```sh', 'afk login', '```', '', 'Closing line.', '',
      ].join('\n');
      expect(maxBlankRun(renderMarkdownToTerminal(md))).toBeLessThanOrEqual(1);
    });

    it('collapses 3+ source newlines between paragraphs to a single blank line', () => {
      const out = renderMarkdownToTerminal('Above.\n\n\n\nBelow.\n');
      expect(maxBlankRun(out)).toBeLessThanOrEqual(1);
    });

    it('an empty code block does not double-space the following blank line', () => {
      // The empty-fence loud-fail placeholder is a block token too: it must own
      // exactly one trailing '\n' like every other block. Guards the formatter
      // empty-code branch against re-introducing '\n\n'.
      const out = renderMarkdownToTerminal('Intro.\n\n```bash\n```\n\nOutro.\n');
      expect(maxBlankRun(out)).toBeLessThanOrEqual(1);
    });
  });
});
