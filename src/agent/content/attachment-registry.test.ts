import { describe, expect, it } from 'vitest';
import { InboundAttachmentRegistry, formatInboundImageMarker } from './attachment-registry.js';

describe('InboundAttachmentRegistry', () => {
  it('stores paths, resolves records, and deduplicates identical bytes', async () => {
    const entries = new Map();
    const registry = new InboundAttachmentRegistry(entries);
    const bytes = Buffer.from('same image');
    const first = await registry.put('session-a', bytes, 'image/png');
    const second = await registry.put('session-a', bytes, 'image/png');
    expect(first.id).toMatch(/^img_[0-9a-f]{6}$/);
    expect(second).toEqual(first);
    expect(registry.get('session-a', first.id)).toEqual({
      path: first.path,
      mediaType: 'image/png',
      sizeBytes: bytes.length,
    });
  });

  it('lengthens the hash prefix when different bytes collide', async () => {
    const registry = new InboundAttachmentRegistry(new Map(), (bytes) =>
      bytes[0] === 1 ? 'abcdef11'.padEnd(64, '1') : 'abcdef22'.padEnd(64, '2'));
    const first = await registry.put('session-b', Buffer.from([1]), 'image/png');
    const second = await registry.put('session-b', Buffer.from([2]), 'image/png');
    expect(first.id).toBe('img_abcdef');
    expect(second.id).toBe('img_abcdef22');
  });

  it('formats the exact shared model-visible marker', () => {
    expect(formatInboundImageMarker('img_a1b2c3', 'image/png', 842 * 1024))
      .toBe('[image img_a1b2c3 · image/png · 842 KB]');
  });
});
