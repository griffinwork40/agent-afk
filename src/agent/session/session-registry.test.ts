/**
 * Unit tests for the surface-agnostic session registry.
 *
 * Encodes the identity contract from session-registry-architecture.md:
 *   - handle.id is registry-minted + stable; sdkSessionId is late-bound.
 *   - resolve(surface, key) routes by binding; many bindings → one handle.
 *   - archive frees keys; accessors return snapshots; mutators fail loud.
 */

import { describe, it, expect } from 'vitest';
import {
  InMemorySessionRegistry,
  createSessionRegistry,
  asHandleId,
  SessionRegistryError,
  type SessionRegistry,
  type SessionHandle,
} from './session-registry.js';

/** Build a fully-formed handle for load() rehydration tests. */
function makeHandle(over: Partial<SessionHandle> & Pick<SessionHandle, 'id'>): SessionHandle {
  return {
    surface: 'telegram',
    model: 'sonnet',
    createdAt: 1,
    lastActiveAt: 1,
    status: 'active',
    bindings: [{ surface: 'telegram', key: '42', boundAt: 1, lastActiveAt: 1 }],
    ...over,
  };
}

/** A registry with a controllable clock for deterministic lastActiveAt ordering. */
function makeReg(start = 1000): { reg: SessionRegistry; tick: (by?: number) => number } {
  let t = start;
  const reg = createSessionRegistry({ now: () => t });
  return { reg, tick: (by = 1) => (t += by) };
}

describe('create / get', () => {
  it('mints a stable id, defaults to active, no sdkSessionId', () => {
    const { reg } = makeReg();
    const h = reg.create({ surface: 'telegram', model: 'sonnet', key: '42' });
    expect(h.id).toBeTruthy();
    expect(h.status).toBe('active');
    expect(h.sdkSessionId).toBeUndefined();
    expect(h.bindings).toEqual([
      { surface: 'telegram', key: '42', boundAt: 1000, lastActiveAt: 1000 },
    ]);
    expect(reg.get(h.id)?.id).toBe(h.id);
  });

  it('two distinct keys on the same chat produce two isolated handles', () => {
    const { reg } = makeReg();
    const a = reg.create({ surface: 'telegram', model: 'sonnet', key: '42' });
    const b = reg.create({ surface: 'telegram', model: 'sonnet', key: '42:7' });
    expect(a.id).not.toBe(b.id);
    expect(reg.resolve('telegram', '42')?.id).toBe(a.id);
    expect(reg.resolve('telegram', '42:7')?.id).toBe(b.id);
  });

  it('honors a rehydration id + createdAt and rejects a duplicate id', () => {
    const { reg } = makeReg();
    const id = asHandleId('fixed-id');
    const h = reg.create({ surface: 'cli', model: 'opus', key: 'resume-me', id, createdAt: 5 });
    expect(h.id).toBe(id);
    expect(h.createdAt).toBe(5);
    expect(() => reg.create({ surface: 'cli', model: 'opus', key: 'other', id })).toThrow(
      SessionRegistryError,
    );
  });

  it('carries optional name / cwd / sdkSessionId through create', () => {
    const { reg } = makeReg();
    const h = reg.create({
      surface: 'daemon',
      model: 'haiku',
      key: 'task-1',
      name: 'nightly',
      cwd: '/repo',
      sdkSessionId: 'sdk-1',
    });
    expect(h.name).toBe('nightly');
    expect(h.cwd).toBe('/repo');
    expect(reg.getBySdkSessionId('sdk-1')?.id).toBe(h.id);
  });
});

describe('resolve', () => {
  it('returns undefined for an unbound key', () => {
    const { reg } = makeReg();
    reg.create({ surface: 'telegram', model: 'sonnet', key: '42' });
    expect(reg.resolve('telegram', '999')).toBeUndefined();
    expect(reg.resolve('cli', '42')).toBeUndefined(); // surface is part of the key
  });
});

