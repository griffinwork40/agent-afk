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

  it('appends a _1 suffix when different byte inputs share the same 64-char digest', async () => {
    // Same full-digest collision: the prefix-lengthening loop fills entries at
    // hexLen 6, 8, 10, ..., 64 (30 puts), then the 31st finds the full-digest
    // id already occupied with different bytes → the suffix kicks in as `_1`.
    const digest = 'a1b2c3'.padEnd(64, 'f');
    const registry = new InboundAttachmentRegistry(new Map(), () => digest);
    for (let i = 0; i < 30; i++) {
      await registry.put('session-suffix', Buffer.from([i + 1]), 'image/png');
    }
    const last = await registry.put('session-suffix', Buffer.from([31]), 'image/png');
    expect(last.id).toBe(`img_${digest}_1`);
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
