/**
 * Process-level presence cleanup registry contract.
 *
 * Two defects this guards, both introduced when presence started being written
 * for every fresh session rather than only resumed ones:
 *
 *   (a) the cleanup handlers called `process.exit()` unconditionally. Every
 *       surface that owns a graceful shutdown installs its OWN signal listener
 *       at startup — before any session reaches its first `query()` — so the
 *       presence handler ran second, in the same signal-delivery tick, and
 *       exited the process while the surface's async shutdown was suspended at
 *       its first `await` (Telegraf drain / `handle.stop()` /
 *       `runCleanupFunctions()`), also changing the exit code 0 → 130/143.
 *   (b) handlers were registered per presence write, so a process hosting N
 *       top-level sessions leaked 3N listeners (12 daemon tasks ⇒ 36 listeners
 *       plus `MaxListenersExceededWarning`).
 *
 * Harness note: these tests never `process.emit` a signal — that would run the
 * test runner's own listeners too. They invoke the listener this module
 * installed (always the last one attached for that event) directly, and spy on
 * `process.exit` so a test can never take the vitest worker down with it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  registerPresenceCleanup,
  unregisterPresenceCleanup,
  _resetPresenceSignalsForTest,
  _getPresenceHeartbeatTimerForTest,
  PRESENCE_HEARTBEAT_INTERVAL_MS,
} from './presence-signals.js';
import {
  writePresenceFile,
  readPresenceFiles,
  touchPresenceHeartbeat,
  removePresenceFileSync,
} from '../../awareness/presence.js';
import { existsSync, readdirSync } from 'fs';
import { getPresenceDir } from '../../../paths.js';

let tmpHome: string;
let savedHome: string | undefined;

function record(sessionId: string): Parameters<typeof writePresenceFile>[0] {
  return {
    sessionId,
    surface: 'cli',
    actor: 'main',
    cwd: '/tmp',
    startedAt: new Date().toISOString(),
    model: { provider: 'anthropic-direct', name: 'claude-sonnet-5' },
    workspace: { branch: null, headSha: null, dirty: false, dirtyCount: 0, remoteUrl: null },
    pid: process.pid,
  };
}

/** The listener this module installed for `event` — always the most recent. */
function lastListener(event: 'exit' | 'SIGINT' | 'SIGTERM'): () => void {
  const listeners = process.listeners(event);
  const last = listeners[listeners.length - 1];
  expect(last).toBeDefined();
  return last as () => void;
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'afk-presence-signals-'));
  savedHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmpHome;
  _resetPresenceSignalsForTest();
});

afterEach(() => {
  _resetPresenceSignalsForTest();
  if (savedHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = savedHome;
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('presence cleanup registry — listener accounting', () => {
  it('installs exactly one listener per event no matter how many sessions register', () => {
    const before = {
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };

    for (const id of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 's12']) {
      registerPresenceCleanup(id);
    }

    // Defect (b): this was 12 per event before the registry existed — 36 total,
    // which tripped Node's default max-listeners warning in a daemon.
    expect(process.listenerCount('exit') - before.exit).toBe(1);
    expect(process.listenerCount('SIGINT') - before.sigint).toBe(1);
    expect(process.listenerCount('SIGTERM') - before.sigterm).toBe(1);
  });
});

describe('presence cleanup registry — file cleanup', () => {
  it('removes every tracked presence file on exit', async () => {
    await writePresenceFile(record('alpha'));
    await writePresenceFile(record('beta'));
    expect(await readPresenceFiles()).toHaveLength(2);

    registerPresenceCleanup('alpha');
    registerPresenceCleanup('beta');
    lastListener('exit')();

    expect(await readPresenceFiles()).toHaveLength(0);
  });

  it('leaves an unregistered session\'s file alone', async () => {
    await writePresenceFile(record('kept'));
    await writePresenceFile(record('dropped'));

    registerPresenceCleanup('kept');
    registerPresenceCleanup('dropped');
    // Mirrors the rewrite path: the old id is unregistered as the new id takes
    // over, and its file is removed explicitly by the caller instead.
    unregisterPresenceCleanup('dropped');
    lastListener('exit')();

    const remaining = await readPresenceFiles();
    expect(remaining.map((r) => r.sessionId)).toEqual(['dropped']);
  });
});

describe('presence cleanup registry — signal ownership', () => {
  it('does NOT exit when another listener already owned the signal', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const surfaceHandler = (): void => { /* stands in for bot.ts / daemon.ts */ };
    process.on('SIGTERM', surfaceHandler);
    try {
      registerPresenceCleanup('owned-elsewhere');
      lastListener('SIGTERM')();

      // Defect (a): exiting here truncates the surface's async shutdown, which
      // is suspended at its first await when this handler runs.
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      process.removeListener('SIGTERM', surfaceHandler);
    }
  });

  it('DOES exit when nothing else owns the signal (afk chat has no handler)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    // Node suppresses its default terminate-on-signal once ANY listener is
    // attached, so a surface with no handler of its own would hang on Ctrl+C if
    // this module returned unconditionally. Simulate that surface by clearing
    // pre-existing listeners for the duration of the install.
    const saved = process.listeners('SIGINT');
    process.removeAllListeners('SIGINT');
    try {
      registerPresenceCleanup('sole-owner');
      lastListener('SIGINT')();
      expect(exitSpy).toHaveBeenCalledWith(130);
    } finally {
      process.removeAllListeners('SIGINT');
      for (const listener of saved) process.on('SIGINT', listener as () => void);
    }
  });

  it('exits 143 on SIGTERM when it owns the signal', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const saved = process.listeners('SIGTERM');
    process.removeAllListeners('SIGTERM');
    try {
      registerPresenceCleanup('sole-owner-term');
      lastListener('SIGTERM')();
      expect(exitSpy).toHaveBeenCalledWith(143);
    } finally {
      process.removeAllListeners('SIGTERM');
      for (const listener of saved) process.on('SIGTERM', listener as () => void);
    }
  });
});

