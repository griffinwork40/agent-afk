/**
 * Regression: LLM ghost-text suggestions were truncated mid-word.
 *
 * The Tier-2 prompt asked the model to echo the WHOLE line under a 24-token
 * cap, so the echoed buffer consumed the budget: a ~50-char input left room
 * for a few words, a ~77-char input for a fragment, and the cut-off reply was
 * shown and cached for the session. These tests drive the real engine with a
 * stub that models a provider honouring the token cap (~4 chars per token)
 * and reporting `max_tokens` when it cuts.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSuggestEngine, type SuggestContext } from './suggest.js';
import { LLM_MAX_TOKENS } from './suggest-tier2.js';
import { trailingWord } from './suggest-reply.js';
import type { CompleteRequest } from './suggest-types.js';

const CHARS_PER_TOKEN = 4;
const CONTINUATION = ' and then open a draft pull request against main with a summary';
/** Longer than the whole token budget, so the stub must cut it. */
const OVERFLOW = CONTINUATION + ' and then request a review from the maintainers of the input package';

function makeCtx(): SuggestContext {
  return {
    model: 'claude-sonnet-4-5',
    cwd: '/home/user/agent-afk',
    getHistory: () => [],
    getDropdownTopCandidate: () => null,
    getTranscriptTail: () => '',
    getRecentCommands: () => [],
    llmEnabled: () => true,
  };
}

function bufferOf(req: CompleteRequest): string {
  return req.user.split('input: ')[1] ?? '';
}

/** Cap `reply` at the request's token budget, reporting max_tokens when cut. */
function capped(reply: string, req: CompleteRequest) {
  const limit = req.maxTokens * CHARS_PER_TOKEN;
  return reply.length > limit
    ? { text: reply.slice(0, limit).trim(), stopReason: 'max_tokens' as const }
    : { text: reply.trim(), stopReason: 'end' as const };
}

describe('Tier-2 ghost text: truncation regression', () => {
  it('gives every buffer length the same continuation budget (echo no longer eats it)', async () => {
    // A provider following the prompt: trailing word + continuation.
    const completeFn = vi.fn(async (req: CompleteRequest) =>
      capped(trailingWord(bufferOf(req)) + CONTINUATION, req),
    );
    const engine = createSuggestEngine({ debounceMs: 0, completeFn });

    for (const buffer of [
      'fix the',
      'can you fix the failing test in suggest-tier2 and',
      'please review the ghost text truncation bug in the compositor render path and',
    ]) {
      // Before the fix the 49- and 77-char buffers came back as
      // "...against mai" and " and then open a dr".
      expect(await engine.getGhost(buffer, makeCtx())).toBe(buffer + CONTINUATION);
    }
  });

  it('never shows a word cut mid-way when the reply hits the token cap', async () => {
    const completeFn = vi.fn(async (req: CompleteRequest) =>
      capped(trailingWord(bufferOf(req)) + OVERFLOW, req),
    );
    const engine = createSuggestEngine({ debounceMs: 0, completeFn });
    const buffer = 'git commit';

    const ghost = await engine.getGhost(buffer, makeCtx());

    expect(ghost).not.toBeNull();
    const fullLine = buffer + OVERFLOW;
    // The stub really did cut the reply (otherwise this test proves nothing).
    expect(ghost!.length).toBeLessThan(fullLine.length);
    // Every word shown is a whole word of the intended line.
    expect(fullLine.startsWith(ghost!)).toBe(true);
    expect(fullLine[ghost!.length]).toBe(' ');
  });

  it('does not cache a truncated reply, so a later clean reply can replace it', async () => {
    let calls = 0;
    const completeFn = vi.fn(async (req: CompleteRequest) => {
      calls += 1;
      const word = trailingWord(bufferOf(req));
      return calls === 1
        ? { text: `${word} and then op`, stopReason: 'max_tokens' as const }
        : { text: `${word} and then open a PR`, stopReason: 'end' as const };
    });
    const engine = createSuggestEngine({ debounceMs: 0, completeFn });

    expect(await engine.getGhost('ship it', makeCtx())).toBe('ship it and then');
    expect(await engine.getGhost('ship it', makeCtx())).toBe('ship it and then open a PR');
    expect(completeFn).toHaveBeenCalledTimes(2);
    // The clean reply IS cached.
    expect(await engine.getGhost('ship it', makeCtx())).toBe('ship it and then open a PR');
    expect(completeFn).toHaveBeenCalledTimes(2);
  });

  it('a truncated reply with no complete new word yields no ghost rather than a fragment', async () => {
    const engine = createSuggestEngine({
      debounceMs: 0,
      completeFn: async () => ({ text: 'it partialwo', stopReason: 'max_tokens' as const }),
    });
    expect(await engine.getGhost('ship it', makeCtx())).toBeNull();
  });

  it('tells the model the trailing word to repeat', async () => {
    const completeFn = vi.fn(async (_req: CompleteRequest) => 'th the bug');
    const engine = createSuggestEngine({ debounceMs: 0, completeFn });

    await engine.getGhost('fix th', makeCtx());

    const req = completeFn.mock.calls[0]![0];
    expect(req.user).toContain('final word: th');
    expect(req.maxTokens).toBe(LLM_MAX_TOKENS);
    expect(req.system).toMatch(/final word exactly as typed/);
  });

  it('caches a null result for a non-truncated unjoinable reply', async () => {
    // Invariant: joined === null && !reply.truncated → result is null, and that
    // null IS cached so the engine does not re-fire for this buffer on the next
    // keystroke-triggered request.
    let calls = 0;
    const completeFn = vi.fn(async (_req: CompleteRequest) => {
      calls += 1;
      // Unjoinable: reply shares no prefix with the buffer's trailing word.
      return { text: 'something completely unrelated', stopReason: 'end' as const };
    });
    const engine = createSuggestEngine({ debounceMs: 0, completeFn });

    // First call: miss → fires LLM → unjoinable → null, cached.
    expect(await engine.getGhost('ship it', makeCtx())).toBeNull();
    expect(calls).toBe(1);

    // Second call: same buffer → cache hit → null, no second LLM call.
    expect(await engine.getGhost('ship it', makeCtx())).toBeNull();
    expect(calls).toBe(1);
  });

  it('journals a truncated reply with the trimmed text the user actually sees', async () => {
    const onRecord = vi.fn();
    const engine = createSuggestEngine({
      debounceMs: 0,
      onRecord,
      completeFn: async () => ({ text: 'it and then op', stopReason: 'max_tokens' as const }),
    });

    expect(await engine.getGhost('ship it', makeCtx())).toBe('ship it and then');
    expect(onRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'generated', source: 'completion', text: 'ship it and then' }),
    );
  });
});
