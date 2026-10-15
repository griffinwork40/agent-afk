/**
 * Tests for the /name ↔ peerNotifier.setName wiring.
 *
 * Verifies that `/name <slug>` calls `peerNotifier.setName` with the
 * same slug so the peer presence file is updated immediately.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nameCmd, setNamePeerNotifier } from './name.js';
import type { PeerInboxNotifier } from '../../commands/interactive/peer-inbox-notifier.js';
import type { SlashContext, SessionStats } from '../types.js';

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env['HOME'];
  tmpHome = join(tmpdir(), `afk-name-peer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env['HOME'] = tmpHome; // audit-env-access: allow — test isolation for session-store
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  if (originalHome !== undefined) process.env['HOME'] = originalHome;
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

function makeCtx(stats: SessionStats): { ctx: SlashContext } {
  const ctx: SlashContext = {
    session: {} as SlashContext['session'],
    stats,
    out: {
      line: vi.fn(),
      raw: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  } as unknown as SlashContext;
  return { ctx };
}

function makeNotifierStub(): PeerInboxNotifier {
  return {
    setName: vi.fn().mockResolvedValue(undefined),
    forceAccept: vi.fn(),
    hasPendingInjections: () => false,
    drainInjections: () => '',
    onInjectable: null,
    start: vi.fn(),
    dispose: vi.fn(),
    scan: vi.fn(),
  } as unknown as PeerInboxNotifier;
}

describe('/name ↔ peerNotifier.setName wiring', () => {
  it('calls setName with the slugified label when a notifier is wired', async () => {
    const notifier = makeNotifierStub();
    setNamePeerNotifier(notifier);
    const { ctx } = makeCtx(makeStats());
    await nameCmd.handler(ctx, 'My Worker Session');
    expect(notifier.setName).toHaveBeenCalledWith('my-worker-session');
  });

  it('does not call setName when arg is empty (no-arg / show path)', async () => {
    const notifier = makeNotifierStub();
    setNamePeerNotifier(notifier);
    const { ctx } = makeCtx(makeStats({ name: 'existing' }));
    await nameCmd.handler(ctx, '');
    expect(notifier.setName).not.toHaveBeenCalled();
  });

  it('does not call setName on an invalid name', async () => {
    const notifier = makeNotifierStub();
    setNamePeerNotifier(notifier);
    const { ctx } = makeCtx(makeStats());
    await nameCmd.handler(ctx, '!!!');
    expect(notifier.setName).not.toHaveBeenCalled();
  });

  it('sets stats.name to the same slug passed to setName', async () => {
    const notifier = makeNotifierStub();
    setNamePeerNotifier(notifier);
    const stats = makeStats();
    const { ctx } = makeCtx(stats);
    await nameCmd.handler(ctx, 'cool session');
    expect(stats.name).toBe('cool-session');
    expect(notifier.setName).toHaveBeenCalledWith('cool-session');
  });
});
