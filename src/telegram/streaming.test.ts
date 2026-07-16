/**
 * Tests for Telegram streaming (token/chunk-by-chunk updates)
 */

import { describe, it, expect, vi } from 'vitest';
import { streamResponse, StreamTimeoutError, renderSubagentFooter, replyWithFloodRetry } from './streaming.js';
import { TelegramError } from 'telegraf';
import type { Context } from 'telegraf';
import type { IAgentSession, OutputEvent } from '../agent/types.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

async function* yieldChunks(...chunks: string[]) {
  for (const c of chunks) {
    yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: c } };
  }
  yield { type: 'done' as const, metadata: undefined };
}

async function* yieldEvents(...events: OutputEvent[]) {
  for (const e of events) yield e;
}

function makeSession(impl: (content: string) => AsyncGenerator<OutputEvent>): IAgentSession {
  return {
    state: 'idle',
    sendMessage: vi.fn(),
    sendMessageStream: impl,
    getOutputStream: vi.fn(),
    close: vi.fn(),
    waitForInitialization: vi.fn().mockResolvedValue({}),
    getSessionIdentity: vi.fn().mockReturnValue({}),
    getSessionMetadata: vi.fn().mockReturnValue({}),
    getQuery: vi.fn(),
    getLastResponseMetadata: vi.fn().mockReturnValue(null),
    interrupt: vi.fn(),
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    supportedCommands: vi.fn().mockResolvedValue([]),
    supportedModels: vi.fn().mockResolvedValue([]),
    supportedAgents: vi.fn().mockResolvedValue([]),
    getContextUsage: vi.fn().mockResolvedValue({}),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
    accountInfo: vi.fn().mockResolvedValue({}),
  } as unknown as IAgentSession;
}

function makeCtx(): { ctx: Context; replies: string[]; edits: string[]; deletes: number[] } {
  const edits: string[] = [];
  const replies: string[] = [];
  const deletes: number[] = [];
  const ctx = {
    chat: { id: 12345, type: 'private' as const },
    reply: vi.fn(async (text: string) => {
      replies.push(text);
      return { message_id: replies.length, text, chat: { id: 12345, type: 'private' as const }, date: 0 };
    }),
    telegram: {
      editMessageText: vi.fn(async (_c: unknown, _m: unknown, _i: unknown, text: string) => {
        edits.push(text);
        return true;
      }),
      deleteMessage: vi.fn(async (_c: unknown, messageId: number) => {
        deletes.push(messageId);
        return true;
      }),
    },
  } as unknown as Context;
  return { ctx, replies, edits, deletes };
}

