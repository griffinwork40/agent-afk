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

describe('updatePresenceCwd', () => {
  it('updates the cwd field on an existing file, preserving every other field', async () => {
    const { writePresenceFile, updatePresenceCwd, readPresenceFiles } = await getPresenceMod();
    await writePresenceFile(mkInfo({ sessionId: 'cwd-update', cwd: '/launch/dir', actor: 'main' }));

    // Simulate a born-named worktree being created mid-session.
    await updatePresenceCwd('cwd-update', '/launch/dir/.afk-worktrees/afk-xyz');

    const records = await readPresenceFiles();
    expect(records).toHaveLength(1);
    expect(records[0]!.cwd).toBe('/launch/dir/.afk-worktrees/afk-xyz');
    // Read-modify-write must not drop the other fields.
    expect(records[0]!.sessionId).toBe('cwd-update');
    expect(records[0]!.actor).toBe('main');
    expect(records[0]!.pid).toBe(process.pid);
  });

  it('is a no-op when no presence file exists (does not throw, creates nothing)', async () => {
    const { updatePresenceCwd, readPresenceFiles } = await getPresenceMod();
    await expect(updatePresenceCwd('ghost-session', '/some/where')).resolves.toBeUndefined();
    expect(await readPresenceFiles()).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// Session-status contract: schema version, heartbeat, pid liveness.
//
// The bug these guard: presence cleanup runs only from
// `process.once('exit'|'SIGINT'|'SIGTERM')`, none of which fire on SIGKILL or an
// OOM kill, and nothing reaps the presence directory. A crashed session
// therefore appeared live forever to every consumer (`/watch` auto-subscribe,
// the Telegram bot, any status UI).
// ---------------------------------------------------------------------------

/**
 * A pid that is definitively not running, found WITHOUT creating a process.
 *
 * Probes downward from implausibly-high values and returns the first one the
 * kernel reports as `ESRCH` (no such process). `pid_max` differs per platform
 * (~99999 on macOS, up to 4194304 on Linux), so no single literal is portably
 * unusable — but probing finds a usable one on any platform.
 *
 * Deliberately does NOT spawn-and-reap a real process to obtain a dead pid, for
 * two reasons:
 *   1. Churning pids raises the odds of pid REUSE elsewhere in the suite. The
 *      process-group-kill test in `tools/handlers/bash.test.ts` probes a
 *      grandchild pid with `kill -0` after a 100ms reap window and fails if
 *      anything has recycled it — observed failing exactly this way in CI.
 *   2. A reaped pid can itself be recycled before the assertion runs, which
 *      would make THIS test flake in the opposite direction.
 *
 * Only `ESRCH` is accepted. `EPERM` means the process exists but belongs to
 * another user, which `isProcessAlive` correctly treats as alive.
 */
function unusedPid(): number {
  for (const candidate of [4_194_305, 4_194_304, 999_999, 99_999]) {
    try {
      process.kill(candidate, 0);
      // No throw ⇒ it exists ⇒ not usable as a dead pid. Try the next.
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return candidate;
    }
  }
  throw new Error('could not find an unused pid to test against');
}

/** Write a presence file directly, bypassing writePresenceFile's stamping. */
function writeRawPresence(sessionId: string, obj: Record<string, unknown>): void {
  const presenceDir = path.join(tmpDir, 'state', 'presence');
  fs.mkdirSync(presenceDir, { recursive: true });
  fs.writeFileSync(path.join(presenceDir, `${sessionId}.json`), JSON.stringify(obj), 'utf8');
}

describe('presence schema version', () => {
  it('writePresenceFile stamps the current schema version', async () => {
    const { writePresenceFile, readPresenceFiles, PRESENCE_SCHEMA_VERSION } = await getPresenceMod();
    await writePresenceFile(mkInfo());

    const [record] = await readPresenceFiles();
    expect(record?.schemaVersion).toBe(PRESENCE_SCHEMA_VERSION);
  });

  it('lets a caller-supplied schemaVersion win over the default', async () => {
    const { writePresenceFile, readPresenceFiles } = await getPresenceMod();
    await writePresenceFile(mkInfo({ schemaVersion: 99 }));

    const [record] = await readPresenceFiles();
    expect(record?.schemaVersion).toBe(99);
  });

  it('reads a legacy record with no schemaVersion or heartbeatAt (fails soft)', async () => {
    const { readPresenceFiles } = await getPresenceMod();
    // Exactly the shape written before versioning existed.
    writeRawPresence('legacy-1', {
      sessionId: 'legacy-1',
      surface: 'cli',
      cwd: '/tmp/x',
      startedAt: new Date().toISOString(),
      model: { provider: 'p', name: 'm' },
      workspace: NULL_WS,
      pid: process.pid,
    });

    const [record] = await readPresenceFiles();
    expect(record?.sessionId).toBe('legacy-1');
    expect(record?.schemaVersion).toBeUndefined();
    expect(record?.heartbeatAgeMs).toBeNull();
    // Still classifiable — a missing version must not cost us liveness.
    expect(record?.liveness).toBe('alive');
  });
});

describe('presence heartbeat', () => {
  it('writePresenceFile stamps an initial heartbeatAt', async () => {
    const { writePresenceFile, readPresenceFiles } = await getPresenceMod();
    await writePresenceFile(mkInfo());

    const [record] = await readPresenceFiles();
    expect(typeof record?.heartbeatAt).toBe('string');
    expect(record?.heartbeatAgeMs).not.toBeNull();
    expect(record!.heartbeatAgeMs!).toBeLessThan(60_000);
  });

  it('touchPresenceHeartbeat refreshes the timestamp, preserving every other field', async () => {
    const { writePresenceFile, touchPresenceHeartbeat, readPresenceFiles } = await getPresenceMod();
    await writePresenceFile(mkInfo({ sessionId: 'hb-1', afk: true, surface: 'telegram' }));
    const before = (await readPresenceFiles())[0]!;

    // Force a measurable gap, then backdate so the refresh is observable
    // regardless of clock granularity.
    writeRawPresence('hb-1', {
      ...before,
      path: undefined,
      liveness: undefined,
      heartbeatAgeMs: undefined,
      heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
    });
    const stale = (await readPresenceFiles())[0]!;
    expect(stale.heartbeatAgeMs!).toBeGreaterThan(60_000);

    await touchPresenceHeartbeat('hb-1');

    const after = (await readPresenceFiles())[0]!;
    expect(after.heartbeatAgeMs!).toBeLessThan(60_000);
    // Other fields survive the read-modify-write.
    expect(after.afk).toBe(true);
    expect(after.surface).toBe('telegram');
    expect(after.sessionId).toBe('hb-1');
  });

  it('touchPresenceHeartbeat is a no-op when no presence file exists', async () => {
    const { touchPresenceHeartbeat, readPresenceFiles } = await getPresenceMod();
    await expect(touchPresenceHeartbeat('nope')).resolves.toBeUndefined();
    expect(await readPresenceFiles()).toHaveLength(0);
  });
});

describe('presence liveness annotation', () => {
  it("classifies the current process as 'alive'", async () => {
    const { writePresenceFile, readPresenceFiles } = await getPresenceMod();
    await writePresenceFile(mkInfo({ pid: process.pid }));

    const [record] = await readPresenceFiles();
    expect(record?.liveness).toBe('alive');
  });

  it("classifies a nonexistent pid as 'dead'", async () => {
    const { writePresenceFile, readPresenceFiles } = await getPresenceMod();
    await writePresenceFile(mkInfo({ pid: unusedPid() }));

    const [record] = await readPresenceFiles();
    expect(record?.liveness).toBe('dead');
  });

  it("classifies an absent or nonsense pid as 'unknown', never 'dead'", async () => {
    const { readPresenceFiles } = await getPresenceMod();
    const base = {
      surface: 'cli',
      cwd: '/tmp/x',
      startedAt: new Date().toISOString(),
      model: { provider: 'p', name: 'm' },
      workspace: NULL_WS,
    };
    writeRawPresence('no-pid', { ...base, sessionId: 'no-pid' });
    writeRawPresence('bad-pid', { ...base, sessionId: 'bad-pid', pid: 'not-a-number' });
    writeRawPresence('zero-pid', { ...base, sessionId: 'zero-pid', pid: 0 });

    const records = await readPresenceFiles();
    expect(records).toHaveLength(3);
    for (const r of records) {
      expect(r.liveness).toBe('unknown');
    }
  });

  it('DOES NOT filter dead records out of readPresenceFiles', async () => {
    // Safety invariant. The worktree sweep decides whether a worktree is in use
    // from these records; a false 'dead' that removed one would let the sweep
    // delete a live session's worktree. Liveness is an annotation, not a filter.
    const { writePresenceFile, readPresenceFiles } = await getPresenceMod();
    await writePresenceFile(mkInfo({ sessionId: 'alive-1', pid: process.pid }));
    await writePresenceFile(mkInfo({ sessionId: 'dead-1', pid: unusedPid() }));

    const records = await readPresenceFiles();
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.sessionId).sort()).toEqual(['alive-1', 'dead-1']);
  });
});

describe('readLivePresenceFiles', () => {
  it("drops records proven 'dead' and keeps 'alive' ones", async () => {
    const { writePresenceFile, readLivePresenceFiles } = await getPresenceMod();
    await writePresenceFile(mkInfo({ sessionId: 'alive-1', pid: process.pid }));
    await writePresenceFile(mkInfo({ sessionId: 'dead-1', pid: unusedPid() }));

    const live = await readLivePresenceFiles();
    expect(live.map((r) => r.sessionId)).toEqual(['alive-1']);
  });

  it("RETAINS 'unknown' records — hiding a running session is the worse failure", async () => {
    const { readLivePresenceFiles } = await getPresenceMod();
    writeRawPresence('no-pid', {
      sessionId: 'no-pid',
      surface: 'cli',
      cwd: '/tmp/x',
      startedAt: new Date().toISOString(),
      model: { provider: 'p', name: 'm' },
      workspace: NULL_WS,
    });

    const live = await readLivePresenceFiles();
    expect(live.map((r) => r.sessionId)).toEqual(['no-pid']);
  });

  it('drops stale heartbeats when maxHeartbeatAgeMs is set', async () => {
    const { readLivePresenceFiles } = await getPresenceMod();
    const base = {
      surface: 'cli',
      cwd: '/tmp/x',
      startedAt: new Date().toISOString(),
      model: { provider: 'p', name: 'm' },
      workspace: NULL_WS,
      pid: process.pid,
    };
    writeRawPresence('fresh', {
      ...base, sessionId: 'fresh', heartbeatAt: new Date().toISOString(),
    });
    writeRawPresence('stale', {
      ...base, sessionId: 'stale', heartbeatAt: new Date(Date.now() - 600_000).toISOString(),
    });

    const live = await readLivePresenceFiles({ maxHeartbeatAgeMs: 60_000 });
    expect(live.map((r) => r.sessionId)).toEqual(['fresh']);
  });

  it('keeps records with no heartbeat even when maxHeartbeatAgeMs is set', async () => {
    // Absence of a heartbeat is not evidence of death — pre-heartbeat records
    // must stay visible or upgrading afk would blank the session list.
    const { readLivePresenceFiles } = await getPresenceMod();
    writeRawPresence('no-hb', {
      sessionId: 'no-hb',
      surface: 'cli',
      cwd: '/tmp/x',
      startedAt: new Date().toISOString(),
      model: { provider: 'p', name: 'm' },
      workspace: NULL_WS,
      pid: process.pid,
    });

    const live = await readLivePresenceFiles({ maxHeartbeatAgeMs: 1 });
    expect(live.map((r) => r.sessionId)).toEqual(['no-hb']);
  });
});
