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

  it('isolates entries by session — get and listIds on a different session return empty', async () => {
    const entries = new Map();
    const registry = new InboundAttachmentRegistry(entries);
    const first = await registry.put('session-A', Buffer.from('img-A'), 'image/png');
    expect(registry.get('session-B', first.id)).toBeUndefined();
    expect(registry.listIds('session-B')).toEqual([]);
  });

  it('appends a _1 suffix when all prefix slots and the full-length slot are occupied by different digests', async () => {
    // Contract: digest-based dedup means a suffix is only needed when every prefix
    // length (6, 8, …, 64) is already occupied by a DIFFERENT digest. We build
    // that state by pre-populating all slots with distinct digest values, then
    // verify that a new put with `base` as its digest lands at `img_${base}_1`.
    const base = 'a1b2c3'.padEnd(64, 'f');
    const entries = new Map<string, Map<string, InboundAttachmentRecord>>();
    const sessionEntries = new Map<string, InboundAttachmentRecord>();
    // Occupy every prefix slot (hexLen 6, 8, …, 64) with a distinct digest.
    for (let hexLen = 6; hexLen <= 64; hexLen += 2) {
      const prefix = base.slice(0, hexLen);
      sessionEntries.set(`img_${prefix}`, {
        path: `/fake/${prefix}.png`,
        mediaType: 'image/png',
        sizeBytes: hexLen,
        digest: `other_digest_${hexLen}_${'0'.repeat(45)}`.slice(0, 64),
      });
    }
    entries.set('session-suffix', sessionEntries);
    const registry = new InboundAttachmentRegistry(entries, () => base);
    const result = await registry.put('session-suffix', Buffer.from([99]), 'image/png');
    expect(result.id).toBe(`img_${base}_1`);
  });

  it('returns listIds in sorted order', async () => {
    const entries = new Map();
    const registry = new InboundAttachmentRegistry(entries);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const rec = await registry.put('session-sort', Buffer.from([i]), 'image/png');
      ids.push(rec.id);
    }
    const listed = registry.listIds('session-sort');
    expect(listed).toEqual([...ids].sort());
  });

  it('get() returns undefined for an unknown session and an unknown id', async () => {
    const entries = new Map();
    const registry = new InboundAttachmentRegistry(entries);
    await registry.put('session-known', Buffer.from('data'), 'image/png');
    expect(registry.get('session-unknown', 'img_a1b2c3')).toBeUndefined();
    expect(registry.get('session-known', 'img_nonexistent')).toBeUndefined();
  });

  it('clear(sessionId) evicts all entries for that session', async () => {
    const entries = new Map();
    const registry = new InboundAttachmentRegistry(entries);
    const first = await registry.put('session-clear', Buffer.from([1]), 'image/png');
    const second = await registry.put('session-clear', Buffer.from([2]), 'image/png');
    expect(registry.listIds('session-clear').length).toBeGreaterThan(0);

    registry.clear('session-clear');

    expect(registry.get('session-clear', first.id)).toBeUndefined();
    expect(registry.get('session-clear', second.id)).toBeUndefined();
    expect(registry.listIds('session-clear')).toEqual([]);
  });
});
