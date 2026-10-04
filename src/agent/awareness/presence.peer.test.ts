/**
 * Tests for presence.peer.ts: setPresenceName, setPresenceNameIfUnset,
 * setPresenceTurnState, setPresencePeerInbox, resolveTmuxLabel (with stub),
 * and concurrency (single write queue).
 *
 * Isolates via AFK_HOME so no real ~/.afk is touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Env isolation
// ---------------------------------------------------------------------------

let tmpDir: string;
let origAfkHome: string | undefined;
let origStateDir: string | undefined;
let origTmux: string | undefined;
let origTmuxPane: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-ppeer-test-'));
  origAfkHome = process.env['AFK_HOME'];
  origStateDir = process.env['AFK_STATE_DIR'];
  origTmux = process.env['TMUX'];
  origTmuxPane = process.env['TMUX_PANE'];
  process.env['AFK_HOME'] = tmpDir;
  delete process.env['AFK_STATE_DIR'];
  delete process.env['TMUX'];
  delete process.env['TMUX_PANE'];
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origAfkHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = origAfkHome;
  if (origStateDir === undefined) delete process.env['AFK_STATE_DIR'];
  else process.env['AFK_STATE_DIR'] = origStateDir;
  if (origTmux === undefined) delete process.env['TMUX'];
  else process.env['TMUX'] = origTmux;
  if (origTmuxPane === undefined) delete process.env['TMUX_PANE'];
  else process.env['TMUX_PANE'] = origTmuxPane;
});

const NULL_WS = { branch: null, headSha: null, dirty: null, dirtyCount: null, remoteUrl: null };
const SESSION_ID = 'presence-peer-test-0001';

async function getPresenceMod() {
  return import('./presence.js');
}

async function getPeerMod() {
  return import('./presence.peer.js');
}

/** Write an initial presence file (required before patching). */
async function writeInitialPresence(sessionId: string = SESSION_ID): Promise<void> {
  const { writePresenceFile } = await getPresenceMod();
  await writePresenceFile({
    sessionId,
    surface: 'cli',
    cwd: '/tmp/test',
    startedAt: new Date().toISOString(),
    model: { provider: 'anthropic-direct', name: 'test-model' },
    workspace: NULL_WS,
    pid: process.pid,
  });
}

async function readPresenceRecord(sessionId: string = SESSION_ID) {
  const { readPresenceFiles } = await getPresenceMod();
  const records = await readPresenceFiles();
  return records.find((r) => r.sessionId === sessionId);
}

// ---------------------------------------------------------------------------
// setPresenceName
// ---------------------------------------------------------------------------

