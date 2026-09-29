/**
 * Tests for enforceManyImageLimit (many-image guard).
 *
 * Regression: a 2210x700 PNG passed the tool-level 8000px guard but caused
 * an Anthropic HTTP 400 once the conversation accumulated >20 images.
 * enforceManyImageLimit runs just before messages.create and replaces
 * out-of-range image blocks with imageOmitted text blocks.
 */

import { describe, it, expect } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import { enforceManyImageLimit, MANY_IMAGE_THRESHOLD, MAX_DIMENSION_MANY_IMAGES } from './_many-image-guard.js';

// ---------------------------------------------------------------------------
// Helpers — synthetic image buffers (mirrors view-image.test.ts helpers)
// ---------------------------------------------------------------------------

function makePngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(29);
  buf.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; buf[25] = 2; buf[26] = 0; buf[27] = 0; buf[28] = 0;
  return buf;
}

function pngBase64(width: number, height: number): string {
  return makePngBuffer(width, height).toString('base64');
}

/** Build a user message containing N image blocks at the given dimensions. */
function makeImageMessages(count: number, width: number, height: number): MessageParam[] {
  // Each message is a user turn with a tool_result that contains one image.
  // This mirrors the real layout produced by tool-results.ts.
  const messages: MessageParam[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: `tu-${i}`,
          content: [
            {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: 'image/png' as const,
                data: pngBase64(width, height),
              },
            },
            { type: 'text' as const, text: `metadata for image ${i}` },
          ],
        },
      ],
    });
  }
  return messages;
}

/** Count image blocks in a messages array (top-level + inside tool_results). */
function countImageBlocks(messages: MessageParam[]): number {
  let n = 0;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block && typeof block === 'object' && (block as Record<string, unknown>)['type'] === 'image') {
        n++;
      }
      if (block && typeof block === 'object' && (block as Record<string, unknown>)['type'] === 'tool_result') {
        const inner = (block as Record<string, unknown>)['content'];
        if (Array.isArray(inner)) {
          for (const ib of inner) {
            if (ib && typeof ib === 'object' && (ib as Record<string, unknown>)['type'] === 'image') {
              n++;
            }
          }
        }
      }
    }
  }
  return n;
}

/** Count text blocks produced by the imageOmitted degradation. */
function countImageOmittedBlocks(messages: MessageParam[]): number {
  let n = 0;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>)['type'] === 'tool_result'
      ) {
        const inner = (block as Record<string, unknown>)['content'];
        if (Array.isArray(inner)) {
          for (const ib of inner) {
            if (
              ib &&
              typeof ib === 'object' &&
              (ib as Record<string, unknown>)['type'] === 'text'
            ) {
              const text = (ib as Record<string, unknown>)['text'];
              if (typeof text === 'string' && text.includes('imageOmitted')) {
                n++;
              }
            }
          }
        }
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enforceManyImageLimit — exported constants', () => {
  it('MANY_IMAGE_THRESHOLD is 20', () => {
    expect(MANY_IMAGE_THRESHOLD).toBe(20);
  });

  it('MAX_DIMENSION_MANY_IMAGES is 2000', () => {
    expect(MAX_DIMENSION_MANY_IMAGES).toBe(2000);
  });
});

describe('enforceManyImageLimit — no-op cases', () => {
  it('does nothing when messages is empty', () => {
    const msgs: MessageParam[] = [];
    const degraded = enforceManyImageLimit(msgs);
    expect(degraded).toBe(0);
    expect(msgs).toHaveLength(0);
  });

  it('does nothing when image count is exactly at the threshold (20)', () => {
    // 20 large images — count is not GT threshold, so no action
    const msgs = makeImageMessages(20, 3000, 3000);
    const degraded = enforceManyImageLimit(msgs);
    expect(degraded).toBe(0);
    expect(countImageBlocks(msgs)).toBe(20);
  });

  it('does nothing for >20 images that are all within 2000px', () => {
    const msgs = makeImageMessages(21, 1999, 1999);
    const degraded = enforceManyImageLimit(msgs);
    expect(degraded).toBe(0);
    expect(countImageBlocks(msgs)).toBe(21);
  });

  it('does nothing for >20 images exactly at 2000px (boundary is inclusive)', () => {
    const msgs = makeImageMessages(21, 2000, 2000);
    const degraded = enforceManyImageLimit(msgs);
    expect(degraded).toBe(0);
    expect(countImageBlocks(msgs)).toBe(21);
  });
});

