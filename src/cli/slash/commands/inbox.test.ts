/**
 * Tests for the /inbox slash command.
 *
 * Each test case redirects AFK_STATE_DIR to a temp dir so disk operations
 * (writeEnvelope, holdPending, listHeld, dropHeld) are isolated and never
 * touch the developer's real ~/.afk.
 */

import { describe, it, expect, beforeEach, afterEach, vi, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inboxCmd, setPeerNotifier } from './inbox.js';
import { writeEnvelope, holdPending, listPending } from '../../../agent/peer/inbox-store.js';
import type { PeerInboxNotifier } from '../../commands/interactive/peer-inbox-notifier.js';
import type { SlashContext, SessionStats } from '../types.js';
import type { PeerEnvelope } from '../../../agent/peer/envelope.js';

// ---------------------------------------------------------------------------
// Test plumbing
// ---------------------------------------------------------------------------

let tmpDir: string;
let prevStateDir: string | undefined;

beforeEach(() => {
  prevStateDir = process.env['AFK_STATE_DIR'];
  tmpDir = mkdtempSync(join(tmpdir(), 'afk-inbox-test-'));
  process.env['AFK_STATE_DIR'] = tmpDir; // audit-env-access: allow — test isolation
});

afterEach(() => {
  if (prevStateDir !== undefined) {
    process.env['AFK_STATE_DIR'] = prevStateDir;
  } else {
    delete process.env['AFK_STATE_DIR'];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    permissionMode: 'default',
    ...overrides,
  };
}

function makeCtx(stats: SessionStats): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: {} as SlashContext['session'],
    stats,
    out: {
      line: (t = ''): void => { lines.push(`LINE:${t}`); },
      raw: (t): void => { lines.push(`RAW:${t}`); },
      success: (t): void => { lines.push(`SUCCESS:${t}`); },
      info: (t): void => { lines.push(`INFO:${t}`); },
      warn: (t): void => { lines.push(`WARN:${t}`); },
      error: (t): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  } as unknown as SlashContext;
  return { ctx, lines };
}

/** Build a minimal PeerEnvelope. */
function makeEnvelope(overrides: Partial<PeerEnvelope> = {}): PeerEnvelope {
  return {
    v: 1,
    messageId: 'msg-' + Math.random().toString(36).slice(2, 10),
    from: { id: 'peer-session-id-abcdef', name: 'peer' },
    to: 'target-session',
    hop: 0,
    ts: new Date().toISOString(),
    body: 'Hello from peer',
    ...overrides,
  };
}

/** Write an envelope then hold it (pending → held). */
async function writeAndHold(sessionId: string, env: PeerEnvelope): Promise<string> {
  await writeEnvelope({ ...env, to: sessionId });
  const files = await listPending(sessionId);
  const file = files[files.length - 1]!;
  await holdPending(sessionId, file);
  return file;
}

/** Make a minimal stub PeerInboxNotifier. */
function makeNotifierStub(sessionId: string): PeerInboxNotifier {
  return {
    forceAccept: vi.fn().mockResolvedValue(1),
    setName: vi.fn().mockResolvedValue(undefined),
    hasPendingInjections: () => false,
    drainInjections: () => '',
    onInjectable: null,
    start: vi.fn(),
    dispose: vi.fn(),
    scan: vi.fn(),
  } as unknown as PeerInboxNotifier;
}

// Strip ANSI escapes for simpler assertions.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
function clean(lines: string[]): string {
  return lines.map((l) => l.replace(ANSI, '')).join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/inbox — no notifier wired', () => {
  it('prints an error when no notifier is wired', async () => {
    setPeerNotifier(undefined as unknown as PeerInboxNotifier, () => 'session-123');
    const { ctx, lines } = makeCtx(makeStats());
    const result = await inboxCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(clean(lines)).toMatch(/error.*not available/i);
  });
});

describe('/inbox — no session id yet', () => {
  it('warns when no session id is known (before first turn)', async () => {
    const notifier = makeNotifierStub('none');
    setPeerNotifier(notifier, () => undefined);
    const { ctx, lines } = makeCtx(makeStats());
    const result = await inboxCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(clean(lines)).toMatch(/warn.*no session id.*before the first turn/i);
  });
});

