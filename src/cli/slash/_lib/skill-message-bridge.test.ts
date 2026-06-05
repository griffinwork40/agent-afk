/**
 * Tests for src/cli/slash/_lib/skill-message-bridge.ts
 */

import { describe, it, expect, vi } from 'vitest';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import type { SkillMetadata } from '../../../skills/index.js';
import { buildSkillInvocationMessage } from './skill-message-bridge.js';

function getTextBlock(block: ContentBlockParam | undefined): { type: 'text'; text: string } {
  if (!block || block.type !== 'text') {
    throw new Error(`expected text block, got ${block?.type ?? 'undefined'}`);
  }
  return block;
}

describe('skill-message-bridge', () => {
  it('buildSkillInvocationMessage returns an array of length 2 with text blocks', () => {
    const skill: SkillMetadata = {
      name: 'foo',
      description: 'test skill',
      handler: vi.fn(),
    };
    const result = buildSkillInvocationMessage(skill, 'bar');

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'text', text: expect.any(String) });
    expect(result[1]).toEqual({ type: 'text', text: expect.any(String) });
  });

  it('first block contains breadcrumb with command-name tag and skill name', () => {
    const skill: SkillMetadata = {
      name: 'parallelize',
      description: 'test',
      handler: vi.fn(),
    };
    const result = buildSkillInvocationMessage(skill, 'myargs');

    const firstBlock = getTextBlock(result[0]);
    expect(firstBlock.text).toContain('<command-name>/parallelize</command-name>');
    expect(firstBlock.text).toContain('parallelize');
  });

  it('second block contains skill name, args, and dispatch instruction', () => {
    const skill: SkillMetadata = {
      name: 'foo',
      description: 'test',
      handler: vi.fn(),
    };
    const result = buildSkillInvocationMessage(skill, 'bar');

    const secondBlock = getTextBlock(result[1]);
    expect(secondBlock.text).toContain('foo');
    expect(secondBlock.text).toContain('bar');
    expect(secondBlock.text).toContain('skill');
    expect(secondBlock.text.toLowerCase()).toContain('dispatch');
  });

  it('second block handles empty args cleanly', () => {
    const skill: SkillMetadata = {
      name: 'mint',
      description: 'test',
      handler: vi.fn(),
    };
    const result = buildSkillInvocationMessage(skill, '');

    const secondBlock = getTextBlock(result[1]);
    expect(secondBlock.text).toContain('mint');
    expect(secondBlock.text).toContain('skill');
  });

  it('second block mentions fork context when skill.context is fork', () => {
    const skill: SkillMetadata = {
      name: 'parallelize',
      description: 'test',
      handler: vi.fn(),
      context: 'fork',
    };
    const result = buildSkillInvocationMessage(skill, 'args');

    const secondBlock = getTextBlock(result[1]);
    expect(secondBlock.text).toContain('fork');
  });

  it('second block does not mention fork context when skill.context is inline or absent', () => {
    const skill: SkillMetadata = {
      name: 'test-inline',
      description: 'test',
      handler: vi.fn(),
      context: 'inline',
    };
    const result = buildSkillInvocationMessage(skill, 'args');

    const secondBlock = getTextBlock(result[1]);
    expect(secondBlock.text).not.toContain('fork');
  });

  it('returns a fresh array on each call with no shared mutable state', () => {
    const skill: SkillMetadata = {
      name: 'test',
      description: 'test',
      handler: vi.fn(),
    };
    const result1 = buildSkillInvocationMessage(skill, 'args');
    const result2 = buildSkillInvocationMessage(skill, 'args');

    expect(result1).not.toBe(result2);
    expect(result1[0]).not.toBe(result2[0]);
    expect(result1[1]).not.toBe(result2[1]);
  });

  // --- Preflight manifest injection ---

  it('without a manifestBlock, returns exactly 2 blocks (breadcrumb + instruction)', () => {
    const skill: SkillMetadata = { name: 'review', description: '', handler: vi.fn() };
    const result = buildSkillInvocationMessage(skill, '277');
    expect(result).toHaveLength(2);
  });

  it('with a manifestBlock, prepends a third block before breadcrumb', () => {
    const skill: SkillMetadata = { name: 'review', description: '', handler: vi.fn() };
    const manifest = '<preflight-context skill="review">data</preflight-context>';
    const result = buildSkillInvocationMessage(skill, '277', manifest);

    expect(result).toHaveLength(3);
    expect(getTextBlock(result[0]).text).toBe(manifest);
    // Breadcrumb + instruction stay byte-for-byte at the tail — load-bearing.
    expect(getTextBlock(result[1]).text).toContain('<command-name>/review</command-name>');
    expect(getTextBlock(result[2]).text).toContain('skill');
  });

  it('treats an empty/whitespace manifestBlock as absent (no third block)', () => {
    const skill: SkillMetadata = { name: 'review', description: '', handler: vi.fn() };
    expect(buildSkillInvocationMessage(skill, '277', '')).toHaveLength(2);
    expect(buildSkillInvocationMessage(skill, '277', '   \n  ')).toHaveLength(2);
  });

  it('manifest does not alter the breadcrumb or instruction blocks', () => {
    const skill: SkillMetadata = { name: 'review', description: '', handler: vi.fn() };
    const withoutManifest = buildSkillInvocationMessage(skill, '277');
    const withManifest = buildSkillInvocationMessage(skill, '277', '<x>m</x>');

    expect(getTextBlock(withManifest[1]).text).toBe(getTextBlock(withoutManifest[0]).text);
    expect(getTextBlock(withManifest[2]).text).toBe(getTextBlock(withoutManifest[1]).text);
  });

  // --- Image attachment support ---

  it('appends image block when 1 attachment passed (no manifest) → length 3', () => {
    const skill: SkillMetadata = { name: 'review', description: '', handler: vi.fn() };
    const img = {
      id: 'img-1',
      mediaType: 'image/png' as const,
      bytes: Buffer.from('fakeimagedata'),
      sizeBytes: 13,
    };
    const result = buildSkillInvocationMessage(skill, '277', undefined, [img]);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ type: 'text' }); // breadcrumb
    expect(result[1]).toMatchObject({ type: 'text' }); // instruction
    expect(result[2]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    });
    const imgBlock = result[2] as { type: 'image'; source: { data: string } };
    expect(imgBlock.source.data).toBe(img.bytes.toString('base64'));
  });

  it('appends image block after manifest when manifest + 1 attachment → length 4', () => {
    const skill: SkillMetadata = { name: 'review', description: '', handler: vi.fn() };
    const manifest = '<preflight-context>data</preflight-context>';
    const img = {
      id: 'img-1',
      mediaType: 'image/jpeg' as const,
      bytes: Buffer.from('jpegdata'),
      sizeBytes: 8,
    };
    const result = buildSkillInvocationMessage(skill, '277', manifest, [img]);

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ type: 'text', text: manifest }); // manifest
    expect(result[1]).toMatchObject({ type: 'text' }); // breadcrumb
    expect(result[2]).toMatchObject({ type: 'text' }); // instruction
    expect(result[3]).toMatchObject({ type: 'image', source: { media_type: 'image/jpeg' } });
  });

  it('appends multiple image blocks in order when N attachments passed', () => {
    const skill: SkillMetadata = { name: 'review', description: '', handler: vi.fn() };
    const imgs = [
      { id: 'a', mediaType: 'image/png' as const, bytes: Buffer.from('a'), sizeBytes: 1 },
      { id: 'b', mediaType: 'image/webp' as const, bytes: Buffer.from('b'), sizeBytes: 1 },
    ];
    const result = buildSkillInvocationMessage(skill, '', undefined, imgs);

    expect(result).toHaveLength(4); // breadcrumb + instruction + 2 images
    expect(result[2]).toMatchObject({ type: 'image', source: { media_type: 'image/png' } });
    expect(result[3]).toMatchObject({ type: 'image', source: { media_type: 'image/webp' } });
  });

  it('preserves 2-block shape when empty attachments array passed', () => {
    const skill: SkillMetadata = { name: 'review', description: '', handler: vi.fn() };
    const result = buildSkillInvocationMessage(skill, '', undefined, []);
    expect(result).toHaveLength(2);
  });

  it('breadcrumb and instruction blocks are unchanged when attachments added', () => {
    const skill: SkillMetadata = { name: 'forge', description: '', handler: vi.fn() };
    const img = { id: 'x', mediaType: 'image/png' as const, bytes: Buffer.from('x'), sizeBytes: 1 };
    const without = buildSkillInvocationMessage(skill, 'idea');
    const withImg = buildSkillInvocationMessage(skill, 'idea', undefined, [img]);

    expect(getTextBlock(withImg[0]).text).toBe(getTextBlock(without[0]).text);
    expect(getTextBlock(withImg[1]).text).toBe(getTextBlock(without[1]).text);
  });
});
