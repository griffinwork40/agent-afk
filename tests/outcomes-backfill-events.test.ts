/**
 * Unit tests for the events.jsonl reader (scripts/outcomes-backfill-events.ts).
 *
 * All I/O is via in-memory strings piped through the parser — no filesystem
 * access, no process.env reads, no network.
 */

import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import type { Turn } from '../src/agent/outcomes/artifacts.js';
import {
  recoverCommitSHAs,
  recoverPRURLs,
} from '../src/agent/outcomes/artifacts.js';
import { parseSelfReport, lfClosure } from '../src/agent/outcomes/lf-immediate.js';

// ---------------------------------------------------------------------------
// Inline parser (mirrors parseEventsFile logic; no fs dependency)
// ---------------------------------------------------------------------------

interface ParsedSession {
  sessionId: string | null;
  cwd: string | null;
  turns: Turn[];
  closureReason: string | null;
}

async function parseLines(lines: string[]): Promise<ParsedSession> {
  // Re-implement the core parser inline so tests have no fs dependency.
  const rl = createInterface({ input: Readable.from(lines.join('\n')) });

  let sessionId: string | null = null;
  let cwd: string | null = null;
  let closureReason: string | null = null;

  const turns: Turn[] = [];
  const pendingTools = new Map<string, { toolName: string; input: string; result?: string; isError?: boolean }>();

  let curUser = '';
  let curAssistant = '';
  let curToolEvents: Array<{ toolName: string; input?: string; result?: string; isError?: boolean }> = [];
  let hasContent = false;

  function flush(): void {
    if (!hasContent) return;
    const turn: Turn = {};
    if (curUser) turn.user = curUser;
    if (curAssistant) turn.assistant = curAssistant;
    if (curToolEvents.length > 0) turn.toolEvents = curToolEvents.map((e) => ({ ...e }));
    if (Object.keys(turn).length > 0) turns.push(turn);
    curUser = '';
    curAssistant = '';
    curToolEvents = [];
    hasContent = false;
  }

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }

    const kind = ev['kind'] as string;

    if (kind === 'meta') {
      if (ev['sessionId']) sessionId = ev['sessionId'] as string;
      if (ev['cwd']) cwd = ev['cwd'] as string;
    } else if (kind === 'user') {
      flush();
      hasContent = true;
      curUser = (ev['text'] as string | undefined) ?? '';
    } else if (kind === 'assistant') {
      hasContent = true;
      const text = (ev['text'] as string | undefined) ?? '';
      curAssistant = curAssistant ? curAssistant + '\n' + text : text;
    } else if (kind === 'tool') {
      hasContent = true;
      const tid = (ev['toolUseId'] as string | undefined) ?? '';
      const inp = typeof ev['input'] === 'string' ? ev['input'] : JSON.stringify(ev['input'] ?? '');
      const stub = { toolName: (ev['toolName'] as string | undefined) ?? 'unknown', input: inp };
      pendingTools.set(tid, stub);
      curToolEvents.push(stub);
    } else if (kind === 'tool_result') {
      const tid = (ev['toolUseId'] as string | undefined) ?? '';
      const p = pendingTools.get(tid);
      if (p) { p.result = (ev['content'] as string | undefined) ?? ''; p.isError = false; pendingTools.delete(tid); }
    } else if (kind === 'tool_error') {
      const tid = (ev['toolUseId'] as string | undefined) ?? '';
      const p = pendingTools.get(tid);
      if (p) { p.result = (ev['content'] as string | undefined) ?? ''; p.isError = true; pendingTools.delete(tid); }
    } else if (kind === 'closed') {
      closureReason = (ev['reason'] as string | undefined) ?? null;
    }
  }
  flush();

  return { sessionId, cwd, turns, closureReason };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function line(rec: Record<string, unknown>): string {
  return JSON.stringify(rec);
}

// ---------------------------------------------------------------------------
// Meta record
// ---------------------------------------------------------------------------

