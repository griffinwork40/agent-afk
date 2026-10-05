/**
 * Hook-level tests for the journal fallback path and subagent artifact recovery.
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
 *   - recoverSubagentArtifacts collects commits/PRs from subagent journals (#2446)
 *   - recoverSubagentArtifacts is empty when no subagent journals exist
 *   - recoverSubagentArtifacts deduplicates artifacts across multiple children
 *   - recoverSubagentArtifacts skips a corrupt subagent journal gracefully
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

/**
 * Write a subagent journal at `afkHome/state/sessions/<id>/subagents/<subId>.jsonl`.
 */
function writeSubagentJournal(
  afkHome: string,
  sessionId: string,
  subagentId: string,
  messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }>,
): void {
  const subDir = join(afkHome, 'state', 'sessions', sessionId, 'subagents');
  mkdirSync(subDir, { recursive: true });
  const journalPath = join(subDir, `${subagentId}.jsonl`);

  const records: string[] = [
    JSON.stringify({
      v: 1,
      ts: Date.now(),
      kind: 'meta',
      sessionId,
      subagentId,
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

// ─── recoverSubagentArtifacts (#2446) ────────────────────────────────────────

describe('recoverSubagentArtifacts — no subagent journals', () => {
  it('returns empty artifacts when no subagents dir exists', async () => {
    const { recoverSubagentArtifacts } = await import('./load-outcome-turns.js');
    const sessionId = 'sess-no-subagents';
    // No session dir at all — should not throw
    const result = recoverSubagentArtifacts(sessionId);
    expect(result.commits).toEqual([]);
    expect(result.prs).toEqual([]);
    expect(result.repo).toBeNull();
  });

  it('returns empty artifacts when subagents dir is empty', async () => {
    const { recoverSubagentArtifacts } = await import('./load-outcome-turns.js');
    const sessionId = 'sess-empty-subagents';
    // Create a parent journal so the session dir exists, but no subagents
    writeJournal(tmpDir, sessionId, [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
    const result = recoverSubagentArtifacts(sessionId);
    expect(result.commits).toEqual([]);
    expect(result.prs).toEqual([]);
  });
});

describe('recoverSubagentArtifacts — collects child commits and PRs (#2446)', () => {
  it('recovers a commit SHA from a single subagent journal', async () => {
    const { recoverSubagentArtifacts } = await import('./load-outcome-turns.js');
    const sessionId = 'sess-sub-commit';
    writeSubagentJournal(tmpDir, sessionId, 'child-1', [
      { role: 'user', content: [{ type: 'text', text: 'make a commit' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'bash', input: { command: 'git commit -m "feat: x"' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tu-1',
            content: [{ type: 'text', text: '[main abc1234] feat: x' }],
          },
        ],
      },
    ]);
    const result = recoverSubagentArtifacts(sessionId);
    expect(result.commits).toContain('abc1234');
    expect(result.prs).toEqual([]);
  });

  it('recovers a PR URL from a single subagent journal', async () => {
    const { recoverSubagentArtifacts } = await import('./load-outcome-turns.js');
    const sessionId = 'sess-sub-pr';
    writeSubagentJournal(tmpDir, sessionId, 'child-pr', [
      { role: 'user', content: [{ type: 'text', text: 'open a PR' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-pr', name: 'bash', input: { command: 'gh pr create --title "feat" --body ""' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tu-pr',
            content: [{ type: 'text', text: 'https://github.com/org/repo/pull/42' }],
          },
        ],
      },
    ]);
    const result = recoverSubagentArtifacts(sessionId);
    expect(result.prs).toContain('https://github.com/org/repo/pull/42');
  });

  it('merges artifacts from multiple subagent journals without duplicates', async () => {
    const { recoverSubagentArtifacts } = await import('./load-outcome-turns.js');
    const sessionId = 'sess-multi-sub';

    // Child A: one commit
    writeSubagentJournal(tmpDir, sessionId, 'child-a', [
      { role: 'user', content: [{ type: 'text', text: 'commit A' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-a', name: 'bash', input: { command: 'git commit -m "feat: A"' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'tu-a', content: [{ type: 'text', text: '[main aaa1111] feat: A' }] }],
      },
    ]);

    // Child B: a different commit + same commit as A (dedup test)
    writeSubagentJournal(tmpDir, sessionId, 'child-b', [
      { role: 'user', content: [{ type: 'text', text: 'commit B' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-b1', name: 'bash', input: { command: 'git commit -m "feat: B"' } },
          { type: 'tool_use', id: 'tu-b2', name: 'bash', input: { command: 'git commit -m "feat: dupe"' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'tu-b1', content: [{ type: 'text', text: '[main bbb2222] feat: B' }] },
          { type: 'tool_result', toolUseId: 'tu-b2', content: [{ type: 'text', text: '[main aaa1111] feat: dupe' }] },
        ],
      },
    ]);

    const result = recoverSubagentArtifacts(sessionId);
    expect(result.commits).toContain('aaa1111');
    expect(result.commits).toContain('bbb2222');
    // aaa1111 appeared in both children — must appear exactly once
    expect(result.commits.filter((s) => s === 'aaa1111')).toHaveLength(1);
  });

  it('skips a corrupt subagent journal gracefully', async () => {
    const { recoverSubagentArtifacts } = await import('./load-outcome-turns.js');
    const sessionId = 'sess-corrupt-sub';

    // Write a valid subagent journal
    writeSubagentJournal(tmpDir, sessionId, 'child-good', [
      { role: 'user', content: [{ type: 'text', text: 'commit' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-g', name: 'bash', input: { command: 'git commit -m "ok"' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'tu-g', content: [{ type: 'text', text: '[main ccc3333] ok' }] }],
      },
    ]);

    // Write a corrupt subagent journal (invalid JSONL)
    const subDir = join(tmpDir, 'state', 'sessions', sessionId, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'child-bad.jsonl'), '{NOT VALID JSON\n', 'utf8');

    // Should recover commits from the good child and skip the bad one
    const result = recoverSubagentArtifacts(sessionId);
    expect(result.commits).toContain('ccc3333');
    // No throw: the corrupt journal was silently skipped
  });
});
