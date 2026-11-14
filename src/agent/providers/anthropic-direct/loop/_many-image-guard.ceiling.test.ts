/**
 * Tests for the always-on per-image pixel ceiling (enforceImageLimits):
 * 8000px per side for ≤20 images, 2000px for >20, JPEG SOF far into the file,
 * exception containment, and per-block dimension caching.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import * as dimsModule from '../../../tools/handlers/_image-dimensions.js';
import { enforceImageLimits, MAX_DIMENSION_SINGLE_IMAGE } from './_many-image-guard.js';

afterEach(() => vi.restoreAllMocks());

function pngBase64(width: number, height: number): string {
  const buf = Buffer.alloc(29);
  buf.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString('base64');
}

/**
 * The incident shape: SOI, APP0 (len 16), an ICC APP2 segment (len 536), two
 * DQT segments (len 67), then SOF0 at byte 696, followed by filler bytes.
 */
function incidentJpegBase64(width: number, height: number): string {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  const segment = (marker: number, len: number): Buffer => {
    const b = Buffer.alloc(2 + len, 0);
    b[0] = 0xff; b[1] = marker; b.writeUInt16BE(len, 2);
    return b;
  };
  parts.push(segment(0xe0, 16), segment(0xe2, 536), segment(0xdb, 67), segment(0xdb, 67));
  const sof = segment(0xc0, 17);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof, Buffer.alloc(4096, 0x55));
  const buf = Buffer.concat(parts);
  expect(buf.indexOf(Buffer.from([0xff, 0xc0]))).toBe(696);
  return buf.toString('base64');
}

function toolResultImage(idx: number, data: string, mediaType = 'image/png'): MessageParam {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result' as const,
        tool_use_id: `tu-${idx}`,
        content: [
          { type: 'image' as const, source: { type: 'base64' as const, media_type: mediaType as 'image/png', data } },
        ],
      },
    ],
  };
}

function innerBlock(msg: MessageParam): Record<string, unknown> {
  const tr = (msg.content as unknown[])[0] as Record<string, unknown>;
  return (tr['content'] as unknown[])[0] as Record<string, unknown>;
}

describe('enforceImageLimits — ≤20 images use the 8000px ceiling', () => {
  it('replaces the incident JPEG (3456x14002, SOF at byte 696) when it is the only image', () => {
    const msgs: MessageParam[] = [
      { role: 'user', content: 'take a full-page screenshot' },
      toolResultImage(0, incidentJpegBase64(3456, 14002), 'image/jpeg'),
    ];
    const report = enforceImageLimits(msgs);
    expect(report.imageCount).toBe(1);
    expect(report.maxDimension).toBe(8000);
    expect(report.manyImage).toBe(false);
    expect(report.omitted).toEqual([{ width: 3456, height: 14002, mediaType: 'image/jpeg', messageIndex: 1 }]);
    expect(report.earliestMessageIndex).toBe(1);

    const block = innerBlock(msgs[1]!);
    expect(block['type']).toBe('text');
    const parsed = JSON.parse(block['text'] as string);
    expect(parsed.imageOmitted).toContain('3456x14002');
    expect(parsed.imageOmitted).toContain('8000');
    expect(parsed.imageOmitted).toMatch(/viewport/);
    expect(parsed.maxDimension).toBe(8000);
  });

  it('leaves 20 images within 8000px untouched', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => toolResultImage(i, pngBase64(3000, 3000)));
    const report = enforceImageLimits(msgs);
    expect(report.omitted).toHaveLength(0);
    expect(report.earliestMessageIndex).toBeNull();
    expect(innerBlock(msgs[0]!)['type']).toBe('image');
  });

  it('allows exactly 8000x8000 (inclusive) and omits 8001', () => {
    const msgs = [toolResultImage(0, pngBase64(8000, 8000)), toolResultImage(1, pngBase64(100, 8001))];
    const report = enforceImageLimits(msgs);
    expect(MAX_DIMENSION_SINGLE_IMAGE).toBe(8000);
    expect(innerBlock(msgs[0]!)['type']).toBe('image');
    expect(innerBlock(msgs[1]!)['type']).toBe('text');
    expect(report.omitted).toHaveLength(1);
    expect(report.earliestMessageIndex).toBe(1);
  });

  it('applies to top-level image blocks too', () => {
    const msgs: MessageParam[] = [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64(9000, 10) } }] },
    ];
    expect(enforceImageLimits(msgs).omitted).toHaveLength(1);
    expect(((msgs[0]!.content as unknown[])[0] as Record<string, unknown>)['type']).toBe('text');
  });
});

describe('enforceImageLimits — >20 images keep the 2000px ceiling', () => {
  it('omits 2001px images and reports the 2000 ceiling', () => {
    const msgs = [
      ...Array.from({ length: 20 }, (_, i) => toolResultImage(i, pngBase64(2000, 2000))),
      toolResultImage(20, pngBase64(2001, 10)),
    ];
    const report = enforceImageLimits(msgs);
    expect(report.manyImage).toBe(true);
    expect(report.maxDimension).toBe(2000);
    expect(report.omitted).toHaveLength(1);
    expect(report.earliestMessageIndex).toBe(20);
    expect(JSON.parse(innerBlock(msgs[20]!)['text'] as string).imageOmitted).toContain('2000');
  });
});

describe('enforceImageLimits — robustness', () => {
  it('contains a parser exception: the image is left alone and the scan continues', () => {
    const real = dimsModule.readImageDimensions;
    let calls = 0;
    vi.spyOn(dimsModule, 'readImageDimensions').mockImplementation((buf, fmt) => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return real(buf, fmt);
    });
    const msgs = [toolResultImage(0, pngBase64(9000, 9000)), toolResultImage(1, pngBase64(9000, 9000))];
    const report = enforceImageLimits(msgs);
    expect(innerBlock(msgs[0]!)['type']).toBe('image');
    expect(innerBlock(msgs[1]!)['type']).toBe('text');
    expect(report.omitted).toHaveLength(1);
  });

  it('measures each image block at most once across repeated calls', () => {
    const spy = vi.spyOn(dimsModule, 'readImageDimensions');
    const msgs = [
      toolResultImage(0, pngBase64(100, 100)),
      toolResultImage(1, incidentJpegBase64(800, 600), 'image/jpeg'),
    ];
    enforceImageLimits(msgs);
    const first = spy.mock.calls.length;
    expect(first).toBe(2);
    enforceImageLimits(msgs);
    enforceImageLimits(msgs);
    expect(spy.mock.calls.length).toBe(first);
  });

  it('leaves undeterminable, URL-source and unknown-type images alone', () => {
    const msgs: MessageParam[] = [
      toolResultImage(0, Buffer.alloc(10).toString('base64')),
      toolResultImage(1, pngBase64(9000, 9000), 'image/avif'),
      { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }] },
    ];
    const report = enforceImageLimits(msgs);
    expect(report.omitted).toHaveLength(0);
    expect(report.imageCount).toBe(3);
  });
});
