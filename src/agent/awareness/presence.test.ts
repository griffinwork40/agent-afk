/**
 * Tests for presence.ts — Phase 2 session presence file lifecycle.
 *
 * Uses a temp directory via AFK_HOME env override to avoid writing to the
 * real ~/.afk/state/presence/ during tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let origAfkHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-presence-test-'));
  origAfkHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origAfkHome === undefined) {
    delete process.env['AFK_HOME'];
  } else {
    process.env['AFK_HOME'] = origAfkHome;
  }
});

// Dynamic import after env setup so paths.ts picks up the temp AFK_HOME.
async function getPresenceMod() {
  // Force module re-evaluation by bypassing cache via query param trick is not
  // available in ESM. Instead we rely on `getPresenceDir()` being called at
  // function-call time (not module-load time), which is how presence.ts works.
  const mod = await import('./presence.js');
  return mod;
}

const NULL_WS = { branch: null, headSha: null, dirty: null, dirtyCount: null, remoteUrl: null };

function mkInfo(overrides: Partial<import('./presence.js').PresenceFileInfo> = {}): import('./presence.js').PresenceFileInfo {
  return {
    sessionId: 'test-session-1234',
    surface: 'cli',
    cwd: '/tmp/test-project',
    startedAt: new Date().toISOString(),
    model: { provider: 'anthropic-direct', name: 'test-model' },
    workspace: NULL_WS,
    pid: process.pid,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('writePresenceFile + readPresenceFiles', () => {
  it('round-trips: write then read returns the record', async () => {
    const { writePresenceFile, readPresenceFiles } = await getPresenceMod();
    const info = mkInfo({ sessionId: 'round-trip-id' });
    await writePresenceFile(info);

    const records = await readPresenceFiles();
    expect(records).toHaveLength(1);
    expect(records[0]!.sessionId).toBe('round-trip-id');
    expect(records[0]!.surface).toBe('cli');
    expect(records[0]!.path).toMatch(/round-trip-id\.json$/);
  });

  it('includes multiple records when multiple files are present', async () => {
    const { writePresenceFile, readPresenceFiles } = await getPresenceMod();
    await writePresenceFile(mkInfo({ sessionId: 'session-a' }));
    await writePresenceFile(mkInfo({ sessionId: 'session-b' }));

    const records = await readPresenceFiles();
    const ids = records.map((r) => r.sessionId).sort();
    expect(ids).toEqual(['session-a', 'session-b']);
  });

  it('round-trips the actor field when present', async () => {
    const { writePresenceFile, readPresenceFiles } = await getPresenceMod();
    await writePresenceFile(mkInfo({ sessionId: 'with-actor', actor: 'main' }));

    const records = await readPresenceFiles();
    expect(records).toHaveLength(1);
    expect(records[0]!.actor).toBe('main');
  });

  it('omits actor cleanly when not set (absent on the record)', async () => {
    const { writePresenceFile, readPresenceFiles } = await getPresenceMod();
    await writePresenceFile(mkInfo({ sessionId: 'no-actor' }));

    const records = await readPresenceFiles();
    expect(records).toHaveLength(1);
    expect(records[0]!.actor).toBeUndefined();
  });
});

describe('removePresenceFile', () => {
  it('deletes the file; subsequent readPresenceFiles omits it', async () => {
    const { writePresenceFile, removePresenceFile, readPresenceFiles } = await getPresenceMod();
    await writePresenceFile(mkInfo({ sessionId: 'to-delete' }));
    expect(await readPresenceFiles()).toHaveLength(1);

    await removePresenceFile('to-delete');
    expect(await readPresenceFiles()).toHaveLength(0);
  });

  it('is a no-op on a non-existent session ID (does not throw)', async () => {
    const { removePresenceFile } = await getPresenceMod();
    await expect(removePresenceFile('does-not-exist')).resolves.toBeUndefined();
  });
});

describe('removePresenceFileSync', () => {
  it('deletes the file synchronously', async () => {
    const { writePresenceFile, removePresenceFileSync, readPresenceFiles } = await getPresenceMod();
    await writePresenceFile(mkInfo({ sessionId: 'sync-del' }));
    removePresenceFileSync('sync-del');

    const records = await readPresenceFiles();
    expect(records).toHaveLength(0);
  });

  it('is a no-op on a non-existent file (does not throw)', async () => {
    const { removePresenceFileSync } = await getPresenceMod();
    expect(() => removePresenceFileSync('ghost-session')).not.toThrow();
  });
});

describe('readPresenceFiles edge cases', () => {
  it('returns [] when the presence dir does not exist', async () => {
    const { readPresenceFiles } = await getPresenceMod();
    // tmpDir exists but no state/presence/ subdir was created yet.
    const records = await readPresenceFiles();
    expect(records).toHaveLength(0);
  });

  it('skips malformed JSON files silently', async () => {
    const { readPresenceFiles } = await getPresenceMod();
    // Create the presence dir manually and write a bad JSON file.
    const presenceDir = path.join(tmpDir, 'state', 'presence');
    fs.mkdirSync(presenceDir, { recursive: true });
    fs.writeFileSync(path.join(presenceDir, 'bad.json'), '{ invalid json }', 'utf8');

    const records = await readPresenceFiles();
    expect(records).toHaveLength(0);
  });

  it('skips files without a sessionId field', async () => {
    const { readPresenceFiles } = await getPresenceMod();
    const presenceDir = path.join(tmpDir, 'state', 'presence');
    fs.mkdirSync(presenceDir, { recursive: true });
    fs.writeFileSync(path.join(presenceDir, 'nosession.json'), JSON.stringify({ surface: 'cli' }), 'utf8');

    const records = await readPresenceFiles();
    expect(records).toHaveLength(0);
  });

  it('skips non-.json files', async () => {
    const { readPresenceFiles } = await getPresenceMod();
    const presenceDir = path.join(tmpDir, 'state', 'presence');
    fs.mkdirSync(presenceDir, { recursive: true });
    fs.writeFileSync(path.join(presenceDir, 'some-file.txt'), 'hello', 'utf8');

    const records = await readPresenceFiles();
    expect(records).toHaveLength(0);
  });
});
