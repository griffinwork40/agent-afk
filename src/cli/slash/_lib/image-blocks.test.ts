/**
 * Unit tests for appendImageBlocks — shared image-tail encoder used by both
 * buildUserPayload (regular turns) and buildSkillInvocationMessage (skill
 * dispatch). The two callers were duplicating this loop; the helper is the
 * single source of truth.
 */

import { describe, it, expect } from 'vitest';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { ImageAttachment } from '../../input/attachments.js';
import { appendImageBlocks } from './image-blocks.js';

function fakeImage(
  id = 'img-1',
  mediaType: ImageAttachment['mediaType'] = 'image/png',
  body = 'fakeimagedata',
): ImageAttachment {
  return {
    id,
    mediaType,
    bytes: Buffer.from(body),
    sizeBytes: body.length,
  };
}

describe('appendImageBlocks', () => {
  it('mutates the provided array in place (no return value)', () => {
    const blocks: ContentBlockParam[] = [{ type: 'text', text: 'hi' }];
    const result = appendImageBlocks(blocks, [fakeImage()]);
    expect(result).toBeUndefined();
    expect(blocks).toHaveLength(2);
  });

  it('appends one image block when one attachment is passed', () => {
    const blocks: ContentBlockParam[] = [];
    const img = fakeImage();
    appendImageBlocks(blocks, [img]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    });
    const imgBlock = blocks[0] as { type: 'image'; source: { data: string } };
    expect(imgBlock.source.data).toBe(img.bytes.toString('base64'));
  });

  it('appends N image blocks in attachment order', () => {
    const blocks: ContentBlockParam[] = [];
    const imgs = [
      fakeImage('a', 'image/png'),
      fakeImage('b', 'image/webp'),
      fakeImage('c', 'image/jpeg'),
    ];
    appendImageBlocks(blocks, imgs);
    expect(blocks).toHaveLength(3);
    expect((blocks[0] as { source: { media_type: string } }).source.media_type).toBe('image/png');
    expect((blocks[1] as { source: { media_type: string } }).source.media_type).toBe('image/webp');
    expect((blocks[2] as { source: { media_type: string } }).source.media_type).toBe('image/jpeg');
  });

  it('is a no-op when attachments is undefined', () => {
    const blocks: ContentBlockParam[] = [{ type: 'text', text: 'hi' }];
    appendImageBlocks(blocks, undefined);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'text', text: 'hi' });
  });

  it('is a no-op when attachments is empty array', () => {
    const blocks: ContentBlockParam[] = [{ type: 'text', text: 'hi' }];
    appendImageBlocks(blocks, []);
    expect(blocks).toHaveLength(1);
  });

  it('preserves existing blocks at the head of the array', () => {
    const blocks: ContentBlockParam[] = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ];
    appendImageBlocks(blocks, [fakeImage()]);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: 'text', text: 'first' });
    expect(blocks[1]).toEqual({ type: 'text', text: 'second' });
    expect(blocks[2]).toMatchObject({ type: 'image' });
  });

  it('encodes raw PNG magic bytes as base64', () => {
    const blocks: ContentBlockParam[] = [];
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    appendImageBlocks(blocks, [
      { id: 'png-magic', mediaType: 'image/png', bytes, sizeBytes: 4 },
    ]);
    const imgBlock = blocks[0] as { type: 'image'; source: { data: string } };
    expect(imgBlock.source.data).toBe(bytes.toString('base64'));
  });
});
