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
     * Wide:narrow ratio under the degenerate squeeze path.
     *
     * Both columns are single, unbreakable tokens (5 and 15 chars), so their
     * incompressible floors (min(natural, longestWord, CAP)) sum to more than
     * the content budget at maxWidth 18 — the degenerate path. It shrinks the
     * floors proportionally, which keeps the wide column meaningfully wider than
     * the narrow one instead of flattening both to roughly equal (the original
     * trim-widest-by-1 failure mode).
     */
    it('preserves wide:narrow ratio under the degenerate squeeze', () => {
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
      // Proportional floor-shrink keeps the ratio at 2x or higher; the original
      // equalize-by-1 would have produced ~1.14x for this input.
      expect(col2Width).toBeGreaterThanOrEqual(col1Width * 2);
    });

    /**
     * Degenerate path fills the width budget (grow-back).
     *
     * When the floors exceed the content budget the allocator scales them down
     * with Math.floor, discarding fractional units. Without a grow-back step the
     * table renders narrower than maxWidth allows. One wide column plus several
     * narrow ones at a tight maxWidth is the concrete case: pre-fix the rendered
     * border was ~3 columns short of the budget (27 of 30); grow-back hands the
     * reclaimed slack to the widest column so the table fills the budget exactly.
     */
    it('fills the width budget in the degenerate squeeze (grow-back)', () => {
      const sample = [
        '| Path | One | Two | Thr | Fou |',
        '|------|-----|-----|-----|-----|',
        '| src/cli/formatter.ts:340-the-allocator | abc | def | ghi | jkl |',
        '',
      ].join('\n');
      const maxWidth = 30;
      const out = stripAnsi(renderMarkdownToTerminal(sample, { maxWidth }));
      const tableLines = out
        .split('\n')
        .filter((l) => /[┌┐└┘├┤┬┴┼│─]/.test(l));
      const widest = Math.max(...tableLines.map((l) => stringWidth(l)));
      // Fills (almost) the whole budget — pre-fix it under-allocated to ~27.
      expect(widest).toBeGreaterThanOrEqual(maxWidth - 1);
      // ...and never exceeds it.
      expect(widest).toBeLessThanOrEqual(maxWidth);
    });

    /**
     * Narrow single-word column protection (the "Verd…" bug).
     *
     * A content-heavy table much wider than the terminal used to shrink EVERY
     * column by the same proportion, crushing a narrow single-word column (e.g.
     * a "Verdict" of CONFIRMED/OVERSTATED) below its content width so each value
     * was chopped to "CONF…"/"OVER…". Floor-based water-filling gives each column
     * its incompressible-word width as a floor and takes the squeeze from the
     * genuinely wide columns instead, so the verdict words render in full while
     * the table still fits the budget and the commit-time re-wrap stays a no-op.
     */
    it('protects a narrow single-word column from ellipsis truncation', () => {
      const sample = [
        '| # | Claim | Verdict | Source |',
        '|---|-------|---------|--------|',
        '| 1 | The dispatcher mishandles partial rows while streaming output | OVERSTATED | src/cli/formatter.ts:340 plus the downstream wrap pass |',
        '| 2 | Column widths derive from natural content width alone here | CONFIRMED | src/cli/markdown-stream-format.ts:92 second wrapToWidth |',
        '',
      ].join('\n');
      const maxWidth = 70;
      const out = stripAnsi(renderMarkdownToTerminal(sample, { maxWidth }));
      // The narrow Verdict column's single-word values survive in full — not
      // chopped to "OVER…"/"CONF…" the way the old proportional squeeze did.
      expect(out).toContain('OVERSTATED');
      expect(out).toContain('CONFIRMED');
      // No rendered line exceeds the budget...
      for (const line of out.split('\n').filter((l) => l.length > 0)) {
        expect(stringWidth(line)).toBeLessThanOrEqual(maxWidth);
      }
      // ...and the commit-time second wrap pass stays a no-op (no orphan-│
      // fragments, no physical line-count inflation).
      const rendered = renderMarkdownToTerminal(sample, { maxWidth });
      expect(wrapToWidth(rendered, maxWidth).split('\n').length)
        .toBe(rendered.split('\n').length);
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

    it('suppresses top chrome when consecutive tables have same structure', () => {
      // LLMs sometimes repeat the header mid-table, splitting one logical
      // table into two marked tokens. The renderer should suppress the
      // second table's top border + header + separator, rendering a
      // seamless continuation instead of a duplicated header seam.
      const twoTables = [
        '| Layer | What |',
        '|-------|------|',
        '| Core  | A    |',
        '',
        '| Layer | What |',
        '|-------|------|',
        '| Click | B    |',
        '',
      ].join('\n');
      const out = stripAnsi(renderMarkdownToTerminal(twoTables));
      const topBorders = out.split('\n').filter((l) => l.startsWith('┌'));
      const bottomBorders = out.split('\n').filter((l) => l.startsWith('└'));
      // Only one top border and one bottom border — visually one table.
      expect(topBorders).toHaveLength(1);
      expect(bottomBorders).toHaveLength(1);
      // Both data rows present.
      expect(out).toContain('Core');
      expect(out).toContain('Click');
      // Header text appears only once.
      const headerMatches = out.split('\n').filter((l) => l.includes('Layer') && l.includes('What'));
      expect(headerMatches).toHaveLength(1);
      expect(out).not.toContain('\n\n');
    });

    it('keeps adjacent tables separate when their schemas differ', () => {
      const out = stripAnsi(renderMarkdownToTerminal([
        '| Summary | Value |', '|---|---|', '| Total | 2 |', '',
        '| Name | Kind | Path |', '|---|---|---|', '| api | service | src/api |', '',
      ].join('\n')));
      expect(out.split('\n').filter((line) => line.startsWith('┌'))).toHaveLength(2);
      expect(out).toContain('Summary');
      expect(out).toContain('Name');
    });

    it('computes one shared layout across continued table rows', () => {
      const out = stripAnsi(renderMarkdownToTerminal([
        '| Key | Value |', '|---|---|', '| a | short |', '',
        '| Key | Value |', '|---|---|', '| b | substantially longer value |', '',
      ].join('\n')));
      const structuralLines = out.split('\n').filter((line) => /^[┌├└│]/.test(line));
      expect(new Set(structuralLines.map((line) => line.length))).toHaveLength(1);
      expect(out.split('\n').filter((line) => line.startsWith('┌'))).toHaveLength(1);
    });

    it('does not suppress top chrome when a non-table block intervenes', () => {
      // Table → paragraph → table should render as two separate tables.
      const separated = [
        '| A | B |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        'Some text between tables.',
        '',
        '| A | B |',
        '|---|---|',
        '| 3 | 4 |',
        '',
      ].join('\n');
      const out = stripAnsi(renderMarkdownToTerminal(separated));
      const topBorders = out.split('\n').filter((l) => l.startsWith('┌'));
      // Two separate tables → two top borders.
      expect(topBorders).toHaveLength(2);
    });

    it('suppresses top chrome for three consecutive tables', () => {
      const threeTables = [
        '| X |',
        '|---|',
        '| a |',
        '',
        '| X |',
        '|---|',
        '| b |',
        '',
        '| X |',
        '|---|',
        '| c |',
        '',
      ].join('\n');
      const out = stripAnsi(renderMarkdownToTerminal(threeTables));
      const topBorders = out.split('\n').filter((l) => l.startsWith('┌'));
      const bottomBorders = out.split('\n').filter((l) => l.startsWith('└'));
      expect(topBorders).toHaveLength(1);
      expect(bottomBorders).toHaveLength(1);
      expect(out).toContain('a');
      expect(out).toContain('b');
      expect(out).toContain('c');
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

  describe('lists — unbreakable tokens wider than the item budget', () => {
    // Regression (observed in a real REPL transcript): the two tests above use
    // word-wrappable prose, so the list branch's word-wrap (hard:false) always
    // found a space to break at and the width invariant held by accident. A
    // single token WIDER than (maxWidth - prefixWidth) — a bare path, URL, or
    // `file.ts:12-34` codespan, which afk emits constantly — was left unbroken,
    // so the item escaped the branch OVER budget and the production commit pass
    // (markdown-stream-format.ts, wrapToWidth with breakLongWords:true) split it
    // at column 0. On screen: `1. src/cli/…/tool-lane-format-` / `args.ts:77-81`
    // flush-left, the list dissolved.
    //
    // The `{ breakLongWords: true }` argument below is load-bearing: it mirrors
    // what the commit pipeline actually does. Re-wrapping without it (as the
    // sibling test above does) cannot observe this failure at all.
    const longToken = 'src/cli/commands/interactive/tool-lane-format-args.ts:77-81';
    const COMMIT = { breakLongWords: true } as const;

    it('ordered item: an over-wide token is broken WITH the hanging indent, not at column 0', () => {
      const md = `1. \`${longToken}\` deletes the wrapper at render time.`;
      const rendered = renderMarkdownToTerminal(md, { maxWidth: 56 });
      const lines = stripAnsi(wrapToWidth(rendered, 56, COMMIT))
        .split('\n')
        .filter((l) => l.length > 0);

      expect(lines.length).toBeGreaterThan(1); // it actually broke the token
      expect(lines[0]).toMatch(/^  1\. \S/); // marker row carries content, not a bare "1."
      // Every continuation sits at the ordered marker's content column ("  1. "
      // = 5), never flush-left.
      for (const line of lines.slice(1)) {
        expect(line).toMatch(/^ {5}\S/);
      }
      for (const line of lines) {
        expect(stringWidth(line)).toBeLessThanOrEqual(56);
      }
    });

    it('bullet item: an over-wide token is broken WITH the hanging indent', () => {
      const md = `- \`${longToken}\` deletes the wrapper.`;
      const rendered = renderMarkdownToTerminal(md, { maxWidth: 48 });
      const lines = stripAnsi(wrapToWidth(rendered, 48, COMMIT))
        .split('\n')
        .filter((l) => l.length > 0);

      expect(lines.length).toBeGreaterThan(1);
      expect(lines[0]).toMatch(/^  • \S/);
      for (const line of lines.slice(1)) {
        expect(line).toMatch(/^ {4}\S/);
      }
      for (const line of lines) {
        expect(stringWidth(line)).toBeLessThanOrEqual(48);
      }
    });

    it('blockquote: an over-wide token keeps the │ gutter on every row', () => {
      const md = `> see \`${longToken}\` for the strip`;
      const rendered = renderMarkdownToTerminal(md, { maxWidth: 48 });
      const lines = stripAnsi(wrapToWidth(rendered, 48, COMMIT))
        .split('\n')
        .filter((l) => l.trim().length > 0);

      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) {
        expect(line).toMatch(/^ {2}│ \S/);
        expect(stringWidth(line)).toBeLessThanOrEqual(48);
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
    const getToolEscape = () => {
      const tagged = palette.tool('SENTINEL');
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

    it('codespan without slash gets tool color, not cyan', () => {
      const out = renderMarkdownToTerminal('`someFunction`');
      const brandEscape = getBrandEscape();
      const toolEscape = getToolEscape();
      // Must contain the tool ANSI escape (cyan is reserved for user identity;
      // non-slash codespans now share the fenced-code/function tone).
      expect(toolEscape).not.toBeNull();
      expect(out).toContain(toolEscape!);
      // Must NOT contain cyan escape
      expect(out).not.toContain(userEscape);
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

    // M1 regression: GFM task syntax is valid on ORDERED items too
    // ("1. [x] done"). The prior prefix ternary checked `list.ordered` first
    // and never re-tested `isTask`, so ordered task items lost the glyph — and
    // because the `checkbox` token is filtered out regardless, the raw "[x]"
    // was lost too, leaving a bare "1. done".
    it('renders ordered checked task with both the number and the ☑ glyph (M1)', () => {
      const out = stripAnsi(renderMarkdownToTerminal('1. [x] done\n'));
      expect(out).toContain('☑');
      expect(out).toMatch(/1\.\s*☑\s*done/);
      expect(out).not.toContain('[x]');
    });

    it('renders ordered unchecked task with both the number and the ☐ glyph (M1)', () => {
      const out = stripAnsi(renderMarkdownToTerminal('1. [ ] todo\n'));
      expect(out).toContain('☐');
      expect(out).toMatch(/1\.\s*☐\s*todo/);
      expect(out).not.toContain('[ ]');
    });

    it('renders a mixed ordered task list preserving sequential numbers and glyphs (M1)', () => {
      const out = stripAnsi(renderMarkdownToTerminal('1. [x] done\n2. [ ] todo\n'));
      expect(out).toMatch(/1\.\s*☑\s*done/);
      expect(out).toMatch(/2\.\s*☐\s*todo/);
      expect(out).not.toMatch(/\[x\]/);
      expect(out).not.toMatch(/\[ \]/);
    });

    // L4 coverage: a task item with rich inline formatting. The checkbox
    // filter strips the leading `checkbox` token, then renders the remaining
    // inline tokens (strong/em/codespan) through renderInline — confirm that
    // path survives: the glyph and words remain, markup is consumed, and the
    // bold SGR is actually emitted (not rendered as raw "**bold**").
    it('renders inline formatting (bold + code) inside a task item (L4)', () => {
      const raw = renderMarkdownToTerminal('- [x] **bold** and `code` here\n');
      const out = stripAnsi(raw);
      expect(out).toContain('☑');
      expect(out).toContain('bold');
      expect(out).toContain('code');
      expect(out).toContain('here');
      expect(out).not.toContain('**');
      expect(out).not.toContain('[x]');
      // chalk.bold → \x1b[1m proves inline tokens were rendered, not emitted raw.
      expect(raw).toContain('\u001b[1m');
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

    // L3 coverage: the `maxTableWidth ?? 40` fallback. Callers that omit opts
    // (no width) must get exactly 40 dashes — the only place the default
    // constant is exercised.
    it('rule defaults to 40 dashes when no maxWidth is provided', () => {
      const out = stripAnsi(renderMarkdownToTerminal('---\n'));
      const ruleLine = out.split('\n').find((l) => /─/.test(l));
      expect(ruleLine).toBeDefined();
      expect(ruleLine!.length).toBe(40);
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

  // ──────────────────────────────────────────────────────────────────────────
  // Code block width capping (HIGH-severity fix): renderCodeBlock must use
  // maxTableWidth to hard-wrap body lines so that wide code lines do not cause
  // the terminal to auto-wrap at col 0, losing the │ gutter on continuation rows.
  // ──────────────────────────────────────────────────────────────────────────
  describe('code block width capping', () => {
    it('wraps a line wider than maxTableWidth and stamps gutter on every physical row', () => {
      // maxWidth 20 → contentWidth 18 (20 - 2 for "│ " gutter).
      // A 36-char line should split into two 18-char rows, each prefixed with │.
      const longLine = 'x'.repeat(36);
      const out = stripAnsi(
        renderMarkdownToTerminal(`\`\`\`\n${longLine}\n\`\`\`\n`, { maxWidth: 20 }),
      );
      const lines = out.split('\n').filter((l) => l.includes('x'));
      // Expect exactly two gutter body rows (not one overflowing row or an
      // extra, content-free gutter row).
      expect(lines).toEqual([`│ ${'x'.repeat(18)}`, `│ ${'x'.repeat(18)}`]);
      expect(out).not.toMatch(/^│ $/m);
      // Each row must not exceed maxTableWidth (20) display columns.
      for (const l of lines) {
        expect(stringWidth(l)).toBeLessThanOrEqual(20);
      }
    });

    it('leaves short lines unaffected when maxTableWidth is set', () => {
      const out = stripAnsi(
        renderMarkdownToTerminal('```bash\ngit status\n```\n', { maxWidth: 80 }),
      );
      // The short line must appear verbatim (single gutter row).
      const bodyLines = out.split('\n').filter((l) => l.startsWith('│ ') && l.includes('git'));
      expect(bodyLines.length).toBe(1);
      expect(bodyLines[0]).toBe('│ git status');
    });

    it('does not wrap when maxTableWidth is undefined', () => {
      // Without maxWidth, renderMarkdownToTerminal does not pass maxTableWidth,
      // so the long line must pass through unsplit.
      const longLine = 'z'.repeat(200);
      const out = stripAnsi(renderMarkdownToTerminal(`\`\`\`\n${longLine}\n\`\`\`\n`));
      const bodyLines = out.split('\n').filter((l) => l.startsWith('│ ') && l.includes('z'));
      expect(bodyLines.length).toBe(1);
      expect(bodyLines[0]).toBe(`│ ${longLine}`);
    });

    it('preserves balanced syntax-highlighting ANSI across wrapped rows', () => {
      const raw = renderMarkdownToTerminal(
        '```json\n{"longPropertyName":"abcdefghijklmnopqrstuvwxyz"}\n```\n',
        { maxWidth: 20 },
      );
      // Exclude the copy-hint header line ("│ json ── /cp N") which also
      // starts with "│ " after stripping ANSI. The filter is intentionally
      // exact: a prior version used `l.trim() !== '|'` (over-inclusive) and
      // the `> 1` assertion passed by accident. The JSON body splits into
      // exactly 3 gutter rows at maxWidth 20.
      const bodyLines = raw.split('\n').filter((line) => stripAnsi(line).startsWith('│ ') &&
        !stripAnsi(line).includes('/cp'));

      expect(bodyLines).toHaveLength(3);
      for (const line of bodyLines) {
        expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(20);
        expect(line).toContain('\x1b[');
        expect(line.match(/\x1b\[3m/g)?.length ?? 0).toBe(line.match(/\x1b\[23m/g)?.length ?? 0);
        expect(line.match(/\x1b\[33m/g)?.length ?? 0).toBe(line.match(/\x1b\[39m/g)?.length ?? 0);
      }
    });

    it('does not emit a gutter-only row after an exactly-full wrapped row', () => {
      const out = stripAnsi(
        renderMarkdownToTerminal(`\`\`\`\n${'x'.repeat(18)}\n\`\`\`\n`, { maxWidth: 20 }),
      );

      expect(out.split('\n').filter((line) => line.includes('x'))).toEqual([`│ ${'x'.repeat(18)}`]);
      expect(out).not.toMatch(/^│ $/m);
    });

    it('wraps code nested in a list against the width after the list prefix', () => {
      const out = stripAnsi(
        renderMarkdownToTerminal(`- \`\`\`\n  ${'x'.repeat(36)}\n  \`\`\`\n`, { maxWidth: 20 }),
      );
      const body = out.split('\n').filter((line) => line.includes('x'));

      expect(body).toEqual([
        `    │ ${'x'.repeat(14)}`,
        `    │ ${'x'.repeat(14)}`,
        `    │ ${'x'.repeat(8)}`,
      ]);
      for (const line of body) expect(stringWidth(line)).toBeLessThanOrEqual(20);
    });

    it('wraps code nested in a blockquote against the width after its prefix', () => {
      const out = stripAnsi(
        renderMarkdownToTerminal(`> \`\`\`\n> ${'x'.repeat(28)}\n> \`\`\`\n`, { maxWidth: 20 }),
      );
      const body = out.split('\n').filter((line) => line.includes('x'));

      expect(body).toEqual([
        `  │ │ ${'x'.repeat(14)}`,
        `  │ │ ${'x'.repeat(14)}`,
      ]);
      for (const line of body) expect(stringWidth(line)).toBeLessThanOrEqual(20);
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
