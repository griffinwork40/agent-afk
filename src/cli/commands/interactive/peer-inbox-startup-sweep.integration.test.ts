/**
 * Integration: a live session that the DISPLAY filter hides (here, a legacy
 * record with a >6h heartbeat, hidden deterministically on every platform)
 * must still protect its peer inbox from the startup sweep. Real presence
 * files, real inbox dirs, real sweep; only AFK_HOME is redirected.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { schedulePeerInboxSweep } from './peer-inbox-startup-sweep.js';
import { writePresenceFile, readLivePresenceFiles, type PresenceFileInfo } from '../../../agent/awareness/presence.js';
import { LEGACY_STALE_HEARTBEAT_MS } from '../../../agent/awareness/presence.liveness.js';
import { getPeerInboxDir } from '../../../paths.js';

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-inbox-sweep-int-'));
  for (const k of ['AFK_HOME', 'AFK_STATE_DIR']) saved[k] = process.env[k];
  process.env['AFK_HOME'] = tmp;
  delete process.env['AFK_STATE_DIR'];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function presence(sessionId: string, pid: number, heartbeatAt: string): PresenceFileInfo {
  return {
    sessionId,
    surface: 'cli',
    cwd: tmp,
    startedAt: heartbeatAt,
    model: { provider: 'p', name: 'm' },
    workspace: { branch: null, headSha: null, dirty: null, dirtyCount: null, remoteUrl: null },
    pid,
    heartbeatAt,
  };
}

/** Create an inbox with one pending message, every mtime 8 days in the past. */
function oldInbox(sessionId: string): string {
  const base = getPeerInboxDir(sessionId);
  const pending = path.join(base, 'pending');
  fs.mkdirSync(pending, { recursive: true });
  const msg = path.join(pending, 'm.json');
  fs.writeFileSync(msg, '{}');
  const past = new Date(Date.now() - 8 * 24 * 60 * 60_000);
  for (const p of [msg, pending, base]) fs.utimesSync(p, past, past);
  return base;
}

function deadPid(): number {
  for (let pid = 4_000_000; ; pid += 1) {
    try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return pid; }
  }
}

describe('peer-inbox startup sweep protection', () => {
  it('keeps the inbox of a live session hidden by the display filter; removes a dead one', async () => {
    const staleHb = new Date(Date.now() - LEGACY_STALE_HEARTBEAT_MS - 60_000).toISOString();
    await writePresenceFile(presence('hidden-live', process.pid, staleHb));
    await writePresenceFile(presence('dead', deadPid(), new Date().toISOString()));
    // Premise: the display filter hides the live legacy record.
    expect((await readLivePresenceFiles()).map((r) => r.sessionId)).not.toContain('hidden-live');

    const keep = oldInbox('hidden-live');
    const drop = oldInbox('dead');
    schedulePeerInboxSweep(0);
    for (let i = 0; i < 200 && fs.existsSync(drop); i++) await new Promise((r) => setTimeout(r, 10));

    expect(fs.existsSync(drop)).toBe(false);
    expect(fs.existsSync(keep)).toBe(true);
  });
});
