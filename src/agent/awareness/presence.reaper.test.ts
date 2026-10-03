/**
 * Tests for the dead-presence reaper: deletes ONLY when kill reports ESRCH.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { sweepDeadPresence } from './presence.reaper.js';
import { writePresenceFile, readPresenceFiles, type PresenceFileInfo } from './presence.js';

let tmpDir: string;
let orig: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-presence-reaper-'));
  orig = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmpDir;
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (orig === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = orig;
});

function info(sessionId: string, pid: number): PresenceFileInfo {
  return {
    sessionId,
    surface: 'cli',
    cwd: '/tmp',
    startedAt: new Date().toISOString(),
    model: { provider: 'p', name: 'm' },
    workspace: { branch: null, headSha: null, dirty: null, dirtyCount: null, remoteUrl: null },
    pid,
  };
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('sweepDeadPresence', () => {
  it('removes only ESRCH records; keeps alive, EPERM, unknown-error, self and own-pid records', async () => {
    await writePresenceFile(info('gone', 900001));
    await writePresenceFile(info('alive', 900002));
    await writePresenceFile(info('eperm', 900003));
    await writePresenceFile(info('weird', 900004));
    await writePresenceFile(info('self', 900005));
    await writePresenceFile(info('own-pid', process.pid));
    const kill = (pid: number): void => {
      if (pid === 900001 || pid === 900005 || pid === process.pid) throw errno('ESRCH');
      if (pid === 900003) throw errno('EPERM');
      if (pid === 900004) throw errno('EINVAL');
    };
    const removed = await sweepDeadPresence({ selfIds: new Set(['self']), kill });
    expect(removed).toBe(1);
    const left = (await readPresenceFiles()).map((r) => r.sessionId).sort();
    expect(left).toEqual(['alive', 'eperm', 'own-pid', 'self', 'weird']);
  });

  it('keeps records with an unusable pid', async () => {
    const { getPresenceDir } = await import('../../paths.js');
    fs.mkdirSync(getPresenceDir(), { recursive: true });
    fs.writeFileSync(path.join(getPresenceDir(), 'nopid.json'), JSON.stringify({ sessionId: 'nopid' }));
    const removed = await sweepDeadPresence({ kill: () => { throw errno('ESRCH'); } });
    expect(removed).toBe(0);
    expect((await readPresenceFiles()).map((r) => r.sessionId)).toEqual(['nopid']);
  });

  it('never throws when removal fails', async () => {
    await writePresenceFile(info('gone', 900001));
    const removed = await sweepDeadPresence({
      kill: () => { throw errno('ESRCH'); },
      remove: async () => { throw errno('EACCES'); },
    });
    expect(removed).toBe(0);
  });

  it('does not delete a record rewritten by a resumed session between the scan and the unlink', async () => {
    const { getPresenceDir } = await import('../../paths.js');
    await writePresenceFile(info('resumed', 900001));
    const file = path.join(getPresenceDir(), 'resumed.json');
    let rewritten = false;
    const kill = (pid: number): void => {
      // First ESRCH probe: a new process resumes the same session id and
      // rewrites the file with its own live pid before the reaper unlinks.
      if (pid === 900001 && !rewritten) {
        rewritten = true;
        fs.writeFileSync(file, JSON.stringify({ ...info('resumed', process.pid) }));
      }
      if (pid === 900001) throw errno('ESRCH');
    };
    expect(await sweepDeadPresence({ kill })).toBe(0);
    const left = await readPresenceFiles();
    expect(left.map((r) => [r.sessionId, r.pid])).toEqual([['resumed', process.pid]]);
  });

  it('skips the unlink when the file vanished or became unreadable before revalidation', async () => {
    await writePresenceFile(info('gone', 900001));
    const remove = async (): Promise<void> => { throw new Error('must not be called'); };
    const removed = await sweepDeadPresence({
      kill: () => { throw errno('ESRCH'); },
      read: async () => { throw errno('ENOENT'); },
      remove,
    });
    expect(removed).toBe(0);
  });

  it('really removes a dead pid with the default kill', async () => {
    // Find a pid that does not exist on this host.
    let pid = 4_000_000;
    for (;;) {
      try { process.kill(pid, 0); pid += 1; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') break; pid += 1; }
    }
    await writePresenceFile(info('real-dead', pid));
    expect(await sweepDeadPresence()).toBe(1);
    expect(await readPresenceFiles()).toHaveLength(0);
  });
});
