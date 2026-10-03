/**
 * Tests for src/telegram/handlers/reaction.ts
 *
 * Covers:
 *  - 👍 on a mapped bot message records succeeded (vote +1)
 *  - 👎 on a mapped bot message records failed (vote -1)
 *  - Reaction on an unmapped message is silently ignored
 *  - Reaction update where the user is NOT the actor doesn't matter (no special
 *    guard needed — the reaction still carries new_reaction)
 *  - Removing a reaction (emoji in old, absent in new) adds no vote
 *  - Changing 👍 to 👎 records the newer verdict
 *  - Non-thumbs reactions are ignored
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context, Update } from 'telegraf';
import { resolveThumbsVerdict, handleMessageReaction } from './reaction.js';
import { ReactionMap } from '../reaction-map.js';

// ---------------------------------------------------------------------------
// Mock upsertVotes so no disk I/O happens
// ---------------------------------------------------------------------------
vi.mock('../../agent/outcomes/store.js', () => ({
  upsertVotes: vi.fn(),
}));

import { upsertVotes } from '../../agent/outcomes/store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(
  chatId: number,
  messageId: number,
  oldEmojis: string[],
  newEmojis: string[],
): Context<Update.MessageReactionUpdate> {
  const toReactions = (emojis: string[]) =>
    emojis.map((emoji) => ({ type: 'emoji' as const, emoji }));

  return {
    update: {
      message_reaction: {
        chat: { id: chatId, type: 'private' as const },
        message_id: messageId,
        old_reaction: toReactions(oldEmojis),
        new_reaction: toReactions(newEmojis),
      },
    },
  } as unknown as Context<Update.MessageReactionUpdate>;
}

// ---------------------------------------------------------------------------
// resolveThumbsVerdict unit tests
// ---------------------------------------------------------------------------

describe('resolveThumbsVerdict', () => {
  it('returns "good" when 👍 is added', () => {
    expect(resolveThumbsVerdict([], ['👍'])).toBe('good');
  });

  it('returns "bad" when 👎 is added', () => {
    expect(resolveThumbsVerdict([], ['👎'])).toBe('bad');
  });

  it('returns null when no thumbs are added', () => {
    expect(resolveThumbsVerdict([], ['❤️'])).toBeNull();
    expect(resolveThumbsVerdict([], [])).toBeNull();
  });

  it('returns null when 👍 is removed (present in old, absent in new)', () => {
    expect(resolveThumbsVerdict(['👍'], [])).toBeNull();
  });

  it('returns null when 👍 is kept (present in both)', () => {
    expect(resolveThumbsVerdict(['👍'], ['👍'])).toBeNull();
  });

  it('returns "good" when changing 👎 to 👍 (👍 added, 👎 removed)', () => {
    expect(resolveThumbsVerdict(['👎'], ['👍'])).toBe('good');
  });

  it('returns "bad" when changing 👍 to 👎', () => {
    expect(resolveThumbsVerdict(['👍'], ['👎'])).toBe('bad');
  });

  it('prefers 👍 when both thumbs appear in new_reaction', () => {
    // Unusual but theoretically possible
    expect(resolveThumbsVerdict([], ['👍', '👎'])).toBe('good');
  });
});

// ---------------------------------------------------------------------------
// handleMessageReaction integration tests
// ---------------------------------------------------------------------------

describe('handleMessageReaction', () => {
  let map: ReactionMap;
  const log = vi.fn();

  beforeEach(() => {
    map = new ReactionMap();
    vi.mocked(upsertVotes).mockClear();
    log.mockClear();
  });

  it('records succeeded when 👍 is added on a mapped bot message', async () => {
    map.set(100, 42, 'session-abc');
    const ctx = makeCtx(100, 42, [], ['👍']);

    await handleMessageReaction(ctx, map, log);

    expect(upsertVotes).toHaveBeenCalledOnce();
    const [sessionId, votes] = vi.mocked(upsertVotes).mock.calls[0] as [string, Array<{ vote: number; lf: string }>];
    expect(sessionId).toBe('session-abc');
    expect(votes[0].vote).toBe(1);
    expect(votes[0].lf).toBe('explicit_feedback');
  });

  it('records failed when 👎 is added on a mapped bot message', async () => {
    map.set(100, 42, 'session-abc');
    const ctx = makeCtx(100, 42, [], ['👎']);

    await handleMessageReaction(ctx, map, log);

    expect(upsertVotes).toHaveBeenCalledOnce();
    const [, votes] = vi.mocked(upsertVotes).mock.calls[0] as [string, Array<{ vote: number }>];
    expect(votes[0].vote).toBe(-1);
  });

  it('ignores reactions on unmapped messages', async () => {
    // map is empty — no mapping for message 99
    const ctx = makeCtx(100, 99, [], ['👍']);

    await handleMessageReaction(ctx, map, log);

    expect(upsertVotes).not.toHaveBeenCalled();
  });

  it('ignores reactions on messages in a different chat even with same message_id', async () => {
    map.set(100, 42, 'session-abc');
    // Different chat id (200 vs 100)
    const ctx = makeCtx(200, 42, [], ['👍']);

    await handleMessageReaction(ctx, map, log);

    expect(upsertVotes).not.toHaveBeenCalled();
  });

  it('ignores removal of 👍 (present in old, absent in new)', async () => {
    map.set(100, 42, 'session-abc');
    const ctx = makeCtx(100, 42, ['👍'], []);

    await handleMessageReaction(ctx, map, log);

    expect(upsertVotes).not.toHaveBeenCalled();
  });

  it('records the new verdict when changing 👍 to 👎', async () => {
    map.set(100, 42, 'session-abc');
    const ctx = makeCtx(100, 42, ['👍'], ['👎']);

    await handleMessageReaction(ctx, map, log);

    expect(upsertVotes).toHaveBeenCalledOnce();
    const [, votes] = vi.mocked(upsertVotes).mock.calls[0] as [string, Array<{ vote: number }>];
    expect(votes[0].vote).toBe(-1);
  });

  it('ignores non-thumbs reactions', async () => {
    map.set(100, 42, 'session-abc');
    const ctx = makeCtx(100, 42, [], ['❤️', '🔥']);

    await handleMessageReaction(ctx, map, log);

    expect(upsertVotes).not.toHaveBeenCalled();
  });
});