describe('enforceManyImageLimit — regression: 2210x700 PNG with >20 images', () => {
  /**
   * This is the exact scenario from the bug report:
   *   - gap1.png is 2210x700 (passes the 8000px tool-level guard)
   *   - conversation already had >20 images
   *   - next API call got HTTP 400 "dimensions exceed max allowed size for many-image requests"
   *
   * After this fix, enforceManyImageLimit should degrade the 2210px image to
   * a text block before the request is sent.
   */
  it('degrades a 2210x700 image in a 21-image conversation', () => {
    // 20 small images already in the conversation
    const msgs = makeImageMessages(20, 100, 100);
    // Plus the offending 2210x700 image (passes 8000px tool guard, fails 2000px many-image limit)
    msgs.push({
      role: 'user',
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: 'tu-20',
          content: [
            {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: 'image/png' as const,
                data: pngBase64(2210, 700),
              },
            },
            { type: 'text' as const, text: '{"path":"gap1.png","bytes":111120,"width":2210,"height":700}' },
          ],
        },
      ],
    });

    expect(countImageBlocks(msgs)).toBe(21);

    const degraded = enforceManyImageLimit(msgs);

    expect(degraded).toBe(1);
    // The 2210px image should now be a text block, not an image block
    expect(countImageBlocks(msgs)).toBe(20); // only the 20 small ones remain as images
    expect(countImageOmittedBlocks(msgs)).toBe(1);

    // Verify the degradation message contains the dimensions
    const lastMsg = msgs[msgs.length - 1]!;
    const toolResult = (lastMsg.content as unknown[])[0] as Record<string, unknown>;
    const inner = toolResult['content'] as unknown[];
    const textBlock = inner[0] as Record<string, unknown>;
    expect(textBlock['type']).toBe('text');
    const parsed = JSON.parse(textBlock['text'] as string);
    expect(parsed.imageOmitted).toContain('2210');
    expect(parsed.imageOmitted).toContain('2000');
    expect(parsed.width).toBe(2210);
    expect(parsed.height).toBe(700);
  });

  it('does NOT degrade a 2210x700 image when there are only 20 total images (threshold not exceeded)', () => {
    // 19 small images + the 2210x700 one = 20 total (not GT threshold)
    const msgs = makeImageMessages(19, 100, 100);
    msgs.push({
      role: 'user',
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: 'tu-19',
          content: [
            {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: 'image/png' as const,
                data: pngBase64(2210, 700),
              },
            },
          ],
        },
      ],
    });

    expect(countImageBlocks(msgs)).toBe(20);
    const degraded = enforceManyImageLimit(msgs);
    expect(degraded).toBe(0);
    expect(countImageBlocks(msgs)).toBe(20);
  });
});

describe('enforceManyImageLimit — bulk degradation', () => {
  it('degrades ALL over-limit images when count > 20', () => {
    // 25 images at 2500x2500 — all should be degraded
    const msgs = makeImageMessages(25, 2500, 2500);
    const degraded = enforceManyImageLimit(msgs);
    expect(degraded).toBe(25);
    expect(countImageBlocks(msgs)).toBe(0);
    expect(countImageOmittedBlocks(msgs)).toBe(25);
  });

  it('degrades only the images over 2000px, leaves within-limit images alone', () => {
    // 20 small images (within limit) + 5 oversized images
    const msgs = [
      ...makeImageMessages(20, 500, 500),
      ...makeImageMessages(5, 3000, 1500),
    ];
    expect(countImageBlocks(msgs)).toBe(25);

    const degraded = enforceManyImageLimit(msgs);

    expect(degraded).toBe(5);
    // 20 small ones survive; 5 oversized ones become text
    expect(countImageBlocks(msgs)).toBe(20);
    expect(countImageOmittedBlocks(msgs)).toBe(5);
  });

  it('handles height-only violation (tall narrow image)', () => {
    // 20 small + 1 that is 100x2001 (height exceeds 2000, width is fine)
    const msgs = makeImageMessages(20, 100, 100);
    msgs.push({
      role: 'user',
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: 'tu-tall',
          content: [
            {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: 'image/png' as const,
                data: pngBase64(100, 2001),
              },
            },
          ],
        },
      ],
    });

    const degraded = enforceManyImageLimit(msgs);
    expect(degraded).toBe(1);
    const parsed = JSON.parse(
      ((((msgs[msgs.length - 1]!.content as unknown[])[0] as Record<string, unknown>)['content'] as unknown[])[0] as Record<string, unknown>)['text'] as string,
    );
    expect(parsed.height).toBe(2001);
  });
});

describe('enforceManyImageLimit — top-level image blocks (not inside tool_result)', () => {
  it('degrades top-level image blocks when count > 20', () => {
    // Build messages where image blocks are directly in the content array,
    // not nested inside a tool_result (e.g. inbound subagent attachments).
    const msgs: MessageParam[] = [];
    for (let i = 0; i < 21; i++) {
      msgs.push({
        role: 'user',
        content: [
          {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: 'image/png' as const,
              data: pngBase64(2500, 2500),
            },
          },
        ],
      });
    }

    expect(countImageBlocks(msgs)).toBe(21);
    const degraded = enforceManyImageLimit(msgs);
    expect(degraded).toBe(21);
    expect(countImageBlocks(msgs)).toBe(0);
  });
});

describe('enforceManyImageLimit — short buffer triggers null dims', () => {
  it('leaves an image alone when the buffer is too short for dimension parsing', () => {
    // A PNG buffer that's too short for the IHDR parser (<24 bytes) → dims is null → no degradation
    const shortBuf = Buffer.alloc(10, 0); // 10 bytes, too short for PNG IHDR (needs ≥24)
    const msgs: MessageParam[] = [];
    for (let i = 0; i < 21; i++) {
      msgs.push({
        role: 'user',
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: `tu-${i}`,
            content: [
              {
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: 'image/png' as const,
                  data: shortBuf.toString('base64'),
                },
              },
            ],
          },
        ],
      });
    }

    const degraded = enforceManyImageLimit(msgs);
    // Buffer too short → readImageDimensions returns null → no degradation
    expect(degraded).toBe(0);
    expect(countImageBlocks(msgs)).toBe(21);
  });
});