describe('events meta parsing', () => {
  it('extracts sessionId and cwd from meta record', async () => {
    const result = await parseLines([
      line({ kind: 'meta', sessionId: 'sess-abc', cwd: '/Users/x/repo', model: 'claude' }),
      line({ kind: 'user', text: 'hello' }),
    ]);
    expect(result.sessionId).toBe('sess-abc');
    expect(result.cwd).toBe('/Users/x/repo');
  });

  it('handles missing optional fields gracefully', async () => {
    const result = await parseLines([
      line({ kind: 'meta' }),
    ]);
    expect(result.sessionId).toBeNull();
    expect(result.cwd).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tool event correlation (tool + tool_result via toolUseId)
// ---------------------------------------------------------------------------

describe('tool event correlation', () => {
  it('matches tool with tool_result via toolUseId', async () => {
    const result = await parseLines([
      line({ kind: 'meta', sessionId: 's1', cwd: '/repo' }),
      line({ kind: 'user', text: 'do something' }),
      line({ kind: 'tool', toolName: 'bash', toolUseId: 'tid1', input: 'echo hi' }),
      line({ kind: 'tool_result', toolUseId: 'tid1', content: 'hi', durationMs: 10 }),
    ]);
    expect(result.turns).toHaveLength(1);
    const te = result.turns[0]?.toolEvents ?? [];
    expect(te).toHaveLength(1);
    expect(te[0]?.toolName).toBe('bash');
    expect(te[0]?.input).toBe('echo hi');
    expect(te[0]?.result).toBe('hi');
    expect(te[0]?.isError).toBe(false);
  });

  it('marks tool as error when tool_error follows', async () => {
    const result = await parseLines([
      line({ kind: 'meta', sessionId: 's2', cwd: '/repo' }),
      line({ kind: 'user', text: 'run fail' }),
      line({ kind: 'tool', toolName: 'bash', toolUseId: 'tid2', input: 'exit 1' }),
      line({ kind: 'tool_error', toolUseId: 'tid2', content: 'Command exited with code 1' }),
    ]);
    const te = result.turns[0]?.toolEvents ?? [];
    expect(te[0]?.isError).toBe(true);
    expect(te[0]?.result).toContain('code 1');
  });

  it('ignores non-tool record kinds (thinking, progress)', async () => {
    const result = await parseLines([
      line({ kind: 'meta', sessionId: 's3', cwd: '/repo' }),
      line({ kind: 'user', text: 'hi' }),
      line({ kind: 'thinking', text: 'hmm' }),
      line({ kind: 'progress', message: 'loading' }),
      line({ kind: 'tool', toolName: 'bash', toolUseId: 'tid3', input: 'ls' }),
      line({ kind: 'tool_result', toolUseId: 'tid3', content: 'file.ts', durationMs: 5 }),
    ]);
    const te = result.turns[0]?.toolEvents ?? [];
    expect(te).toHaveLength(1);
    expect(te[0]?.toolName).toBe('bash');
  });
});

// ---------------------------------------------------------------------------
// Artifact recovery from events tool_result content
// ---------------------------------------------------------------------------

describe('artifact recovery from events', () => {
  it('recovers commit SHA from git commit tool_result', async () => {
    const result = await parseLines([
      line({ kind: 'meta', sessionId: 's4', cwd: '/repo' }),
      line({ kind: 'user', text: 'commit it' }),
      line({ kind: 'tool', toolName: 'bash', toolUseId: 'tid4',
             input: 'git commit -F /tmp/msg.txt' }),
      line({ kind: 'tool_result', toolUseId: 'tid4',
             content: '[main abc1234] feat: add events reader\n 3 files changed' }),
    ]);
    const shas = recoverCommitSHAs(result.turns);
    expect(shas).toContain('abc1234');
  });

  it('recovers PR URL from gh pr create tool_result', async () => {
    const result = await parseLines([
      line({ kind: 'meta', sessionId: 's5', cwd: '/repo' }),
      line({ kind: 'user', text: 'open pr' }),
      line({ kind: 'tool', toolName: 'bash', toolUseId: 'tid5',
             input: 'gh pr create --title foo --body bar' }),
      line({ kind: 'tool_result', toolUseId: 'tid5',
             content: 'https://github.com/org/repo/pull/42' }),
    ]);
    const prs = recoverPRURLs(result.turns);
    expect(prs).toContain('https://github.com/org/repo/pull/42');
  });

  it('does NOT attribute a PR URL from a non-create command', async () => {
    const result = await parseLines([
      line({ kind: 'meta', sessionId: 's6', cwd: '/repo' }),
      line({ kind: 'user', text: 'view pr' }),
      line({ kind: 'tool', toolName: 'bash', toolUseId: 'tid6',
             input: 'gh pr view 42 --json state' }),
      line({ kind: 'tool_result', toolUseId: 'tid6',
             content: 'https://github.com/org/repo/pull/42\nstate: MERGED' }),
    ]);
    const prs = recoverPRURLs(result.turns);
    expect(prs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Closure detection from 'closed' record
// ---------------------------------------------------------------------------

describe('closure detection', () => {
  it('detects abort from closed.reason=abort', async () => {
    const result = await parseLines([
      line({ kind: 'meta', sessionId: 's7', cwd: '/repo' }),
      line({ kind: 'user', text: 'long task' }),
      line({ kind: 'closed', reason: 'abort' }),
    ]);
    expect(result.closureReason).toBe('abort');
  });

  it('does NOT mark close reason as abort', async () => {
    const result = await parseLines([
      line({ kind: 'meta', sessionId: 's8', cwd: '/repo' }),
      line({ kind: 'user', text: 'quick task' }),
      line({ kind: 'closed', reason: 'close' }),
    ]);
    expect(result.closureReason).toBe('close');
    // 'close' is not 'abort', so closure LF should not vote
    const closure = lfClosure(
      's8',
      (_id) => result.closureReason === 'abort' ? { reason: 'abort' } : null,
      new Date().toISOString(),
    );
    expect(closure).toHaveLength(0);
  });

  it('lfClosure fires for abort closure from events', () => {
    const closureInfo = { reason: 'abort' as const };
    const votes = lfClosure('s9', (_id) => closureInfo, new Date().toISOString());
    expect(votes).toHaveLength(1);
    expect(votes[0]?.lf).toBe('closure');
    expect(votes[0]?.vote).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Self-report from assistant records
// ---------------------------------------------------------------------------

describe('self-report from assistant records', () => {
  it('parses Done from assistant text', async () => {
    const result = await parseLines([
      line({ kind: 'meta', sessionId: 'sr1', cwd: '/repo' }),
      line({ kind: 'user', text: 'do task' }),
      line({ kind: 'assistant', text: 'Task complete. **Done**' }),
    ]);
    const lastAssistant = result.turns
      .map((t) => t.assistant ?? '')
      .filter(Boolean)
      .at(-1) ?? '';
    expect(parseSelfReport(lastAssistant)).toBe('done');
  });

  it('parses Blocked from assistant text', async () => {
    const result = await parseLines([
      line({ kind: 'meta', sessionId: 'sr2', cwd: '/repo' }),
      line({ kind: 'user', text: 'do task' }),
      line({ kind: 'assistant', text: '**Blocked** — needs credentials.' }),
    ]);
    const lastAssistant = result.turns
      .map((t) => t.assistant ?? '')
      .filter(Boolean)
      .at(-1) ?? '';
    expect(parseSelfReport(lastAssistant)).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
// discoverEventsSessionsSync — unit-level contract (no FS, test via mock)
// ---------------------------------------------------------------------------

describe('discoverEventsSessionsSync contract', () => {
  it('should be importable from the backfill module', async () => {
    // We import the module to verify it exports the function without errors.
    // Actual filesystem traversal is an integration test; here we just confirm
    // the export surface exists and the function is callable.
    const mod = await import('../scripts/outcomes-backfill-events.js');
    expect(typeof mod.discoverEventsSessionsSync).toBe('function');
    expect(typeof mod.loadEventsSessionTurns).toBe('function');
    expect(typeof mod.parseEventsFile).toBe('function');
  });
});
