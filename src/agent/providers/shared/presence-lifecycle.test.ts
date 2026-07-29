/**
 * Presence session-id RESOLUTION contract (pure unit level).
 *
 * The bug this guards: presence was gated on `config.sessionId`, which is set
 * ONLY under `--resume`/`--continue`. Every fresh top-level session therefore
 * wrote NO presence file, so the Telegram bot's presence-driven auto-subscribe
 * loop (`telegram/bot.ts`, filters `surface === 'cli' && afk === true`) was
 * structurally blind to it, and bidirectional AFK — the agent asking a yes/no
 * question and the operator tapping an inline Telegram button — could never
 * work for a non-resumed session. The real id was minted downstream of the
 * gate, inside query construction, from the *different* `config.resume` field.
 *
 * End-to-end advertisement behavior (real provider, real presence file) lives
 * in `presence-advertise.test.ts`; this file covers the resolver alone.
 */

import { describe, it, expect } from 'vitest';
import { resolveTopLevelSessionId, isTopLevelSession } from './presence-lifecycle.js';

describe('resolveTopLevelSessionId', () => {
  // 'cli' is the default surface for both providers (see each ctor's
  // `opts.surface ?? 'cli'`) and the only surface a presence consumer reads.
  const topLevel = { depth: undefined, parentSessionId: undefined, surface: 'cli' };

  it('mints an id for a fresh top-level session that supplied none (the regression)', () => {
    const out = resolveTopLevelSessionId({
      sessionId: undefined,
      resume: undefined,
      ...topLevel,
      memoized: null,
    });
    // Before the fix this position held `config.sessionId` — undefined — so the
    // presence gate no-opped and no file was ever written.
    expect(out.id).toBeTypeOf('string');
    expect(out.id).not.toBe('');
    expect(out.memoized).toBe(out.id);
  });

  it('is stable across turns once memoized (query() runs once per turn)', () => {
    const first = resolveTopLevelSessionId({
      sessionId: undefined,
      resume: undefined,
      ...topLevel,
      memoized: null,
    });
    const second = resolveTopLevelSessionId({
      sessionId: undefined,
      resume: undefined,
      ...topLevel,
      memoized: first.memoized,
    });
    // A fresh mint per turn would move the ledger directory out from under the
    // presence file the Telegram watcher is already following.
    expect(second.id).toBe(first.id);
  });

  it('lets an explicit config.sessionId win unchanged (resume semantics)', () => {
    const out = resolveTopLevelSessionId({
      sessionId: 'resumed-abc',
      resume: undefined,
      ...topLevel,
      memoized: null,
    });
    expect(out.id).toBe('resumed-abc');
    expect(out.memoized).toBeNull(); // no mint burned
  });

  it('falls back to config.resume when sessionId is absent', () => {
    const out = resolveTopLevelSessionId({
      sessionId: undefined,
      resume: 'continued-xyz',
      ...topLevel,
      memoized: null,
    });
    expect(out.id).toBe('continued-xyz');
    expect(out.memoized).toBeNull();
  });

  it('prefers sessionId over resume when both are present', () => {
    const out = resolveTopLevelSessionId({
      sessionId: 'explicit',
      resume: 'fallback',
      ...topLevel,
      memoized: null,
    });
    expect(out.id).toBe('explicit');
  });

  it('never mints for a fork identified by depth', () => {
    const out = resolveTopLevelSessionId({
      sessionId: undefined,
      resume: undefined,
      depth: 1,
      parentSessionId: undefined,
      surface: 'cli',
      memoized: null,
    });
    // Forks must not inherit or share a minted id — that would collide on the
    // ledger directory. undefined ⇒ query keeps its own per-call mint.
    expect(out.id).toBeUndefined();
    expect(out.memoized).toBeNull();
  });

  it('never mints for a fork identified by parentSessionId', () => {
    const out = resolveTopLevelSessionId({
      sessionId: undefined,
      resume: undefined,
      depth: undefined,
      parentSessionId: 'parent-1',
      surface: 'cli',
      memoized: null,
    });
    expect(out.id).toBeUndefined();
    expect(out.memoized).toBeNull();
  });

  it('mints only on a surface a presence consumer reads', () => {
    // A daemon task or Telegram chat session advertising presence is invisible
    // to both readers (bot.ts filters surface === 'cli'; watch.ts lists live
    // records) while still costing a file + a cleanup registration — that is how
    // a long-running daemon accrued one stale live-looking record per task.
    for (const surface of ['daemon', 'telegram', 'unknown']) {
      const out = resolveTopLevelSessionId({
        sessionId: undefined,
        resume: undefined,
        depth: 0,
        parentSessionId: undefined,
        surface,
        memoized: null,
      });
      expect(out.id, surface).toBeUndefined();
      expect(out.memoized, surface).toBeNull();
    }
  });

  it('still honors an explicit id on a non-minting surface (resume advertises everywhere)', () => {
    // presence-surface.test.ts pins this contract for cli/daemon/telegram: the
    // surface gate applies to the MINT, never to an explicitly supplied id.
    const out = resolveTopLevelSessionId({
      sessionId: 'resumed-daemon-task',
      resume: undefined,
      depth: 0,
      parentSessionId: undefined,
      surface: 'daemon',
      memoized: null,
    });
    expect(out.id).toBe('resumed-daemon-task');
  });

  it('keeps the memoized id across a reset() (/clear) on the same provider instance', () => {
    const first = resolveTopLevelSessionId({
      sessionId: undefined,
      resume: undefined,
      ...topLevel,
      memoized: null,
    });
    // AgentSession.reset() deletes config.resume AND config.sessionId, then
    // rebuilds the query on the SAME provider instance. Id stability is load
    // bearing: the AFK elicitation channel and the remote-abort watcher are
    // bound to the id captured at `/afk on`, and the `afk` marker lives on that
    // id's presence file, so a new mint here would silently strand both.
    const afterClear = resolveTopLevelSessionId({
      sessionId: undefined,
      resume: undefined,
      ...topLevel,
      memoized: first.memoized,
    });
    expect(afterClear.id).toBe(first.id);
    expect(afterClear.memoized).toBe(first.memoized);
  });

  it('resolves a fork to its parent id (subagent.ts threads resume) without minting', () => {
    // subagent.ts sets `resume: options.parent.sessionId` on every child config,
    // so the explicit branch returns the parent id — which is exactly what fork
    // query construction already used. Presence stays blocked by the
    // isTopLevelSession re-gate in registerPresenceLifecycle, asserted e2e below.
    const out = resolveTopLevelSessionId({
      sessionId: undefined,
      resume: 'parent-session-id',
      depth: 1,
      parentSessionId: 'parent-session-id',
      surface: 'cli',
      memoized: null,
    });
    expect(out.id).toBe('parent-session-id');
    expect(out.memoized).toBeNull();
  });
});

describe('isTopLevelSession', () => {
  it('treats depth 0 / undefined with no parent as top-level', () => {
    expect(isTopLevelSession(undefined, undefined)).toBe(true);
    expect(isTopLevelSession(0, undefined)).toBe(true);
  });

  it('treats any depth > 0 or any parent id as a fork', () => {
    expect(isTopLevelSession(1, undefined)).toBe(false);
    expect(isTopLevelSession(0, 'parent')).toBe(false);
  });
});
