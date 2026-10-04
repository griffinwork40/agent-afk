/**
 * registerPresenceLifecycle stamps the pid start identity readers use to
 * detect pid reuse: `pidStartedAt` always, and `pidStartTicks` exactly when
 * this host can report it (Linux). Real presence write under a temp AFK_HOME.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerPresenceLifecycle } from './presence-lifecycle.js';
import { _resetPresenceSignalsForTest } from './presence-signals.js';
import { readPresenceFiles } from '../../awareness/presence.js';
import type { RuntimeStateSource } from '../../awareness/index.js';
import { ownProcessStartedAt, ownProcessStartTicks } from '../../process-liveness.start-time.js';

let tmpHome: string;
let savedHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'afk-presence-stamp-'));
  savedHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmpHome;
  _resetPresenceSignalsForTest();
});
afterEach(() => {
  _resetPresenceSignalsForTest();
  if (savedHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = savedHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

const runtimeStateSource = {
  getWorkspace: () => ({ branch: null, headSha: null, dirty: null, dirtyCount: null, remoteUrl: null }),
} as unknown as RuntimeStateSource;

describe('registerPresenceLifecycle start-identity stamp', () => {
  it('writes pidStartedAt and (where available) pidStartTicks for this process', async () => {
    const id = registerPresenceLifecycle({
      depth: 0,
      parentSessionId: undefined,
      sessionId: 'stamp-1',
      currentPresenceSessionId: null,
      runtimeStateSource,
      surface: 'cli',
      cwd: tmpHome,
      providerName: 'p',
      model: 'm',
    });
    expect(id).toBe('stamp-1');
    const [rec] = await readPresenceFiles();
    expect(rec?.pid).toBe(process.pid);
    expect(rec?.pidStartedAt).toBe(ownProcessStartedAt());
    // undefined off Linux (JSON drops it), the real tick count on Linux.
    expect(rec?.pidStartTicks).toBe(ownProcessStartTicks());
  });
});