describe('presence heartbeat timer', () => {
  it('starts one unref\'d interval on registration and refreshes heartbeatAt', async () => {
    const stale = new Date(Date.now() - 3_600_000).toISOString();
    await writePresenceFile({ ...record('hb'), heartbeatAt: stale });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      registerPresenceCleanup('hb');
      registerPresenceCleanup('hb2');
      const timer = _getPresenceHeartbeatTimerForTest();
      expect(timer).not.toBeNull();
      expect((timer as NodeJS.Timeout).hasRef()).toBe(false);
      vi.advanceTimersByTime(PRESENCE_HEARTBEAT_INTERVAL_MS);
      // The heartbeat write is async I/O (tmp + rename); poll on real time until
      // it lands. setImmediate ticks were too short on Windows CI, where the
      // atomic rename is slow. Only setInterval is faked, so setTimeout is real.
      let refreshed: string | undefined;
      for (let i = 0; i < 250 && (refreshed === undefined || refreshed === stale); i++) {
        await new Promise((r) => setTimeout(r, 20));
        refreshed = (await readPresenceFiles()).find((r) => r.sessionId === 'hb')?.heartbeatAt;
      }
      expect(refreshed).toBeDefined();
      expect(Date.parse(refreshed as string)).toBeGreaterThan(Date.parse(stale));
    } finally {
      vi.useRealTimers();
    }
  });

  it('touchPresenceHeartbeat never creates a missing file and leaves no temp files', async () => {
    await writePresenceFile(record('present'));
    await touchPresenceHeartbeat('absent');
    await touchPresenceHeartbeat('present');
    expect(readdirSync(getPresenceDir()).sort()).toEqual(['present.json']);
  });

  it('drops the refresh when ownership is lost between the read and the commit', async () => {
    const stale = new Date(Date.now() - 3_600_000).toISOString();
    await writePresenceFile({ ...record('race'), heartbeatAt: stale });
    let calls = 0;
    // Owned at the pre-read check, lost by the commit guard.
    await touchPresenceHeartbeat('race', { stillOwned: () => ++calls === 1 });
    expect(calls).toBe(2);
    const after = (await readPresenceFiles()).find((r) => r.sessionId === 'race');
    expect(after?.heartbeatAt).toBe(stale);
    expect(readdirSync(getPresenceDir())).toEqual(['race.json']);
  });

  it('does not recreate a file unlinked between the read and the commit', async () => {
    await writePresenceFile(record('unlinked'));
    const file = join(getPresenceDir(), 'unlinked.json');
    let calls = 0;
    // Second ownership check runs inside the commit guard; simulate the
    // out-of-queue removePresenceFileSync landing exactly there.
    await touchPresenceHeartbeat('unlinked', {
      stillOwned: () => {
        calls += 1;
        if (calls === 2) removePresenceFileSync('unlinked');
        return true;
      },
    });
    expect(calls).toBe(2);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(getPresenceDir())).toEqual([]);
  });

  it('clears the interval when the last session unregisters, on exit, and on reset', () => {
    registerPresenceCleanup('a');
    expect(_getPresenceHeartbeatTimerForTest()).not.toBeNull();
    unregisterPresenceCleanup('a');
    expect(_getPresenceHeartbeatTimerForTest()).toBeNull();

    registerPresenceCleanup('b');
    lastListener('exit')();
    expect(_getPresenceHeartbeatTimerForTest()).toBeNull();

    registerPresenceCleanup('c');
    _resetPresenceSignalsForTest();
    expect(_getPresenceHeartbeatTimerForTest()).toBeNull();
  });
});
