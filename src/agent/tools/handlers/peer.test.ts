/**
 * Tests for peer tool handlers: list_sessions, send_to_session.
 *
 * - list_sessions excludes self, reports acceptsMessages/turnState/pendingMessages.
 * - send_to_session errors without context.sessionId, refuses with isError,
 *   queues successfully, computes hop = originalHop + 1 on reply_to, emits
 *   peer_message trace events with bytes (no body text).
 * - Dispatcher gating: list_sessions / send_to_session present at top-level,
 *   absent when parentSessionId is set.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { InMemoryTraceWriter } from '../../trace/writer.js';
import { closeStore } from '../../goals/goal-store.js';

// ---------------------------------------------------------------------------
// Env isolation
// ---------------------------------------------------------------------------

let tmpDir: string;
let origAfkHome: string | undefined;
let origStateDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-peertool-test-'));
  origAfkHome = process.env['AFK_HOME'];
  origStateDir = process.env['AFK_STATE_DIR'];
  process.env['AFK_HOME'] = tmpDir;
  process.env['AFK_STATE_DIR'] = tmpDir;
});

afterEach(() => {
  // Defensively close the goal-store singleton before Windows temp cleanup.
  // Its actual opener is getGoal -> store() (goal-store.ts), not handler import
  // evaluation. This is a no-op when this worker has not used the goal store.
  closeStore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origAfkHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = origAfkHome;
  if (origStateDir === undefined) delete process.env['AFK_STATE_DIR'];
  else process.env['AFK_STATE_DIR'] = origStateDir;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NULL_WS = { branch: null, headSha: null, dirty: null, dirtyCount: null, remoteUrl: null };
const SELF_ID = 'self-session-aaaa';
const PEER_ID = 'peer-session-bbbb';

async function getPresenceMod() {
  return import('../../awareness/presence.js');
}

async function getHandlers() {
  return import('./peer.js');
}

async function getInboxStore() {
  return import('../../peer/inbox-store.js');
}

async function writeSession(
  sessionId: string,
  opts: {
    peerInbox?: boolean;
    turnState?: 'idle' | 'busy' | 'blocked';
    name?: string;
    blockedSince?: string;
  } = {},
): Promise<void> {
  const { writePresenceFile } = await getPresenceMod();
  await writePresenceFile({
    sessionId,
    surface: 'cli',
    cwd: '/tmp/fake',
    startedAt: new Date().toISOString(),
    model: { provider: 'anthropic-direct', name: 'claude' },
    workspace: NULL_WS,
    pid: process.pid, // alive
    ...(opts.peerInbox !== undefined ? { peerInbox: opts.peerInbox } : {}),
    ...(opts.turnState !== undefined ? { turnState: opts.turnState } : {}),
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.blockedSince !== undefined ? { blockedSince: opts.blockedSince } : {}),
  });
}

// ---------------------------------------------------------------------------
// list_sessions
// ---------------------------------------------------------------------------

describe('listSessionsHandler', () => {
  it('excludes self from results', async () => {
    await writeSession(SELF_ID);
    await writeSession(PEER_ID, { peerInbox: true });
    const { listSessionsHandler } = await getHandlers();
    const result = await listSessionsHandler(
      {},
      undefined,
      { sessionId: SELF_ID },
    );
    expect(result.isError).toBeFalsy();
    const sessions = JSON.parse(result.content) as Array<{ sessionId: string }>;
    expect(sessions.find((s) => s.sessionId === SELF_ID)).toBeUndefined();
    expect(sessions.find((s) => s.sessionId === PEER_ID)).toBeDefined();
  });

  it('reports acceptsMessages: true for a session with peerInbox', async () => {
    await writeSession(PEER_ID, { peerInbox: true });
    const { listSessionsHandler } = await getHandlers();
    const result = await listSessionsHandler({}, undefined, { sessionId: SELF_ID });
    const sessions = JSON.parse(result.content) as Array<{
      sessionId: string;
      acceptsMessages: boolean;
    }>;
    const peer = sessions.find((s) => s.sessionId === PEER_ID)!;
    expect(peer.acceptsMessages).toBe(true);
  });

  it('reports acceptsMessages: false for a session without peerInbox', async () => {
    await writeSession(PEER_ID, { peerInbox: false });
    const { listSessionsHandler } = await getHandlers();
    const result = await listSessionsHandler({}, undefined, { sessionId: SELF_ID });
    const sessions = JSON.parse(result.content) as Array<{
      sessionId: string;
      acceptsMessages: boolean;
    }>;
    const peer = sessions.find((s) => s.sessionId === PEER_ID)!;
    expect(peer.acceptsMessages).toBe(false);
  });

  it('reports turnState for a peer', async () => {
    await writeSession(PEER_ID, { turnState: 'idle', peerInbox: true });
    const { listSessionsHandler } = await getHandlers();
    const result = await listSessionsHandler({}, undefined, { sessionId: SELF_ID });
    const sessions = JSON.parse(result.content) as Array<{
      sessionId: string;
      turnState: string;
    }>;
    const peer = sessions.find((s) => s.sessionId === PEER_ID)!;
    expect(peer.turnState).toBe('idle');
  });

  it('reports pendingMessages count', async () => {
    await writeSession(PEER_ID, { peerInbox: true });
    // Write 2 envelopes to peer's inbox.
    const { writeEnvelope } = await getInboxStore();
    const baseEnv = (n: number) => ({
      v: 1 as const,
      messageId: `pm-${n}`,
      from: { id: SELF_ID },
      to: PEER_ID,
      hop: 0,
      ts: new Date().toISOString(),
      body: `msg ${n}`,
    });
    await writeEnvelope(baseEnv(1));
    await writeEnvelope(baseEnv(2));

    const { listSessionsHandler } = await getHandlers();
    const result = await listSessionsHandler({}, undefined, { sessionId: SELF_ID });
    const sessions = JSON.parse(result.content) as Array<{
      sessionId: string;
      pendingMessages: number;
    }>;
    const peer = sessions.find((s) => s.sessionId === PEER_ID)!;
    expect(peer.pendingMessages).toBe(2);
  });

  it('works without context.sessionId (no exclusion)', async () => {
    await writeSession(PEER_ID, { peerInbox: true });
    const { listSessionsHandler } = await getHandlers();
    const result = await listSessionsHandler({}, undefined, undefined);
    expect(result.isError).toBeFalsy();
    const sessions = JSON.parse(result.content) as Array<{ sessionId: string }>;
    expect(sessions.find((s) => s.sessionId === PEER_ID)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// send_to_session
// ---------------------------------------------------------------------------

describe('sendToSessionHandler', () => {
  it('returns isError when context.sessionId is missing', async () => {
    const { sendToSessionHandler } = await getHandlers();
    const result = await sendToSessionHandler(
      { to: PEER_ID, message: 'hi' },
      undefined,
      undefined, // no context at all
    );
    expect(result.isError).toBe(true);
  });

  it('returns isError when context has no sessionId', async () => {
    const { sendToSessionHandler } = await getHandlers();
    const result = await sendToSessionHandler(
      { to: PEER_ID, message: 'hi' },
      undefined,
      {} as never, // context without sessionId
    );
    expect(result.isError).toBe(true);
  });

  it('returns isError for unknown target', async () => {
    const { sendToSessionHandler } = await getHandlers();
    await writeSession(SELF_ID);
    const result = await sendToSessionHandler(
      { to: 'no-such-target', message: 'hi' },
      undefined,
      { sessionId: SELF_ID },
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content) as { status: string; reason: string };
    expect(body.status).toBe('refused');
    expect(body.reason).toBe('unknown-target');
  });

  it('returns isError for no-receiver target', async () => {
    await writeSession(SELF_ID);
    await writeSession(PEER_ID, { peerInbox: false });
    const { sendToSessionHandler } = await getHandlers();
    const result = await sendToSessionHandler(
      { to: PEER_ID, message: 'hi' },
      undefined,
      { sessionId: SELF_ID },
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content) as { reason: string };
    expect(body.reason).toBe('no-receiver');
  });

  it('queues successfully and returns messageId', async () => {
    await writeSession(SELF_ID);
    await writeSession(PEER_ID, { peerInbox: true });
    const { sendToSessionHandler } = await getHandlers();
    const result = await sendToSessionHandler(
      { to: PEER_ID, message: 'hello from handler' },
      undefined,
      { sessionId: SELF_ID },
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content) as { status: string; messageId: string };
    expect(body.status).toBe('queued');
    expect(body.messageId).toBeDefined();
  });

  it('emits peer_message trace event with bytes but no body text', async () => {
    await writeSession(SELF_ID);
    await writeSession(PEER_ID, { peerInbox: true });
    const writer = new InMemoryTraceWriter();
    const { sendToSessionHandler } = await getHandlers();
    const message = 'trace event test message';
    await sendToSessionHandler(
      { to: PEER_ID, message },
      undefined,
      { sessionId: SELF_ID, traceWriter: writer },
    );
    const peerEvents = writer.events.filter((e) => e.kind === 'peer_message');
    expect(peerEvents).toHaveLength(1);
    const evt = peerEvents[0]!;
    expect(evt.payload.bytes).toBe(Buffer.byteLength(message, 'utf8'));
    expect(evt.payload.action).toBe('sent');
    // Body must NOT appear in the event.
    expect(JSON.stringify(evt)).not.toContain('trace event test message');
  });

  it('emits refused trace event when target is unknown', async () => {
    await writeSession(SELF_ID);
    const writer = new InMemoryTraceWriter();
    const { sendToSessionHandler } = await getHandlers();
    await sendToSessionHandler(
      { to: 'no-such', message: 'hi' },
      undefined,
      { sessionId: SELF_ID, traceWriter: writer },
    );
    const peerEvents = writer.events.filter((e) => e.kind === 'peer_message');
    expect(peerEvents).toHaveLength(1);
    expect(peerEvents[0]!.payload.action).toBe('refused');
  });

  it('computes hop = originalHop + 1 for reply_to', async () => {
    await writeSession(SELF_ID);
    await writeSession(PEER_ID, { peerInbox: true });

    // Write an original envelope into SELF's delivered/ with hop=3.
    const { writeEnvelope, listPending, claimPending } = await getInboxStore();
    const originalEnv = {
      v: 1 as const,
      messageId: 'orig-env-hop-test',
      from: { id: PEER_ID },
      to: SELF_ID,
      hop: 3,
      ts: new Date().toISOString(),
      body: 'original msg',
    };
    await writeEnvelope(originalEnv);
    const files = await listPending(SELF_ID);
    await claimPending(SELF_ID, files[0]!);

    const { sendToSessionHandler } = await getHandlers();
    const result = await sendToSessionHandler(
      { to: PEER_ID, message: 'reply', reply_to: 'orig-env-hop-test' },
      undefined,
      { sessionId: SELF_ID },
    );
    expect(result.isError).toBeFalsy();

    // Verify the hop in the sent envelope.
    const sentFiles = await listPending(PEER_ID);
    const sentEnv = await claimPending(PEER_ID, sentFiles[0]!);
    expect(sentEnv!.hop).toBe(4); // 3 + 1
  });
});

// ---------------------------------------------------------------------------
// Dispatcher gating: list_sessions/send_to_session present/absent
// ---------------------------------------------------------------------------

describe('dispatcher gating — peer tools', () => {
  it('list_sessions and send_to_session present for top-level (no parentSessionId)', async () => {
    const { SessionToolDispatcher } = await import('../dispatcher.js');
    const { builtinToolSchemas } = await import('../schemas.js');
    const { createBuiltinHandlers } = await import('./index.js');

    const dispatcher = new SessionToolDispatcher({
      handlers: createBuiltinHandlers(),
      schemas: [...builtinToolSchemas],
      permissions: { allowedTools: builtinToolSchemas.map((s) => s.name) },
      // No parentSessionId → top-level session
    });

    const toolNames = dispatcher.toolDefs.map((t) => t.name);
    expect(toolNames).toContain('list_sessions');
    expect(toolNames).toContain('send_to_session');
  });

  it('list_sessions and send_to_session absent when parentSessionId is set', async () => {
    const { SessionToolDispatcher } = await import('../dispatcher.js');
    const { builtinToolSchemas } = await import('../schemas.js');
    const { createBuiltinHandlers } = await import('./index.js');

    const dispatcher = new SessionToolDispatcher({
      handlers: createBuiltinHandlers(),
      schemas: [...builtinToolSchemas],
      permissions: { allowedTools: builtinToolSchemas.map((s) => s.name) },
      parentSessionId: 'parent-session-xyz',
    });

    const toolNames = dispatcher.toolDefs.map((t) => t.name);
    expect(toolNames).not.toContain('list_sessions');
    expect(toolNames).not.toContain('send_to_session');
  });
});