describe('/inbox list', () => {
  it('shows "no held messages" when inbox is empty', async () => {
    const sessionId = 'sess-empty-' + Math.random().toString(36).slice(2, 8);
    const notifier = makeNotifierStub(sessionId);
    setPeerNotifier(notifier, () => sessionId);
    const { ctx, lines } = makeCtx(makeStats({ sessionId }));
    await inboxCmd.handler(ctx, '');
    expect(clean(lines)).toMatch(/no held messages/i);
  });

  it('lists held envelopes with id, from, age, preview', async () => {
    const sessionId = 'sess-list-' + Math.random().toString(36).slice(2, 8);
    const env = makeEnvelope({ to: sessionId, body: 'A test message body', from: { id: 'abcdef123456', name: 'worker' } });
    await writeAndHold(sessionId, env);

    const notifier = makeNotifierStub(sessionId);
    setPeerNotifier(notifier, () => sessionId);
    const { ctx, lines } = makeCtx(makeStats({ sessionId }));
    await inboxCmd.handler(ctx, '');
    const output = clean(lines);
    expect(output).toContain(env.messageId.slice(0, 8));
    expect(output).toMatch(/worker/);
    expect(output).toMatch(/A test message body/);
  });
});

describe('/inbox accept', () => {
  it('calls forceAccept("all") when no prefix given', async () => {
    const sessionId = 'sess-accept-' + Math.random().toString(36).slice(2, 8);
    const env = makeEnvelope({ to: sessionId });
    await writeAndHold(sessionId, env);

    const notifier = makeNotifierStub(sessionId);
    setPeerNotifier(notifier, () => sessionId);
    const { ctx, lines } = makeCtx(makeStats({ sessionId }));
    await inboxCmd.handler(ctx, 'accept all');
    expect(notifier.forceAccept).toHaveBeenCalledWith('all');
    expect(clean(lines)).toMatch(/accepted.*1/i);
    expect(clean(lines)).toMatch(/next turn/i);
  });

  it('calls forceAccept with matched ids when a prefix is given', async () => {
    const sessionId = 'sess-accept-pfx-' + Math.random().toString(36).slice(2, 8);
    const env = makeEnvelope({ to: sessionId });
    await writeAndHold(sessionId, env);
    const prefix = env.messageId.slice(0, 6);

    // Override forceAccept to just accept and return count
    const notifier = {
      ...makeNotifierStub(sessionId),
      forceAccept: vi.fn().mockResolvedValue(1),
    } as unknown as PeerInboxNotifier;
    setPeerNotifier(notifier, () => sessionId);
    const { ctx, lines } = makeCtx(makeStats({ sessionId }));
    await inboxCmd.handler(ctx, `accept ${prefix}`);
    expect(notifier.forceAccept).toHaveBeenCalledWith(new Set([env.messageId]));
    expect(clean(lines)).toMatch(/accepted.*1/i);
  });

  it('warns when prefix matches nothing', async () => {
    const sessionId = 'sess-accept-nomatch-' + Math.random().toString(36).slice(2, 8);
    const env = makeEnvelope({ to: sessionId });
    await writeAndHold(sessionId, env);

    const notifier = makeNotifierStub(sessionId);
    setPeerNotifier(notifier, () => sessionId);
    const { ctx, lines } = makeCtx(makeStats({ sessionId }));
    await inboxCmd.handler(ctx, 'accept zzzzzzz');
    expect(clean(lines)).toMatch(/warn.*no held message.*starts with/i);
    expect(notifier.forceAccept).not.toHaveBeenCalled();
  });
});

