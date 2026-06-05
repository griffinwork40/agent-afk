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

describe('buildUserPayload', () => {
  it('(1) text-only, no attachments, no manifest → [text block]', () => {
    const result = buildUserPayload('hello world', []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', text: 'hello world' });
  });

  it('(2) text + 1 image → [text, image]', () => {
    const img = fakeImage();
    const result = buildUserPayload('describe this', [img]);
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

  it('(3) text + N images → [text, image, image, ...]', () => {
    const imgs = [fakeImage('a'), fakeImage('b'), fakeImage('c')];
    const result = buildUserPayload('many images', imgs);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ type: 'text', text: 'many images' });
    expect(result[1]).toMatchObject({ type: 'image' });
    expect(result[2]).toMatchObject({ type: 'image' });
    expect(result[3]).toMatchObject({ type: 'image' });
  });

  it('(4) empty text + N images → [image, image, ...] (no empty text block)', () => {
    const imgs = [fakeImage('a'), fakeImage('b')];
    const result = buildUserPayload('', imgs);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: 'image' });
    expect(result[1]).toMatchObject({ type: 'image' });
    // No text block with empty string
    expect(result.every((b) => b.type !== 'text' || (b.type === 'text' && b.text !== ''))).toBe(true);
  });

  it('(5) manifest + text + N images → [manifest, text, image×N]', () => {
    const img = fakeImage();
    const manifest = '<preflight-context>data</preflight-context>';
    const result = buildUserPayload('my instruction', [img], manifest);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: 'text', text: manifest });
    expect(result[1]).toEqual({ type: 'text', text: 'my instruction' });
    expect(result[2]).toMatchObject({ type: 'image' });
  });

  it('(6) whitespace-only manifest is treated as absent — no manifest block prepended', () => {
    const img = fakeImage();
    const resultSpace = buildUserPayload('text', [img], '   ');
    const resultNewline = buildUserPayload('text', [img], '\n\t  \n');
    const resultEmpty = buildUserPayload('text', [img], '');

    for (const result of [resultSpace, resultNewline, resultEmpty]) {
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ type: 'text', text: 'text' });
      expect(result[1]).toMatchObject({ type: 'image' });
    }
  });

  it('empty text + no attachments + no manifest → empty array', () => {
    const result = buildUserPayload('', []);
    expect(result).toHaveLength(0);
  });

  it('image blocks carry correct media_type from attachment', () => {
    const webpImg: ImageAttachment = {
      id: 'w1',
      mediaType: 'image/webp',
      bytes: Buffer.from('webpdata'),
      sizeBytes: 8,
    };
    const result = buildUserPayload('check this', [webpImg]);
    const imgBlock = result[1] as { type: 'image'; source: { media_type: string } };
    expect(imgBlock.source.media_type).toBe('image/webp');
  });

  it('returns a fresh array on each call (no shared mutable state)', () => {
    const img = fakeImage();
    const r1 = buildUserPayload('hello', [img]);
    const r2 = buildUserPayload('hello', [img]);
    expect(r1).not.toBe(r2);
    expect(r1[0]).not.toBe(r2[0]);
  });

  it('image block data is correct base64 of attachment bytes', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    const img: ImageAttachment = {
      id: 'png-magic',
      mediaType: 'image/png',
      bytes,
      sizeBytes: 4,
    };
    const result = buildUserPayload('check png', [img]);
    const imgBlock = result[1] as { type: 'image'; source: { data: string } };
    expect(imgBlock.source.data).toBe(bytes.toString('base64'));
  });

  it('(7) text + fileBlocks → [fileBlock, text] (file content precedes the ask)', () => {
    const fileBlock: ContentBlockParam = { type: 'text', text: '```ts\nconst x = 1;\n```' };
    const result = buildUserPayload('summarize this', [], undefined, [fileBlock]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(fileBlock);
    expect(result[1]).toEqual({ type: 'text', text: 'summarize this' });
  });

  it('(8) manifest + fileBlocks + text + image → [manifest, fileBlock, text, image]', () => {
    const img = fakeImage();
    const fileBlock: ContentBlockParam = { type: 'text', text: '```json\n{}\n```' };
    const manifest = '<preflight-context>data</preflight-context>';
    const result = buildUserPayload('my question', [img], manifest, [fileBlock]);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ type: 'text', text: manifest });
    expect(result[1]).toEqual(fileBlock);
    expect(result[2]).toEqual({ type: 'text', text: 'my question' });
    expect(result[3]).toMatchObject({ type: 'image' });
  });

  it('empty fileBlocks array is a no-op (no extra blocks)', () => {
    const result = buildUserPayload('hi', [], undefined, []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', text: 'hi' });
  });
});
