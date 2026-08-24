import { describe, it, expect } from 'vitest';
import { createStreamingCap, SCAN_CAP_BYTES, scanCapKillNote } from './_streaming-cap.js';

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

describe('createStreamingCap', () => {
  describe('under budget', () => {
    it('renders the stream verbatim and reports no truncation', () => {
      const cap = createStreamingCap(10_000);
      cap.push(buf('alpha\nbeta\ngamma\n'));

      expect(cap.render()).toBe('alpha\nbeta\ngamma\n');
      expect(cap.truncated()).toBe(false);
      expect(cap.totalBytes()).toBe(17);
      expect(cap.totalLines()).toBe(3);
    });

    it('joins many small chunks in arrival order', () => {
      const cap = createStreamingCap(10_000);
      for (const part of ['a', 'b', 'c', 'd']) cap.push(buf(part));

      expect(cap.render()).toBe('abcd');
      expect(cap.truncated()).toBe(false);
    });

    it('ignores empty chunks', () => {
      const cap = createStreamingCap(1_000);
      cap.push(buf(''));
      cap.push(buf('x'));
      cap.push(Buffer.alloc(0));

      expect(cap.render()).toBe('x');
      expect(cap.totalBytes()).toBe(1);
    });
  });

  describe('over budget', () => {
    it('bounds retained bytes while counting every byte and line', () => {
      const cap = createStreamingCap(2_000);
      // 5,000 lines × 10 bytes = 50,000 bytes, 25x the budget.
      for (let i = 0; i < 5_000; i++) cap.push(buf('123456789\n'));

      expect(cap.totalBytes()).toBe(50_000);
      expect(cap.totalLines()).toBe(5_000);
      expect(cap.truncated()).toBe(true);
      expect(Buffer.byteLength(cap.render(), 'utf8')).toBeLessThanOrEqual(2_000);
    });

    it('preserves the head and the tail, dropping only the interior', () => {
      const cap = createStreamingCap(1_000);
      cap.push(buf('HEAD_MARKER\n'));
      for (let i = 0; i < 500; i++) cap.push(buf('filler-filler-filler\n'));
      cap.push(buf('TAIL_MARKER\n'));

      const rendered = cap.render();
      expect(rendered).toContain('HEAD_MARKER');
      expect(rendered).toContain('TAIL_MARKER');
      expect(rendered).toContain('bytes truncated');
    });

    it('reports true totals in the marker so a bounded view never looks complete', () => {
      const cap = createStreamingCap(1_000);
      for (let i = 0; i < 300; i++) cap.push(buf('0123456789\n')); // 3,300 bytes, 300 lines

      const rendered = cap.render();
      expect(rendered).toContain('of 3300;');
      expect(rendered).toContain('300 matching lines total');
    });

    it('handles a single chunk far larger than the whole budget', () => {
      const cap = createStreamingCap(500);
      cap.push(buf('S' + 'x'.repeat(100_000) + 'E'));

      const rendered = cap.render();
      expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(500);
      expect(cap.totalBytes()).toBe(100_002);
      expect(cap.truncated()).toBe(true);
      expect(rendered.startsWith('S')).toBe(true);
      expect(rendered.endsWith('E')).toBe(true);
    });
  });

  describe('UTF-8 boundaries', () => {
    it('never emits replacement characters at the head/tail seams', () => {
      // 3-byte code points guarantee the head/tail cut points land
      // mid-character unless the collector trims to a boundary. The stream is
      // sliced into consecutive 149-byte chunks (coprime with 3) so no byte is
      // lost — exactly how a pipe splits a real multi-byte stream.
      const cap = createStreamingCap(1_000);
      const full = Buffer.from('界'.repeat(2_000), 'utf8'); // 6,000 valid bytes
      for (let i = 0; i < full.length; i += 149) {
        cap.push(full.subarray(i, Math.min(i + 149, full.length)));
      }

      const rendered = cap.render();
      expect(cap.totalBytes()).toBe(6_000);
      expect(cap.truncated()).toBe(true);
      expect(rendered).not.toContain('\uFFFD');
    });

    it('heals a code point split across two chunks', () => {
      // Regression guard for the prior design, which called .toString() on
      // each chunk independently and so produced mojibake whenever a pipe
      // boundary fell inside a multi-byte sequence. Buffering the bytes and
      // decoding once makes the split invisible.
      const cap = createStreamingCap(10_000);
      const glyph = Buffer.from('界', 'utf8'); // 3 bytes
      cap.push(glyph.subarray(0, 1));
      cap.push(glyph.subarray(1));

      expect(cap.render()).toBe('界');
      expect(cap.render()).not.toContain('\uFFFD');
    });

    it('keeps multi-byte content intact when it fits', () => {
      const cap = createStreamingCap(10_000);
      cap.push(Buffer.from('héllo wörld 界', 'utf8'));

      expect(cap.render()).toBe('héllo wörld 界');
      expect(cap.render()).not.toContain('\uFFFD');
    });
  });

  describe('exported policy', () => {
    it('sets a scan ceiling with real headroom over the measured worst case', () => {
      // The broadest realistic search measured 62.8MB; the ceiling must sit
      // well above it or the kill it replaced starts firing again.
      expect(SCAN_CAP_BYTES).toBe(256_000_000);
      expect(SCAN_CAP_BYTES).toBeGreaterThan(4 * 62_800_000);
    });

    it('starts the kill sentinel with the prefix both provider loops match', () => {
      const note = scanCapKillNote(SCAN_CAP_BYTES);
      expect(note).toContain('[output truncated');
      expect(note).toContain('was terminated');
      expect(scanCapKillNote(123)).toContain('123-byte');
    });
  });
});
