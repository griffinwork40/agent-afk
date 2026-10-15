/**
 * Tests for send.ts — target resolution, guards, and envelope writing.
 *
 * Isolates via AFK_STATE_DIR + AFK_HOME temp directories.
 * Uses writePresenceFileSync / patchPresenceFile to set up fake sessions
 * with pid=process.pid so they read as alive.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Env isolation
// ---------------------------------------------------------------------------

let tmpDir: string;
let origStateDir: string | undefined;
let origAfkHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-send-test-'));
  origStateDir = process.env['AFK_STATE_DIR'];
  origAfkHome = process.env['AFK_HOME'];
  process.env['AFK_STATE_DIR'] = tmpDir;
  process.env['AFK_HOME'] = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origStateDir === undefined) delete process.env['AFK_STATE_DIR'];
  else process.env['AFK_STATE_DIR'] = origStateDir;
  if (origAfkHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = origAfkHome;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NULL_WS = { branch: null, headSha: null, dirty: null, dirtyCount: null, remoteUrl: null };

async function getPresenceMod() {
  return import('../awareness/presence.js');
}

async function getPresencePeerMod() {
  return import('../awareness/presence.peer.js');
}

async function getSendMod() {
  return import('./send.js');
}

async function getInboxStore() {
  return import('./inbox-store.js');
}

/** Write a fake presence file for a session, marking it alive. */
async function fakeSession(
  sessionId: string,
  overrides: {
    name?: string;
    peerInbox?: boolean;
    turnState?: 'idle' | 'busy' | 'blocked';
    blockedSince?: string;
  } = {},
): Promise<void> {
  const { writePresenceFile } = await getPresenceMod();
  await writePresenceFile({
    sessionId,
    surface: 'cli',
    cwd: '/tmp/fake',
    startedAt: new Date().toISOString(),
    model: { provider: 'anthropic-direct', name: 'claude-3-5' },
    workspace: NULL_WS,
    pid: process.pid, // alive: same pid as test process
    ...(overrides.name !== undefined ? { name: overrides.name } : {}),
    ...(overrides.peerInbox !== undefined ? { peerInbox: overrides.peerInbox } : {}),
    ...(overrides.turnState !== undefined ? { turnState: overrides.turnState } : {}),
    ...(overrides.blockedSince !== undefined ? { blockedSince: overrides.blockedSince } : {}),
  });
}

const SELF_ID = 'self-session-0000';
const TARGET_ID = 'target-session-1111';
const FROM = { id: SELF_ID };

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

describe('sendToSession — resolution', () => {
  it('resolves by exact sessionId', async () => {
    await fakeSession(TARGET_ID, { peerInbox: true });
    const { sendToSession } = await getSendMod();
    const result = await sendToSession({ from: FROM, to: TARGET_ID, message: 'hi' });
    expect(result.status).toBe('queued');
    expect(result.resolvedTo).toBe(TARGET_ID);
  });

  it('resolves by unique >=6-char prefix', async () => {
    await fakeSession(TARGET_ID, { peerInbox: true });
    const { sendToSession } = await getSendMod();
    // Use at least 6 chars of the target id.
    const prefix = TARGET_ID.slice(0, 8);
    const result = await sendToSession({ from: FROM, to: prefix, message: 'hi' });
    expect(result.status).toBe('queued');
    expect(result.resolvedTo).toBe(TARGET_ID);
  });

  it('refuses prefix < 6 chars (not matched as prefix)', async () => {
    await fakeSession(TARGET_ID, { peerInbox: true });
    const { sendToSession } = await getSendMod();
    const result = await sendToSession({ from: FROM, to: TARGET_ID.slice(0, 4), message: 'hi' });
    // Short prefix → unknown target (no match)
    expect(result.status).toBe('refused');
    expect(result.reason).toBe('unknown-target');
  });

  it('resolves by exact session name', async () => {
    await fakeSession(TARGET_ID, { peerInbox: true, name: 'research' });
    const { sendToSession } = await getSendMod();
    const result = await sendToSession({ from: FROM, to: 'research', message: 'hi' });
    expect(result.status).toBe('queued');
    expect(result.resolvedTo).toBe(TARGET_ID);
  });

  it('refuses ambiguous name (two sessions with same name)', async () => {
    await fakeSession('target-aaa', { peerInbox: true, name: 'duplicate' });
    await fakeSession('target-bbb', { peerInbox: true, name: 'duplicate' });
    const { sendToSession } = await getSendMod();
    const result = await sendToSession({ from: FROM, to: 'duplicate', message: 'hi' });
    expect(result.status).toBe('refused');
    expect(result.reason).toBe('ambiguous-target');
  });

  it('refuses self by exact id', async () => {
    await fakeSession(SELF_ID, { peerInbox: true });
    const { sendToSession } = await getSendMod();
    const result = await sendToSession({ from: FROM, to: SELF_ID, message: 'hi' });
    expect(result.status).toBe('refused');
    expect(result.reason).toBe('self');
  });

  it('refuses unknown target', async () => {
    const { sendToSession } = await getSendMod();
    const result = await sendToSession({ from: FROM, to: 'no-such-session', message: 'hi' });
    expect(result.status).toBe('refused');
    expect(result.reason).toBe('unknown-target');
  });

  it('refuses target without peerInbox: true with no-receiver', async () => {
    await fakeSession(TARGET_ID, { peerInbox: false });
    const { sendToSession } = await getSendMod();
    const result = await sendToSession({ from: FROM, to: TARGET_ID, message: 'hi' });
    expect(result.status).toBe('refused');
    expect(result.reason).toBe('no-receiver');
  });

  it('refuses target with peerInbox absent (undefined) with no-receiver', async () => {
    await fakeSession(TARGET_ID); // no peerInbox field
    const { sendToSession } = await getSendMod();
    const result = await sendToSession({ from: FROM, to: TARGET_ID, message: 'hi' });
    expect(result.status).toBe('refused');
    expect(result.reason).toBe('no-receiver');
  });
});