describe('streamResponse', () => {
  it('should send incremental edits when session has sendMessageStream and yields chunks', async () => {
    const { ctx, replies, edits } = makeCtx();
    const session = makeSession(async function* (content: string) {
      expect(content).toBe('Hi');
      yield* yieldChunks('Hello', ' ', 'world');
    });

    await streamResponse(ctx, session, 'Hi');

    expect(replies.length + edits.length).toBeGreaterThanOrEqual(1);
    const allContent = [...replies, ...edits].join('');
    expect(allContent).toContain('Hello');
    expect(allContent).toContain('world');
  });

  it('forwards progress events as ◦-prefixed lines in the message', async () => {
    const { ctx, replies, edits } = makeCtx();
    const session = makeSession(async function* () {
      yield* yieldEvents(
        { type: 'chunk', chunk: { type: 'content', content: 'Starting…' } },
        {
          type: 'progress',
          progress: {
            taskId: 't1',
            description: 'Researching codebase',
            summary: '12 matches in 4 files',
            lastToolName: 'Grep',
            totalTokens: 100,
            toolUses: 2,
            durationMs: 300,
          },
        },
        { type: 'done', metadata: undefined },
      );
    });

    await streamResponse(ctx, session, 'go');
    const joined = [...replies, ...edits].join('\n');
    expect(joined).toContain('◦ Researching codebase');
    expect(joined).toContain('(Grep)');
    expect(joined).toContain('12 matches in 4 files');
  });

  it('sanitizes control/ANSI sequences in model-controlled progress fields before sending to Telegram', async () => {
    // Regression: progress.description/summary/lastToolName are populated
    // from model-controlled tool input (summarizeToolInput) and interpolated
    // raw into the Telegram message. markdownToTelegramHtml only strips
    // \x02/\x03 sentinels + HTML-escapes & < > — it does not strip ANSI/C1
    // control bytes. Verify the streaming handler scrubs them itself.
    const { ctx, replies, edits } = makeCtx();
    const session = makeSession(async function* () {
      yield* yieldEvents(
        {
          type: 'progress',
          progress: {
            taskId: 't1',
            description: 'grep \x1b[2Jsrc/\x9b malicious',
            summary: 'grep \x1b[2Jsrc/\x9b malicious',
            lastToolName: 'Grep\x1b[2J\x9b',
            totalTokens: 100,
            toolUses: 2,
            durationMs: 300,
          },
        },
        { type: 'done', metadata: undefined },
      );
    });

    await streamResponse(ctx, session, 'go');
    const joined = [...replies, ...edits].join('\n');

    // Visible text survives sanitization.
    expect(joined).toContain('grep');
    expect(joined).toContain('src/');

    // Raw escape/control bytes must not reach the Telegram message.
    expect(joined).not.toContain('\x1b');
    expect(joined).not.toContain('\x9b');
  });

  it('appends prompt_suggestion as a final 💡 line', async () => {
    const { ctx, replies, edits } = makeCtx();
    const session = makeSession(async function* () {
      yield* yieldEvents(
        { type: 'chunk', chunk: { type: 'content', content: 'Here is the answer.' } },
        { type: 'suggestion', suggestion: 'Want me to write tests next?' },
        { type: 'done', metadata: undefined },
      );
    });

    await streamResponse(ctx, session, 'go');
    const joined = [...replies, ...edits].join('\n');
    expect(joined).toContain('💡');
    expect(joined).toContain('Want me to write tests next?');
  });

  it('does NOT echo the suggestion when it duplicates the already-rendered response', async () => {
    // Regression: anthropic-direct's loop yields a `suggestion` event whose
    // payload is the assistant's short final text verbatim (≤200 chars). The
    // CLI silently drops these; Telegram used to append them as `💡 <text>`,
    // producing a visible doubling like "Hi!\n\n💡 Hi!". The handler now
    // suppresses suggestions whose payload equals the accumulated content.
    const { ctx, replies, edits } = makeCtx();
    const session = makeSession(async function* () {
      yield* yieldEvents(
        { type: 'chunk', chunk: { type: 'content', content: 'Hi! What can I help you with?' } },
        { type: 'suggestion', suggestion: 'Hi! What can I help you with?' },
        { type: 'done', metadata: undefined },
      );
    });

    await streamResponse(ctx, session, 'hi');
    const joined = [...replies, ...edits].join('\n');
    // The 💡 echo must not appear when suggestion == response text.
    expect(joined).not.toContain('💡');
    // And the response text must not appear twice in any single message.
    for (const msg of [...replies, ...edits]) {
      const occurrences = msg.split('Hi! What can I help you with?').length - 1;
      expect(occurrences).toBeLessThanOrEqual(1);
    }
  });

  it('T3: tool_diff chunks are silently swallowed — no API call, no error, no message emitted', async () => {
    const { ctx, replies, edits } = makeCtx();
    const session = makeSession(async function* () {
      yield* yieldEvents(
        { type: 'chunk', chunk: { type: 'content', content: 'Done.' } },
        {
          type: 'chunk',
          chunk: {
            type: 'tool_diff',
            toolUseId: 'tu-99',
            diff: {
              hunks: [{
                oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
                lines: [
                  { kind: '-' as const, text: 'old' },
                  { kind: '+' as const, text: 'new' },
                ],
              }],
              addedLines: 1,
              removedLines: 1,
            },
          },
        },
        { type: 'done', metadata: undefined },
      );
    });

    // Must not throw.
    await expect(streamResponse(ctx, session, 'test')).resolves.not.toThrow();

    // No Telegram API call must have been triggered by the tool_diff itself.
    // The only content is 'Done.' — verify neither reply nor edit contains
    // any diff-related content.
    const allOutput = [...replies, ...edits].join('\n');
    expect(allOutput).not.toContain('@@');       // no unified diff header
    expect(allOutput).not.toContain('old');      // no diff line content
    expect(allOutput).toContain('Done.');        // real content arrived
  });

  it('does not flood the Telegram API with empty progress updates', async () => {
    const { ctx, replies, edits } = makeCtx();
    const session = makeSession(async function* () {
      // 4 progress events back-to-back — edit throttling should suppress
      // intermediate updates (EDIT_THROTTLE_MS = 300).
      yield* yieldEvents(
        { type: 'progress', progress: { taskId: 't', description: 'phase 1', totalTokens: 0, toolUses: 0, durationMs: 0 } },
        { type: 'progress', progress: { taskId: 't', description: 'phase 2', totalTokens: 0, toolUses: 0, durationMs: 0 } },
        { type: 'progress', progress: { taskId: 't', description: 'phase 3', totalTokens: 0, toolUses: 0, durationMs: 0 } },
        { type: 'progress', progress: { taskId: 't', description: 'phase 4', totalTokens: 0, toolUses: 0, durationMs: 0 } },
        { type: 'done', metadata: undefined },
      );
    });
    await streamResponse(ctx, session, 'go');
    // The accumulated final message contains all phases, but edit count is
    // bounded by throttle — we don't assert an exact number (timing-sensitive),
    // only that it's less than 1 edit per event in the worst case.
    expect(edits.length + replies.length).toBeLessThanOrEqual(5);
  });

  it('routes ContentBlockParam[] to sendMessageStream, never to sendMessage (real routing — un-mocked)', async () => {
    // This test exercises the REAL streamResponse routing logic (streaming.ts line ~117):
    //   Array.isArray(content) ? session.sendMessageStream(content) : ...
    // The message-photo.test.ts "content-block path" test mocks streamResponse entirely
    // and can never catch a regression in this branch. This test does not mock streaming.
    const { ctx } = makeCtx();

    const sendMessage = vi.fn();
    const sendMessageStream = vi.fn(async function* (
      _content: string | ContentBlockParam[]
    ): AsyncGenerator<OutputEvent> {
      yield { type: 'done' as const, metadata: undefined };
    });

    // Inline session construction — makeSession types its factory as (string) → generator,
    // which would cause a TypeScript error for the ContentBlockParam[] overload.
    const session = {
      state: 'idle',
      sendMessage,
      sendMessageStream,
      getOutputStream: vi.fn(),
      close: vi.fn(),
      waitForInitialization: vi.fn().mockResolvedValue({}),
      getSessionIdentity: vi.fn().mockReturnValue({}),
      getSessionMetadata: vi.fn().mockReturnValue({}),
      getQuery: vi.fn(),
      getLastResponseMetadata: vi.fn().mockReturnValue(null),
      interrupt: vi.fn(),
      setModel: vi.fn(),
      setPermissionMode: vi.fn(),
      supportedCommands: vi.fn().mockResolvedValue([]),
      supportedModels: vi.fn().mockResolvedValue([]),
      supportedAgents: vi.fn().mockResolvedValue([]),
      getContextUsage: vi.fn().mockResolvedValue({}),
      mcpServerStatus: vi.fn().mockResolvedValue([]),
      accountInfo: vi.fn().mockResolvedValue({}),
    } as unknown as IAgentSession;

    const blocks: ContentBlockParam[] = [
      { type: 'text', text: '[User caption]: vision test' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'ZmFrZQ==' },
      },
    ];

    await streamResponse(ctx, session, blocks);

    // The Array.isArray(content) branch must route to sendMessageStream with the array.
    expect(sendMessageStream).toHaveBeenCalledTimes(1);
    expect(sendMessageStream).toHaveBeenCalledWith(blocks);

    // The string-only fallback (sendMessage) must never be called for an array input.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // Same session shape (answer + a ◦ progress event) is run through both modes
  // to prove the contrast: legacy force-flushes the noisy buffer into the final
  // message; cleanFinal keeps the answer free of the ◦ status noise.
  function answerWithProgress() {
    return makeSession(async function* () {
      yield* yieldEvents(
        { type: 'chunk', chunk: { type: 'content', content: 'Final answer.' } },
        {
          type: 'progress',
          progress: { taskId: 't', description: 'Running tool', lastToolName: 'Bash', totalTokens: 0, toolUses: 1, durationMs: 10 },
        },
        { type: 'done', metadata: undefined },
      );
    });
  }

  it('cleanFinal: delivers the answer as a fresh message free of ◦ noise and deletes the preview', async () => {
    const { ctx, replies, deletes } = makeCtx();

    await streamResponse(ctx, answerWithProgress(), 'go', undefined, { cleanFinal: true });

    // The final delivered message is a fresh reply with just the answer — the
    // ◦ progress/status noise that accumulates in the live preview is kept out.
    const finalReply = replies[replies.length - 1]!;
    expect(finalReply).toContain('Final answer.');
    expect(finalReply).not.toContain('◦');
    // No delivered reply leaks the progress noise into the conversation.
    expect(replies.some((r) => r.includes('◦'))).toBe(false);
    // And the live preview message was deleted so the chat ends clean.
    expect(deletes.length).toBe(1);
  });

  it('cleanFinal: retries only a failed clean chunk as plaintext and continues with remaining chunks', async () => {
    const { ctx, replies, deletes } = makeCtx();
    const parseError = new TelegramError({
      error_code: 400,
      description: "Bad Request: can't parse entities: unexpected end tag",
    });

    (ctx.reply as ReturnType<typeof vi.fn>).mockImplementation(async (text: string, extra?: { parse_mode?: string }) => {
      if (extra?.parse_mode === 'HTML' && text.startsWith('second ')) {
        throw parseError;
      }
      replies.push(text);
      return { message_id: replies.length, text, chat: { id: 12345, type: 'private' as const }, date: 0 };
    });

    const first = `first ${'a'.repeat(4080)}`;
    const second = `second ${'b'.repeat(4080)}`;
    const third = `third ${'c'.repeat(100)}`;
    const longAnswer = [first, second, third].join('\n');
    const session = makeSession(async function* () {
      yield* yieldEvents(
        { type: 'chunk', chunk: { type: 'content', content: longAnswer } },
        { type: 'done', metadata: undefined },
      );
    });

    await streamResponse(ctx, session, 'go', undefined, { cleanFinal: true });

    expect(replies.filter((r) => r.startsWith('first '))).toHaveLength(1);
    expect(replies.filter((r) => r.startsWith('second '))).toHaveLength(1);
    expect(replies.filter((r) => r.startsWith('third '))).toHaveLength(1);
    expect(deletes.length).toBe(1);
  });

  it('default (no cleanFinal): force-flushes the in-place preview (noise included) and never deletes', async () => {
    const { ctx, edits, deletes } = makeCtx();

    await streamResponse(ctx, answerWithProgress(), 'go');

    // Legacy force-flushes `accumulated` on done, which mixes the ◦ progress
    // noise into the final in-place edit — the behavior cleanFinal improves on.
    expect(edits.join('\n')).toContain('◦ Running tool');
    // No fresh-send swap, no preview deletion.
    expect(deletes.length).toBe(0);
  });

  it('no `done` event: delivers the full streamed answer as a fresh message and removes the frozen preview', async () => {
    // Regression (long-reply cutoff): if the provider stream ends WITHOUT a
    // terminal `done` event, the clean-final delivery never ran and the user was
    // stranded on the in-place preview — which is edit-throttled + edit-flood-
    // controlled, so it can freeze mid-stream and show LESS than what streamed.
    // The fix finalizes on ANY non-terminal exit: re-deliver the full answer as a
    // fresh message and delete the preview.
    const { ctx, replies, deletes } = makeCtx();
    const answerNoDone = makeSession(async function* () {
      yield { type: 'chunk', chunk: { type: 'content', content: 'Complete answer that never received a done event.' } };
      // NO done event — the generator simply returns (provider closed the stream).
    });

    await streamResponse(ctx, answerNoDone, 'go', undefined, { cleanFinal: true });

    // The full streamed text is delivered as a fresh reply, not left in the preview…
    expect(replies.some((r) => r.includes('Complete answer that never received a done event.'))).toBe(true);
    // …and the frozen preview was removed so the chat doesn't end on stale content.
    expect(deletes.length).toBe(1);
  });

  it('cleanFinal: surfaces a visible truncation notice instead of silently dropping the tail on a transport error', async () => {
    // Regression (silent tail-drop): a long reply fans out into several sends; if
    // Telegram refuses a chunk mid-delivery (flood-control 429 past our retries, or
    // another transport error), the old code re-threw and the handler swallowed it
    // silently — the tail vanished with no indication. The fix keeps the delivered
    // chunks and posts a visible notice.
    const { ctx, replies } = makeCtx();
    const transportError = new TelegramError({ error_code: 400, description: 'Bad Request: message is too long' });
    (ctx.reply as ReturnType<typeof vi.fn>).mockImplementation(async (text: string, extra?: { parse_mode?: string }) => {
      // Fail the tail chunk ("second …") — a non-parse-entities transport error, so
      // it exercises the visible-notice branch (not the plaintext-fallback branch).
      if (extra?.parse_mode === 'HTML' && text.startsWith('second ')) throw transportError;
      replies.push(text);
      return { message_id: replies.length, text, chat: { id: 12345, type: 'private' as const }, date: 0 };
    });
    const first = `first ${'a'.repeat(4080)}`;
    const second = `second ${'b'.repeat(200)}`;
    const longAnswer = [first, second].join('\n');
    const session = makeSession(async function* () {
      yield { type: 'chunk', chunk: { type: 'content', content: longAnswer } };
      yield { type: 'done', metadata: undefined };
    });

    // Never rejects — a transport failure mid-delivery is handled, not thrown.
    await expect(streamResponse(ctx, session, 'go', undefined, { cleanFinal: true })).resolves.toBeUndefined();

    // The first chunk landed, and the dropped tail is announced (not silent).
    expect(replies.some((r) => r.startsWith('first '))).toBe(true);
    expect(replies.some((r) => r.includes('Telegram dropped'))).toBe(true);
  });

  it('cleanFinal: does NOT delete the frozen preview when the FIRST clean chunk fails (never zero content)', async () => {
    // Regression (PR #620 review, High): deliverClean posted the truncation notice
    // and returned on a transport error, but both callers deleted the live preview
    // unconditionally. So if the VERY FIRST fresh chunk failed, the user was left
    // with the preview gone AND zero answer content. deliverClean now reports
    // whether anything landed; the preview must survive when nothing replaced it.
    const { ctx, replies, deletes } = makeCtx();
    const transportError = new TelegramError({ error_code: 400, description: 'Bad Request: message is too long' });
    let htmlReplies = 0;
    (ctx.reply as ReturnType<typeof vi.fn>).mockImplementation(async (text: string, extra?: { parse_mode?: string }) => {
      if (extra?.parse_mode === 'HTML') {
        htmlReplies++;
        // Reply #1 is the live-preview creation (must succeed so a preview exists);
        // reply #2 is deliverClean's FIRST fresh chunk — fail it so nothing lands.
        if (htmlReplies >= 2) throw transportError;
      }
      replies.push(text);
      return { message_id: replies.length, text, chat: { id: 12345, type: 'private' as const }, date: 0 };
    });
    const answer = 'Complete answer that must survive as the frozen preview.';
    const session = makeSession(async function* () {
      yield { type: 'chunk', chunk: { type: 'content', content: answer } };
      yield { type: 'done', metadata: undefined };
    });

    // Never rejects — a first-chunk transport failure is handled, not thrown.
    await expect(streamResponse(ctx, session, 'go', undefined, { cleanFinal: true })).resolves.toBeUndefined();

    // Nothing replaced the preview, so it must NOT be deleted (user keeps content)…
    expect(deletes.length).toBe(0);
    // …and the failure is announced, not silent.
    expect(replies.some((r) => r.includes('Telegram dropped'))).toBe(true);
  });

  it('cleanFinal: a long-answer first-chunk failure does NOT re-send a contradictory chunks[1..] fragment (#623)', async () => {
    // Regression (#623, medium): on a LONG cleanFinal answer, if deliverClean's FIRST
    // fresh chunk fails past retries it posts the truncation notice and returns
    // delivered=false, leaving `sentMessage` set. The post-loop overflow branch used to
    // fire on ANY terminal exit with a surviving preview and re-send chunks[1..] of the
    // noisy `accumulated` buffer — immediately contradicting the "dropped, ask me to
    // resend" notice it had just posted. Gating that branch on `!cleanFinal` keeps the
    // cleanFinal failure path from falling through to it. The pre-existing short
    // first-chunk-fail test could not catch this: a single-chunk answer never satisfies
    // the overflow branch's `chunks.length > 1` guard.
    const { ctx, replies, deletes } = makeCtx();
    const transportError = new TelegramError({ error_code: 400, description: 'Bad Request: message is too long' });
    let htmlReplies = 0;
    (ctx.reply as ReturnType<typeof vi.fn>).mockImplementation(async (text: string, extra?: { parse_mode?: string }) => {
      if (extra?.parse_mode === 'HTML') {
        htmlReplies++;
        // Reply #1 creates the live preview (must succeed so a preview exists); reply #2
        // is deliverClean's FIRST fresh chunk — fail it (and everything after) so nothing
        // clean lands and the frozen preview must survive.
        if (htmlReplies >= 2) throw transportError;
      }
      replies.push(text);
      return { message_id: replies.length, text, chat: { id: 12345, type: 'private' as const }, date: 0 };
    });
    const first = `first ${'a'.repeat(4080)}`;
    const second = `second ${'b'.repeat(200)}`;
    const longAnswer = [first, second].join('\n');
    const session = makeSession(async function* () {
      yield { type: 'chunk', chunk: { type: 'content', content: longAnswer } };
      yield { type: 'done', metadata: undefined };
    });

    await expect(streamResponse(ctx, session, 'go', undefined, { cleanFinal: true })).resolves.toBeUndefined();

    // The frozen preview survives (nothing clean replaced it)…
    expect(deletes.length).toBe(0);
    // …and the failure is announced EXACTLY once. The buggy overflow re-send posted a
    // SECOND contradictory notice (and re-delivered chunks[1..] of the noisy buffer).
    expect(replies.filter((r) => r.includes('Telegram dropped'))).toHaveLength(1);
  });

  it('default (no cleanFinal): a multi-chunk answer delivers chunks[1..] as fresh replies (tail not dropped)', async () => {
    // Guard for the #623 fix CHOICE. `sendOrEdit` only ever renders chunk[0] into the
    // single preview message, so on the non-cleanFinal `done` path (sawTerminalEvent=true)
    // chunks[1..] can reach the user ONLY via the post-loop overflow branch. Gating that
    // branch on `!sawTerminalEvent` (the rejected alternative fix) makes it dead code and
    // silently drops the tail — reintroducing the #620 bug. Gating on `!cleanFinal` keeps
    // it reachable here. This test fails under `!sawTerminalEvent` and passes under
    // `!cleanFinal`.
    const { ctx, replies, deletes } = makeCtx();
    const first = `first ${'a'.repeat(4080)}`;
    const second = `second ${'b'.repeat(200)}`;
    const longAnswer = [first, second].join('\n');
    const session = makeSession(async function* () {
      yield { type: 'chunk', chunk: { type: 'content', content: longAnswer } };
      yield { type: 'done', metadata: undefined };
    });

    await expect(streamResponse(ctx, session, 'go')).resolves.toBeUndefined();

    // The overflow tail was delivered as a fresh reply (not stranded in the preview)…
    expect(replies.some((r) => r.startsWith('second '))).toBe(true);
    // …and the non-cleanFinal path never deletes the preview.
    expect(deletes.length).toBe(0);
  });

  it('default (no cleanFinal): a failed overflow tail chunk posts a visible notice and never rethrows', async () => {
    // Coverage gap (#623): the non-cleanFinal overflow catch — which posts
    // DELIVERY_TRUNCATED_NOTICE when a chunks[1..] send fails — had NO test; every
    // throwing-reply test used cleanFinal. Here a multi-chunk answer reaches `done`,
    // chunk[0] sits in the preview, and the overflow send fails with a transport error:
    // the notice must post and nothing may rethrow uncaught into the finally.
    const { ctx, replies, edits, deletes } = makeCtx();
    const transportError = new TelegramError({ error_code: 400, description: 'Bad Request: message is too long' });
    let htmlReplies = 0;
    (ctx.reply as ReturnType<typeof vi.fn>).mockImplementation(async (text: string, extra?: { parse_mode?: string }) => {
      if (extra?.parse_mode === 'HTML') {
        htmlReplies++;
        // Reply #1 creates the preview (chunk[0], must succeed); reply #2 is the overflow
        // chunks[1] send — fail it so the non-cleanFinal notice branch runs.
        if (htmlReplies >= 2) throw transportError;
      }
      replies.push(text);
      return { message_id: replies.length, text, chat: { id: 12345, type: 'private' as const }, date: 0 };
    });
    const first = `first ${'a'.repeat(4080)}`;
    const second = `second ${'b'.repeat(200)}`;
    const longAnswer = [first, second].join('\n');
    const session = makeSession(async function* () {
      yield { type: 'chunk', chunk: { type: 'content', content: longAnswer } };
      yield { type: 'done', metadata: undefined };
    });

    // A transport failure on the overflow tail is handled, not thrown.
    await expect(streamResponse(ctx, session, 'go')).resolves.toBeUndefined();

    // chunk[0] is rendered into the preview via edit (the non-cleanFinal path edits
    // the live message rather than re-sending it), and the dropped tail is announced…
    expect(edits.some((e) => e.startsWith('first '))).toBe(true);
    expect(replies.filter((r) => r.includes('Telegram dropped'))).toHaveLength(1);
    // …and the non-cleanFinal path never deletes the preview.
    expect(deletes.length).toBe(0);
  });

  it('cleanFinal: a progress-only turn (no assistant answer) still delivers a long accumulated buffer\'s overflow tail (#623 follow-up)', async () => {
    // Regression (#623 follow-up — flagged independently by this repo's own review
    // pipeline AND by Codex on PR #626): when cleanFinal===true but the turn produces
    // NO final assistant text (a subagent-heavy turn with only `◦` progress lines,
    // `answerText` stays ''), the `done` handler's `if (cleanFinal && answerText.trim())`
    // guard is false, so it falls to `sendOrEdit(accumulated, true)` — which, like the
    // non-cleanFinal path, renders only chunk[0] into the preview. The post-loop overflow
    // branch must still fire to deliver chunks[1..] of that (long, progress-only)
    // `accumulated` buffer. Gating that branch on bare `!cleanFinal` (the original #623
    // fix) wrongly excluded this case too, silently truncating the tail. The refined gate
    // — the exact negation of the `done` handler's own `cleanFinal && answerText.trim()`
    // guard — restores delivery here while still suppressing the original #623
    // contradictory-resend bug (see the cleanFinal first-chunk-failure test above).
    const { ctx, replies, deletes } = makeCtx();
    const firstDescription = `first ${'a'.repeat(4080)}`;
    const secondDescription = 'second progress marker';
    const session = makeSession(async function* () {
      yield {
        type: 'progress',
        progress: {
          taskId: 't1',
          description: firstDescription,
          totalTokens: 100,
          toolUses: 1,
          durationMs: 100,
        },
      };
      yield {
        type: 'progress',
        progress: {
          taskId: 't2',
          description: secondDescription,
          totalTokens: 100,
          toolUses: 1,
          durationMs: 100,
        },
      };
      yield { type: 'done', metadata: undefined };
    });

    await expect(streamResponse(ctx, session, 'go', undefined, { cleanFinal: true })).resolves.toBeUndefined();

    // No clean answer text ever existed to replace the preview, so it is never deleted…
    expect(deletes.length).toBe(0);
    // …but the overflow tail — the second progress line — still reaches the user as a
    // fresh reply instead of being silently stranded behind the frozen chunk[0] preview.
    expect(replies.some((r) => r.includes(secondDescription))).toBe(true);
    // Nothing failed, so no truncation notice fires.
    expect(replies.some((r) => r.includes('Telegram dropped'))).toBe(false);
  });
});

describe('generator finalizer cleanup', () => {
  it('calls iter.return() so the generator finally block runs after streamResponse resolves', async () => {
    let finallyCount = 0;
    const { ctx } = makeCtx();
    const session = makeSession(async function* () {
      try {
        yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: 'hi' } };
        yield { type: 'done' as const, metadata: undefined };
      } finally {
        finallyCount++;
      }
    });
    await streamResponse(ctx, session, 'test');
    // iter.return() must have been called — the generator's finally block increments finallyCount
    expect(finallyCount).toBe(1);
  });

  // NOTE (false positive): This test does NOT verify that iter.return() is
  // called on the error path. The generator yields { type: 'done' } and
  // exhausts naturally, so V8 runs `finally { busy = false }` regardless of
  // whether iter.return() is called. Removing iter.return() from streaming.ts
  // entirely leaves this test green. The 'error event mid-stream' test below
  // is the real regression guard for the iter.return() fix.
  it('second sequential call succeeds without "session is busy" error', async () => {
    let busy = false;
    const { ctx } = makeCtx();

    function makeBusySession(): IAgentSession {
      return {
        state: 'idle',
        sendMessage: vi.fn(),
        sendMessageStream: async function* (content: string) {
          if (busy) throw new Error('Cannot send message: session is busy');
          busy = true;
          try {
            yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: content } };
            yield { type: 'done' as const, metadata: undefined };
          } finally {
            busy = false;
          }
        },
        getOutputStream: vi.fn(),
        close: vi.fn(),
        waitForInitialization: vi.fn().mockResolvedValue({}),
        getSessionIdentity: vi.fn().mockReturnValue({}),
        getSessionMetadata: vi.fn().mockReturnValue({}),
        getQuery: vi.fn(),
        getLastResponseMetadata: vi.fn().mockReturnValue(null),
        interrupt: vi.fn(),
        setModel: vi.fn(),
        setPermissionMode: vi.fn(),
        supportedCommands: vi.fn().mockResolvedValue([]),
        supportedModels: vi.fn().mockResolvedValue([]),
        supportedAgents: vi.fn().mockResolvedValue([]),
        getContextUsage: vi.fn().mockResolvedValue({}),
        mcpServerStatus: vi.fn().mockResolvedValue([]),
        accountInfo: vi.fn().mockResolvedValue({}),
      } as unknown as IAgentSession;
    }

    const session = makeBusySession();

    // First call: should resolve cleanly
    await expect(streamResponse(ctx, session, 'first')).resolves.toBeUndefined();
    // Second call: should also resolve cleanly (busy=false because finally ran)
    await expect(streamResponse(ctx, session, 'second')).resolves.toBeUndefined();
  });

  it('calls iter.return() even when streamResponse throws mid-stream (error event)', async () => {
    // This test FAILS on unfixed code — when runWithSink throws at the
    // `event.type === 'error'` branch, execution jumps to the outer catch
    // and skips iter.return(), leaving the generator's finally block unrun.
    // It passes once iter.return() is inside a finally block.
    let finallyRan = false;
    const { ctx } = makeCtx();
    const session = makeSession(async function* () {
      try {
        // Yield one real chunk so receivedAny becomes true — the error event
        // is therefore reached mid-stream, not on the very first event.
        yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: 'partial output' } };
        // Emit an error event — this triggers `throw event.error` inside
        // runWithSink (streaming.ts), before the generator is exhausted.
        yield { type: 'error' as const, error: new Error('mid-stream error') };
        // Intentionally unreachable — the throw above exits the loop.
        yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: 'never reached' } };
      } finally {
        // On unfixed code: this never runs because iter.return() is skipped.
        // On fixed code: iter.return() in the finally block triggers this.
        finallyRan = true;
      }
    });

    // streamResponse must rethrow the mid-stream error.
    await expect(streamResponse(ctx, session, 'test')).rejects.toThrow('mid-stream error');

    // The generator's finally block must have run — proving iter.return() was
    // called on the error path, not just on the normal exhaustion path.
    expect(finallyRan).toBe(true);
  });
});

