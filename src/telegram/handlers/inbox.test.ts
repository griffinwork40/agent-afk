/**
 * Tests for the Telegram /inbox command handler.
 *
 * Uses a temp AFK_STATE_DIR so disk operations never touch the developer's
 * real ~/.afk. Mirrors the pattern used in src/cli/slash/commands/inbox.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from 'telegraf';
import { handleInbox } from './inbox.js';
import {
  writeEnvelope,
  holdPending,
  listHeld,
  listPending,
} from '../../agent/peer/inbox-store.js';
import type { PeerEnvelope } from '../../agent/peer/envelope.js';

// ---------------------------------------------------------------------------
// Test plumbing
// ---------------------------------------------------------------------------

let tmpDir: string;
let prevStateDir: string | undefined;

beforeEach(() => {
  prevStateDir = process.env['AFK_STATE_DIR'];
  tmpDir = mkdtempSync(join(tmpdir(), 'afk-tg-inbox-test-'));
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

/** Build a minimal PeerEnvelope. */
function makeEnvelope(overrides: Partial<PeerEnvelope> = {}): PeerEnvelope {
  return {
    v: 1,
    messageId: 'msg-' + Math.random().toString(36).slice(2, 10),
    from: { id: 'peer-session-abcdef', name: 'peer' },
    to: 'test-session-id',
    ts: new Date().toISOString(),
    body: 'Hello from peer',
    hop: 0,
    ...overrides,
  };
}

/** Typed mock Telegraf Context with captured reply calls. */
type MockContext = Context & { replyCalls: Array<[string, unknown?]> };

/** Build a mock Telegraf Context. */
function makeCtx(commandText = '/inbox'): { ctx: MockContext } {
  const replyCalls: Array<[string, unknown?]> = [];
  const ctx = {
    message: { text: commandText },
    chat: { id: 42 },
    reply: vi.fn(async (text: string, opts?: unknown) => {
      replyCalls.push([text, opts]);
    }),
    replyCalls,
  } as unknown as MockContext;
  return { ctx };
}

/** Build a mock SessionManager. */
function makeSessionManager(sessionId: string | undefined) {
  return {
    getSessionId: vi.fn(() => sessionId),
  } as unknown as import('../session-manager.js').SessionManager;
}

const SESSION_ID = 'test-session-id';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleInbox — no session', () => {
  it('replies with guidance when no session is active', async () => {
    const { ctx } = makeCtx('/inbox');
    const sm = makeSessionManager(undefined);
    await handleInbox(ctx, sm);
    expect(ctx.reply).toHaveBeenCalledOnce();
    const [text] = ctx.replyCalls[0]!;
    expect(text).toContain('No session active yet');
  });
});

describe('handleInbox list', () => {
  it('reports empty inbox', async () => {
    const { ctx } = makeCtx('/inbox');
    const sm = makeSessionManager(SESSION_ID);
    await handleInbox(ctx, sm);
    const [text] = ctx.replyCalls[0]!;
    expect(text).toContain('No held messages');
  });

  it('lists held messages with from/age/preview', async () => {
    const env = makeEnvelope({ to: SESSION_ID, body: 'ping from peer' });
    await writeEnvelope(env);
    const pending = await (await import('../../agent/peer/inbox-store.js')).listPending(SESSION_ID);
    await holdPending(SESSION_ID, pending[0]!);

    const { ctx } = makeCtx('/inbox');
    const sm = makeSessionManager(SESSION_ID);
    await handleInbox(ctx, sm);

    const [text, opts] = ctx.replyCalls[0]!;
    expect((opts as { parse_mode?: string })?.parse_mode).toBe('HTML');
    expect(text).toContain(env.messageId.slice(0, 8));
    expect(text).toContain('peer');
    expect(text).toContain('ping from peer');
  });
});

describe('handleInbox release', () => {
  it('releases all held messages', async () => {
    const env = makeEnvelope({ to: SESSION_ID });
    await writeEnvelope(env);
    const pending = await (await import('../../agent/peer/inbox-store.js')).listPending(SESSION_ID);
    await holdPending(SESSION_ID, pending[0]!);

    const { ctx } = makeCtx('/inbox release all');
    const sm = makeSessionManager(SESSION_ID);
    await handleInbox(ctx, sm);

    const [text] = ctx.replyCalls[0]!;
    expect(text).toContain('Accepted 1 message');

    // Held dir should now be empty.
    const stillHeld = await listHeld(SESSION_ID);
    expect(stillHeld).toHaveLength(0);
  });

  it('releases by id prefix', async () => {
    const env = makeEnvelope({ to: SESSION_ID, messageId: 'abcdef1234' });
    await writeEnvelope(env);
    const pending = await (await import('../../agent/peer/inbox-store.js')).listPending(SESSION_ID);
    await holdPending(SESSION_ID, pending[0]!);

    const { ctx } = makeCtx('/inbox release abcdef');
    const sm = makeSessionManager(SESSION_ID);
    await handleInbox(ctx, sm);

    const [text] = ctx.replyCalls[0]!;
    expect(text).toContain('Accepted 1 message');
  });

  it('warns when prefix matches nothing', async () => {
    const env = makeEnvelope({ to: SESSION_ID });
    await writeEnvelope(env);
    const pending = await (await import('../../agent/peer/inbox-store.js')).listPending(SESSION_ID);
    await holdPending(SESSION_ID, pending[0]!);

    const { ctx } = makeCtx('/inbox release zzznomatch');
    const sm = makeSessionManager(SESSION_ID);
    await handleInbox(ctx, sm);

    const [text] = ctx.replyCalls[0]!;
    expect(text).toContain('No held message id starts with');
  });

  it('replies empty when no held messages', async () => {
    const { ctx } = makeCtx('/inbox release all');
    const sm = makeSessionManager(SESSION_ID);
    await handleInbox(ctx, sm);
    const [text] = ctx.replyCalls[0]!;
    expect(text).toContain('No held messages to release');
  });
});

