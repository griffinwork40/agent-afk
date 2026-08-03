/**
 * Unit tests for buildUserPayload — canonical content-block encoder.
 *
 * All six cases from the spec:
 *   1. text-only, no attachments, no manifest
 *   2. text + 1 image
 *   3. text + N images
 *   4. empty text + N images (no empty text block emitted)
 *   5. manifest + text + N images
 *   6. whitespace manifest treated as absent
 */

import { describe, it, expect } from 'vitest';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { ImageAttachment } from '../../input/attachments.js';
import { buildUserPayload } from './user-payload.js';

function fakeImage(id = 'img-1'): ImageAttachment {
  return {
    id,
    mediaType: 'image/png',
    bytes: Buffer.from('fakeimagedata'),
    sizeBytes: 13,
  };
}

describe('buildUserPayload', async () => {
  it('(1) text-only, no attachments, no manifest → [text block]', async () => {
    const result = await buildUserPayload('hello world', []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', text: 'hello world' });
  });

  it('emits the shared exact marker before a registered image', async () => {
    const img = fakeImage();
    const result = await buildUserPayload('describe this', [img], undefined, undefined, 'cli-marker-session');
    expect(result[1]).toEqual({ type: 'text', text: '[image img_a06bf7 · image/png · 1 KB]' });
    expect(result[2]).toMatchObject({ type: 'image' });
  });

  it('(2) text + 1 image → [text, image]', async () => {
    const img = fakeImage();
    const result = await buildUserPayload('describe this', [img]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'text', text: 'describe this' });
    expect(result[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    });
    // Verify base64 encoding
    const block = result[1] as { type: 'image'; source: { data: string } };
    expect(block.source.data).toBe(img.bytes.toString('base64'));
  });

  it('(3) text + N images → [text, image, image, ...]', async () => {
    const imgs = [fakeImage('a'), fakeImage('b'), fakeImage('c')];
    const result = await buildUserPayload('many images', imgs);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ type: 'text', text: 'many images' });
    expect(result[1]).toMatchObject({ type: 'image' });
    expect(result[2]).toMatchObject({ type: 'image' });
    expect(result[3]).toMatchObject({ type: 'image' });
  });

  it('(4) empty text + N images → [image, image, ...] (no empty text block)', async () => {
    const imgs = [fakeImage('a'), fakeImage('b')];
    const result = await buildUserPayload('', imgs);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: 'image' });
    expect(result[1]).toMatchObject({ type: 'image' });
    // No text block with empty string
    expect(result.every((b) => b.type !== 'text' || (b.type === 'text' && b.text !== ''))).toBe(true);
  });

  it('(5) manifest + text + N images → [manifest, text, image×N]', async () => {
    const img = fakeImage();
    const manifest = '<preflight-context>data</preflight-context>';
    const result = await buildUserPayload('my instruction', [img], manifest);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: 'text', text: manifest });
    expect(result[1]).toEqual({ type: 'text', text: 'my instruction' });
    expect(result[2]).toMatchObject({ type: 'image' });
  });

  it('(6) whitespace-only manifest is treated as absent — no manifest block prepended', async () => {
    const img = fakeImage();
    const resultSpace = await buildUserPayload('text', [img], '   ');
    const resultNewline = await buildUserPayload('text', [img], '\n\t  \n');
    const resultEmpty = await buildUserPayload('text', [img], '');

    for (const result of [resultSpace, resultNewline, resultEmpty]) {
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ type: 'text', text: 'text' });
      expect(result[1]).toMatchObject({ type: 'image' });
    }
  });

  it('empty text + no attachments + no manifest → empty array', async () => {
    const result = await buildUserPayload('', []);
    expect(result).toHaveLength(0);
  });

  it('image blocks carry correct media_type from attachment', async () => {
    const webpImg: ImageAttachment = {
      id: 'w1',
      mediaType: 'image/webp',
      bytes: Buffer.from('webpdata'),
      sizeBytes: 8,
    };
    const result = await buildUserPayload('check this', [webpImg]);
    const imgBlock = result[1] as { type: 'image'; source: { media_type: string } };
    expect(imgBlock.source.media_type).toBe('image/webp');
  });

  it('returns a fresh array on each call (no shared mutable state)', async () => {
    const img = fakeImage();
    const r1 = await buildUserPayload('hello', [img]);
    const r2 = await buildUserPayload('hello', [img]);
    expect(r1).not.toBe(r2);
    expect(r1[0]).not.toBe(r2[0]);
  });

  it('image block data is correct base64 of attachment bytes', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    const img: ImageAttachment = {
      id: 'png-magic',
      mediaType: 'image/png',
      bytes,
      sizeBytes: 4,
    };
    const result = await buildUserPayload('check png', [img]);
    const imgBlock = result[1] as { type: 'image'; source: { data: string } };
    expect(imgBlock.source.data).toBe(bytes.toString('base64'));
  });

  it('(7) text + fileBlocks → [fileBlock, text] (file content precedes the ask)', async () => {
    const fileBlock: ContentBlockParam = { type: 'text', text: '```ts\nconst x = 1;\n```' };
    const result = await buildUserPayload('summarize this', [], undefined, [fileBlock]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(fileBlock);
    expect(result[1]).toEqual({ type: 'text', text: 'summarize this' });
  });

  it('(8) manifest + fileBlocks + text + image → [manifest, fileBlock, text, image]', async () => {
    const img = fakeImage();
    const fileBlock: ContentBlockParam = { type: 'text', text: '```json\n{}\n```' };
    const manifest = '<preflight-context>data</preflight-context>';
    const result = await buildUserPayload('my question', [img], manifest, [fileBlock]);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ type: 'text', text: manifest });
    expect(result[1]).toEqual(fileBlock);
    expect(result[2]).toEqual({ type: 'text', text: 'my question' });
    expect(result[3]).toMatchObject({ type: 'image' });
  });

  it('empty fileBlocks array is a no-op (no extra blocks)', async () => {
    const result = await buildUserPayload('hi', [], undefined, []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', text: 'hi' });
  });

  it('dedups through the full buildUserPayload path — same bytes + session → same img_ marker', async () => {
    const bytes = Buffer.from('unique-dedup-bytes');
    const img: ImageAttachment = {
      id: 'dedup-1',
      mediaType: 'image/png',
      bytes,
      sizeBytes: bytes.length,
    };
    const r1 = await buildUserPayload('first', [img], undefined, undefined, 'dedup-test-session');
    const r2 = await buildUserPayload('second', [img], undefined, undefined, 'dedup-test-session');
    // The marker text block sits at index 1 (after the user text at index 0).
    const marker1 = r1[1];
    const marker2 = r2[1];
    expect(marker1).toBeDefined();
    expect(marker2).toBeDefined();
    expect(marker1).toEqual(marker2);
    // Verify the marker contains an img_ id (the same one both times).
    const text = (marker1 as { type: 'text'; text: string }).text;
    expect(text).toMatch(/^\[image img_[0-9a-f]{6,64}/);
  });
});