describe('renderSubagentFooter (bounded sub-agent progress)', () => {
  it('returns empty string when there is no activity', () => {
    expect(renderSubagentFooter(0, [])).toBe('');
    expect(renderSubagentFooter(0, ['ignored'])).toBe('');
  });

  it('reports the step count and pluralizes correctly', () => {
    expect(renderSubagentFooter(1, ['recon: read_file a'])).toContain('1 step');
    expect(renderSubagentFooter(1, ['recon: read_file a'])).not.toContain('1 steps');
    expect(renderSubagentFooter(5, ['recon: read_file a'])).toContain('5 steps');
  });

  it('bounds the preview to the last few lines regardless of total step count', () => {
    // The pre-fix sink appended one line per child tool call, unbounded. The
    // footer must stay bounded even after 50 tool calls.
    const many = Array.from({ length: 50 }, (_, i) => `recon: read_file file${i}`);
    const footer = renderSubagentFooter(50, many);
    const shownLines = footer.split('\n').filter((l) => l.includes('read_file'));
    expect(shownLines.length).toBeLessThanOrEqual(4);
    // The rolling tail keeps the MOST RECENT entries…
    expect(footer).toContain('file49');
    // …and drops the oldest.
    expect(footer).not.toContain('file0 ');
    // The counter still reflects the true total even though lines are capped.
    expect(footer).toContain('50 steps');
  });
});

