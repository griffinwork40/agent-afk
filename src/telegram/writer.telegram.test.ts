import { describe, it, expect } from 'vitest';
import { TelegramWriter, escapeTelegramHtml, TELEGRAM_MESSAGE_LIMIT } from './writer.telegram.js';
import type { OutputBlock } from '../cli/slash/output-blocks.js';

const fb = { text: 'fallback', ansi: 'fallback' };
function render(fill: (w: TelegramWriter) => void, limit?: number): string[] {
  const w = new TelegramWriter();
  fill(w);
  return w.toHtmlChunks(limit);
}

/** Every chunk must have balanced tags (no tag split across messages). */
function assertBalanced(chunk: string): void {
  for (const tag of ['pre', 'b', 'a', 'code']) {
    const opens = chunk.match(new RegExp(`<${tag}[ >]`, 'g'))?.length ?? 0;
    const closes = chunk.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0;
    expect(opens, `${tag} balanced in chunk`).toBe(closes);
  }
  expect(chunk).not.toMatch(/&[a-z]*$/); // no entity cut at the end
}

describe('TelegramWriter', () => {
  it('escapes HTML and strips ANSI from text lines', () => {
    const [html] = render((w) => {
      const out = w.asWriterInterface();
      out.line('\u001b[1m<b>Tom & "Jerry"</b>\u001b[0m');
    });
    expect(html).toBe('&lt;b&gt;Tom &amp; &quot;Jerry&quot;&lt;/b&gt;');
    expect(escapeTelegramHtml('<&>')).toBe('&lt;&amp;&gt;');
  });

  it('renders tables as monospaced <pre> with aligned columns and a bold title', () => {
    const [html] = render((w) => w.block({
      ...fb, kind: 'table', title: 'Jobs', columns: ['id', 'state'], rows: [['a<1', 'ok'], ['long-id', 'x']],
    }));
    expect(html).toBe('<b>Jobs</b>\n<pre>id       state\n-------  -----\na&lt;1      ok\nlong-id  x</pre>');
  });

  it('renders keyValue as bold labels', () => {
    const [html] = render((w) => w.block({
      ...fb, kind: 'keyValue', entries: [{ key: 'model', value: 'sonnet' }, { key: 'a&b', value: '<x>' }],
    }));
    expect(html).toBe('<b>model</b>: sonnet\n<b>a&amp;b</b>: &lt;x&gt;');
  });

  it('renders diffs as <pre> with the file name as title', () => {
    const [html] = render((w) => w.block({ ...fb, kind: 'diff', fileName: 'a.ts', diff: '+<new>\n-old\n' }));
    expect(html).toBe('<b>a.ts</b>\n<pre>+&lt;new&gt;\n-old</pre>');
  });

  it('renders lists with code names and descriptions', () => {
    const [html] = render((w) => w.block({
      ...fb, kind: 'list', title: 'Commands', items: [{ text: '/help', description: 'Show <help>' }, { text: '/x' }],
    }));
    expect(html).toBe('<b>Commands</b>\n• <code>/help</code> — Show &lt;help&gt;\n• <code>/x</code>');
  });

  it('renders http(s) links as anchors and refuses other schemes', () => {
    const [ok] = render((w) => w.block({ ...fb, kind: 'link', url: 'https://x.test/?a=1&b="2"', label: 'Auth <me>' }));
    expect(ok).toBe('<a href="https://x.test/?a=1&amp;b=&quot;2&quot;">Auth &lt;me&gt;</a>');
    const [bad] = render((w) => w.block({ ...fb, kind: 'link', url: 'javascript:alert(1)', label: 'x' }));
    expect(bad).not.toContain('<a');
    expect(bad).toContain('javascript:alert(1)');
  });

  it('uses the plain fallback text for unknown block kinds', () => {
    const [html] = render((w) => w.block({ kind: 'mystery', text: 'plain <t>', ansi: 'plain' } as unknown as OutputBlock));
    expect(html).toBe('plain &lt;t&gt;');
  });

  it('keeps text and block emission order', () => {
    const [html] = render((w) => {
      w.asWriterInterface().line('before');
      w.block({ ...fb, kind: 'keyValue', entries: [{ key: 'k', value: 'v' }] });
      w.asWriterInterface().line('after');
    });
    expect(html).toBe('before\n<b>k</b>: v\nafter');
  });

  it('splits at the 4096 limit without breaking tags or entities', () => {
    const rows = Array.from({ length: 600 }, (_, i) => [`row-${i}`, '<&>'.repeat(3)]);
    const chunks = render((w) => {
      w.asWriterInterface().line('&'.repeat(5000));
      w.block({ ...fb, kind: 'table', columns: ['id', 'v'], rows });
    });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
      assertBalanced(c);
    }
    const tableChunks = chunks.filter((c) => c.includes('row-'));
    expect(tableChunks.every((c) => c.includes('<pre>') && c.endsWith('</pre>'))).toBe(true);
    expect(chunks.join('').match(/row-\d+/g)).toHaveLength(600);
  });

  it('splits a single over-long pre line across chunks, each wrapped', () => {
    const chunks = render((w) => w.block({ ...fb, kind: 'diff', diff: '<'.repeat(300) }), 100);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
      assertBalanced(c);
    }
    expect(chunks.join('').match(/&lt;/g)).toHaveLength(300);
  });

  it('reports empty output and returns no chunks', () => {
    const w = new TelegramWriter();
    expect(w.isEmpty()).toBe(true);
    expect(w.toHtmlChunks()).toEqual([]);
  });
});
