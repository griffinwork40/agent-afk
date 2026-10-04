/**
 * End-to-end test for the peer-messaging system.
 *
 * Two fake sessions (A and B) with presence files are set up. The test
 * exercises the full send → receive → reply → receive cycle:
 *
 *   1. Session A sends to Session B → B's notifier.scan() claims it →
 *      drainInjections yields a <peer-session-message from=A id=…> block.
 *   2. Session B replies to A (via sendToSession with hop incremented) →
 *      A's notifier receives it with reply_to set and hop=1.
 *
 * Everything runs in-process against a tmpdir AFK_HOME so no real presence
 * records or inbox files are touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── path isolation ───────────────────────────────────────────────────────────
let tmpHome: string;
const prevHome = process.env['AFK_HOME'];

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'afk-e2e-peer-'));
  process.env['AFK_HOME'] = tmpHome;
  delete process.env['AFK_STATE_DIR'];
  delete process.env['AFK_FRAMEWORK_DIR'];
});

afterEach(async () => {
  if (prevHome !== undefined) process.env['AFK_HOME'] = prevHome;
  else delete process.env['AFK_HOME'];
  delete process.env['AFK_STATE_DIR'];
  delete process.env['AFK_FRAMEWORK_DIR'];
  await rm(tmpHome, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Write a minimal presence file for a fake session so sendToSession can
 * resolve it. Sets peerInbox=true so the receiver check passes.
 */