describe('provider-turn interrupt on incomplete exit (stale-buffer guard)', () => {
  it('throws StreamTimeoutError and interrupts the still-running turn on total silence', async () => {
    vi.useFakeTimers();
    try {
      let releaseHang: () => void = () => {};
      const hang = new Promise<void>((resolve) => { releaseHang = resolve; });
      const session = makeSession(async function* () {
        // One event so receivedAny becomes true (NEXT_EVENT_TIMEOUT_MS applies),
        // then the provider goes silent — simulating a turn still running with
        // no parent-stream events AND no sink activity, so the watchdog fires.
        yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: 'partial' } };
        await hang;
      });
      // Mirror the real interrupt() contract: aborting the turn unblocks the
      // in-flight provider pull so the generator can finalize cleanly.
      (session as { interrupt: ReturnType<typeof vi.fn> }).interrupt = vi.fn(async () => { releaseHang(); });
      const { ctx } = makeCtx();

      const p = streamResponse(ctx, session, 'go');
      const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
      // Flush the first event, then advance past the 180s inactivity window.
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(180_001);
      await rejection;
      // The fix: a timeout MUST abort the underlying turn so it doesn't keep
      // streaming into the shared providerIterator and get drained by the next
      // message ("send a '.' to recover the lost result" bug).
      expect((session as { interrupt: ReturnType<typeof vi.fn> }).interrupt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it('does NOT interrupt on a provider error EVENT — the turn already ended (terminal event seen)', async () => {
    const { ctx } = makeCtx();
    const session = makeSession(async function* () {
      yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: 'partial' } };
      yield { type: 'error' as const, error: new Error('mid-stream boom') };
    });
    await expect(streamResponse(ctx, session, 'go')).rejects.toThrow('mid-stream boom');
    // An 'error' EVENT is terminal: the provider emitted it and parked itself at
    // the next-prompt boundary, so there is nothing to interrupt. (Contrast with
    // a RAW throw / non-terminal exit below, which DOES require interrupt().)
    expect((session as { interrupt: ReturnType<typeof vi.fn> }).interrupt).not.toHaveBeenCalled();
  });

  it('interrupts on a non-terminal early exit (raw throw, no done/error event)', async () => {
    // The leak the fix closes: the consumer exits WITHOUT a terminal event
    // (here a raw throw, standing in for a Telegram render exception or other
    // mid-stream failure). The shared provider iterator is still live, so
    // without interrupt() its buffered events would be drained by the user's
    // NEXT message — the "send a '.' to recover the lost result" bug. Previously
    // this path was NOT covered because interrupt() was gated on `timedOut` alone.
    const { ctx } = makeCtx();
    const session = makeSession(async function* () {
      yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: 'partial' } };
      throw new Error('render boom'); // raw throw — NOT an 'error' OutputEvent
    });
    await expect(streamResponse(ctx, session, 'go')).rejects.toThrow('render boom');
    expect((session as { interrupt: ReturnType<typeof vi.fn> }).interrupt).toHaveBeenCalledTimes(1);
  });

  it('does NOT interrupt on a clean turn that reaches done', async () => {
    // Happy path: a terminal done event was seen, so interrupt() must be a
    // no-op here — firing it would abort an already-completed turn (and, before
    // iter.return() runs, currentState is still 'streaming', so the abort would
    // NOT be swallowed). The gate must therefore key off the terminal event.
    const { ctx } = makeCtx();
    const session = makeSession(async function* () {
      yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: 'all good' } };
      yield { type: 'done' as const, metadata: undefined };
    });
    await streamResponse(ctx, session, 'go');
    expect((session as { interrupt: ReturnType<typeof vi.fn> }).interrupt).not.toHaveBeenCalled();
  });

  it('suspends the watchdog while a foreground tool is in flight, then fires past MAX_TOOL_INFLIGHT_MS', async () => {
    vi.useFakeTimers();
    try {
      let releaseHang: () => void = () => {};
      const hang = new Promise<void>((resolve) => { releaseHang = resolve; });
      const session = makeSession(async function* () {
        // A foreground tool STARTS (tool_use_detail) then the parent stream goes
        // silent for the whole tool run — exactly a long bash / nested `afk chat`.
        // No tool_result arrives, so the tool stays "in flight" and the watchdog
        // must SUSPEND rather than fire at NEXT_EVENT_TIMEOUT_MS.
        yield { type: 'chunk' as const, chunk: { type: 'tool_use_detail' as const, toolUseId: 't1', toolName: 'bash', toolInput: 'afk chat' } };
        await hang;
      });
      (session as { interrupt: ReturnType<typeof vi.fn> }).interrupt = vi.fn(async () => { releaseHang(); });
      const { ctx } = makeCtx();

      const p = streamResponse(ctx, session, 'go');
      let settled = false;
      void p.then(() => { settled = true; }, () => { settled = true; });

      await vi.advanceTimersByTimeAsync(1);        // flush tool_use_detail → tool in flight
      await vi.advanceTimersByTimeAsync(180_001);  // past NEXT_EVENT_TIMEOUT_MS
      await vi.advanceTimersByTimeAsync(180_001);  // still in flight → suspended, no timeout
      expect(settled).toBe(false);
      expect((session as { interrupt: ReturnType<typeof vi.fn> }).interrupt).not.toHaveBeenCalled();

      // Past MAX_TOOL_INFLIGHT_MS (660s) the tool is treated as genuinely wedged
      // and the watchdog is finally allowed to fire.
      const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
      await vi.advanceTimersByTimeAsync(660_001);
      await rejection;
      expect((session as { interrupt: ReturnType<typeof vi.fn> }).interrupt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('resumes the watchdog after a tool_result clears the in-flight set', async () => {
    vi.useFakeTimers();
    try {
      let releaseHang: () => void = () => {};
      const hang = new Promise<void>((resolve) => { releaseHang = resolve; });
      const session = makeSession(async function* () {
        // Tool starts AND finishes (tool_result), so the in-flight set is empty
        // again — subsequent silence is a genuinely stuck turn and MUST time out.
        yield { type: 'chunk' as const, chunk: { type: 'tool_use_detail' as const, toolUseId: 't1', toolName: 'bash', toolInput: 'x' } };
        yield { type: 'chunk' as const, chunk: { type: 'tool_result' as const, toolUseId: 't1', content: 'ok' } };
        await hang;
      });
      (session as { interrupt: ReturnType<typeof vi.fn> }).interrupt = vi.fn(async () => { releaseHang(); });
      const { ctx } = makeCtx();

      const p = streamResponse(ctx, session, 'go');
      const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
      await vi.advanceTimersByTimeAsync(1);        // flush tool_use_detail + tool_result
      await vi.advanceTimersByTimeAsync(180_001);  // silence, no tool in flight → fires
      await rejection;
      expect((session as { interrupt: ReturnType<typeof vi.fn> }).interrupt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);
});

describe('replyWithFloodRetry (flood-control 429 backoff)', () => {
  const flood429 = (retryAfter: number) =>
    new TelegramError({
      error_code: 429,
      description: `Too Many Requests: retry after ${retryAfter}`,
      parameters: { retry_after: retryAfter },
    });

  it('retries a 429 (honoring retry_after) then succeeds', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const reply = vi.fn(async () => {
      calls++;
      if (calls === 1) throw flood429(2);
      return {};
    });
    await replyWithFloodRetry(reply, 'hi', undefined, { sleep: async (ms) => { sleeps.push(ms); } });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2000]); // honored retry_after=2s (converted to ms)
  });

  it('throws after exhausting retries on a persistent 429', async () => {
    const reply = vi.fn(async () => { throw flood429(1); });
    await expect(
      replyWithFloodRetry(reply, 'hi', undefined, { maxRetries: 2, sleep: async () => {} }),
    ).rejects.toBeInstanceOf(TelegramError);
    expect(reply).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it('propagates a non-429 error immediately without retrying', async () => {
    const err = new TelegramError({ error_code: 400, description: "Bad Request: can't parse entities" });
    const reply = vi.fn(async () => { throw err; });
    await expect(
      replyWithFloodRetry(reply, 'hi', { parse_mode: 'HTML' }, { sleep: async () => {} }),
    ).rejects.toBe(err);
    expect(reply).toHaveBeenCalledTimes(1);
  });
});
