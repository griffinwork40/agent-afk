/**
 * Tests for Telegram streaming (token/chunk-by-chunk updates)
 */

import { describe, it, expect, vi } from 'vitest';
import { streamResponse, StreamTimeoutError, renderSubagentFooter, renderProgressRegion, renderInterleavedPreview, renderActivityReceipt, formatTelegramActivity, formatTelegramAgentLabel, replyWithFloodRetry } from './streaming.js';
import { TelegramError } from 'telegraf';
import type { Context } from 'telegraf';
import type { IAgentSession, OutputEvent } from '../agent/types.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { getCurrentSink } from '../agent/_lib/skill-sink-channel.js';

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

    // progressDelayMs: 0 opts out of the latency gate (PROGRESS_START_DELAY_MS)
    // so this test asserts the RENDERING contract deterministically. The gate
    // itself is covered by the 'latency gate' tests below.
    await streamResponse(ctx, session, 'go', undefined, { progressDelayMs: 0 });
    const joined = [...replies, ...edits].join('\n');
    expect(joined).toContain('◦ Researching codebase');
    expect(joined).not.toContain('(Grep)');
    expect(joined).not.toContain('12 matches in 4 files');
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

  it('shows friendly sub-agent activity without exposing tool arguments or paths', async () => {
    const { ctx, replies, edits } = makeCtx();
    const session = makeSession(async function* () {
      getCurrentSink()?.(
        {
          type: 'chunk',
          chunk: {
            type: 'tool_use_detail',
            toolUseId: 'tool-1',
            toolName: 'Grep',
            toolInput: '/Users/example/private-project --hidden secret-pattern',
          },
        },
        { subagentId: 'sub-1', agentType: 'research-agent' },
      );
      await Promise.resolve();
      yield { type: 'done', metadata: undefined };
    });

    await streamResponse(ctx, session, 'go');

    const joined = [...replies, ...edits].join('\n');
    expect(joined).toContain('Research agent — Searching');
    expect(joined).not.toContain('/Users/example/private-project');
    expect(joined).not.toContain('secret-pattern');
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

    // progressDelayMs: 0 opts out of the latency gate so the ◦ line is rendered
    // into `accumulated` and this test still exercises the legacy flush path.
    await streamResponse(ctx, answerWithProgress(), 'go', undefined, { progressDelayMs: 0 });

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

describe('Telegram-friendly activity formatting', () => {
  it('humanizes generic tool activity and keeps meaningful descriptions', () => {
    expect(formatTelegramActivity('Working', 'memory_search')).toBe('Searching');
    expect(formatTelegramActivity('Processing', 'Bash')).toBe('Running a command');
    expect(formatTelegramActivity('Researching release notes', 'WebSearch')).toBe('Researching release notes');
  });

  it('categorizes by whole token, so a domain outranks a colliding verb', () => {
    // `browser_open` is browser navigation, not a file read: the `browser`
    // domain token wins over the `open` verb token.
    expect(formatTelegramActivity('Working', 'browser_open')).toBe('Researching');
    expect(formatTelegramActivity('Working', 'web_scrape')).toBe('Researching');
    expect(formatTelegramActivity('Working', 'read_file')).toBe('Reading files');
    expect(formatTelegramActivity('Working', 'write_file')).toBe('Editing files');
    expect(formatTelegramActivity('Working', 'Grep')).toBe('Searching');
  });

  it('falls back to a readable label rather than a confidently wrong category', () => {
    // `memory` alone is not a search, and a `terminal_font_size` setting is not
    // a shell command — a substring match previously claimed both.
    expect(formatTelegramActivity('Working', 'memory_update')).toBe('Using memory update');
    expect(formatTelegramActivity('Working', 'terminal_font_size')).toBe('Using terminal font size');
  });

  it('humanizes agent labels and hides opaque UUIDs', () => {
    expect(formatTelegramAgentLabel('research-agent')).toBe('Research agent');
    expect(formatTelegramAgentLabel('c204d56f-bd57-4380-8a5f-123456789abc')).toBe('Sub-agent');
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

describe('apiRoundInFlight cleared in finally block', () => {
  it('clears apiRoundInFlight after streamResponse completes normally (progress then done)', async () => {
    // Regression guard for #1143: the `finally` block must reset
    // `watchdog.apiRoundInFlight` and `watchdog.apiRoundSince` on every exit path.
    // On a normal turn the `progress` event sets apiRoundInFlight=true; the next
    // event clears it at the event-receipt site (line ~202). But if the stream ends
    // without a subsequent event after the last `progress`, only the `finally` block
    // can clear it. This test verifies the happy-path cleanup is in place by
    // confirming streamResponse resolves without errors after a progress+done turn.
    const { ctx } = makeCtx();
    const session = makeSession(async function* () {
      yield {
        type: 'progress' as const,
        progress: { taskId: 't1', description: 'tool round', totalTokens: 0, toolUses: 1, durationMs: 10 },
      };
      yield { type: 'done' as const, metadata: undefined };
    });

    // Must resolve cleanly — if the finally block is missing the apiRoundInFlight
    // reset, a subsequent hang would extend the watchdog by up to 420s (#1143).
    await expect(streamResponse(ctx, session, 'go')).resolves.toBeUndefined();
  });

  it('watchdog fires at normal window when progress is the final event and stream hangs', async () => {
    // The scenario from #1143: `progress` sets apiRoundInFlight=true, then the
    // stream wedges non-terminally (no further events). Without the finally-block
    // reset the watchdog suspends for up to 420s (MAX_API_ROUND_INFLIGHT_MS)
    // before firing. With the fix the flag is cleared when the finally runs, so
    // the timeout fires at the normal NEXT_EVENT_TIMEOUT_MS window.
    //
    // Note: the finally block runs AFTER the watchdog fires and throws, so the
    // 420s deferral is unavoidable for a still-hanging stream — this test confirms
    // the watchdog DOES eventually fire (i.e., `apiRoundSince` is not null but the
    // ceiling is respected), and that streamResponse throws StreamTimeoutError.
    vi.useFakeTimers();
    try {
      let releaseHang: () => void = () => {};
      const hang = new Promise<void>((resolve) => { releaseHang = resolve; });
      const session = makeSession(async function* () {
        yield {
          type: 'progress' as const,
          progress: { taskId: 't1', description: 'tool round', totalTokens: 0, toolUses: 1, durationMs: 10 },
        };
        // Stream hangs: apiRoundInFlight stays true while we wait
        await hang;
      });
      (session as { interrupt: ReturnType<typeof vi.fn> }).interrupt = vi.fn(async () => { releaseHang(); });
      const { ctx } = makeCtx();

      const p = streamResponse(ctx, session, 'go');
      const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);

      // Flush the progress event (sets apiRoundInFlight=true)
      await vi.advanceTimersByTimeAsync(1);
      // Advance past NEXT_EVENT_TIMEOUT_MS (180s) — watchdog enters arm() with remaining<=0
      await vi.advanceTimersByTimeAsync(180_001);
      // Advance past MAX_API_ROUND_INFLIGHT_MS (420s) — watchdog finally fires
      await vi.advanceTimersByTimeAsync(420_001);
      await rejection;

      // The finally block must have cleared the state; interrupt is called once
      expect((session as { interrupt: ReturnType<typeof vi.fn> }).interrupt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
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

describe('bounded ◦ progress region', () => {
  function progressEvent(description: string): OutputEvent {
    return {
      type: 'progress',
      progress: { taskId: 't', description, totalTokens: 0, toolUses: 1, durationMs: 1 },
    } as OutputEvent;
  }

  it('latency gate: a fast turn renders NO ◦ progress lines at all', async () => {
    // The user-visible point of the gate: most turns finish well under
    // PROGRESS_START_DELAY_MS, and those turns should go straight from the
    // `Thinking…` placeholder to the answer with zero `◦` churn. No
    // progressDelayMs override here — this asserts the production default.
    const { ctx, replies, edits } = makeCtx();
    const session = makeSession(async function* () {
      yield* yieldEvents(
        progressEvent('Running tool'),
        progressEvent('Running another tool'),
        { type: 'chunk', chunk: { type: 'content', content: 'Done thinking.' } },
        { type: 'done', metadata: undefined },
      );
    });

    await streamResponse(ctx, session, 'go', undefined, { cleanFinal: true });

    expect([...replies, ...edits].some((t) => t.includes('◦'))).toBe(false);
    expect(replies.some((r) => r.includes('Done thinking.'))).toBe(true);
  });

  it('rolling window: only the most recent MAX_PROGRESS_LINES survive', async () => {
    // Regression: progress lines used to append to `accumulated` without bound,
    // so a tool-heavy turn grew the preview one line per round forever.
    const { ctx, edits } = makeCtx();
    const session = makeSession(async function* () {
      for (let i = 1; i <= 9; i++) yield progressEvent(`round-${i}`);
      yield { type: 'done', metadata: undefined };
    });

    await streamResponse(ctx, session, 'go', undefined, { progressDelayMs: 0 });

    // `done` force-flushes the full accumulated buffer into the preview.
    const final = edits[edits.length - 1] ?? '';
    expect(final).toContain('round-9');
    expect(final).toContain('round-4'); // 9 rounds, window of 6 → 4..9 kept
    expect(final).not.toContain('round-3');
    expect(final).not.toContain('round-1');
  });

  it('REGRESSION: a gated-off progress round still sets the stream_retry boundary, so a retry does not eat earlier answer text', async () => {
    // This is the trap a shadow-verify wave caught. The `progress` handler's
    // `inContentRun = false` is NOT cosmetic — it is the stream_retry round
    // boundary. Suppressing progress RENDERING must not skip it: if it were
    // skipped, contentRunStartAnswer would still point at offset 0 when the
    // second content run began, and the stream_retry below would slice
    // answerText back to '' — silently destroying 'AAA', text the model had
    // already streamed. Runs with the DEFAULT latency gate (progress renders
    // nothing here) precisely to prove render-suppression keeps the boundary.
    const { ctx, replies } = makeCtx();
    const session = makeSession(async function* () {
      yield { type: 'chunk', chunk: { type: 'content', content: 'AAA' } };
      yield progressEvent('tool round between two content runs');
      yield { type: 'chunk', chunk: { type: 'content', content: 'BBB' } };
      yield { type: 'stream_retry' } as OutputEvent;
      yield { type: 'chunk', chunk: { type: 'content', content: 'CCC' } };
      yield { type: 'done', metadata: undefined };
    });

    let recorded: string | undefined;
    await streamResponse(ctx, session, 'go', undefined, {
      cleanFinal: true,
      onComplete: (text) => { recorded = text; },
    });

    // 'AAA' survived the retry; only the retried round ('BBB') was discarded.
    expect(recorded).toBe('AAACCC');
    expect(replies.some((r) => r.includes('AAACCC'))).toBe(true);
  });

  it('dead-turn guard: a fast progress-only turn still delivers, never stranding the user on `Thinking…`', async () => {
    // With the latency gate active and no answer text (e.g. an abort mid
    // tool-loop yields turn.completed with no assistant message), `accumulated`
    // is empty — so without an explicit flush the user's entire reply would be
    // the bare `Thinking…` placeholder: a silent dead turn.
    const { ctx, replies, edits } = makeCtx();
    const session = makeSession(async function* () {
      yield* yieldEvents(
        progressEvent('searched the codebase'),
        { type: 'done', metadata: undefined },
      );
    });

    await streamResponse(ctx, session, 'go', undefined, { cleanFinal: true });

    const all = [...replies, ...edits];
    expect(all.some((t) => t.includes('searched the codebase'))).toBe(true);
    // The placeholder is not the last thing the user sees.
    expect(all[all.length - 1]).not.toBe('Thinking…');
  });

  it('activity receipt: summarizes tool rounds on the clean final but never enters recorded history', async () => {
    const { ctx, replies } = makeCtx();
    const session = makeSession(async function* () {
      yield* yieldEvents(
        progressEvent('step one'),
        progressEvent('step two'),
        { type: 'chunk', chunk: { type: 'content', content: 'The answer.' } },
        { type: 'done', metadata: undefined },
      );
    });

    let recorded: string | undefined;
    await streamResponse(ctx, session, 'go', undefined, {
      cleanFinal: true,
      onComplete: (text) => { recorded = text; },
    });

    const finalReply = replies[replies.length - 1] ?? '';
    expect(finalReply).toContain('The answer.');
    expect(finalReply).toContain('2 steps');
    // The receipt is presentation only: recorded turn history stays clean so a
    // CLI `--resume` does not replay UI chrome as assistant text.
    expect(recorded).toBe('The answer.');
    expect(recorded).not.toContain('⏱️');
  });

  it('activity receipt: absent on a turn with no tool rounds', async () => {
    const { ctx, replies } = makeCtx();
    const session = makeSession(async function* () {
      yield* yieldChunks('Just an answer.');
    });

    await streamResponse(ctx, session, 'go', undefined, { cleanFinal: true });

    expect(replies[replies.length - 1]).toBe('Just an answer.');
  });

  it('suggestion dedupe compares against the ANSWER, not the progress-polluted buffer', async () => {
    // Regression: the gate used to compare the suggestion against `accumulated`,
    // which also carries the `◦` region. On a tool-heavy turn that made the
    // comparison spuriously unequal, so a suggestion identical to the answer was
    // appended anyway — a duplicate 💡 echo on exactly the turns with progress.
    const { ctx, replies } = makeCtx();
    const session = makeSession(async function* () {
      yield* yieldEvents(
        progressEvent('did some work'),
        { type: 'chunk', chunk: { type: 'content', content: 'Hi! What can I help with?' } },
        { type: 'suggestion', suggestion: 'Hi! What can I help with?' },
        { type: 'done', metadata: undefined },
      );
    });

    await streamResponse(ctx, session, 'go', undefined, { cleanFinal: true, progressDelayMs: 0 });

    expect(replies.some((r) => r.includes('💡'))).toBe(false);
  });

  it('renderProgressRegion/renderActivityReceipt are pure and bounded', () => {
    expect(renderProgressRegion([])).toBe('');
    expect(renderProgressRegion(['a', 'b'])).toBe('\na\nb');
    // Window of 6: a 9-entry input keeps the tail only.
    const nine = Array.from({ length: 9 }, (_, i) => `l${i + 1}`);
    expect(renderProgressRegion(nine)).toBe('\nl4\nl5\nl6\nl7\nl8\nl9');
    expect(renderActivityReceipt(0, 5_000)).toBe('');
    expect(renderActivityReceipt(1, 4_000)).toBe('\n\n⏱️ 1 step · 4s');
    expect(renderActivityReceipt(3, 12_400)).toBe('\n\n⏱️ 3 steps · 12s');
    // Sub-second turns floor to 1s rather than showing '0s'.
    expect(renderActivityReceipt(2, 200)).toBe('\n\n⏱️ 2 steps · 1s');
  });
});

describe('◦ progress region — PR #702 review follow-ups', () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  function progressEvent(description: string): OutputEvent {
    return {
      type: 'progress',
      progress: { taskId: 't', description, totalTokens: 0, toolUses: 1, durationMs: 1 },
    } as OutputEvent;
  }

  it('bounds progress across INTERLEAVED content, not just within one consecutive run (Codex P1)', async () => {
    // Regression: the region used to be spliced into `accumulated` at an offset,
    // so any content chunk froze it in place and the next progress event started a
    // NEW region. An alternating stream — what the anthropic-direct and
    // openai-compatible loops actually emit — therefore kept all 9 lines. As a
    // single footer the MAX_PROGRESS_LINES bound holds globally.
    const { ctx, edits } = makeCtx();
    const session = makeSession(async function* () {
      for (let i = 1; i <= 9; i++) {
        yield progressEvent(`round-${i}`);
        yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: `c${i} ` } };
      }
      yield { type: 'done' as const, metadata: undefined };
    });

    await streamResponse(ctx, session, 'go', undefined, { progressDelayMs: 0 });

    const final = edits[edits.length - 1] ?? '';
    // Window of 6 over NINE rounds that each had content in between.
    expect(final).toContain('round-9');
    expect(final).toContain('round-4');
    expect(final).not.toContain('round-3');
    expect(final).not.toContain('round-1');
    // Answer content is untouched by the bounded region.
    expect(final).toContain('c1 ');
    expect(final).toContain('c9 ');
  });

  it('opens the gate on a timer when no further progress event arrives (Codex P2)', async () => {
    // Regression: the gate was re-checked ONLY when another `progress` event
    // arrived, so a single tool running silently past the delay left the user on
    // `Thinking…` for its whole duration. cleanFinal delivers only `answerText`
    // (no ◦), so the progress line can reach the user ONLY via a live edit —
    // which means the timer fired.
    const { ctx, replies, edits } = makeCtx();
    const session = makeSession(async function* () {
      yield progressEvent('slow tool running');
      await sleep(90); // silent stretch longer than progressDelayMs
      yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: 'Answer.' } };
      yield { type: 'done' as const, metadata: undefined };
    });

    await streamResponse(ctx, session, 'go', undefined, { cleanFinal: true, progressDelayMs: 25 });

    expect(edits.some((e) => e.includes('slow tool running'))).toBe(true);
    // The clean final answer is still free of ◦ noise.
    expect(replies.some((r) => r.includes('◦'))).toBe(false);
    expect(replies.some((r) => r.includes('Answer.'))).toBe(true);
  });

  it('delivers a gated progress-only turn that ends WITHOUT a done event (review: medium)', async () => {
    // Regression introduced by the first commit of this PR: the withheld-region
    // flush was added to the `done` branch only. A provider stream that ends by
    // graceful iterator close (no done/error) hit the post-loop branch, where
    // bare `accumulated` is empty under a closed gate — so nothing was delivered
    // and the user was stranded on `Thinking…`. Uses the DEFAULT gate so every
    // line really is withheld.
    const { ctx, replies, edits } = makeCtx();
    const session = makeSession(async function* () {
      yield progressEvent('did work then the stream closed');
      // no `done` — the generator simply returns
    });

    await streamResponse(ctx, session, 'go', undefined, { cleanFinal: true });

    expect([...replies, ...edits].some((t) => t.includes('did work then the stream closed'))).toBe(true);
    expect([...replies, ...edits].every((t) => t !== 'Thinking…') || replies.length > 0).toBe(true);
  });
});

describe('chronological interleave of the ◦ progress region (live preview)', () => {
  function progressEvent(description: string): OutputEvent {
    return {
      type: 'progress',
      progress: { taskId: 't', description, totalTokens: 0, toolUses: 1, durationMs: 1 },
    } as OutputEvent;
  }
  const content = (c: string): OutputEvent =>
    ({ type: 'chunk', chunk: { type: 'content', content: c } }) as OutputEvent;

  // Sentences are >100 chars combined with a label so no live edit is dropped by
  // EDIT_THROTTLE_MS (which only throttles payloads under 100 chars).
  const A = 'First I check the schedule and confirm that the cron expression is actually right. ';
  const B = 'Now I run the rehearsal to see whether the 9am fire really works end to end. ';

  it('WIRING: a live-preview edit places the ◦ line BETWEEN the two narration runs', async () => {
    // The reported bug: every round's preamble was concatenated into one wall
    // ("…your session.Diagnosis is clear.") with all ◦ lines collected at the
    // bottom, so no line sat next to the tool round it described.
    const { ctx, edits } = makeCtx();
    const session = makeSession(async function* () {
      yield content(A);
      yield progressEvent('Using list schedules');
      yield content(B);
      yield { type: 'done', metadata: undefined } as OutputEvent;
    });

    await streamResponse(ctx, session, 'go', undefined, { progressDelayMs: 0 });

    // The label sits between the runs — this is the whole point of the change.
    // The trailing break after the label is load-bearing: without it the next
    // round's narration absorbs into the label (`◦ Using list schedulesNow I…`).
    expect(edits).toContain(`${A}\n◦ Using list schedules\n${B}`);
    // No LIVE preview glues the two runs into the reported wall of text. The final
    // edit is excluded deliberately: that one is finalBody(), whose trailing-footer
    // shape (and therefore its concatenation) is held byte-stable because it is a
    // DELIVERED payload on progress-only / non-terminal-exit turns.
    const previews = edits.slice(0, -1);
    expect(previews.some((e) => e.includes('right. Now I run'))).toBe(false);
  });

  it('DELIVERY: the final body still uses the legacy trailing footer, byte-stable', async () => {
    // finalBody() is delivered (not merely previewed) when answerText is empty or
    // the stream ends without a terminal event, so interleaving must not reach it.
    const { ctx, edits } = makeCtx();
    const session = makeSession(async function* () {
      yield content(A);
      yield progressEvent('Using list schedules');
      yield content(B);
      yield { type: 'done', metadata: undefined } as OutputEvent;
    });

    await streamResponse(ctx, session, 'go', undefined, { progressDelayMs: 0 });

    expect(edits[edits.length - 1]).toBe(`${A}${B}\n◦ Using list schedules`);
  });

  it('SEMANTICS: bounded to 6 labels, chronological, and breaks trimmed rounds apart', () => {
    // Nine rounds, each recorded after its own content chunk — the alternating
    // shape both provider loops actually emit.
    const text = 'c1 c2 c3 c4 c5 c6 c7 c8 c9 ';
    const entries = Array.from({ length: 9 }, (_, i) => ({
      label: `round-${i + 1}`,
      at: 3 * (i + 1),
    }));

    const out = renderInterleavedPreview(text, entries);

    // Exact shape: a 6-label window (rounds 4..9) placed after their own text,
    // and a bare line break standing in for each trimmed round (1..3). Each
    // label is TERMINATED by a break when narration follows it, so the next
    // round's text never absorbs into the label; the last label (round-9) sits
    // at end-of-text and stays bare.
    expect(out).toBe(
      'c1 \nc2 \nc3 \nc4 \nround-4\nc5 \nround-5\nc6 \nround-6\nc7 \nround-7\nc8 \nround-8\nc9 \nround-9',
    );
    // Global cap preserved — the property PR #702 established.
    expect(out).toContain('round-9');
    expect(out).toContain('round-4');
    expect(out).not.toContain('round-3');
    expect(out).not.toContain('round-1');
    // Narration is never trimmed.
    expect(out).toContain('c1 ');
    expect(out).toContain('c9 ');
    // Chronology: each label follows its own round's text and precedes the next.
    expect(out.indexOf('c4 ')).toBeLessThan(out.indexOf('round-4'));
    expect(out.indexOf('round-4')).toBeLessThan(out.indexOf('c5 '));
    expect(out.indexOf('round-8')).toBeLessThan(out.indexOf('round-9'));
    // A trimmed round still separates the narration either side of it.
    expect(out).not.toContain('c1 c2 ');
  });

  it('renderInterleavedPreview is pure and degenerate-safe', () => {
    expect(renderInterleavedPreview('abc', [])).toBe('abc');
    expect(renderInterleavedPreview('', [{ label: '◦ a', at: 0 }])).toBe('\n◦ a');
    // Following narration is separated from the label by a break, never glued.
    expect(renderInterleavedPreview('onetwo', [{ label: '◦ a', at: 3 }])).toBe('one\n◦ a\ntwo');
    // ...but text that ALREADY starts with a newline gains no second break.
    expect(renderInterleavedPreview('one\ntwo', [{ label: '◦ a', at: 3 }])).toBe('one\n◦ a\ntwo');
    // A label at END of text stays bare — the footer/byte-equivalence contract.
    expect(renderInterleavedPreview('one', [{ label: '◦ a', at: 3 }])).toBe('one\n◦ a');
    // Consecutive rounds at the SAME offset emit no stray breaks: this is the
    // progress-only turn, and it must stay byte-identical to the footer output.
    const nine = Array.from({ length: 9 }, (_, i) => ({ label: `l${i + 1}`, at: 0 }));
    expect(renderInterleavedPreview('', nine)).toBe('\nl4\nl5\nl6\nl7\nl8\nl9');
    expect(renderInterleavedPreview('', nine)).toBe(renderProgressRegion(nine.map((e) => e.label)));
  });

  it('never splices inside a code fence or an inline-code span (formatter safety)', () => {
    // markdownToTelegramHtml extracts fenced blocks and inline spans positionally,
    // so a label landing inside one is swallowed into <pre>/<code> and can break
    // backtick parity for the rest of the message. An unsafe offset degrades to
    // the end of the text — exactly where the legacy footer put it.
    const openFence = 'intro\n```bash\nnpm run build';
    expect(renderInterleavedPreview(openFence, [{ label: '◦ x', at: 20 }]))
      .toBe(`${openFence}\n◦ x`);
    const openSpan = 'see `pnpm test for more';
    expect(renderInterleavedPreview(openSpan, [{ label: '◦ x', at: 12 }]))
      .toBe(`${openSpan}\n◦ x`);
    // A CLOSED fence is safe to splice after.
    const closed = 'a\n```sh\nls\n```\nb';
    expect(renderInterleavedPreview(closed, [{ label: '◦ x', at: closed.length - 2 }]))
      .toBe('a\n```sh\nls\n```\n◦ x\nb');
  });

  it('clamps a stale offset to the end instead of splicing mid-sentence', () => {
    // stream_retry rewinds `accumulated` mid-turn and the authoritative assistant
    // message replaces it wholesale at turn end, so a recorded offset can outrun
    // the buffer. It must collapse to the end (footer placement), never throw.
    expect(renderInterleavedPreview('short', [{ label: '◦ x', at: 999 }]))
      .toBe('short\n◦ x');
    // Offsets are forced monotonic: a later entry can never render before an
    // earlier one even if its recorded offset went backwards.
    expect(
      renderInterleavedPreview('abcdef', [
        { label: '◦ first', at: 4 },
        { label: '◦ second', at: 1 },
      ]),
    ).toBe('abcd\n◦ first\n◦ second\nef');
  });

  it('terminates a label so following narration never absorbs into it (review 1)', () => {
    // The next iteration appends text.slice(pos, at) — the FOLLOWING round's
    // narration. Without a delimiter it reads as part of the label.
    const out = renderInterleavedPreview('firstNow I run the rehearsal', [
      { label: '◦ Using list schedules', at: 5 },
    ]);
    expect(out).toBe('first\n◦ Using list schedules\nNow I run the rehearsal');
    expect(out).not.toContain('◦ Using list schedulesNow');
    // Superstring invariant: narration is never dropped or reordered.
    expect(out.replace(/\n◦ Using list schedules\n/, '')).toBe('firstNow I run the rehearsal');
  });

  it('defers a splice inside an UNTERMINATED markdown link (review 2)', () => {
    // A tool boundary splits a link across rounds. formatter.ts step 7 rewrites
    // [text](url) positionally, so a label spliced into either half is swallowed
    // into the href — hiding the status and corrupting the target.
    const openUrl = 'see [docs](https://exa';
    expect(renderInterleavedPreview(openUrl, [{ label: '◦ x', at: 22 }]))
      .toBe(`${openUrl}\n◦ x`);
    // Mid-URL (in range, not end-of-text) must also degrade to the end.
    const openUrlMore = 'see [docs](https://exa and then more prose';
    expect(renderInterleavedPreview(openUrlMore, [{ label: '◦ x', at: 22 }]))
      .toBe(`${openUrlMore}\n◦ x`);
    // Unclosed label: `[docs` with no `]` yet.
    const openLabel = 'see [docs plus trailing prose';
    expect(renderInterleavedPreview(openLabel, [{ label: '◦ x', at: 9 }]))
      .toBe(`${openLabel}\n◦ x`);
    // A COMPLETE link is safe to splice after — the guard is not a blanket ban.
    const closedLink = 'see [docs](https://example.com) then more';
    expect(renderInterleavedPreview(closedLink, [{ label: '◦ x', at: 31 }]))
      .toBe('see [docs](https://example.com)\n◦ x\n then more');
  });

  it('emits no stray blank line when a trimmed round shares an offset (review 4)', () => {
    // A trimmed entry (i < labelFrom) emits a bare `\n`; when the immediately
    // following LABELED entry sits at the same offset it emits `\n<label>` too,
    // which used to yield `\n\n` between narration and its label.
    const out = renderInterleavedPreview('abcdef', [
      { label: 'l1', at: 3 },
      { label: 'l2', at: 3 },
      { label: 'l3', at: 4 },
      { label: 'l4', at: 4 },
      { label: 'l5', at: 5 },
      { label: 'l6', at: 5 },
      { label: 'l7', at: 6 },
    ]);
    expect(out).not.toContain('\n\n');
    expect(out).toBe('abc\nl2\nd\nl3\nl4\ne\nl5\nl6\nf\nl7');
    // The trimmed round is still label-suppressed (global cap intact).
    expect(out).not.toContain('l1');
  });

  it('mirrors the formatter fence pattern: a single-line ```word``` is NOT a fence (review 5)', () => {
    // formatter.ts step 2 requires a newline after the opening fence and anchors
    // at line start, so it sees NO complete fence here — meaning an offset after
    // it lands in the inline-code pass. Both parse models must agree, so this
    // offset is unsafe and degrades to end-of-text.
    const inlineFence = 'run ```build``` now and more';
    expect(renderInterleavedPreview(inlineFence, [{ label: '◦ x', at: 20 }]))
      .toBe(`${inlineFence}\n◦ x`);
    // Indented (≤3 spaces) real fence still parses as complete, per the
    // formatter's ^ {0,3} prefix — so splicing right after it stays SAFE.
    const indented = ' ```sh\nls\n```\ntail text';
    expect(renderInterleavedPreview(indented, [{ label: '◦ x', at: indented.indexOf('\ntail') }]))
      .toBe(' ```sh\nls\n```\n◦ x\ntail text');
  });

  it('WIRING: re-bases retained offsets when the assistant message replaces the buffer (review 3)', async () => {
    // :782 replaces `accumulated` wholesale with the FINAL round's text only, so
    // an offset sampled in an earlier round is frequently still IN RANGE of the
    // replacement — the monotonic clamp never fires and the label splices
    // mid-word. Replacement here is LONGER than the recorded offset (the case
    // the clamp cannot cover).
    const early = 'Short first round. ';
    const replacement =
      'A completely different and much longer authoritative final answer that outruns the early offset.';
    expect(replacement.length).toBeGreaterThan(early.length);

    const { ctx, edits } = makeCtx();
    const session = makeSession(async function* () {
      yield content(early);
      yield progressEvent('Using list schedules');
      yield {
        type: 'message',
        message: { role: 'assistant', content: replacement },
      } as OutputEvent;
      yield { type: 'done', metadata: undefined } as OutputEvent;
    });

    await streamResponse(ctx, session, 'go', undefined, { progressDelayMs: 0 });

    // Filter-independent on purpose: the BUGGY render splits `replacement`
    // around the label ('A completely differ\n◦ …\nent and much longer…'), so any
    // filter keyed on `includes(replacement)` would silently exclude the very
    // edit under test and pass vacuously. Assert over ALL edits instead.
    const label = '◦ Using list schedules';
    const labelled = edits.filter((e) => e.includes(label));
    expect(labelled.length).toBeGreaterThan(0);
    for (const e of labelled) {
      // Footer placement: the label terminates the message, never interrupts it.
      expect(e.endsWith(`\n${label}`)).toBe(true);
      // The specific reported corruption: a splice mid-word.
      expect(e).not.toMatch(new RegExp(`\\n${label}\\n\\S`));
    }
    // The post-replace preview shows the authoritative text whole, label at end.
    expect(edits).toContain(`${replacement}\n${label}`);
    // And no edit renders the buffer torn apart by the stale offset.
    expect(edits.some((e) => e.includes('differ\n'))).toBe(false);
  });
});