describe('bind — many bindings → one handle (cross-surface)', () => {
  it('a second binding resolves to the same handle', () => {
    const { reg } = makeReg();
    const h = reg.create({ surface: 'cli', model: 'sonnet', key: 'repl-abc' });
    reg.bind(h.id, { surface: 'telegram', key: '42:7' });
    expect(reg.resolve('cli', 'repl-abc')?.id).toBe(h.id);
    expect(reg.resolve('telegram', '42:7')?.id).toBe(h.id);
    expect(reg.get(h.id)?.bindings).toHaveLength(2);
  });

  it('re-binding an existing key refreshes rather than duplicating', () => {
    const { reg, tick } = makeReg();
    const h = reg.create({ surface: 'telegram', model: 'sonnet', key: '42' });
    tick(50);
    reg.bind(h.id, { surface: 'telegram', key: '42' });
    const got = reg.get(h.id)!;
    expect(got.bindings).toHaveLength(1);
    expect(got.bindings[0]!.lastActiveAt).toBe(1050);
    expect(got.bindings[0]!.boundAt).toBe(1000);
  });

  it('re-points a key away from a prior owner (last-writer-wins)', () => {
    const { reg } = makeReg();
    const a = reg.create({ surface: 'telegram', model: 'sonnet', key: '42' });
    const b = reg.create({ surface: 'telegram', model: 'sonnet', key: '99' });
    reg.bind(b.id, { surface: 'telegram', key: '42' }); // steal '42' from a
    expect(reg.resolve('telegram', '42')?.id).toBe(b.id);
    expect(reg.get(a.id)?.bindings).toHaveLength(0); // a lost the binding
    expect(reg.get(b.id)?.bindings).toHaveLength(2);
  });
});

describe('unbind', () => {
  it('removes the binding from its owner and stops resolving', () => {
    const { reg } = makeReg();
    const h = reg.create({ surface: 'telegram', model: 'sonnet', key: '42' });
    reg.unbind('telegram', '42');
    expect(reg.resolve('telegram', '42')).toBeUndefined();
    expect(reg.get(h.id)?.bindings).toHaveLength(0);
  });

  it('is a no-op for an unknown key', () => {
    const { reg } = makeReg();
    expect(() => reg.unbind('telegram', 'nope')).not.toThrow();
  });
});

describe('attachSdkSessionId — late binding', () => {
  it('indexes for reverse lookup and updates on re-attach', () => {
    const { reg } = makeReg();
    const h = reg.create({ surface: 'telegram', model: 'sonnet', key: '42' });
    reg.attachSdkSessionId(h.id, 'sdk-1');
    expect(reg.getBySdkSessionId('sdk-1')?.id).toBe(h.id);
    reg.attachSdkSessionId(h.id, 'sdk-2');
    expect(reg.getBySdkSessionId('sdk-1')).toBeUndefined(); // stale index dropped
    expect(reg.getBySdkSessionId('sdk-2')?.id).toBe(h.id);
    expect(reg.get(h.id)?.sdkSessionId).toBe('sdk-2');
  });
});

describe('rename', () => {
  it('sets the human label', () => {
    const { reg } = makeReg();
    const h = reg.create({ surface: 'telegram', model: 'sonnet', key: '42' });
    reg.rename(h.id, 'fix-the-thing');
    expect(reg.get(h.id)?.name).toBe('fix-the-thing');
  });
});

describe('archive', () => {
  it('frees keys (resolve misses) but retains the handle for get/list', () => {
    const { reg } = makeReg();
    const h = reg.create({ surface: 'telegram', model: 'sonnet', key: '42' });
    reg.archive(h.id);
    expect(reg.resolve('telegram', '42')).toBeUndefined();
    expect(reg.get(h.id)?.status).toBe('archived');
    expect(reg.list({ status: 'archived' }).map((x) => x.id)).toContain(h.id);
  });

  it('a new session can reclaim an archived handle key', () => {
    const { reg } = makeReg();
    const a = reg.create({ surface: 'telegram', model: 'sonnet', key: '42' });
    reg.archive(a.id);
    const b = reg.create({ surface: 'telegram', model: 'sonnet', key: '42' });
    expect(reg.resolve('telegram', '42')?.id).toBe(b.id);
    expect(b.id).not.toBe(a.id);
  });
});

