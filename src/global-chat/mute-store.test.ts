import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileMuteStore } from './mute-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'afk-mute-test-'));
  filePath = join(dir, 'mutes.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function store(): FileMuteStore {
  return new FileMuteStore({ filePath });
}

const PK1 = 'aa'.repeat(32);
const PK2 = 'bb'.repeat(32);
const PK3 = 'cc'.repeat(32);

// ---------------------------------------------------------------------------
// list() / has()
// ---------------------------------------------------------------------------

describe('FileMuteStore.list()', () => {
  it('returns empty array when file is missing', async () => {
    expect(await store().list()).toEqual([]);
  });

  it('returns empty array for empty JSON array', async () => {
    await writeFile(filePath, '[]');
    expect(await store().list()).toEqual([]);
  });

  it('returns entries for valid file', async () => {
    await writeFile(filePath, JSON.stringify([{ pubkey: PK1, name: 'alice' }]));
    const list = await store().list();
    expect(list).toHaveLength(1);
    expect(list[0]!.pubkey).toBe(PK1);
    expect(list[0]!.name).toBe('alice');
  });

  it('returns empty array for corrupt JSON without throwing', async () => {
    await writeFile(filePath, '{ not valid');
    expect(await store().list()).toEqual([]);
  });

  it('returns empty array for wrong shape (object not array)', async () => {
    await writeFile(filePath, JSON.stringify({ pubkey: PK1, name: 'alice' }));
    expect(await store().list()).toEqual([]);
  });

  it('returns empty array for array with invalid entry shapes', async () => {
    await writeFile(filePath, JSON.stringify([{ pubkey: 'short', name: 'alice' }]));
    expect(await store().list()).toEqual([]);
  });

  it('returns empty array for entry missing name', async () => {
    await writeFile(filePath, JSON.stringify([{ pubkey: PK1 }]));
    expect(await store().list()).toEqual([]);
  });

  it('never throws when file is a directory', async () => {
    await mkdir(filePath);
    expect(await store().list()).toEqual([]);
  });

  it('does not overwrite corrupt file on read', async () => {
    const corrupt = '{ not valid';
    await writeFile(filePath, corrupt);
    await store().list();
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(filePath, 'utf-8')).toBe(corrupt);
  });
});

describe('FileMuteStore.has()', () => {
  it('returns false when file is missing', async () => {
    expect(await store().has(PK1)).toBe(false);
  });

  it('returns true for a known pubkey', async () => {
    await writeFile(filePath, JSON.stringify([{ pubkey: PK1, name: 'alice' }]));
    expect(await store().has(PK1)).toBe(true);
  });

  it('returns false for an unknown pubkey', async () => {
    await writeFile(filePath, JSON.stringify([{ pubkey: PK1, name: 'alice' }]));
    expect(await store().has(PK2)).toBe(false);
  });

  it('returns false on corrupt file without throwing', async () => {
    await writeFile(filePath, '{ bad');
    expect(await store().has(PK1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// add()
// ---------------------------------------------------------------------------

describe('FileMuteStore.add()', () => {
  it('adds a new entry', async () => {
    await store().add(PK1, 'alice');
    expect(await store().has(PK1)).toBe(true);
    const list = await store().list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('alice');
  });

  it('is idempotent: duplicate add does not create two entries', async () => {
    await store().add(PK1, 'alice');
    await store().add(PK1, 'alice-renamed');
    const list = await store().list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('alice');
  });

  it('creates parent directory if missing', async () => {
    const nested = join(dir, 'sub', 'mutes.json');
    const s = new FileMuteStore({ filePath: nested });
    await s.add(PK1, 'alice');
    expect(await s.has(PK1)).toBe(true);
  });

  it('adds multiple distinct entries', async () => {
    await store().add(PK1, 'alice');
    await store().add(PK2, 'bob');
    await store().add(PK3, 'carol');
    const list = await store().list();
    expect(list).toHaveLength(3);
    expect(list.map(e => e.pubkey).sort()).toEqual([PK1, PK2, PK3].sort());
  });

  it('writes a private file (mode 0600 where the platform has mode bits)', async () => {
    await store().add(PK1, 'alice');
    const { stat } = await import('node:fs/promises');
    const info = await stat(filePath);
    // NTFS exposes no POSIX mode bits, so on Windows only the write itself can be checked.
    if (process.platform === 'win32') { expect(info.isFile()).toBe(true); } else { expect(info.mode & 0o777).toBe(0o600); }
  });

  it('writes over a corrupt file on first successful mutation', async () => {
    await writeFile(filePath, '{ bad json');
    // list() returns [] without overwriting; add() reads [] then writes the new entry
    await store().add(PK1, 'alice');
    expect(await store().has(PK1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// remove()
// ---------------------------------------------------------------------------

describe('FileMuteStore.remove()', () => {
  it('removes an existing entry', async () => {
    await store().add(PK1, 'alice');
    await store().remove(PK1);
    expect(await store().has(PK1)).toBe(false);
  });

  it('is a no-op for unknown pubkey (no write)', async () => {
    await store().add(PK1, 'alice');
    // read mtime before
    const { stat } = await import('node:fs/promises');
    const before = (await stat(filePath)).mtimeMs;
    await store().remove(PK2);
    const after = (await stat(filePath)).mtimeMs;
    expect(after).toBe(before);
    expect(await store().has(PK1)).toBe(true);
  });

  it('is a no-op when file is missing', async () => {
    await expect(store().remove(PK1)).resolves.toBeUndefined();
  });

  it('leaves remaining entries intact', async () => {
    await store().add(PK1, 'alice');
    await store().add(PK2, 'bob');
    await store().remove(PK1);
    const list = await store().list();
    expect(list).toHaveLength(1);
    expect(list[0]!.pubkey).toBe(PK2);
  });

  it('is idempotent: double remove is safe', async () => {
    await store().add(PK1, 'alice');
    await store().remove(PK1);
    await store().remove(PK1);
    expect(await store().has(PK1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Concurrency: serialized mutations
// ---------------------------------------------------------------------------

describe('FileMuteStore concurrency', () => {
  it('concurrent adds on same instance are safe', async () => {
    const s = store();
    await Promise.all([
      s.add(PK1, 'alice'),
      s.add(PK2, 'bob'),
      s.add(PK3, 'carol'),
    ]);
    const list = await s.list();
    expect(list).toHaveLength(3);
  });

  it('concurrent add+remove on same instance is safe', async () => {
    const s = store();
    await s.add(PK1, 'alice');
    await Promise.all([s.add(PK2, 'bob'), s.remove(PK1)]);
    expect(await s.has(PK1)).toBe(false);
    expect(await s.has(PK2)).toBe(true);
  });

  it('idempotent concurrent adds produce one entry', async () => {
    const s = store();
    await Promise.all([
      s.add(PK1, 'alice'),
      s.add(PK1, 'alice'),
      s.add(PK1, 'alice'),
    ]);
    const list = await s.list();
    expect(list).toHaveLength(1);
  });
});