async function writePresence(sessionId: string, name?: string): Promise<void> {
  const { getPresenceDir } = await import('../../paths.js');
  const dir = getPresenceDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const record = {
    schemaVersion: 1,
    sessionId,
    pid: process.pid,
    surface: 'cli',
    cwd: process.cwd(),
    heartbeatAt: new Date().toISOString(),
    peerInbox: true,
    ...(name !== undefined ? { name } : {}),
  };
  await writeFile(join(dir, `${sessionId}.json`), JSON.stringify(record, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('peer-messaging end-to-end', () => {
  it('A sendToSession → B scan → drain shows from=A with correct id', async () => {
    const { sendToSession } = await import('./send.js');
    const { PeerInboxNotifier } = await import(
      '../../cli/commands/interactive/peer-inbox-notifier.js'
    );

    const sessionA = randomUUID();
    const sessionB = randomUUID();

    await writePresence(sessionA, 'session-a');
    await writePresence(sessionB, 'session-b');

    // A sends to B
    const sendResult = await sendToSession({
      from: { id: sessionA, name: 'session-a' },
      to: sessionB,
      message: 'Hello from A to B',
    });

    expect(sendResult.status).toBe('queued');
    expect(sendResult.messageId).toBeDefined();
    const messageId = sendResult.messageId!;

    // B's notifier scans and claims the message
    let bScanId: string | undefined = sessionB;
    const bLines: string[] = [];
    const bNotifier = new PeerInboxNotifier({
      getSessionId: () => bScanId,
      writeLine: (t) => bLines.push(t),
      mode: () => 'accept',
      pollMs: 5,
    });
    await bNotifier.scan();

    expect(bNotifier.hasPendingInjections()).toBe(true);
    const bDrained = bNotifier.drainInjections();

    // Verify the block contains the expected attributes
    expect(bDrained).toContain(`from="${sessionA}"`);
    expect(bDrained).toContain(`id="${messageId}"`);
    expect(bDrained).toContain('Hello from A to B');
    expect(bDrained).toContain('<peer-session-message');
    expect(bDrained).toContain('</peer-session-message>');

    // writeLine was called with a "peer message from" line
    expect(bLines.some((l) => l.includes('peer message from'))).toBe(true);

    void bScanId;
  });

  it('B replies to A → A notifier receives it with reply_to set and hop=1', async () => {
    const { sendToSession } = await import('./send.js');
    const { PeerInboxNotifier } = await import(
      '../../cli/commands/interactive/peer-inbox-notifier.js'
    );

    const sessionA = randomUUID();
    const sessionB = randomUUID();

    await writePresence(sessionA, 'session-a');
    await writePresence(sessionB, 'session-b');

    // A → B (original message, hop=0)
    const sendResult = await sendToSession({
      from: { id: sessionA, name: 'session-a' },
      to: sessionB,
      message: 'Original message from A',
    });
    expect(sendResult.status).toBe('queued');
    const originalMessageId = sendResult.messageId!;

    // B scans and claims it
    const bNotifier = new PeerInboxNotifier({
      getSessionId: () => sessionB,
      writeLine: () => {},
      mode: () => 'accept',
      pollMs: 5,
    });
    await bNotifier.scan();
    const bBlock = bNotifier.drainInjections();
    expect(bBlock).toContain(originalMessageId);

    // B replies to A with hop=1 and replyTo=originalMessageId
    const replyResult = await sendToSession({
      from: { id: sessionB, name: 'session-b' },
      to: sessionA,
      message: 'Reply from B to A',
      replyTo: originalMessageId,
      hop: 1,
    });
    expect(replyResult.status).toBe('queued');
    const replyMessageId = replyResult.messageId!;

    // A's notifier scans and claims the reply
    const aNotifier = new PeerInboxNotifier({
      getSessionId: () => sessionA,
      writeLine: () => {},
      mode: () => 'accept',
      pollMs: 5,
    });
    await aNotifier.scan();

    expect(aNotifier.hasPendingInjections()).toBe(true);
    const aDrained = aNotifier.drainInjections();

    // Verify reply attributes
    expect(aDrained).toContain(`from="${sessionB}"`);
    expect(aDrained).toContain(`id="${replyMessageId}"`);
    expect(aDrained).toContain(`reply_to="${originalMessageId}"`);
    expect(aDrained).toContain('hop="1"');
    expect(aDrained).toContain('Reply from B to A');
  });

  it('A cannot send to itself (refused with reason=self)', async () => {
    const { sendToSession } = await import('./send.js');

    const sessionA = randomUUID();
    await writePresence(sessionA);

    const result = await sendToSession({
      from: { id: sessionA },
      to: sessionA,
      message: 'This should be refused',
    });

    expect(result.status).toBe('refused');
    expect(result.reason).toBe('self');
  });

  it('sending to a dead/unknown session is refused', async () => {
    const { sendToSession } = await import('./send.js');

    const sessionA = randomUUID();
    await writePresence(sessionA);

    const result = await sendToSession({
      from: { id: sessionA },
      to: 'no-such-session-id',
      message: 'This should fail',
    });

    expect(result.status).toBe('refused');
    expect(result.reason).toBe('unknown-target');
  });

  it('multi-line body stays in one envelope and renders as one block', async () => {
    const { sendToSession } = await import('./send.js');
    const { PeerInboxNotifier } = await import(
      '../../cli/commands/interactive/peer-inbox-notifier.js'
    );

    const sessionA = randomUUID();
    const sessionB = randomUUID();
    await writePresence(sessionA);
    await writePresence(sessionB);

    const multiLineBody = 'Line 1\nLine 2\nLine 3\nLine 4';
    const sendResult = await sendToSession({
      from: { id: sessionA },
      to: sessionB,
      message: multiLineBody,
    });
    expect(sendResult.status).toBe('queued');

    const bNotifier = new PeerInboxNotifier({
      getSessionId: () => sessionB,
      writeLine: () => {},
      mode: () => 'accept',
      pollMs: 5,
    });
    await bNotifier.scan();
    const block = bNotifier.drainInjections();

    // One opening, one closing tag → single block
    expect((block.match(/<peer-session-message /g) ?? []).length).toBe(1);
    expect((block.match(/<\/peer-session-message>/g) ?? []).length).toBe(1);
    // Body content present
    expect(block).toContain('Line 1');
    expect(block).toContain('Line 4');
  });
});
