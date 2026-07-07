import { describe, it, expect } from 'vitest';
import { StreamingMarkdownRenderer } from './markdown-stream.js';
import { findBlockBoundary } from './markdown-stream-format.js';

// Strip ANSI for readable assertions.
const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\u001b\[[0-9;]*m/g, '');

function renderNonTTY(chunks: string[]): string {
  const r = new StreamingMarkdownRenderer({ indent: '' });
  for (const c of chunks) r.push(c);
  return stripAnsi(r.getCommittedOutput());
}

// ──────────────────────────────────────────────────────────────────────────
// Regression: a NON-EMPTY fenced code block that is NOT preceded by a blank
// line (the opening fence directly follows a paragraph, e.g. "run:\n```\ncmd")
// used to render as TWO "(empty code block)" placeholders sandwiching the body
// as a stray paragraph. Root cause: findBlockBoundary's closing-fence regex
// could not distinguish an opening fence from a closing one, so it committed
// the block at the OPENER — orphaning the never-closed fence (→ empty block)
// and leaving body + closer to form a second block (→ paragraph + empty block).
// Fix: parity-aware scan commits only at a fence that CLOSES an open block.
// ──────────────────────────────────────────────────────────────────────────
describe('non-empty fence not preceded by a blank line', () => {
  it('findBlockBoundary defers past the opening fence to the closing fence', () => {
    const text = 'To extract it, run:\n```\n/harvest abc123\n```\n';
    // Boundary must land at the END of the block (after the closing fence),
    // not at index 24 (right after the opening fence).
    expect(findBlockBoundary(text)).toBe(text.length);
  });

  it('renders the command body, not "(empty code block)" (single push)', () => {
    const out = renderNonTTY(['To extract it, run:\n```\n/harvest abc123\n```\n']);
    expect(out).toContain('/harvest abc123');
    expect(out).not.toContain('(empty code block)');
  });

  it('renders the command body, not "(empty code block)" (chunked across fence)', () => {
    const out = renderNonTTY(['To extract it, run:\n```\n', '/harvest abc123\n```\n']);
    expect(out).toContain('/harvest abc123');
    expect(out).not.toContain('(empty code block)');
  });

  it('control: a fence WITH a preceding blank line still renders the body', () => {
    const out = renderNonTTY(['To extract it, run:\n\n```\n/harvest abc123\n```\n']);
    expect(out).toContain('/harvest abc123');
    expect(out).not.toContain('(empty code block)');
  });

  it('a genuinely empty fence still loud-fails with the placeholder', () => {
    const out = renderNonTTY(['Heads up:\n```\n```\n']);
    expect(out).toContain('(empty code block)');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Regression: the same "two empty blocks sandwiching the body" bug reappeared
// for a fence NESTED IN A LIST ITEM (indented to align under the list marker,
// e.g. "3. run:\n   ```\n   cmd\n   ```"). Root cause: isInOpenCodeFence's
// parity regex was anchored at column 0 (`^```), so it was BLIND to indented
// fences, while findBlockBoundary's closing-fence regex tolerated leading
// `[ \t]*`. That asymmetry made findBlockBoundary read even parity at an
// indented OPENER and commit there. Only reproduces under chunked streaming
// (single-push keeps the fence intact via the trailing blank line), which is
// why the flush-left cases above never caught it.
// Fix: isInOpenCodeFence now tolerates the same leading `[ \t]*` indentation.
// ──────────────────────────────────────────────────────────────────────────
describe('non-empty fence nested in a list item (indented)', () => {
  const item = '3. Only if they open it themselves: you already have `ngrok` installed →';

  it('findBlockBoundary defers past an indented opener to the indented closer', () => {
    const text = `${item}\n   \`\`\`\n   ngrok http 3000\n   \`\`\`\n`;
    expect(findBlockBoundary(text)).toBe(text.length);
  });

  it('renders the command body, not "(empty code block)" (single push)', () => {
    const out = renderNonTTY([`${item}\n   \`\`\`\n   ngrok http 3000\n   \`\`\`\n\nShare it.`]);
    expect(out).toContain('ngrok http 3000');
    expect(out).not.toContain('(empty code block)');
  });

  it('renders the command body, not "(empty code block)" (chunked after opener)', () => {
    // The exact streaming split that produced the reported screenshot: the
    // opener arrives in one chunk, the body + closer in the next.
    const out = renderNonTTY([
      `${item}\n   \`\`\`\n`,
      '   ngrok http 3000\n   ```\n\nShare it.',
    ]);
    expect(out).toContain('ngrok http 3000');
    expect(out).not.toContain('(empty code block)');
  });

  it('renders the command body, not "(empty code block)" (chunked before closer)', () => {
    const out = renderNonTTY([
      `${item}\n   \`\`\`\n   ngrok http 3000\n`,
      '   ```\n\nShare it.',
    ]);
    expect(out).toContain('ngrok http 3000');
    expect(out).not.toContain('(empty code block)');
  });

  it('a genuinely empty INDENTED fence still loud-fails with the placeholder', () => {
    const out = renderNonTTY([`${item}\n   \`\`\`\n   \`\`\`\n`]);
    expect(out).toContain('(empty code block)');
  });
});
