/**
 * Hardening tests for enforceManyImageLimit — advisory findings from #2333.
 *
 * Tests added in #2348:
 *  1. Unknown media types (e.g. image/avif) are skipped — not degraded.
 *  2. URL image blocks count toward the 20-image threshold but are left
 *     unchanged in the replacement pass.
 *  3. 15 base64 oversized + 7 URL blocks (22 total) → guard fires, URL
 *     blocks unchanged, oversized base64 blocks replaced.
 *  4. 15 base64 oversized + 5 URL blocks (=20 total) → no-op (threshold not exceeded).
 *  5. Trace emit: many_image_degraded session_phase fired when guard degrades blocks.
 */

import { describe, it, expect } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import { enforceManyImageLimit, MANY_IMAGE_THRESHOLD, MAX_DIMENSION_MANY_IMAGES } from './_many-image-guard.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import { InMemoryTraceWriter } from '../../../trace/writer.js';

// ---------------------------------------------------------------------------
// Helpers
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

/** Build a single user message containing one base64 image block. */
function makeBase64ImageMessage(
  idx: number,
  width: number,
  height: number,
  mediaType: string = 'image/png',
): MessageParam {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result' as const,
        tool_use_id: `tu-${idx}`,
        content: [
          {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: mediaType as 'image/png',
              data: pngBase64(width, height),
            },
          },
        ],
      },
    ],
  };
}

/** Build a single user message containing one URL image block. */
function makeUrlImageMessage(idx: number): MessageParam {
  return {
    role: 'user',
    content: [
      {
        type: 'image' as const,
        source: {
          type: 'url' as const,
          url: `https://example.com/image-${idx}.png`,
        },
      },
    ],
  };
}

/** Count all image blocks (base64 or URL, top-level or inside tool_result). */
function countImageBlocks(messages: MessageParam[]): number {
  let n = 0;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b['type'] === 'image') n++;
        if (b['type'] === 'tool_result') {
          const inner = b['content'];
          if (Array.isArray(inner)) {
            for (const ib of inner) {
              if (ib && typeof ib === 'object' && (ib as Record<string, unknown>)['type'] === 'image') n++;
            }
          }
        }
      }
    }
  }
  return n;
}

/** Count URL image blocks only. */
function countUrlImageBlocks(messages: MessageParam[]): number {
  let n = 0;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>)['type'] === 'image'
      ) {
        const src = (block as Record<string, unknown>)['source'];
        if (src && typeof src === 'object' && (src as Record<string, unknown>)['type'] === 'url') {
          n++;
        }
      }
    }
  }
  return n;
}

