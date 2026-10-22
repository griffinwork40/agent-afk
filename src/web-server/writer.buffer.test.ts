/**
 * Tests for BufferingWriter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

/** Untyped call-through mock; the precise signature is irrelevant to these tests. */
type AnyMock = Mock<(...args: unknown[]) => unknown>;
import { stripVTControlCharacters } from 'node:util';

// Mock writer.ts to avoid palette / bounded-line deps
let mockCreateConsoleWriter: AnyMock;
vi.mock('../cli/slash/writer.js', () => ({
  createConsoleWriter: (...args: unknown[]) => mockCreateConsoleWriter(...args),
}));

import { BufferingWriter } from './writer.buffer.js';

const FAKE_WRITER = { line: vi.fn(), raw: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  mockCreateConsoleWriter = vi.fn().mockReturnValue(FAKE_WRITER);
  vi.clearAllMocks();
});

describe('BufferingWriter', () => {
  it('returns no blocks when nothing was emitted', () => {
    const bw = new BufferingWriter();
    bw.rawFn('');
    expect(bw.toOutputBlocks()).toEqual([]);
  });

  it('flushes raw/line text around blocks in order and strips ANSI only in text fallback', () => {
    const bw = new BufferingWriter();
    bw.rawFn('\x1b[31mred\x1b[0m');
    bw.fn(' line');
    bw.asWriterInterface().block!({ kind: 'link', label: 'Docs', url: 'https://example.com', text: 'Docs\n', ansi: 'Docs\n' });
    bw.rawFn('tail');
    bw.fn(' end');
    const blocks = bw.toOutputBlocks();
    expect(blocks).toEqual([
      { kind: 'text', ansi: '\x1b[31mred\x1b[0m line\n', text: 'red line\n' },
      { kind: 'link', label: 'Docs', url: 'https://example.com', text: 'Docs\n', ansi: 'Docs\n' },
      { kind: 'text', ansi: 'tail end\n', text: 'tail end\n' },
    ]);
    expect(JSON.parse(JSON.stringify(blocks))).toEqual(blocks);
    expect(bw.toOutputBlocks()).toEqual(blocks);
    expect(bw.toOutputBlock().text).toBe('red line\nDocs\ntail end\n');
  });

  it('keeps adjacent blocks separate and snapshots independent of caller mutation', () => {
    const bw = new BufferingWriter();
    const block = { kind: 'table' as const, columns: ['A'], rows: [['B']], text: 'A\nB\n', ansi: 'A\nB\n' };
    bw.block(block);
    bw.block(block);
    block.rows[0]!.push('mutation');
    const first = bw.toOutputBlocks();
    expect(first).toHaveLength(2);
    if (first[0]?.kind === 'table') first[0].rows.push(['mutation']);
    expect(bw.toOutputBlocks()[0]).toMatchObject({ rows: [['B']] });
    bw.fn('later');
    expect(bw.toOutputBlocks()).toHaveLength(3);
  });

  it('captures fn() calls with newline appended', () => {
    const bw = new BufferingWriter();
    bw.fn('hello');
    bw.fn('world');
    expect(bw.getChunks()).toEqual(['hello\n', 'world\n']);
  });

  it('captures rawFn() calls without appending newline', () => {
    const bw = new BufferingWriter();
    bw.rawFn('raw text');
    expect(bw.getChunks()).toEqual(['raw text']);
  });

  it('captures mixed fn and rawFn calls in order', () => {
    const bw = new BufferingWriter();
    bw.fn('line1');
    bw.rawFn('raw');
    bw.fn('line2');
    expect(bw.getChunks()).toEqual(['line1\n', 'raw', 'line2\n']);
  });

  it('getChunks returns a copy (not the internal array)', () => {
    const bw = new BufferingWriter();
    bw.fn('x');
    const chunks = bw.getChunks();
    chunks.push('injected');
    expect(bw.getChunks()).toHaveLength(1);
  });

  it('asWriterInterface passes this as sink to createConsoleWriter', () => {
    const bw = new BufferingWriter();
    const w = bw.asWriterInterface();
    expect(mockCreateConsoleWriter).toHaveBeenCalledWith(bw);
    expect(w).toMatchObject(FAKE_WRITER);
    expect(w.block).toEqual(expect.any(Function));
  });

  it('toOutputBlock returns ansi = joined chunks', () => {
    const bw = new BufferingWriter();
    bw.fn('hello');
    bw.rawFn(' world');
    const block = bw.toOutputBlock();
    expect(block.ansi).toBe('hello\n world');
  });

  it('toOutputBlock text = stripVTControlCharacters(ansi)', () => {
    const bw = new BufferingWriter();
    const ansiStr = '\x1b[1mbold\x1b[0m normal';
    bw.rawFn(ansiStr);
    const block = bw.toOutputBlock();
    expect(block.text).toBe(stripVTControlCharacters(ansiStr));
    expect(block.text).toBe('bold normal');
  });

  it('toOutputBlock with empty buffer returns empty strings', () => {
    const bw = new BufferingWriter();
    const block = bw.toOutputBlock();
    expect(block.ansi).toBe('');
    expect(block.text).toBe('');
  });
});
