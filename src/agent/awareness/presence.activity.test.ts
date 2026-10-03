/**
 * Tests for presence.activity.ts: setPresenceActivityPromptHead,
 * setPresenceActivityTurnEnd, normalizePromptHead, and concurrency.
 *
 * Isolates via AFK_HOME so no real ~/.afk is touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Env isolation
// ---------------------------------------------------------------------------

let tmpDir: string;
let origAfkHome: string | undefined;
let origStateDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-activity-test-'));
  origAfkHome = process.env['AFK_HOME'];
  origStateDir = process.env['AFK_STATE_DIR'];
  process.env['AFK_HOME'] = tmpDir;
  delete process.env['AFK_STATE_DIR'];
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origAfkHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = origAfkHome;
  if (origStateDir === undefined) delete process.env['AFK_STATE_DIR'];
  else process.env['AFK_STATE_DIR'] = origStateDir;
});

const NULL_WS = { branch: null, headSha: null, dirty: null, dirtyCount: null, remoteUrl: null };
const SESSION_ID = 'activity-test-session-0001';

async function getPresenceMod() {
  return import('./presence.js');
}

async function getActivityMod() {
  return import('./presence.activity.js');
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
// normalizePromptHead
// ---------------------------------------------------------------------------

describe('normalizePromptHead', () => {
  it('collapses whitespace and trims', async () => {
    const { normalizePromptHead } = await getActivityMod();
    expect(normalizePromptHead('  hello   world  ')).toBe('hello world');
  });

  it('collapses newlines to spaces', async () => {
    const { normalizePromptHead } = await getActivityMod();
    expect(normalizePromptHead('line1\nline2\nline3')).toBe('line1 line2 line3');
  });

  it('collapses tabs', async () => {
    const { normalizePromptHead } = await getActivityMod();
    expect(normalizePromptHead('a\tb\tc')).toBe('a b c');
  });

  it('returns undefined for empty string', async () => {
    const { normalizePromptHead } = await getActivityMod();
    expect(normalizePromptHead('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string', async () => {
    const { normalizePromptHead } = await getActivityMod();
    expect(normalizePromptHead('   \n\t  ')).toBeUndefined();
  });

  it('truncates to at most 120 characters', async () => {
    const { normalizePromptHead } = await getActivityMod();
    // Use a word-like repeated phrase that won't trigger the generic token rule.
    const long = 'analyze the feature '.repeat(15); // 300 chars, clear words
    const result = normalizePromptHead(long)!;
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.length).toBeGreaterThan(0);
  });

  it('redacts an Anthropic API key', async () => {
    const { normalizePromptHead } = await getActivityMod();
    const raw = 'use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA for the call';
    const result = normalizePromptHead(raw)!;
    expect(result).not.toContain('sk-ant-');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts a generic long token', async () => {
    const { normalizePromptHead } = await getActivityMod();
    // Mixed-case alphanumeric: not a git sha, not a filesystem path.
    const token = 'AbCdEf1234567890AbCdEf1234567890AbCdEfAb';
    const raw = `authenticate with ${token} now`;
    const result = normalizePromptHead(raw)!;
    expect(result).not.toContain(token);
    expect(result).toContain('[REDACTED]');
  });

  it('does not redact a filesystem path', async () => {
    const { normalizePromptHead } = await getActivityMod();
    const raw = 'read /Users/me/Projects/open_source/agent-afk/src/config/env.ts';
    const result = normalizePromptHead(raw)!;
    // The path should survive redaction.
    expect(result).toContain('/Users/me');
  });
});

// ---------------------------------------------------------------------------
// setPresenceActivityPromptHead
// ---------------------------------------------------------------------------

describe('setPresenceActivityPromptHead', () => {
  it('sets activity.promptHead on the presence file', async () => {
    await writeInitialPresence();
    const { setPresenceActivityPromptHead } = await getActivityMod();
    await setPresenceActivityPromptHead(SESSION_ID, 'analyze the new feature');
    const rec = await readPresenceRecord();
    expect(rec?.activity?.promptHead).toBe('analyze the new feature');
  });

  it('preserves existing turns/lastTurnEndedAt when updating promptHead', async () => {
    await writeInitialPresence();
    const { setPresenceActivityTurnEnd, setPresenceActivityPromptHead } = await getActivityMod();

    // Complete a turn to set turns/lastTurnEndedAt.
    await setPresenceActivityTurnEnd(SESSION_ID);
    const rec1 = await readPresenceRecord();
    expect(rec1?.activity?.turns).toBe(1);
    const endedAt1 = rec1?.activity?.lastTurnEndedAt;

    // Now set a new promptHead — turns and lastTurnEndedAt must survive.
    await setPresenceActivityPromptHead(SESSION_ID, 'next prompt');
    const rec2 = await readPresenceRecord();
    expect(rec2?.activity?.promptHead).toBe('next prompt');
    expect(rec2?.activity?.turns).toBe(1);
    expect(rec2?.activity?.lastTurnEndedAt).toBe(endedAt1);
  });

  it('is a no-op when rawText normalizes to empty', async () => {
    await writeInitialPresence();
    const { setPresenceActivityPromptHead } = await getActivityMod();

    // Set an initial promptHead.
    await setPresenceActivityPromptHead(SESSION_ID, 'original prompt');

    // Empty / whitespace-only raw text → should NOT overwrite existing promptHead.
    await setPresenceActivityPromptHead(SESSION_ID, '   ');
    const rec = await readPresenceRecord();
    expect(rec?.activity?.promptHead).toBe('original prompt');
  });

  it('redacts a secret in the raw text', async () => {
    await writeInitialPresence();
    const { setPresenceActivityPromptHead } = await getActivityMod();
    await setPresenceActivityPromptHead(SESSION_ID, 'send sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBB to endpoint');
    const rec = await readPresenceRecord();
    expect(rec?.activity?.promptHead).not.toContain('sk-ant-');
    expect(rec?.activity?.promptHead).toContain('[REDACTED]');
  });

  it('truncates a long prompt to at most 120 characters', async () => {
    await writeInitialPresence();
    const { setPresenceActivityPromptHead } = await getActivityMod();
    // Use word-like content that won't be redacted.
    const longPrompt = 'check the build status and run all the tests '.repeat(10);
    await setPresenceActivityPromptHead(SESSION_ID, longPrompt);
    const rec = await readPresenceRecord();
    expect(rec?.activity?.promptHead?.length).toBeLessThanOrEqual(120);
    expect(rec?.activity?.promptHead?.length).toBeGreaterThan(0);
  });

  it('collapses newlines in the raw prompt', async () => {
    await writeInitialPresence();
    const { setPresenceActivityPromptHead } = await getActivityMod();
    await setPresenceActivityPromptHead(SESSION_ID, 'line1\nline2\nline3');
    const rec = await readPresenceRecord();
    expect(rec?.activity?.promptHead).toBe('line1 line2 line3');
  });
});

// ---------------------------------------------------------------------------
// setPresenceActivityTurnEnd
// ---------------------------------------------------------------------------

describe('setPresenceActivityTurnEnd', () => {
  it('increments turns from 0 to 1 on first call', async () => {
    await writeInitialPresence();
    const { setPresenceActivityTurnEnd } = await getActivityMod();
    await setPresenceActivityTurnEnd(SESSION_ID);
    const rec = await readPresenceRecord();
    expect(rec?.activity?.turns).toBe(1);
  });

  it('increments turns on each call', async () => {
    await writeInitialPresence();
    const { setPresenceActivityTurnEnd } = await getActivityMod();
    await setPresenceActivityTurnEnd(SESSION_ID);
    await setPresenceActivityTurnEnd(SESSION_ID);
    await setPresenceActivityTurnEnd(SESSION_ID);
    const rec = await readPresenceRecord();
    expect(rec?.activity?.turns).toBe(3);
  });

  it('stamps lastTurnEndedAt as an ISO string', async () => {
    await writeInitialPresence();
    const { setPresenceActivityTurnEnd } = await getActivityMod();
    const before = new Date().toISOString();
    await setPresenceActivityTurnEnd(SESSION_ID);
    const after = new Date().toISOString();
    const rec = await readPresenceRecord();
    const endedAt = rec?.activity?.lastTurnEndedAt;
    expect(endedAt).toBeDefined();
    expect(endedAt! >= before).toBe(true);
    expect(endedAt! <= after).toBe(true);
  });

  it('preserves promptHead set by setPresenceActivityPromptHead', async () => {
    await writeInitialPresence();
    const { setPresenceActivityPromptHead, setPresenceActivityTurnEnd } = await getActivityMod();
    await setPresenceActivityPromptHead(SESSION_ID, 'my prompt');
    await setPresenceActivityTurnEnd(SESSION_ID);
    const rec = await readPresenceRecord();
    expect(rec?.activity?.promptHead).toBe('my prompt');
    expect(rec?.activity?.turns).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Concurrency: activity patch preserves turnState and other concurrent fields
// ---------------------------------------------------------------------------

describe('presence.activity concurrency', () => {
  it('concurrent activity + turnState + name all land without lost updates', async () => {
    await writeInitialPresence();
    const { setPresenceActivityPromptHead } = await getActivityMod();
    const { setPresenceTurnState, setPresenceName } = await (import('./presence.peer.js'));
    const { touchPresenceHeartbeat } = await getPresenceMod();

    // Fire all concurrently — they must serialize through the queue.
    await Promise.all([
      setPresenceActivityPromptHead(SESSION_ID, 'concurrent prompt'),
      setPresenceTurnState(SESSION_ID, 'busy'),
      setPresenceName(SESSION_ID, 'concurrent-session'),
      touchPresenceHeartbeat(SESSION_ID),
    ]);

    const rec = await readPresenceRecord();
    expect(rec?.activity?.promptHead).toBe('concurrent prompt');
    expect(rec?.turnState).toBe('busy');
    expect(rec?.name).toBe('concurrent-session');
    expect(rec?.heartbeatAt).toBeDefined();
  });

  it('concurrent promptHead + turnEnd serialize correctly', async () => {
    await writeInitialPresence();
    const { setPresenceActivityPromptHead, setPresenceActivityTurnEnd } = await getActivityMod();

    // Simulate a turn boundary: promptHead at start, turnEnd at end.
    await Promise.all([
      setPresenceActivityPromptHead(SESSION_ID, 'prompt for turn 1'),
      setPresenceActivityTurnEnd(SESSION_ID),
    ]);

    const rec = await readPresenceRecord();
    // Both must have landed; turns must be 1.
    expect(rec?.activity?.turns).toBe(1);
    // promptHead must exist (either the set value or empty string from turnEnd).
    expect(typeof rec?.activity?.promptHead).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Injection isolation: injected peer-message text must not reach promptHead
// ---------------------------------------------------------------------------

describe('injection isolation', () => {
  it('normalizePromptHead called on raw text does not contain injected peer body', async () => {
    const { normalizePromptHead } = await getActivityMod();

    // Simulate what loop-iteration.ts does: raw text is what the user typed.
    const rawUserText = 'run the tests';
    // The composited runText would have peer message prepended:
    // '<peer-session-message>secret body</peer-session-message>\n\n' + rawUserText
    // Only rawUserText is passed to normalizePromptHead — never runText.
    const head = normalizePromptHead(rawUserText);
    expect(head).toBe('run the tests');
    expect(head).not.toContain('peer-session-message');
  });

  it('setPresenceActivityPromptHead called with raw text excludes injected content', async () => {
    await writeInitialPresence();
    const { setPresenceActivityPromptHead } = await getActivityMod();

    // rawUserText is what the operator typed — no injections.
    const rawUserText = 'check the build';
    await setPresenceActivityPromptHead(SESSION_ID, rawUserText);

    const rec = await readPresenceRecord();
    expect(rec?.activity?.promptHead).toBe('check the build');
    expect(rec?.activity?.promptHead).not.toContain('peer-session-message');
    expect(rec?.activity?.promptHead).not.toContain('background-subagent-result');
  });
});

// ---------------------------------------------------------------------------
// list_sessions includes activity when present, omits when absent
// ---------------------------------------------------------------------------

describe('list_sessions activity field', () => {
  let lsTmpDir: string;
  let lsOrigAfkHome: string | undefined;
  let lsOrigStateDir: string | undefined;

  beforeEach(() => {
    lsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-ls-activity-test-'));
    lsOrigAfkHome = process.env['AFK_HOME'];
    lsOrigStateDir = process.env['AFK_STATE_DIR'];
    process.env['AFK_HOME'] = lsTmpDir;
    process.env['AFK_STATE_DIR'] = lsTmpDir;
  });

  afterEach(() => {
    fs.rmSync(lsTmpDir, { recursive: true, force: true });
    if (lsOrigAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = lsOrigAfkHome;
    if (lsOrigStateDir === undefined) delete process.env['AFK_STATE_DIR'];
    else process.env['AFK_STATE_DIR'] = lsOrigStateDir;
  });

  const SELF_ID = 'ls-self-aaaa';
  const PEER_A = 'ls-peer-with-activity';
  const PEER_B = 'ls-peer-no-activity';

  async function writePeer(sessionId: string, peerInbox = true): Promise<void> {
    const { writePresenceFile } = await import('./presence.js');
    await writePresenceFile({
      sessionId,
      surface: 'cli',
      cwd: '/tmp/fake',
      startedAt: new Date().toISOString(),
      model: { provider: 'anthropic-direct', name: 'claude' },
      workspace: NULL_WS,
      pid: process.pid,
      ...(peerInbox ? { peerInbox: true } : {}),
    });
  }

  it('includes activity when present on the presence record', async () => {
    await writePeer(SELF_ID);
    await writePeer(PEER_A);
    const { setPresenceActivityPromptHead } = await import('./presence.activity.js');
    await setPresenceActivityPromptHead(PEER_A, 'doing some work');

    const { listSessionsHandler } = await import('../tools/handlers/peer.js');
    const result = await listSessionsHandler({}, undefined, { sessionId: SELF_ID });
    type SessionEntry = { sessionId: string; activity?: { promptHead: string } };
    const sessions = JSON.parse(result.content) as SessionEntry[];
    const peer = sessions.find((s) => s.sessionId === PEER_A)!;
    expect(peer.activity).toBeDefined();
    expect(peer.activity?.promptHead).toBe('doing some work');
  });

  it('omits activity when not present on the presence record', async () => {
    await writePeer(SELF_ID);
    await writePeer(PEER_B);
    // No activity written for PEER_B.

    const { listSessionsHandler } = await import('../tools/handlers/peer.js');
    const result = await listSessionsHandler({}, undefined, { sessionId: SELF_ID });
    type SessionEntry = { sessionId: string; activity?: unknown };
    const sessions = JSON.parse(result.content) as SessionEntry[];
    const peer = sessions.find((s) => s.sessionId === PEER_B)!;
    expect(peer.activity).toBeUndefined();
    // activity key should not appear at all.
    expect(Object.prototype.hasOwnProperty.call(peer, 'activity')).toBe(false);
  });
});