// ---------------------------------------------------------------------------
// describeTargetState
// ---------------------------------------------------------------------------

describe('describeTargetState', () => {
  it('returns "blocked" when blockedSince is set', async () => {
    const { describeTargetState } = await getSendMod();
    const record = {
      sessionId: 'x',
      surface: 'cli',
      cwd: '/',
      startedAt: '',
      model: { provider: 'a', name: 'b' },
      workspace: NULL_WS,
      pid: process.pid,
      path: '/fake',
      liveness: 'alive' as const,
      heartbeatAgeMs: 0,
      blockedSince: new Date().toISOString(),
    };
    expect(describeTargetState(record)).toBe('blocked');
  });

  it('returns "busy" when turnState is busy', async () => {
    const { describeTargetState } = await getSendMod();
    const record = {
      sessionId: 'x', surface: 'cli', cwd: '/', startedAt: '',
      model: { provider: 'a', name: 'b' }, workspace: NULL_WS,
      pid: process.pid, path: '/fake', liveness: 'alive' as const,
      heartbeatAgeMs: 0, turnState: 'busy' as const,
    };
    expect(describeTargetState(record)).toBe('busy');
  });

  it('returns "idle" when turnState is idle', async () => {
    const { describeTargetState } = await getSendMod();
    const record = {
      sessionId: 'x', surface: 'cli', cwd: '/', startedAt: '',
      model: { provider: 'a', name: 'b' }, workspace: NULL_WS,
      pid: process.pid, path: '/fake', liveness: 'alive' as const,
      heartbeatAgeMs: 0, turnState: 'idle' as const,
    };
    expect(describeTargetState(record)).toBe('idle');
  });

  it('returns "unknown" when no turnState or blockedSince', async () => {
    const { describeTargetState } = await getSendMod();
    const record = {
      sessionId: 'x', surface: 'cli', cwd: '/', startedAt: '',
      model: { provider: 'a', name: 'b' }, workspace: NULL_WS,
      pid: process.pid, path: '/fake', liveness: 'alive' as const,
      heartbeatAgeMs: 0,
    };
    expect(describeTargetState(record)).toBe('unknown');
  });

  it('blocked takes priority over turnState', async () => {
    const { describeTargetState } = await getSendMod();
    const record = {
      sessionId: 'x', surface: 'cli', cwd: '/', startedAt: '',
      model: { provider: 'a', name: 'b' }, workspace: NULL_WS,
      pid: process.pid, path: '/fake', liveness: 'alive' as const,
      heartbeatAgeMs: 0,
      turnState: 'busy' as const,
      blockedSince: new Date().toISOString(),
    };
    expect(describeTargetState(record)).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
// Successful queue: envelope lands in target's pending dir
// ---------------------------------------------------------------------------

describe('sendToSession — queued result', () => {
  it('writes an envelope into target pending dir', async () => {
    await fakeSession(TARGET_ID, { peerInbox: true });
    const { sendToSession } = await getSendMod();
    const { listPending } = await getInboxStore();

    const result = await sendToSession({ from: FROM, to: TARGET_ID, message: 'hi there' });
    expect(result.status).toBe('queued');
    expect(result.messageId).toBeDefined();

    const files = await listPending(TARGET_ID);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(result.messageId);
  });

  it('hop defaults to 0', async () => {
    await fakeSession(TARGET_ID, { peerInbox: true });
    const { sendToSession } = await getSendMod();
    const { listPending, claimPending } = await getInboxStore();

    const result = await sendToSession({ from: FROM, to: TARGET_ID, message: 'hop check' });
    expect(result.status).toBe('queued');

    const files = await listPending(TARGET_ID);
    const env = await claimPending(TARGET_ID, files[0]!);
    expect(env!.hop).toBe(0);
  });

  it('passes hop through to the sent envelope', async () => {
    // sendToSession takes hop as an input parameter (default 0).
    // The caller (peer.ts handler) looks up the original envelope and passes hop+1.
    // Here we test that sendToSession writes the hop it receives.
    await fakeSession(TARGET_ID, { peerInbox: true });
    const { sendToSession } = await getSendMod();
    const { listPending, claimPending } = await getInboxStore();

    const result = await sendToSession({
      from: FROM,
      to: TARGET_ID,
      message: 'hop passthrough test',
      hop: 3, // caller pre-computed hop+1
    });

    expect(result.status).toBe('queued');
    const sentFiles = await listPending(TARGET_ID);
    const sentEnv = await claimPending(TARGET_ID, sentFiles[0]!);
    expect(sentEnv!.hop).toBe(3);
  });
});
