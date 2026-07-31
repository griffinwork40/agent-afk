/**
 * Unit tests for the /retry slash command.
 *
 * The command's contract: resubmit the last USER message in the session's
 * conversation history via `{ kind: 'submit', message }` — the same
 * pre-fill-and-auto-submit affordance `/plan off` uses (see
 * `src/cli/slash/commands/plan.ts`). It must source that message from
 * `session.current.getHistory()`, NOT `ctx.stats.turns` — a turn that died
 * from a usage-limit error never reaches the turn-completion recorder, so
 * `stats.turns` would be missing exactly the message `/retry` needs to
 * resubmit.
 *
 * @module cli/slash/commands/retry.test
 */

import { describe, it, expect } from 'vitest';
import { retryCmd } from './retry.js';
import type { SlashContext } from '../types.js';
import type { Message } from '../../../agent/types/message-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedCtx extends SlashContext {
  infos: string[];
}

/** Build a SlashContext whose `session.current.getHistory()` returns `history`. */
function makeCtx(history: Message[]): CapturedCtx {
  const infos: string[] = [];

  const session = {
    current: {
      getHistory: (): readonly Message[] => history,
    },
  } as unknown as SlashContext['session'];

  const ctx: CapturedCtx = {
    infos,
    session,
    stats: {} as SlashContext['stats'],
    out: {
      line: () => {},
      raw: () => {},
      success: () => {},
      info: (s: string) => { infos.push(s); },
      warn: () => {},
      error: () => {},
    },
    ui: {} as SlashContext['ui'],
  };
  return ctx;
}

function msg(role: 'user' | 'assistant', content: string): Message {
  return { role, content, timestamp: new Date() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/retry', () => {
  it('resubmits the last user message via { kind: "submit" }', async () => {
    const ctx = makeCtx([msg('user', 'what is the capital of France?')]);

    const result = await retryCmd.handler(ctx, '');

    expect(result).toEqual({ kind: 'submit', message: 'what is the capital of France?' });
  });

  it('returns an informational result when history is empty — no crash, no empty submit', async () => {
    const ctx = makeCtx([]);

    const result = await retryCmd.handler(ctx, '');

    expect(result).toBe('continue');
    expect(ctx.infos.length).toBeGreaterThan(0);
    // Must not be a submit of any kind, empty or otherwise.
    expect(result).not.toEqual(expect.objectContaining({ kind: 'submit' }));
  });

  it('finds the last user message when history ends in an assistant reply', async () => {
    // A turn that completed normally: user asked, assistant answered. /retry
    // should still resolve to the user's message (regenerate semantics) —
    // scanning backward past the trailing assistant entry, not bailing out
    // because the last role isn't 'user'.
    const ctx = makeCtx([
      msg('user', 'summarize the README'),
      msg('assistant', 'Here is a summary...'),
    ]);

    const result = await retryCmd.handler(ctx, '');

    expect(result).toEqual({ kind: 'submit', message: 'summarize the README' });
  });

  it('picks the MOST RECENT user message, not the first, when several exist', async () => {
    const ctx = makeCtx([
      msg('user', 'first question'),
      msg('assistant', 'first answer'),
      msg('user', 'second question'),
      msg('assistant', 'second answer'),
      msg('user', 'third question — the dead turn'),
    ]);

    const result = await retryCmd.handler(ctx, '');

    expect(result).toEqual({ kind: 'submit', message: 'third question — the dead turn' });
  });

  it('returns an informational result when history has messages but none are from the user', async () => {
    const ctx = makeCtx([msg('assistant', 'a stray assistant-only entry')]);

    const result = await retryCmd.handler(ctx, '');

    expect(result).toBe('continue');
    expect(ctx.infos.length).toBeGreaterThan(0);
  });

  it('registers a name and summary for /help and the autocomplete dropdown', () => {
    expect(retryCmd.name).toBe('/retry');
    expect(retryCmd.summary.length).toBeGreaterThan(0);
  });
});
