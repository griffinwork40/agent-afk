/**
 * Hook-level tests for the journal fallback path.
 *
 * Verifies that when no sidecar exists but a journal is present, the outcome
 * hook produces real labeling votes rather than empty-turn results.
 *
 * Tests:
 *   - error_tail fires on 3 trailing errors from journal
 *   - session_kind becomes 'mutating' when edit_file appears in journal
 *   - first_prompt is extracted from the journal's first user message
 *   - loadOutcomeTurns returns source:'sidecar' when sidecar exists
 *   - loadOutcomeTurns returns source:'journal' when only journal exists
 *   - loadOutcomeTurns returns source:'none' when neither exists
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Write a journal.jsonl for `sessionId` into `afkHome/state/sessions/<id>/journal.jsonl`.
 * Each element of `messages` becomes an `append` record.
 */
function writeJournal(
  afkHome: string,
  sessionId: string,
  messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }>,
): void {
  const sessionDir = join(afkHome, 'state', 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const journalPath = join(sessionDir, 'journal.jsonl');

  const records: string[] = [
    JSON.stringify({
      v: 1,
      ts: Date.now(),
      kind: 'meta',
      sessionId,
      writerId: 'test',
    }),
    ...messages.map((msg, index) =>
      JSON.stringify({
        v: 1,
        ts: Date.now() + index,
        kind: 'append',
        index,
        message: msg,
      }),
    ),
  ];
  writeFileSync(journalPath, records.join('\n') + '\n', 'utf8');
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let tmpDir: string;
let prevAfkHome: string | undefined;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `afk-outcome-journal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  prevAfkHome = process.env['AFK_HOME']; // audit-env-access: allow — test isolation
  process.env['AFK_HOME'] = tmpDir; // audit-env-access: allow — test isolation
});

afterEach(() => {
  if (prevAfkHome === undefined) delete process.env['AFK_HOME']; // audit-env-access: allow — test isolation
  else process.env['AFK_HOME'] = prevAfkHome; // audit-env-access: allow — test isolation
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── loadOutcomeTurns source selection ───────────────────────────────────────

describe('loadOutcomeTurns — source selection', () => {
  it('returns source:none when neither sidecar nor journal exists', async () => {
    const { loadOutcomeTurns } = await import('./load-outcome-turns.js');
    const result = loadOutcomeTurns('sess-no-journal');
    expect(result.source).toBe('none');
    expect(result.turns).toEqual([]);
  });

  it('returns source:journal when only journal exists', async () => {
    const sessionId = 'sess-journal-only';
    writeJournal(tmpDir, sessionId, [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
    ]);

    const { loadOutcomeTurns } = await import('./load-outcome-turns.js');
    const result = loadOutcomeTurns(sessionId);
    expect(result.source).toBe('journal');
    expect(result.turns.length).toBeGreaterThan(0);
  });

  it('returns source:sidecar when sidecar exists with turns', async () => {
    const sessionId = 'sess-with-sidecar';
    // Write a minimal sidecar
    const sessionsDir = join(tmpDir, 'state', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const sidecar = {
      sessionId,
      model: 'claude-sonnet',
      startedAt: Date.now(),
      savedAt: Date.now(),
      totalTurns: 1,
      turns: [{ user: 'hello from sidecar', assistant: 'ok', timestamp: Date.now() }],
    };
    writeFileSync(join(sessionsDir, `${sessionId}.json`), JSON.stringify(sidecar), 'utf8');

    const { loadOutcomeTurns } = await import('./load-outcome-turns.js');
    const result = loadOutcomeTurns(sessionId);
    expect(result.source).toBe('sidecar');
    expect(result.turns[0]?.user).toBe('hello from sidecar');
  });

  it('falls back to journal when sidecar is corrupt (invalid JSON)', async () => {
    const sessionId = 'sess-corrupt-sidecar';
    // Write a corrupt sidecar (invalid JSON)
    const sessionsDir = join(tmpDir, 'state', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, `${sessionId}.json`), '{ "turns": [CORRUPT', 'utf8');

    // Write a valid journal that the fallback should use
    writeJournal(tmpDir, sessionId, [
      { role: 'user', content: [{ type: 'text', text: 'from journal fallback' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]);

    const { loadOutcomeTurns } = await import('./load-outcome-turns.js');
    const result = loadOutcomeTurns(sessionId);
    // Corrupt sidecar must not suppress the journal fallback
    expect(result.source).toBe('journal');
    expect(result.turns.length).toBeGreaterThan(0);
  });
});

// ─── error_tail fires from journal ───────────────────────────────────────────

describe('journal fallback — error_tail fires on 3 trailing errors', () => {
  it('votes -1 error_tail when session ends with 3+ consecutive errors from journal', async () => {
    const sessionId = 'sess-error-tail';
    // Build a journal: user prompt, then assistant with 4 tool_use blocks,
    // then tool_results all with isError:true.
    writeJournal(tmpDir, sessionId, [
      { role: 'user', content: [{ type: 'text', text: 'fix the tests' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'bash', input: { command: 'pnpm test' } },
          { type: 'tool_use', id: 'tu-2', name: 'bash', input: { command: 'pnpm test' } },
          { type: 'tool_use', id: 'tu-3', name: 'bash', input: { command: 'pnpm test' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'tu-1', isError: true, content: [{ type: 'text', text: 'err1' }] },
          { type: 'tool_result', toolUseId: 'tu-2', isError: true, content: [{ type: 'text', text: 'err2' }] },
          { type: 'tool_result', toolUseId: 'tu-3', isError: true, content: [{ type: 'text', text: 'err3' }] },
        ],
      },
    ]);

    const { loadOutcomeTurns } = await import('./load-outcome-turns.js');
    const { lfErrorTail } = await import('./lf-immediate.js');

    const { turns, source } = loadOutcomeTurns(sessionId);
    expect(source).toBe('journal');
    expect(turns.length).toBeGreaterThan(0);

    const now = new Date().toISOString();
    const vote = lfErrorTail(turns, now);
    expect(vote).not.toBeNull();
    expect(vote!.lf).toBe('error_tail');
    expect(vote!.vote).toBe(-1);
  });
});

// ─── session_kind = 'mutating' from journal ───────────────────────────────────

describe('journal fallback — session_kind from journal', () => {
  it('detects mutating session when edit_file appears in journal', async () => {
    const sessionId = 'sess-mutating';
    writeJournal(tmpDir, sessionId, [
      { role: 'user', content: [{ type: 'text', text: 'add a feature' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-ef', name: 'edit_file', input: { file_path: '/foo.ts', old_string: 'a', new_string: 'b' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'tu-ef', content: [{ type: 'text', text: 'ok' }] },
        ],
      },
    ]);

    const { loadOutcomeTurns } = await import('./load-outcome-turns.js');
    const { turns, source } = loadOutcomeTurns(sessionId);
    expect(source).toBe('journal');

    // detectSessionKind is internal to session-end-hook.ts; replicate here
    const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'patch_apply']);
    const kind = turns.some((t) =>
      t.toolEvents?.some((ev) => WRITE_TOOLS.has(ev.toolName)),
    )
      ? 'mutating'
      : 'text';
    expect(kind).toBe('mutating');
  });
});

// ─── first_prompt from journal ────────────────────────────────────────────────

describe('journal fallback — first_prompt extraction', () => {
  it('extracts first_prompt from the first user message in the journal', async () => {
    const sessionId = 'sess-first-prompt';
    writeJournal(tmpDir, sessionId, [
      { role: 'user', content: [{ type: 'text', text: 'create a new feature for X' }] },
      { role: 'assistant', content: [{ type: 'text', text: '**Done**' }] },
    ]);

    const { loadOutcomeTurns } = await import('./load-outcome-turns.js');
    const { turns, source } = loadOutcomeTurns(sessionId);
    expect(source).toBe('journal');

    // extractFirstPrompt logic (replicated from session-end-hook.ts)
    let firstPrompt: string | undefined;
    for (const turn of turns) {
      const text = turn.user?.trim();
      if (text) { firstPrompt = text.slice(0, 2000); break; }
    }
    expect(firstPrompt).toBe('create a new feature for X');
  });

  it('strips preamble so first_prompt is the real user question', async () => {
    const sessionId = 'sess-fp-preamble';
    const preamble =
      '[skill-routing: active]\nsome instructions\n' +
      '[bridge: context]\ncommit abc\n' +
      'Read any referenced file for deeper context before acting — these are pointers, not full content.\n' +
      '\nfix the flaky test';

    writeJournal(tmpDir, sessionId, [
      { role: 'user', content: [{ type: 'text', text: preamble }] },
      { role: 'assistant', content: [{ type: 'text', text: '**Done**' }] },
    ]);

    const { loadOutcomeTurns } = await import('./load-outcome-turns.js');
    const { turns } = loadOutcomeTurns(sessionId);

    let firstPrompt: string | undefined;
    for (const turn of turns) {
      const text = turn.user?.trim();
      if (text) { firstPrompt = text.slice(0, 2000); break; }
    }
    expect(firstPrompt).toBe('fix the flaky test');
  });
});

describe('sessionHistoryMessages — history, not the folded context', () => {
  const user = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] });
  const rec = (index: number, message: ReturnType<typeof user>) =>
    ({ v: 1 as const, ts: index, kind: 'append' as const, index, message });

  it('keeps messages a truncate record dropped from the fold', async () => {
    const { sessionHistoryMessages } = await import('./load-outcome-turns.js');
    const records = [
      rec(0, user('first')),
      rec(1, user('committed abc1234')),
      { v: 1 as const, ts: 2, kind: 'truncate' as const, length: 1, reason: 'compact' as const },
      rec(1, user('summary')),
    ];
    const texts = sessionHistoryMessages(records).map((m) => (m.content[0] as { text: string }).text);
    expect(texts).toEqual(['first', 'committed abc1234', 'summary']);
  });

  it('skips verbatim re-appends (resync / compaction replay)', async () => {
    const { sessionHistoryMessages } = await import('./load-outcome-turns.js');
    const records = [
      rec(0, user('first')),
      { v: 1 as const, ts: 1, kind: 'truncate' as const, length: 0, reason: 'resync' as const },
      rec(0, user('first')),
      rec(1, user('second')),
    ];
    expect(sessionHistoryMessages(records)).toHaveLength(2);
  });
});