describe('/inbox drop', () => {
  it('drops a held envelope by id prefix', async () => {
    const sessionId = 'sess-drop-' + Math.random().toString(36).slice(2, 8);
    const env = makeEnvelope({ to: sessionId });
    await writeAndHold(sessionId, env);

    const notifier = makeNotifierStub(sessionId);
    setPeerNotifier(notifier, () => sessionId);
    const { ctx, lines } = makeCtx(makeStats({ sessionId }));
    const prefix = env.messageId.slice(0, 6);
    await inboxCmd.handler(ctx, `drop ${prefix}`);
    expect(clean(lines)).toMatch(/dropped 1/i);
  });

  it('drops all held envelopes with "drop all"', async () => {
    const sessionId = 'sess-drop-all-' + Math.random().toString(36).slice(2, 8);
    await writeAndHold(sessionId, makeEnvelope({ to: sessionId }));
    await writeAndHold(sessionId, makeEnvelope({ to: sessionId }));

    const notifier = makeNotifierStub(sessionId);
    setPeerNotifier(notifier, () => sessionId);
    const { ctx, lines } = makeCtx(makeStats({ sessionId }));
    await inboxCmd.handler(ctx, 'drop all');
    expect(clean(lines)).toMatch(/dropped 2/i);
  });

  it('drops a corrupt held entry by filename prefix', async () => {
    const sessionId = 'sess-drop-corrupt-' + Math.random().toString(36).slice(2, 8);
    // Write a valid held envelope first.
    const env = makeEnvelope({ to: sessionId });
    await writeAndHold(sessionId, env);
    // Manually create a corrupt held file.
    const heldDir = join(tmpDir, 'inbox', sessionId, 'held');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(heldDir, 'corrupt-file.json'), 'NOT-JSON', { mode: 0o600 });

    const notifier = makeNotifierStub(sessionId);
    setPeerNotifier(notifier, () => sessionId);
    const { ctx, lines } = makeCtx(makeStats({ sessionId }));
    // Drop only the corrupt entry by its filename prefix.
    await inboxCmd.handler(ctx, 'drop corrupt');
    expect(clean(lines)).toMatch(/dropped 1/i);
    // The valid entry should still be there.
    const { listHeld } = await import('../../../agent/peer/inbox-store.js');
    const remaining = await listHeld(sessionId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.corrupt).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// AFK_PEER_INBOUND typo visibility (#2820 item 3)
// ---------------------------------------------------------------------------

describe('/inbox list — AFK_PEER_INBOUND typo warning', () => {
  // Reset modules so getPeerInboundModeConfig re-reads the env in each test.
  beforeEach(() => { vi.resetModules(); });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('shows the resolved mode line when AFK_PEER_INBOUND is valid', async () => {
    vi.stubEnv('AFK_PEER_INBOUND', 'hold');
    const sessionId = 'sess-mode-valid-' + Math.random().toString(36).slice(2, 8);
    const notifier = makeNotifierStub(sessionId);
    setPeerNotifier(notifier, () => sessionId);
    const { ctx, lines } = makeCtx(makeStats({ sessionId }));
    await inboxCmd.handler(ctx, '');
    const output = clean(lines);
    expect(output).toContain('AFK_PEER_INBOUND=hold');
    // No typo warning for a valid value.
    expect(output).not.toMatch(/is not recognised/i);
  });

  it('emits a WARN line when AFK_PEER_INBOUND is a typo like "hol"', async () => {
    vi.stubEnv('AFK_PEER_INBOUND', 'hol');
    const sessionId = 'sess-mode-typo-' + Math.random().toString(36).slice(2, 8);
    const notifier = makeNotifierStub(sessionId);
    setPeerNotifier(notifier, () => sessionId);
    const { ctx, lines } = makeCtx(makeStats({ sessionId }));
    await inboxCmd.handler(ctx, '');
    const output = clean(lines);
    // Mode line shows the fallback 'accept' (not the typo).
    expect(output).toContain('AFK_PEER_INBOUND=accept');
    // A WARN line must surface the raw typo so the operator notices without AFK_DEBUG=1.
    const warnLine = lines.find((l) => l.startsWith('WARN:') && l.includes('hol'));
    expect(warnLine).toBeDefined();
    expect(warnLine).toMatch(/is not recognised/i);
  });

  it('caps the echoed raw value at 20 chars in the warning', async () => {
    const longValue = 'z'.repeat(50);
    vi.stubEnv('AFK_PEER_INBOUND', longValue);
    const sessionId = 'sess-mode-long-' + Math.random().toString(36).slice(2, 8);
    const notifier = makeNotifierStub(sessionId);
    setPeerNotifier(notifier, () => sessionId);
    const { ctx, lines } = makeCtx(makeStats({ sessionId }));
    await inboxCmd.handler(ctx, '');
    const warnLine = lines.find((l) => l.startsWith('WARN:'));
    expect(warnLine).toBeDefined();
    // The truncated value (20 z's + "…") must appear, not all 50 z's.
    expect(warnLine).toContain('z'.repeat(20) + '…');
    expect(warnLine).not.toContain('z'.repeat(21));
  });
});