/** Count imageOmitted text blocks produced by degradation. */
function countDegradedBlocks(messages: MessageParam[]): number {
  let n = 0;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b['type'] === 'tool_result') {
          const inner = b['content'];
          if (Array.isArray(inner)) {
            for (const ib of inner) {
              if (
                ib &&
                typeof ib === 'object' &&
                (ib as Record<string, unknown>)['type'] === 'text'
              ) {
                const text = (ib as Record<string, unknown>)['text'];
                if (typeof text === 'string' && text.includes('imageOmitted')) n++;
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

describe('enforceManyImageLimit — unknown media type (#2348 finding 3)', () => {
  it('does not degrade image/avif blocks even when count > threshold', () => {
    // 21 large images with image/avif — unrecognised type should be skipped
    const msgs: MessageParam[] = [];
    for (let i = 0; i < 21; i++) {
      msgs.push(makeBase64ImageMessage(i, 3000, 3000, 'image/avif'));
    }
    const degraded = enforceManyImageLimit(msgs);
    expect(degraded).toBe(0);
    // All blocks still present as images
    expect(countImageBlocks(msgs)).toBe(21);
  });

  it('skips only the unknown-type block but degrades known-type oversized blocks', () => {
    // 20 oversized PNG + 1 oversized avif = 21 total; only the 20 PNGs should degrade
    const msgs: MessageParam[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(makeBase64ImageMessage(i, 3000, 3000, 'image/png'));
    }
    msgs.push(makeBase64ImageMessage(20, 3000, 3000, 'image/avif'));
    expect(countImageBlocks(msgs)).toBe(21);
    const degraded = enforceManyImageLimit(msgs);
    expect(degraded).toBe(20); // avif skipped, 20 PNGs degraded
    expect(countDegradedBlocks(msgs)).toBe(20);
    expect(countImageBlocks(msgs)).toBe(1); // only avif block remains
  });
});

describe('enforceManyImageLimit — URL image blocks (#2348 finding 4)', () => {
  it('counts URL blocks toward threshold so guard fires when base64+URL > 20', () => {
    // 15 oversized base64 + 7 URL = 22 total → guard fires; 15 base64 degraded
    const msgs: MessageParam[] = [];
    for (let i = 0; i < 15; i++) {
      msgs.push(makeBase64ImageMessage(i, 3000, 3000));
    }
    for (let i = 0; i < 7; i++) {
      msgs.push(makeUrlImageMessage(i));
    }
    expect(countImageBlocks(msgs)).toBe(22);
    const degraded = enforceManyImageLimit(msgs);
    expect(degraded).toBe(15);
    expect(countDegradedBlocks(msgs)).toBe(15);
    // URL blocks stay unchanged
    expect(countUrlImageBlocks(msgs)).toBe(7);
  });

  it('URL blocks unchanged in replacement pass (source.type remains url)', () => {
    // 15 oversized base64 + 7 URL; verify the URL block structure is intact
    const msgs: MessageParam[] = [];
    for (let i = 0; i < 15; i++) {
      msgs.push(makeBase64ImageMessage(i, 3000, 3000));
    }
    for (let i = 0; i < 7; i++) {
      msgs.push(makeUrlImageMessage(i));
    }
    enforceManyImageLimit(msgs);
    const urlMsgs = msgs.slice(15);
    for (const msg of urlMsgs) {
      const block = (msg.content as unknown[])[0] as Record<string, unknown>;
      expect(block['type']).toBe('image');
      const src = block['source'] as Record<string, unknown>;
      expect(src['type']).toBe('url');
    }
  });

  it('does not fire when 15 oversized base64 + 5 URL = exactly 20 (threshold not exceeded)', () => {
    // 15 + 5 = 20 — equal to threshold, NOT greater, so guard is a no-op
    const msgs: MessageParam[] = [];
    for (let i = 0; i < 15; i++) {
      msgs.push(makeBase64ImageMessage(i, 3000, 3000));
    }
    for (let i = 0; i < 5; i++) {
      msgs.push(makeUrlImageMessage(i));
    }
    expect(countImageBlocks(msgs)).toBe(20);
    expect(countImageBlocks(msgs)).toBe(MANY_IMAGE_THRESHOLD);
    const degraded = enforceManyImageLimit(msgs);
    expect(degraded).toBe(0);
    // All base64 blocks untouched
    expect(countImageBlocks(msgs)).toBe(20);
    expect(countUrlImageBlocks(msgs)).toBe(5);
  });

  it('does not count URL blocks in the replacement pass', () => {
    // 21 URL images only — no base64 to degrade, so degraded count must be 0
    // even though threshold is exceeded
    const msgs: MessageParam[] = [];
    for (let i = 0; i < 21; i++) {
      msgs.push(makeUrlImageMessage(i));
    }
    const degraded = enforceManyImageLimit(msgs);
    expect(degraded).toBe(0);
    // All URL blocks still present
    expect(countUrlImageBlocks(msgs)).toBe(21);
  });
});

// ---------------------------------------------------------------------------
// Trace emit: many_image_degraded (#2348 finding 1)
// Tests the emit pattern used in round-request.ts via the same
// emitSessionPhase + InMemoryTraceWriter harness used by session-phase.test.ts.
// ---------------------------------------------------------------------------

describe('many_image_degraded session_phase emit', () => {
  it('emits many_image_degraded with correct metadata when guard degrades blocks', async () => {
    const writer = new InMemoryTraceWriter();
    // 21 oversized PNG blocks → guard fires
    const msgs: MessageParam[] = [];
    for (let i = 0; i < 21; i++) {
      msgs.push(makeBase64ImageMessage(i, 3000, 3000));
    }
    const degraded = enforceManyImageLimit(msgs);
    expect(degraded).toBeGreaterThan(0);

    await emitSessionPhase(writer, {
      phase: 'many_image_degraded',
      metadata: {
        degradedCount: degraded,
        threshold: MANY_IMAGE_THRESHOLD,
        maxDimension: MAX_DIMENSION_MANY_IMAGES,
      },
    });

    const events = writer.events;
    const phaseEvents = events.filter((e) => e.kind === 'session_phase');
    expect(phaseEvents).toHaveLength(1);
    const evt = phaseEvents[0]!;
    if (evt.kind !== 'session_phase') throw new Error('unreachable');
    expect(evt.payload.phase).toBe('many_image_degraded');
    expect(evt.payload.metadata?.degradedCount).toBe(degraded);
    expect(evt.payload.metadata?.threshold).toBe(MANY_IMAGE_THRESHOLD);
    expect(evt.payload.metadata?.maxDimension).toBe(MAX_DIMENSION_MANY_IMAGES);
  });

  it('does NOT emit many_image_degraded when no blocks are degraded', async () => {
    const writer = new InMemoryTraceWriter();
    // 20 oversized blocks = at threshold, guard does NOT fire
    const msgs: MessageParam[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(makeBase64ImageMessage(i, 3000, 3000));
    }
    const degraded = enforceManyImageLimit(msgs);
    expect(degraded).toBe(0);

    // Simulate the round-request.ts guard: only emit when degraded > 0
    if (degraded > 0) {
      await emitSessionPhase(writer, {
        phase: 'many_image_degraded',
        metadata: { degradedCount: degraded, threshold: MANY_IMAGE_THRESHOLD, maxDimension: MAX_DIMENSION_MANY_IMAGES },
      });
    }

    const phaseEvents = writer.events.filter((e) => e.kind === 'session_phase');
    expect(phaseEvents).toHaveLength(0);
  });
});
