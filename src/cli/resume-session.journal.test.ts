/**
 * resumeConfigFor × message journal: a session with a journal resumes from its
 * full-fidelity fold (`resumeMessages`, full tool_result content), while the
 * legacy `resumeHistory` path is kept for journal-less sessions.
 */
import { describe, expect, it } from 'vitest';
import { createMessageJournal } from '../agent/journal/index.js';
import { useTmpAfkHome, user, assistant, toolResult } from '../agent/journal/__test-utils__/helpers.js';
import { resumeConfigFor } from './resume-session.js';
import type { StoredSession } from './session-store.js';

useTmpAfkHome();

const BIG = 'line of real tool output\n'.repeat(400);

const stored = {
  sessionId: 'sess-journal-1',
  model: 'sonnet',
  turns: [{ user: 'read it', assistant: 'done', timestamp: 1, inputTokens: 1234 }],
} satisfies Partial<StoredSession> as StoredSession;

async function writeJournal(sessionId: string): Promise<void> {
  const journal = createMessageJournal({ getSessionId: () => sessionId });
  journal.append(0, user('read it'));
  journal.append(1, {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu_1', name: 'read_file', input: { file_path: '/x' } }],
  });
  journal.append(2, toolResult('tu_1', BIG));
  journal.append(3, assistant('done'));
  await journal.close();
}

describe('resumeConfigFor with a message journal', () => {
  it('sets resumeMessages with the FULL tool_result content', async () => {
    await writeJournal('sess-journal-1');
    const config = resumeConfigFor({ id: 'sess-journal-1', resumeId: 'sess-journal-1', stored });

    expect(config.resume).toBe('sess-journal-1');
    expect(config.sessionId).toBe('sess-journal-1');
    expect(config.resumeMessages).toHaveLength(4);
    const tr = config.resumeMessages?.[2]?.content[0];
    expect(tr).toMatchObject({ type: 'tool_result', toolUseId: 'tu_1' });
    const part = tr && tr.type === 'tool_result' ? tr.content[0] : undefined;
    expect(part).toEqual({ type: 'text', text: BIG });
    // Legacy seed still present (context-guard inputTokens + fallback).
    expect(config.resumeHistory?.at(-1)?.inputTokens).toBe(1234);
  });

  it('omits resumeMessages when the session has no journal', () => {
    const config = resumeConfigFor({ id: 'no-journal', resumeId: 'no-journal', stored });
    expect(config).not.toHaveProperty('resumeMessages');
    expect(config.resumeHistory).toHaveLength(1);
  });

  it('omits resumeMessages when the journal is disabled', async () => {
    await writeJournal('sess-journal-off');
    process.env['AFK_MESSAGE_JOURNAL_DISABLED'] = '1'; // audit-env-access: allow — test isolation
    try {
      const config = resumeConfigFor({ id: 'x', resumeId: 'sess-journal-off' });
      expect(config).not.toHaveProperty('resumeMessages');
    } finally {
      delete process.env['AFK_MESSAGE_JOURNAL_DISABLED']; // audit-env-access: allow — test isolation
    }
  });
});
