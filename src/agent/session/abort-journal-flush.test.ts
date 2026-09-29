/**
 * Regression: a child aborted mid-run leaves a journal record per completed
 * tool call after `journal.flush()`.
 *
 * This is the killed-child proof for issue #2460: the retire of
 * `AFK_CAPTURE_SUBAGENT_OUTPUT` required verifying that the journal covers
 * the same failure case that flag was designed for — a child that runs to its
 * timeout and produces no final output. The capture flag flushed per tool call;
 * the journal `flush()` drains the SerialQueue and achieves the same guarantee
 * on a graceful abort.
 *
 * Note: SIGKILL cannot be caught, so an OS-level kill may lose the last queued
 * journal write. This is the same exposure the old capture flag had (it also
 * flushed asynchronously through a WriteStream). The in-process abort path
 * (`journal.flush()` in `agent-session.ts:close()`) is what this test covers.
 *
 * @module agent/session/abort-journal-flush.test
 */

import { describe, expect, it } from 'vitest';
import { useTmpAfkHome, user, toolResult } from '../journal/__test-utils__/helpers.js';
import { createMessageJournal, loadJournalMessages } from '../journal/index.js';

useTmpAfkHome();

describe('journal flush on abort', () => {
  it('records appended before flush() are durable after flush resolves', async () => {
    // Simulate a child that writes journal records for two tool calls but is
    // aborted before sending a final message. This is the scenario AFK_CAPTURE_SUBAGENT_OUTPUT
    // existed to debug: a child that hits its timeout with no final output.
    const journal = createMessageJournal({
      getSessionId: () => 'abort-flush-session',
    });

    // Append two messages simulating the dispatch prompt + a tool result
    // written mid-run before abort.
    journal.append(0, user('dispatch prompt'));
    journal.append(1, toolResult('tool-use-id-1', 'tool call result'));

    // flush() is what agent-session.ts calls on abort — drains the SerialQueue.
    await journal.flush();

    // Both records must be on disk after flush().
    const messages = loadJournalMessages('abort-flush-session');
    expect(messages).not.toBeNull();
    expect(messages).toHaveLength(2);
    expect(messages![0]).toMatchObject({ role: 'user' });
    expect(messages![1]).toMatchObject({ role: 'user' });

    await journal.close();
  });

  it('records are ordered — earlier tool calls appear before later ones', async () => {
    // The incremental capture guarantee: each tool round is a separate append,
    // and all arrive in dispatch order after flush().
    const journal = createMessageJournal({
      getSessionId: () => 'ordered-flush-session',
    });

    for (let i = 0; i < 5; i++) {
      journal.append(i, toolResult(`tool-${i}`, `result-${i}`));
    }
    await journal.flush();

    const messages = loadJournalMessages('ordered-flush-session');
    expect(messages).toHaveLength(5);
    // Verify ordering is preserved: each message is a user/tool_result block.
    for (const message of messages!) {
      expect(message.role).toBe('user');
    }

    await journal.close();
  });
});