describe('handleInbox drop', () => {
  it('drops all held messages', async () => {
    const env = makeEnvelope({ to: SESSION_ID });
    await writeEnvelope(env);
    const pending = await (await import('../../agent/peer/inbox-store.js')).listPending(SESSION_ID);
    await holdPending(SESSION_ID, pending[0]!);

    const { ctx } = makeCtx('/inbox drop all');
    const sm = makeSessionManager(SESSION_ID);
    await handleInbox(ctx, sm);

    const [text] = ctx.replyCalls[0]!;
    expect(text).toContain('Dropped 1 message');

    const stillHeld = await listHeld(SESSION_ID);
    expect(stillHeld).toHaveLength(0);
  });

  it('drops by id prefix', async () => {
    const env = makeEnvelope({ to: SESSION_ID, messageId: 'xyzabc9999' });
    await writeEnvelope(env);
    const pending = await (await import('../../agent/peer/inbox-store.js')).listPending(SESSION_ID);
    await holdPending(SESSION_ID, pending[0]!);

    const { ctx } = makeCtx('/inbox drop xyzabc');
    const sm = makeSessionManager(SESSION_ID);
    await handleInbox(ctx, sm);

    const [text] = ctx.replyCalls[0]!;
    expect(text).toContain('Dropped 1 message');
  });

  it('warns when prefix matches nothing', async () => {
    const env = makeEnvelope({ to: SESSION_ID });
    await writeEnvelope(env);
    const pending = await (await import('../../agent/peer/inbox-store.js')).listPending(SESSION_ID);
    await holdPending(SESSION_ID, pending[0]!);

    const { ctx } = makeCtx('/inbox drop zzznomatch');
    const sm = makeSessionManager(SESSION_ID);
    await handleInbox(ctx, sm);

    const [text] = ctx.replyCalls[0]!;
    expect(text).toContain('No held message id starts with');
  });
});

describe('handleInbox release — hold-mode delivery', () => {
  it('release claims to delivered so hold-mode rescan cannot re-hold', async () => {
    const env = makeEnvelope({ to: SESSION_ID });
    await writeEnvelope(env);
    const pending = await listPending(SESSION_ID);
    await holdPending(SESSION_ID, pending[0]!);

    const { ctx } = makeCtx('/inbox release all');
    const sm = makeSessionManager(SESSION_ID);
    await handleInbox(ctx, sm);

    const [text] = ctx.replyCalls[0]!;
    expect(text).toContain('Accepted 1 message');

    // The message should NOT be in held anymore.
    const stillHeld = await listHeld(SESSION_ID);
    expect(stillHeld).toHaveLength(0);

    // The message should NOT be in pending (it should be in delivered).
    const stillPending = await listPending(SESSION_ID);
    expect(stillPending).toHaveLength(0);
  });
});

describe('handleInbox list — long message chunking', () => {
  it('chunks long listing across multiple replies', async () => {
    // Create enough held messages to exceed 4096 chars.
    for (let i = 0; i < 60; i++) {
      const env = makeEnvelope({
        to: SESSION_ID,
        body: 'A'.repeat(60),
        messageId: `msg-${String(i).padStart(4, '0')}-${Math.random().toString(36).slice(2, 10)}`,
      });
      await writeEnvelope(env);
    }
    const pending = await listPending(SESSION_ID);
    for (const file of pending) {
      await holdPending(SESSION_ID, file);
    }

    const { ctx } = makeCtx('/inbox');
    const sm = makeSessionManager(SESSION_ID);
    await handleInbox(ctx, sm);

    // Should have been split into multiple replies.
    expect(ctx.replyCalls.length).toBeGreaterThan(1);
    // Each chunk must be under Telegram's 4096-char limit.
    for (const [text] of ctx.replyCalls) {
      expect(text.length).toBeLessThanOrEqual(4096);
    }
  });
});

describe('handleInbox unknown subcommand', () => {
  it('replies with usage hint', async () => {
    const { ctx } = makeCtx('/inbox frobnicate');
    const sm = makeSessionManager(SESSION_ID);
    await handleInbox(ctx, sm);
    const [text] = ctx.replyCalls[0]!;
    expect(text).toContain('Unknown subcommand');
    expect(text).toContain('frobnicate');
  });
});
