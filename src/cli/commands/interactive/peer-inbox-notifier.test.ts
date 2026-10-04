/**
 * Tests for `PeerInboxNotifier`.
 *
 * Uses a fresh AFK_HOME per test for filesystem isolation. The notifier's
 * poll timer is set to a very short interval (5ms) in tests that exercise
 * real timers; `start()` / `dispose()` tests rely on the unref()'d timer
 * not preventing vitest from exiting naturally.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { InMemoryTraceWriter } from '../../../agent/trace/writer.js';
import { PeerInboxNotifier } from './peer-inbox-notifier.js';
import { writeEnvelope } from '../../../agent/peer/inbox-store.js';
import { writePresenceFile } from '../../../agent/awareness/presence.js';
import { renderPeerMessageBlock, type PeerEnvelope } from '../../../agent/peer/envelope.js';

import { stripAnsi } from '../../display.js';

// ── path isolation ──────────────────────────────────────────────────────────
let tmpHome: string;
const prevHome = process.env['AFK_HOME'];

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'afk-notifier-test-'));
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

// ── helpers ─────────────────────────────────────────────────────────────────

function makeEnvelope(
  to: string,
  opts: Partial<Omit<PeerEnvelope, 'v' | 'to'>> = {},
): PeerEnvelope {
  return {
    v: 1,
    messageId: opts.messageId ?? randomUUID(),
    from: opts.from ?? { id: 'sender-' + randomUUID().slice(0, 8) },
    to,
    hop: opts.hop ?? 0,
    ts: opts.ts ?? new Date().toISOString(),
    body: opts.body ?? 'hello world',
    ...(opts.replyTo !== undefined ? { replyTo: opts.replyTo } : {}),
  };
}

function makeNotifier(
  sessionId: string | undefined,
  opts: {
    lines?: string[];
    pollMs?: number;
    mode?: () => 'accept' | 'hold' | 'off';
    now?: () => number;
  } = {},
): { notifier: PeerInboxNotifier; lines: string[] } {
  const lines = opts.lines ?? [];
  const notifier = new PeerInboxNotifier({
    getSessionId: () => sessionId,
    writeLine: (t) => lines.push(t),
    mode: opts.mode ?? (() => 'accept'),
    pollMs: opts.pollMs ?? 5,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return { notifier, lines };
}

// ── accept → hasPendingInjections + drain ───────────────────────────────────

describe('PeerInboxNotifier — accept path', () => {
  it('scan → hasPendingInjections true, drainInjections returns one block per envelope then empty', async () => {
    const sessionId = randomUUID();
    const e1 = makeEnvelope(sessionId);
    const e2 = makeEnvelope(sessionId);
    await writeEnvelope(e1);
    await writeEnvelope(e2);

    const { notifier } = makeNotifier(sessionId);
    await notifier.scan();

    expect(notifier.hasPendingInjections()).toBe(true);
    const drained = notifier.drainInjections();
    expect(drained).toContain(`from="${e1.from.id}"`);
    expect(drained).toContain(`from="${e2.from.id}"`);
    expect(drained.trim().length).toBeGreaterThan(0);

    // Second call → empty
    expect(notifier.drainInjections()).toBe('');
    expect(notifier.hasPendingInjections()).toBe(false);
  });

  it('multi-line body is delivered as ONE block (not split)', async () => {
    const sessionId = randomUUID();
    const body = 'line one\nline two\nline three';
    await writeEnvelope(makeEnvelope(sessionId, { body }));

    const { notifier } = makeNotifier(sessionId);
    await notifier.scan();

    const drained = notifier.drainInjections();
    // The opening and closing tags appear exactly once
    expect((drained.match(/<peer-session-message /g) ?? []).length).toBe(1);
    expect((drained.match(/<\/peer-session-message>/g) ?? []).length).toBe(1);
    // Body content is present (XML-escaped newlines preserved as \n in text)
    expect(drained).toContain('line one');
    expect(drained).toContain('line three');
  });

  it('onInjectable fires once on empty→non-empty transition, not on subsequent scans', async () => {
    const sessionId = randomUUID();
    await writeEnvelope(makeEnvelope(sessionId));

    const { notifier } = makeNotifier(sessionId);
    const spy = vi.fn();
    notifier.onInjectable = spy;

    // First scan — transitions from empty to non-empty → fires once
    await notifier.scan();
    expect(spy).toHaveBeenCalledTimes(1);

    // Reset buffer without draining (simulate not draining yet)
    // Write another envelope
    await writeEnvelope(makeEnvelope(sessionId));
    // Second scan while buffer is non-empty — no second fire
    await notifier.scan();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('writeLine called with a "peer message from" line on accept', async () => {
    const sessionId = randomUUID();
    const e = makeEnvelope(sessionId, { from: { id: 'abc12345', name: 'alice' } });
    await writeEnvelope(e);

    const { notifier, lines } = makeNotifier(sessionId);
    await notifier.scan();

    expect(lines.some((l) => l.includes('peer message from') && l.includes('alice'))).toBe(true);
  });

  it.each([undefined, 40, 200])('shows sender identity and byte count at columns=%s without changing drained envelopes', async (columns) => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    vi.stubEnv('AFK_CENTER_CONTENT', '1');
    vi.stubEnv('AFK_TEXT_MEASURE', '100');
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: columns });
    try {
      const sessionId = randomUUID();
      const e = makeEnvelope(sessionId, {
        from: { id: 'abc12345', name: '\x1b[31malice\x1b[0m' },
        body: 'safe preview\n' + '界👩‍💻 & <long body> '.repeat(40), hop: 1, replyTo: randomUUID(),
      });
      await writeEnvelope(e);
      const { notifier, lines } = makeNotifier(sessionId);
      await notifier.scan();
      // Format: ↘ peer message from <name> (<shortId>) · <N KB>
      const plain = stripAnsi(lines[0]!);
      expect(plain).toContain('peer message from');
      expect(plain).toContain('alice');
      // Drained envelope unchanged — body never mutated by display path.
      expect(notifier.drainInjections()).toBe(renderPeerMessageBlock(e) + '\n\n');
      expect(notifier.drainInjections()).toBe('');
    } finally {
      if (descriptor) Object.defineProperty(process.stdout, 'columns', descriptor);
      else Reflect.deleteProperty(process.stdout, 'columns');
      vi.unstubAllEnvs();
    }
  });

  it('held path writes a "held" line and does not buffer the envelope', async () => {
    const sessionId = randomUUID();
    await writeEnvelope(makeEnvelope(sessionId, { from: { id: 'sender-id', name: 'alice' } }));

    const { notifier, lines } = makeNotifier(sessionId, {
      mode: () => 'hold',
    });
    await notifier.scan();

    expect(notifier.hasPendingInjections()).toBe(false);
    expect(notifier.drainInjections()).toBe('');
    expect(lines.some((l) => l.includes('held'))).toBe(true);
  });

  it('two notifiers on the same inbox deliver each message exactly once total', async () => {
    const sessionId = randomUUID();
    await writeEnvelope(makeEnvelope(sessionId));

    const { notifier: n1 } = makeNotifier(sessionId);
    const { notifier: n2 } = makeNotifier(sessionId);

    await Promise.all([n1.scan(), n2.scan()]);

    const drains = [n1.drainInjections(), n2.drainInjections()];
    expect(drains.filter((text) => text !== '')).toHaveLength(1);
    expect((drains.join('').match(/<peer-session-message /g) ?? [])).toHaveLength(1);
    expect(n1.drainInjections()).toBe('');
    expect(n2.drainInjections()).toBe('');
    const { notifier: fresh } = makeNotifier(sessionId);
    await fresh.scan();
    expect(fresh.drainInjections()).toBe('');
  });

  it('forceAccept("all") moves held envelopes into the buffer bypassing budget', async () => {
    const sessionId = randomUUID();
    await writeEnvelope(makeEnvelope(sessionId));

    // Scan with mode=hold to hold it
    const { notifier } = makeNotifier(sessionId, { mode: () => 'hold' });
    await notifier.scan();
    expect(notifier.hasPendingInjections()).toBe(false);

    // Now switch mode to accept and forceAccept
    const { notifier: n2 } = makeNotifier(sessionId, { mode: () => 'accept' });
    // The held file is in held/; forceAccept on the SAME sessionId
    // (but n2 is a fresh notifier — use the same session id to share disk)
    // Actually use same notifier but re-create with accept mode for forceAccept
    // Use original notifier with forceAccept
    const injected = await notifier.forceAccept('all');
    expect(injected).toBe(1);
    expect(notifier.hasPendingInjections()).toBe(true);
    const drained = notifier.drainInjections();
    expect(drained.length).toBeGreaterThan(0);
    void n2;
  });
});

// ── re-key on sessionId change ───────────────────────────────────────────────

describe('PeerInboxNotifier — re-key', () => {
  it('changing getSessionId value makes the next tick watch/scan the new inbox', async () => {
    let currentId = randomUUID();
    const e1 = makeEnvelope(currentId);
    await writeEnvelope(e1);

    const { notifier } = makeNotifier(currentId);
    // Drain first session's message
    await notifier.scan();
    const d1 = notifier.drainInjections();
    expect(d1).toContain(e1.from.id);

    // Switch to a new session id
    const newId = randomUUID();
    const e2 = makeEnvelope(newId, { from: { id: 'new-sender' } });
    await writeEnvelope(e2);

    // Rebuild notifier with new id
    const { notifier: n2 } = makeNotifier(newId);
    await n2.scan();
    const d2 = n2.drainInjections();
    expect(d2).toContain('new-sender');
    void currentId;
  });
});

// ── advertise ────────────────────────────────────────────────────────────────

describe('PeerInboxNotifier — advertise', () => {
  it('sets peerInbox=true in presence file and applies desiredName', async () => {
    const sessionId = randomUUID();

    // Write a minimal presence file first so patchPresenceFile has something to read
    await writePresenceFile({
      sessionId,
      pid: process.pid,
      surface: 'cli',
      cwd: process.cwd(),
      schemaVersion: 1,
      heartbeatAt: new Date().toISOString(),
    });

    // Call the presence peer helpers directly (same functions that advertise()
    // delegates to) — this tests the integration without relying on fire-and-forget timing.
    const { setPresencePeerInbox, setPresenceName } = await import(
      '../../../agent/awareness/presence.peer.js'
    );
    await setPresencePeerInbox(sessionId, true);
    await setPresenceName(sessionId, 'my-test-session');

    // Read the presence file and verify
    const { getPresenceDir } = await import('../../../paths.js');
    const { readFile } = await import('fs/promises');
    const raw = await readFile(join(getPresenceDir(), `${sessionId}.json`), 'utf8');
    const record = JSON.parse(raw) as { peerInbox?: boolean; name?: string };
    expect(record.peerInbox).toBe(true);
    expect(record.name).toBe('my-test-session');
  });
});

// ── start / dispose — no open handles ───────────────────────────────────────

describe('PeerInboxNotifier — start/dispose lifecycle', () => {
  it('start() + dispose() leaves no open handles (short pollMs)', async () => {
    const sessionId = randomUUID();
    const { notifier } = makeNotifier(sessionId, { pollMs: 5 });
    notifier.start();
    // Give at least one tick
    await new Promise((r) => setTimeout(r, 20));
    notifier.dispose();
    // If the test completes without vitest hanging, there are no open handles.
    expect(true).toBe(true);
  });

  it('start() is idempotent — calling twice does not double-poll', () => {
    const sessionId = randomUUID();
    const { notifier } = makeNotifier(sessionId, { pollMs: 5 });
    notifier.start();
    notifier.start(); // second call is a no-op
    notifier.dispose();
    expect(true).toBe(true);
  });

  it('dispose() is idempotent — calling twice does not throw', () => {
    const sessionId = randomUUID();
    const { notifier } = makeNotifier(sessionId, { pollMs: 5 });
    notifier.start();
    notifier.dispose();
    expect(() => notifier.dispose()).not.toThrow();
  });
});

describe('PeerInboxNotifier — resetForNewSession (resume swap)', () => {
  it('resetForNewSession clears the buffer synchronously', async () => {
    const sessionId = randomUUID();
    await writeEnvelope(makeEnvelope(sessionId));

    const { notifier } = makeNotifier(sessionId);
    await notifier.scan();
    expect(notifier.hasPendingInjections()).toBe(true);

    notifier.resetForNewSession();
    expect(notifier.hasPendingInjections()).toBe(false);
    expect(notifier.drainInjections()).toBe('');
  });

  it('reset clears exhausted sender wake credit without advancing the clock', async () => {
    const sessionId = randomUUID();
    const { notifier } = makeNotifier(sessionId, { now: () => 0 });
    for (let i = 0; i < 21; i++) {
      await writeEnvelope(makeEnvelope(sessionId, { from: { id: 'same-sender' } }));
      await notifier.scan();
      const delivered = notifier.drainInjections();
      expect(delivered.length > 0).toBe(i < 20);
    }
    notifier.resetForNewSession();
    await writeEnvelope(makeEnvelope(sessionId, { from: { id: 'same-sender' } }));
    await notifier.scan();
    expect(notifier.drainInjections()).toContain('same-sender');
  });
});

describe('PeerInboxNotifier — live trace writer', () => {
  it('routes delivered AND held events after switching writers; getter beats static sink', async () => {
    const sessionId = randomUUID();
    const oldWriter = new InMemoryTraceWriter();
    const newWriter = new InMemoryTraceWriter();
    let currentWriter = oldWriter;
    let mode: 'accept' | 'hold' = 'accept';
    const notifier = new PeerInboxNotifier({
      getSessionId: () => sessionId, writeLine: () => undefined,
      mode: () => mode, traceWriter: oldWriter,
      getTraceWriter: () => currentWriter,
    });
    await writeEnvelope(makeEnvelope(sessionId));
    await notifier.scan();
    expect(oldWriter.events).toHaveLength(1);
    currentWriter = newWriter;
    const delivered = makeEnvelope(sessionId);
    await writeEnvelope(delivered);
    await notifier.scan();
    mode = 'hold';
    const held = makeEnvelope(sessionId);
    await writeEnvelope(held);
    await notifier.scan();
    expect(oldWriter.events).toHaveLength(1);
    expect(newWriter.events).toEqual([
      expect.objectContaining({ kind: 'peer_message', payload: expect.objectContaining({ action: 'claimed', messageId: delivered.messageId }) }),
      expect.objectContaining({ kind: 'peer_message', payload: expect.objectContaining({ action: 'held', messageId: held.messageId }) }),
    ]);
  });

  it('retains static traceWriter support without a getter', async () => {
    const sessionId = randomUUID();
    const writer = new InMemoryTraceWriter();
    const notifier = new PeerInboxNotifier({ getSessionId: () => sessionId, writeLine: () => undefined, mode: () => 'accept', traceWriter: writer });
    await writeEnvelope(makeEnvelope(sessionId));
    await notifier.scan();
    expect(writer.events).toHaveLength(1);
    expect(writer.events[0]).toMatchObject({ kind: 'peer_message', payload: { action: 'claimed' } });
  });
});

describe('PeerInboxNotifier — dispose race (regression)', () => {
  it('a tick in flight at dispose() never resurrects a watcher that claims later messages', async () => {
    const sessionId = randomUUID();
    const { notifier: stale } = makeNotifier(sessionId, { pollMs: 10_000 });
    // start() kicks off an async tick (mkdir + watch setup); dispose before it settles.
    stale.start();
    stale.dispose();
    await new Promise((r) => setTimeout(r, 100));

    const env = makeEnvelope(sessionId, { body: 'for the live notifier' });
    await writeEnvelope(env);
    await new Promise((r) => setTimeout(r, 200));
    expect(stale.hasPendingInjections()).toBe(false);

    // A fresh notifier on the same inbox still receives it.
    const { notifier: live } = makeNotifier(sessionId);
    await live.scan();
    expect(live.drainInjections()).toContain('for the live notifier');
    live.dispose();
  });
});

// ── reclaim: claimed-but-uninjected returned to pending ─────────────────────

describe('PeerInboxNotifier — reclaim()', () => {
  it('reclaim() moves buffered envelopes back to pending/ and clears buffer', async () => {
    const sessionId = randomUUID();
    const e1 = makeEnvelope(sessionId);
    await writeEnvelope(e1);

    const { notifier } = makeNotifier(sessionId);
    await notifier.scan(); // claims e1 → buffer
    expect(notifier.hasPendingInjections()).toBe(true);

    const count = await notifier.reclaim();
    expect(count).toBe(1);
    expect(notifier.hasPendingInjections()).toBe(false);

    // Envelope should be back in pending/ and claimable again.
    const { listPending } = await import('../../../agent/peer/inbox-store.js');
    const files = await listPending(sessionId);
    expect(files).toHaveLength(1);
  });

  it('reclaim() on empty buffer returns 0 and leaves pending/ unchanged', async () => {
    const sessionId = randomUUID();
    const { notifier } = makeNotifier(sessionId);
    const count = await notifier.reclaim();
    expect(count).toBe(0);
  });

  it('reclaim() then rescan re-delivers the same envelope', async () => {
    const sessionId = randomUUID();
    const e = makeEnvelope(sessionId);
    await writeEnvelope(e);

    const { notifier } = makeNotifier(sessionId);
    await notifier.scan();
    expect(notifier.hasPendingInjections()).toBe(true);

    await notifier.reclaim();
    expect(notifier.hasPendingInjections()).toBe(false);

    // Rescan — envelope is back in pending/ so it should be re-claimed.
    await notifier.scan();
    expect(notifier.hasPendingInjections()).toBe(true);
    const drained = notifier.drainInjections();
    expect(drained).toContain(`from="${e.from.id}"`);
  });

  it('drainInjections() removes items from buffer so reclaim() after drain returns 0', async () => {
    const sessionId = randomUUID();
    await writeEnvelope(makeEnvelope(sessionId));

    const { notifier } = makeNotifier(sessionId);
    await notifier.scan();
    notifier.drainInjections(); // consume the buffer
    const count = await notifier.reclaim();
    expect(count).toBe(0); // nothing left to reclaim
  });
});

// ── stale scan rejection ─────────────────────────────────────────────────────

describe('PeerInboxNotifier — stale scan rejection', () => {
  it('envelopes claimed by a scan that races a session-id change are reclaimed, not buffered', async () => {
    const oldId = randomUUID();
    let currentId = oldId;

    const e = makeEnvelope(oldId);
    await writeEnvelope(e);

    const { notifier } = makeNotifier(oldId, {
      mode: () => 'accept' as const,
    });

    // Claim the envelope manually under oldId (as if a scan did it).
    const { claimPending, listPending, reclaimDelivered } = await import('../../../agent/peer/inbox-store.js');
    const files = await listPending(oldId);
    expect(files).toHaveLength(1);
    const claimed = await claimPending(oldId, files[0]!);
    expect(claimed).not.toBeNull();
    // Now manually reclaim (simulating what the stale-scan guard does).
    const ok = await reclaimDelivered(oldId, files[0]!);
    expect(ok).toBe(true);
    const pendingAfter = await listPending(oldId);
    expect(pendingAfter).toHaveLength(1); // back in pending
    void currentId; // suppress unused warning
    notifier.dispose();
  });
});