describe('list', () => {
  it('filters by surface + status and sorts by lastActiveAt desc', () => {
    const { reg, tick } = makeReg();
    const a = reg.create({ surface: 'telegram', model: 'sonnet', key: '1' });
    tick(10);
    const b = reg.create({ surface: 'telegram', model: 'sonnet', key: '2' });
    tick(10);
    reg.create({ surface: 'cli', model: 'sonnet', key: 'x' });
    tick(10);
    reg.touch(a.id); // a is now the most recently active

    const tg = reg.list({ surface: 'telegram' });
    expect(tg.map((h) => h.id)).toEqual([a.id, b.id]);
    expect(reg.list({ surface: 'cli' })).toHaveLength(1);
    expect(reg.list()).toHaveLength(3);
  });
});

describe('snapshot isolation', () => {
  it('mutating a returned handle does not affect registry state', () => {
    const { reg } = makeReg();
    const h = reg.create({ surface: 'telegram', model: 'sonnet', key: '42' });
    h.bindings.push({ surface: 'cli', key: 'evil', boundAt: 0, lastActiveAt: 0 });
    h.name = 'mutated';
    expect(reg.get(h.id)?.bindings).toHaveLength(1);
    expect(reg.get(h.id)?.name).toBeUndefined();
    expect(reg.resolve('cli', 'evil')).toBeUndefined();
  });
});

describe('fail-loud mutators', () => {
  it('throw SessionRegistryError on an unknown id', () => {
    const reg = new InMemorySessionRegistry();
    const ghost = asHandleId('ghost');
    expect(() => reg.bind(ghost, { surface: 'cli', key: 'k' })).toThrow(SessionRegistryError);
    expect(() => reg.rename(ghost, 'x')).toThrow(SessionRegistryError);
    expect(() => reg.touch(ghost)).toThrow(SessionRegistryError);
    expect(() => reg.archive(ghost)).toThrow(SessionRegistryError);
    expect(() => reg.attachSdkSessionId(ghost, 's')).toThrow(SessionRegistryError);
  });
});

describe('load — rehydration from persistence', () => {
  it('indexes an active handle by every binding + id + sdk id', () => {
    const { reg } = makeReg();
    reg.load(
      makeHandle({
        id: asHandleId('h1'),
        sdkSessionId: 'sdk-1',
        bindings: [
          { surface: 'telegram', key: '42', boundAt: 1, lastActiveAt: 1 },
          { surface: 'cli', key: 'my-repl', boundAt: 1, lastActiveAt: 1 },
        ],
      }),
    );
    expect(reg.resolve('telegram', '42')?.id).toBe('h1');
    expect(reg.resolve('cli', 'my-repl')?.id).toBe('h1');
    expect(reg.get(asHandleId('h1'))?.id).toBe('h1');
    expect(reg.getBySdkSessionId('sdk-1')?.id).toBe('h1');
  });

  it('an archived handle loads without indexing its keys for routing', () => {
    const { reg } = makeReg();
    reg.load(makeHandle({ id: asHandleId('old'), status: 'archived' }));
    expect(reg.resolve('telegram', '42')).toBeUndefined();
    expect(reg.get(asHandleId('old'))?.status).toBe('archived');
    expect(reg.list({ status: 'archived' }).map((h) => h.id)).toContain('old');
  });

  it('throws on a duplicate id', () => {
    const { reg } = makeReg();
    reg.load(makeHandle({ id: asHandleId('dup') }));
    expect(() => reg.load(makeHandle({ id: asHandleId('dup') }))).toThrow(SessionRegistryError);
  });

  it('takes a private snapshot (mutating the passed handle is inert)', () => {
    const { reg } = makeReg();
    const h = makeHandle({ id: asHandleId('snap') });
    reg.load(h);
    h.bindings.push({ surface: 'cli', key: 'evil', boundAt: 0, lastActiveAt: 0 });
    expect(reg.resolve('cli', 'evil')).toBeUndefined();
    expect(reg.get(asHandleId('snap'))?.bindings).toHaveLength(1);
  });

  it('round-trips a created handle snapshot through a fresh registry', () => {
    const { reg: a } = makeReg();
    const h = a.create({ surface: 'telegram', model: 'opus', key: '42:7', name: 'x' });
    const { reg: b } = makeReg();
    b.load(h); // h is a snapshot from create()
    expect(b.resolve('telegram', '42:7')?.id).toBe(h.id);
    expect(b.get(h.id)?.name).toBe('x');
  });
});