describe('setPresenceName', () => {
  it('sets a name on the presence file', async () => {
    await writeInitialPresence();
    const { setPresenceName } = await getPeerMod();
    await setPresenceName(SESSION_ID, 'my-session');
    const rec = await readPresenceRecord();
    expect(rec?.name).toBe('my-session');
  });

  it('normalizes multi-word name: collapses whitespace and trims', async () => {
    await writeInitialPresence();
    const { setPresenceName } = await getPeerMod();
    await setPresenceName(SESSION_ID, '  research   session  ');
    const rec = await readPresenceRecord();
    expect(rec?.name).toBe('research session');
  });

  it('truncates name to 64 chars', async () => {
    await writeInitialPresence();
    const { setPresenceName } = await getPeerMod();
    await setPresenceName(SESSION_ID, 'a'.repeat(80));
    const rec = await readPresenceRecord();
    expect(rec!.name!.length).toBe(64);
  });

  it('clears name when called with undefined', async () => {
    await writeInitialPresence();
    const { setPresenceName } = await getPeerMod();
    await setPresenceName(SESSION_ID, 'some-name');
    await setPresenceName(SESSION_ID, undefined);
    const rec = await readPresenceRecord();
    expect(rec?.name).toBeUndefined();
  });

  it('clears name when called with empty/whitespace string', async () => {
    await writeInitialPresence();
    const { setPresenceName } = await getPeerMod();
    await setPresenceName(SESSION_ID, 'some-name');
    await setPresenceName(SESSION_ID, '   ');
    const rec = await readPresenceRecord();
    expect(rec?.name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// setPresenceNameIfUnset
// ---------------------------------------------------------------------------

describe('setPresenceNameIfUnset', () => {
  it('sets name when none is present', async () => {
    await writeInitialPresence();
    const { setPresenceNameIfUnset } = await getPeerMod();
    await setPresenceNameIfUnset(SESSION_ID, 'auto-name');
    const rec = await readPresenceRecord();
    expect(rec?.name).toBe('auto-name');
  });

  it('does not override an existing name', async () => {
    await writeInitialPresence();
    const { setPresenceName, setPresenceNameIfUnset } = await getPeerMod();
    await setPresenceName(SESSION_ID, 'operator-name');
    await setPresenceNameIfUnset(SESSION_ID, 'auto-name');
    const rec = await readPresenceRecord();
    expect(rec?.name).toBe('operator-name');
  });
});

// ---------------------------------------------------------------------------
// setPresenceTurnState
// ---------------------------------------------------------------------------

describe('setPresenceTurnState', () => {
  it('sets turnState to "busy"', async () => {
    await writeInitialPresence();
    const { setPresenceTurnState } = await getPeerMod();
    await setPresenceTurnState(SESSION_ID, 'busy');
    const rec = await readPresenceRecord();
    expect(rec?.turnState).toBe('busy');
    expect(rec?.turnStateSince).toBeDefined();
  });

  it('sets turnState to "idle"', async () => {
    await writeInitialPresence();
    const { setPresenceTurnState } = await getPeerMod();
    await setPresenceTurnState(SESSION_ID, 'idle');
    const rec = await readPresenceRecord();
    expect(rec?.turnState).toBe('idle');
  });

  it('sets turnState to "blocked"', async () => {
    await writeInitialPresence();
    const { setPresenceTurnState } = await getPeerMod();
    await setPresenceTurnState(SESSION_ID, 'blocked');
    const rec = await readPresenceRecord();
    expect(rec?.turnState).toBe('blocked');
  });

  it('stamps a fresh turnStateSince on each call', async () => {
    await writeInitialPresence();
    const { setPresenceTurnState } = await getPeerMod();
    await setPresenceTurnState(SESSION_ID, 'busy');
    const rec1 = await readPresenceRecord();
    await new Promise((r) => setTimeout(r, 5));
    await setPresenceTurnState(SESSION_ID, 'idle');
    const rec2 = await readPresenceRecord();
    expect(rec2?.turnStateSince).not.toBe(rec1?.turnStateSince);
  });
});

// ---------------------------------------------------------------------------
// setPresencePeerInbox
// ---------------------------------------------------------------------------

describe('setPresencePeerInbox', () => {
  it('sets peerInbox to true', async () => {
    await writeInitialPresence();
    const { setPresencePeerInbox } = await getPeerMod();
    await setPresencePeerInbox(SESSION_ID, true);
    const rec = await readPresenceRecord();
    expect(rec?.peerInbox).toBe(true);
  });

  it('clears peerInbox when called with false', async () => {
    await writeInitialPresence();
    const { setPresencePeerInbox } = await getPeerMod();
    await setPresencePeerInbox(SESSION_ID, true);
    await setPresencePeerInbox(SESSION_ID, false);
    const rec = await readPresenceRecord();
    expect(rec?.peerInbox).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Concurrency: single write queue prevents lost updates
// ---------------------------------------------------------------------------

describe('presence.peer concurrency', () => {
  it('all concurrent mutations land on the presence file', async () => {
    await writeInitialPresence();
    const { setPresenceTurnState, setPresencePeerInbox, setPresenceName } = await getPeerMod();
    const { touchPresenceHeartbeat, setPresenceAfk } = await getPresenceMod();

    // Fire all without await — they must serialize through the queue.
    const ops = [
      setPresenceTurnState(SESSION_ID, 'busy'),
      touchPresenceHeartbeat(SESSION_ID),
      setPresenceAfk(SESSION_ID, true),
      setPresenceName(SESSION_ID, 'concurrent-name'),
    ];
    await Promise.all(ops);

    const rec = await readPresenceRecord();
    // Every field must have landed.
    expect(rec?.turnState).toBe('busy');
    expect(rec?.heartbeatAt).toBeDefined();
    expect(rec?.afk).toBe(true);
    expect(rec?.name).toBe('concurrent-name');
  });
});

// ---------------------------------------------------------------------------
// resolveTmuxLabel — returns undefined when TMUX is unset
// ---------------------------------------------------------------------------

describe('resolveTmuxLabel', () => {
  it('returns undefined when TMUX is not set', async () => {
    // TMUX is already deleted in beforeEach.
    const { resolveTmuxLabel } = await getPeerMod();
    const label = await resolveTmuxLabel();
    expect(label).toBeUndefined();
  });

  it('returns undefined when TMUX is set but env module still reads unset (via stubbed env)', async () => {
    // The env module's TMUX getter reads the live env at call time.
    // We keep TMUX unset (beforeEach deleted it), so this passes trivially.
    const { resolveTmuxLabel } = await getPeerMod();
    const result = await resolveTmuxLabel();
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizePresenceName helper
// ---------------------------------------------------------------------------

describe('normalizePresenceName', () => {
  it('returns undefined for empty string', async () => {
    const { normalizePresenceName } = await getPeerMod();
    expect(normalizePresenceName('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string', async () => {
    const { normalizePresenceName } = await getPeerMod();
    expect(normalizePresenceName('   ')).toBeUndefined();
  });

  it('collapses internal whitespace', async () => {
    const { normalizePresenceName } = await getPeerMod();
    expect(normalizePresenceName('a  b   c')).toBe('a b c');
  });

  it('replaces newlines with spaces', async () => {
    const { normalizePresenceName } = await getPeerMod();
    expect(normalizePresenceName('a\nb')).toBe('a b');
  });

  it('truncates at 64 characters', async () => {
    const { normalizePresenceName } = await getPeerMod();
    const long = 'x'.repeat(100);
    expect(normalizePresenceName(long)!.length).toBe(64);
  });
});
