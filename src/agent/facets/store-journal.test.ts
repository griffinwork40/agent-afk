/**
 * store-journal.test.ts — integration tests verifying that getOrDeriveFacet
 * reads journal data when available and falls back to the sidecar path when:
 *   - journal is absent
 *   - AFK_MESSAGE_JOURNAL_DISABLED=1
 *   - journal file is unreadable
 *
 * Also verifies:
 *   - journal mtime bump triggers re-derive
 *   - subagent tool calls are excluded from parent tool_counts
 *   - subagent_breakdown is populated when subagent journals exist
 *
 * Uses useTmpAfkHome() so all path helpers resolve into a temp directory.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { useTmpAfkHome } from '../journal/__test-utils__/helpers.js';
import { getOrDeriveFacet } from './store.js';
import type { StoredSessionInput } from './schema.js';

const { home } = useTmpAfkHome();

// A safe session id for isSafeLedgerSessionId
const SESSION_ID = 'store-journal-test-sess';

function makeSession(overrides: Partial<StoredSessionInput> = {}): StoredSessionInput {
  return {
    sessionId: SESSION_ID,
    model: 'sonnet',
    startedAt: 1_000_000,
    savedAt: 1_001_000,
    totalTurns: 1,
    turns: [
      {
        user: 'hello',
        assistant: 'hi',
        toolEvents: [
          { toolName: 'bash', toolUseId: 'sidecar-1', input: 'ls' },
        ],
      },
    ],
    ...overrides,
  };
}

function writeSession(session: StoredSessionInput): string {
  const sessDir = join(home(), 'state', 'sessions');
  mkdirSync(sessDir, { recursive: true });
  const p = join(sessDir, `${SESSION_ID}.json`);
  writeFileSync(p, JSON.stringify(session), 'utf8');
  return p;
}

function cacheDir(): string {
  const d = join(home(), 'state', 'facets');
  mkdirSync(d, { recursive: true });
  return d;
}

function writeJournal(content: string): string {
  const ledgerDir = join(home(), 'state', 'sessions', SESSION_ID);
  mkdirSync(ledgerDir, { recursive: true });
  const p = join(ledgerDir, 'journal.jsonl');
  writeFileSync(p, content, 'utf8');
  return p;
}

function writeSubagentJournal(subId: string, content: string): string {
  const subDir = join(home(), 'state', 'sessions', SESSION_ID, 'subagents');
  mkdirSync(subDir, { recursive: true });
  const p = join(subDir, `${subId}.jsonl`);
  writeFileSync(p, content, 'utf8');
  return p;
}

function journalLine(record: Record<string, unknown>): string {
  return JSON.stringify(record) + '\n';
}

const TS = 1_000_000;
const V = 1;

function metaLine(): string {
  return journalLine({ v: V, ts: TS, kind: 'meta', sessionId: SESSION_ID, writerId: 'w1' });
}

function appendLine(index: number, blocks: unknown[]): string {
  return journalLine({ v: V, ts: TS, kind: 'append', index, message: { role: 'assistant', content: blocks } });
}

function toolUseLine(index: number, id: string, name: string, input: unknown = {}): string {
  return appendLine(index, [{ type: 'tool_use', id, name, input }]);
}

function toolResultLine(index: number, toolUseId: string, text: string, isError?: boolean): string {
  return journalLine({
    v: V, ts: TS, kind: 'append', index,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId, ...(isError !== undefined ? { isError } : {}), content: [{ type: 'text', text }] }],
    },
  });
}

describe('getOrDeriveFacet with journal', () => {
  it('journal counts win over sidecar when journal present', () => {
    writeSession(makeSession());
    // Journal has TWO bash calls (vs. one in the sidecar)
    writeJournal(
      metaLine() +
      toolUseLine(0, 'j1', 'bash') +
      toolUseLine(1, 'j2', 'read_file', { file_path: '/x.ts' }) +
      toolResultLine(2, 'j1', 'ok') +
      toolResultLine(3, 'j2', 'content'),
    );
    const facet = getOrDeriveFacet(SESSION_ID, { cacheDir: cacheDir() });
    expect(facet).toBeDefined();
    // Journal-derived: bash and read_file from journal (not just sidecar's bash)
    expect(facet?.tool_counts?.['bash']).toBe(1);
    expect(facet?.tool_counts?.['read_file']).toBe(1);
    // Sidecar had only 1 bash; journal adds read_file — verify we're not
    // in sidecar-only mode (sidecar has no read_file)
  });

  it('sidecar fallback when journal absent', () => {
    writeSession(makeSession());
    // No journal written
    const facet = getOrDeriveFacet(SESSION_ID, { cacheDir: cacheDir() });
    expect(facet).toBeDefined();
    expect(facet?.tool_counts?.['bash']).toBe(1);
  });

  it('sidecar fallback when AFK_MESSAGE_JOURNAL_DISABLED=1', () => {
    writeSession(makeSession());
    writeJournal(metaLine() + toolUseLine(0, 'j3', 'read_file', { file_path: '/a.ts' }));
    vi.stubEnv('AFK_MESSAGE_JOURNAL_DISABLED', '1');
    try {
      const facet = getOrDeriveFacet(SESSION_ID, { cacheDir: cacheDir() });
      expect(facet).toBeDefined();
      // With journal disabled, should fall back to sidecar (bash only)
      expect(facet?.tool_counts?.['bash']).toBe(1);
      expect(facet?.tool_counts?.['read_file']).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('journal mtime bump triggers re-derive', () => {
    writeSession(makeSession());
    const jPath = writeJournal(metaLine() + toolUseLine(0, 'j4', 'bash'));
    const facet1 = getOrDeriveFacet(SESSION_ID, { cacheDir: cacheDir() });
    expect(facet1?.tool_counts?.['bash']).toBe(1);

    // Now append a new tool call to the journal (changing its mtime)
    writeFileSync(jPath,
      metaLine() +
      toolUseLine(0, 'j4', 'bash') +
      toolUseLine(1, 'j5', 'write_file', { file_path: '/new.ts' }),
      'utf8',
    );

    // Re-derive should pick up the new tool call
    const facet2 = getOrDeriveFacet(SESSION_ID, { cacheDir: cacheDir() });
    expect(facet2?.tool_counts?.['write_file']).toBe(1);
  });

  it('subagent tool calls excluded from parent tool_counts', () => {
    writeSession(makeSession());
    // Parent journal: 1 bash
    writeJournal(metaLine() + toolUseLine(0, 'p1', 'bash'));
    // Subagent journal: 1 read_file (should NOT appear in parent tool_counts)
    writeSubagentJournal('subagent-abc',
      metaLine() + toolUseLine(0, 'sub1', 'read_file', { file_path: '/sub.ts' }),
    );

    const facet = getOrDeriveFacet(SESSION_ID, { cacheDir: cacheDir() });
    expect(facet?.tool_counts?.['bash']).toBe(1);
    // subagent read_file must NOT be in parent counts
    expect(facet?.tool_counts?.['read_file']).toBeUndefined();
  });

  it('subagent_breakdown populated when subagent journals exist', () => {
    writeSession(makeSession());
    writeJournal(metaLine() + toolUseLine(0, 'p2', 'bash'));
    writeSubagentJournal('subagent-xyz',
      metaLine() +
      toolUseLine(0, 'sub2', 'bash') +
      toolResultLine(1, 'sub2', 'err', true),
    );

    const facet = getOrDeriveFacet(SESSION_ID, { cacheDir: cacheDir() });
    expect(facet?.subagent_breakdown).toBeDefined();
    expect(facet?.subagent_breakdown).toHaveLength(1);
    const breakdown = facet?.subagent_breakdown?.[0];
    expect(breakdown?.subagent_id).toBe('subagent-xyz');
    expect(breakdown?.tool_calls).toBe(1);
    expect(breakdown?.tool_errors).toBe(1);
    expect(breakdown?.tool_counts?.['bash']).toBe(1);
  });

  it('no subagent_breakdown when no subagent journals', () => {
    writeSession(makeSession());
    writeJournal(metaLine() + toolUseLine(0, 'p3', 'bash'));
    // No subagent journals
    const facet = getOrDeriveFacet(SESSION_ID, { cacheDir: cacheDir() });
    // breakdown should be absent or empty
    expect(facet?.subagent_breakdown === undefined || facet?.subagent_breakdown.length === 0).toBe(true);
  });

  it('counts compacted tool calls from journal', () => {
    writeSession(makeSession());
    // Simulate: tool_use at index 0, then truncate to 0, then new content
    // The compacted tool_use should still be counted
    writeJournal(
      metaLine() +
      toolUseLine(0, 'compacted', 'read_file', { file_path: '/old.ts' }) +
      JSON.stringify({ v: V, ts: TS, kind: 'truncate', length: 0 }) + '\n' +
      toolUseLine(0, 'fresh', 'bash'),
    );
    const facet = getOrDeriveFacet(SESSION_ID, { cacheDir: cacheDir() });
    // Both should count
    expect(facet?.tool_counts?.['read_file']).toBe(1);
    expect(facet?.tool_counts?.['bash']).toBe(1);
  });
  it('ignores the default-home journal when sessionsDir is overridden', () => {
    // A foreign sessions dir holds only a sidecar; the default home has a
    // journal for the same id. The journal must NOT be attributed to it.
    writeJournal(metaLine() + toolUseLine(0, 'j1', 'read_file', { file_path: '/x.ts' }));
    const foreign = join(home(), 'other-home', 'sessions');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, `${SESSION_ID}.json`), JSON.stringify(makeSession()), 'utf8');
    const facet = getOrDeriveFacet(SESSION_ID, { sessionsDir: foreign, cacheDir: cacheDir() });
    expect(facet?.tool_counts?.['bash']).toBe(1);
    expect(facet?.tool_counts?.['read_file']).toBeUndefined();
  });
  it('detects git commits from the journal bash command', () => {
    writeSession(makeSession());
    writeJournal(metaLine() + toolUseLine(0, 'c1', 'bash', { command: 'cd repo &&\n  git commit -F msg.txt' }));
    const facet = getOrDeriveFacet(SESSION_ID, { cacheDir: cacheDir() });
    expect(facet?.world_changes?.commits).toBe(1);
  });
});
