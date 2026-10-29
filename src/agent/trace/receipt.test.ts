import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getReceiptsDir } from '../../paths.js';
import {
  extractJournalSummary,
  generateReceipt,
  parseTraceJsonl,
  receiptPathsFor,
  RECEIPT_SCHEMA_VERSION,
  renderReceiptMarkdown,
  runReceiptSessionEndHook,
  writeRunReceipt,
  type JournalSummary,
  type RunReceipt,
} from './receipt.js';
import type { JournalMessage, JournalRecord } from '../journal/types.js';
import type { ClosureReason, ToolFailureClass, TraceEvent } from './types.js';

// ---------------------------------------------------------------------------
// Event builders — keep the on-disk envelope ({ ts, seq, kind, payload }).
// ---------------------------------------------------------------------------

let seq = 0;
const TS = (n: number): string => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;

function toolDone(
  name: string,
  opts: {
    isError?: boolean;
    failureClass?: ToolFailureClass;
    circuitBreaker?: boolean;
    durationMs?: number;
    toolUseId?: string;
    truncated?: boolean;
  } = {},
): TraceEvent {
  const s = seq++;
  return {
    ts: TS(s + 1),
    seq: s,
    kind: 'tool_call',
    payload: {
      phase: 'completed',
      toolUseId: opts.toolUseId ?? `t${s}`,
      name,
      resultBytes: 12,
      isError: opts.isError ?? false,
      truncated: opts.truncated ?? false,
      durationMs: opts.durationMs ?? 7,
      ...(opts.failureClass !== undefined ? { failureClass: opts.failureClass } : {}),
      ...(opts.circuitBreaker !== undefined ? { circuitBreaker: opts.circuitBreaker } : {}),
    },
  };
}

function closure(reason: ClosureReason): TraceEvent {
  const s = seq++;
  return {
    ts: TS(s + 1),
    seq: s,
    kind: 'closure',
    payload: {
      reason,
      finalTurnCount: 4,
      finalCostUsd: 0.1234,
      finalTokens: { input: 100, output: 50, cacheRead: 10 },
      lastStopReason: 'end_turn',
    },
  };
}

function sealed(
  status: 'succeeded' | 'failed' | 'cancelled',
  extra: { incomplete?: boolean } = {},
): TraceEvent {
  const s = seq++;
  return {
    ts: TS(s + 1),
    seq: s,
    kind: 'session_sealed',
    payload: {
      status,
      finalCostUsd: 0.1234,
      finalTurnCount: 4,
      closedAt: TS(s + 1),
      ...(extra.incomplete !== undefined ? { incomplete: extra.incomplete } : {}),
    },
  };
}

function subagentFailed(): TraceEvent {
  const s = seq++;
  return {
    ts: TS(s + 1),
    seq: s,
    kind: 'subagent_lifecycle',
    payload: {
      transition: 'failed',
      subagentId: `sa${s}`,
      errorClass: 'Error',
      errorMessage: 'boom',
      partialOutputBytes: 0,
    },
  };
}

const META = { tracePath: '/x/witness/run-abc/trace.jsonl', witnessLabel: 'run-abc' };

beforeEach(() => {
  seq = 0;
});

// ---------------------------------------------------------------------------
// Scenario 1 — success-only trace
// ---------------------------------------------------------------------------

describe('generateReceipt — success-only trace', () => {
  it('reports succeeded status, zero failures, and no review required', () => {
    const events = [
      toolDone('read_file'),
      toolDone('bash'),
      toolDone('bash'),
      closure('model_end_turn'),
      sealed('succeeded'),
    ];
    const r = generateReceipt(events, META);

    expect(r.status).toBe('succeeded');
    expect(r.toolCalls.total).toBe(3);
    expect(r.toolCalls.succeeded).toBe(3);
    expect(r.toolCalls.errored).toBe(0);
    expect(r.toolCalls.erroredNotable).toBe(0);
    expect(r.toolCalls.refused).toBe(0);
    expect(r.toolCalls.byTool['bash']).toEqual({ total: 2, errored: 0 });
    expect(r.failures).toEqual([]);
    expect(r.humanReviewRequired).toBe(false);
    expect(r.humanReviewReasons).toEqual([]);
    expect(r.closureReason).toBe('model_end_turn');
    expect(r.cost.finalCostUsd).toBeCloseTo(0.1234);
    expect(r.cost.turnCount).toBe(4);
    expect(r.witnessLabel).toBe('run-abc');
    expect(r.tracePath).toBe(META.tracePath);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — failed tool calls (notable vs exempt) + circuit breaker
// ---------------------------------------------------------------------------

describe('generateReceipt — failed tool calls', () => {
  it('separates notable from exempt failures and flags review', () => {
    const events = [
      toolDone('bash', { isError: true, toolUseId: 'fail-unclassified' }),
      toolDone('browser_open', { isError: true, failureClass: 'timeout', toolUseId: 'fail-timeout' }),
      toolDone('browser_open', {
        isError: true,
        failureClass: 'policy-refusal',
        toolUseId: 'exempt-policy',
      }),
      toolDone('ask_question', {
        isError: true,
        failureClass: 'elicitation-declined',
        toolUseId: 'exempt-elicit',
      }),
      toolDone('grep', {
        isError: true,
        failureClass: 'no-such-target',
        toolUseId: 'exempt-missing-target',
      }),
      toolDone('bash', { circuitBreaker: true, isError: true }),
      toolDone('read_file'),
      closure('abort'),
      sealed('failed'),
    ];
    const r = generateReceipt(events, META);

    // circuitBreaker completion is excluded from totals, counted separately.
    expect(r.toolCalls.total).toBe(6);
    expect(r.toolCalls.errored).toBe(5);
    expect(r.toolCalls.erroredNotable).toBe(2); // unclassified + timeout
    // refused = gate-refusal classes only: policy-refusal counts;
    // elicitation-declined is exempt-but-not-a-denial, so it does NOT.
    expect(r.toolCalls.refused).toBe(1);
    expect(r.toolCalls.circuitBreakerHits).toBe(1);
    expect(r.toolCalls.byFailureClass).toMatchObject({
      unclassified: 1,
      timeout: 1,
      'policy-refusal': 1,
      'elicitation-declined': 1,
      'no-such-target': 1,
    });

    expect(r.failures).toHaveLength(5);
    const unclassified = r.failures.find((f) => f.toolUseId === 'fail-unclassified');
    expect(unclassified?.failureClass).toBeUndefined();
    expect(unclassified?.exempt).toBe(false);
    expect(r.failures.find((f) => f.toolUseId === 'fail-timeout')?.exempt).toBe(false);
    expect(r.failures.find((f) => f.toolUseId === 'exempt-missing-target')?.exempt).toBe(true);
    expect(r.failures.find((f) => f.toolUseId === 'exempt-policy')?.exempt).toBe(true);
    expect(r.failures.find((f) => f.toolUseId === 'exempt-elicit')?.exempt).toBe(true);

    expect(r.status).toBe('failed');
    expect(r.humanReviewRequired).toBe(true);
    const joined = r.humanReviewReasons.join('\n');
    expect(joined).toContain('status "failed"');
    expect(joined).toContain('2 tool call(s) returned an error');
    expect(joined).toContain('circuit breaker fired 1');
    expect(joined).toContain('Closure reason "abort"');
  });

  it('flags review when a subagent failed', () => {
    const events = [toolDone('read_file'), subagentFailed(), closure('model_end_turn'), sealed('succeeded')];
    const r = generateReceipt(events, META);
    expect(r.subagents.failed).toBe(1);
    expect(r.humanReviewRequired).toBe(true);
    expect(r.humanReviewReasons.join('\n')).toContain('1 subagent(s) failed');
  });

  it('tallies gate refusals (permission-denied + hook-block) without forcing review', () => {
    // Mirrors the /diagnose case: a restrictive allowlist denies repeated
    // tool calls (permission-denied) alongside a PreToolUse hook block.
    const events = [
      toolDone('bash', { isError: true, failureClass: 'permission-denied', toolUseId: 'd1' }),
      toolDone('list_directory', {
        isError: true,
        failureClass: 'permission-denied',
        toolUseId: 'd2',
      }),
      toolDone('bash', { isError: true, failureClass: 'hook-block', toolUseId: 'd3' }),
      toolDone('read_file'), // 1 clean call → total 4, rate 75%
      closure('model_end_turn'),
      sealed('succeeded'),
    ];
    const r = generateReceipt(events, META);

    expect(r.toolCalls.total).toBe(4);
    expect(r.toolCalls.refused).toBe(3);
    // All three are exempt refusals → none count as "notable".
    expect(r.toolCalls.erroredNotable).toBe(0);
    // Denials are EXPECTED outcomes — they must not force human review on their own.
    expect(r.humanReviewRequired).toBe(false);

    const md = renderReceiptMarkdown(r);
    expect(md).toContain('| Refused (denylisted) | 3 (75.0% of calls) |');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — missing / partial metadata
// ---------------------------------------------------------------------------

describe('generateReceipt — missing/partial metadata', () => {
  it('tolerates no closure and no session_sealed', () => {
    const events = [toolDone('bash'), toolDone('read_file', { isError: true })];
    const r = generateReceipt(events, META);

    expect(r.status).toBe('unknown');
    expect(r.closureReason).toBeUndefined();
    expect(r.cost.finalCostUsd).toBeUndefined();
    expect(r.cost.turnCount).toBeUndefined();
    expect(r.toolCalls.total).toBe(2);
    expect(r.toolCalls.errored).toBe(1);
    // status unknown is itself a review trigger.
    expect(r.humanReviewRequired).toBe(true);
    expect(r.humanReviewReasons.join('\n')).toContain('No terminal session_sealed record');
    expect(r.limitations.join('\n')).toContain('No session_sealed record was present');
  });

  it('flags an incomplete (process-exit backstop) seal', () => {
    const events = [toolDone('bash'), sealed('failed', { incomplete: true })];
    const r = generateReceipt(events, META);
    expect(r.incomplete).toBe(true);
    expect(r.humanReviewReasons.join('\n')).toContain('process-exit backstop');
  });

  it('does not throw on an empty event list', () => {
    const r = generateReceipt([], META);
    expect(r.status).toBe('unknown');
    expect(r.toolCalls.total).toBe(0);
    expect(r.events.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

describe('renderReceiptMarkdown', () => {
  it('renders the review banner, reasons, and failures table for a failed run', () => {
    const events = [
      toolDone('bash', { isError: true }),
      closure('abort'),
      sealed('failed'),
    ];
    const md = renderReceiptMarkdown(generateReceipt(events, META));
    expect(md).toContain('# Run receipt — run-abc');
    expect(md).toContain('⚠️ YES');
    expect(md).toContain('## Why review is required');
    expect(md).toContain('## Failures');
    expect(md).toContain(META.tracePath);
    expect(md).toContain('## Limitations');
    expect(md).toContain('read-only; no agent behavior was modified');
  });

  it('renders the root cost as unknown after a process-exit backstop seal (#3890)', () => {
    const md = renderReceiptMarkdown(
      generateReceipt([closure('model_end_turn'), sealed('failed', { incomplete: true })], META),
    );
    expect(md).toContain('| Cost (USD, total) | 0.1234 |');
    expect(md).toContain('| Cost (USD, root) | unknown');
    expect(md).toContain('| Cost (USD, subagents) | 0.1234 |');
  });

  it('renders a clean run without a review section', () => {
    const md = renderReceiptMarkdown(
      generateReceipt([toolDone('bash'), closure('model_end_turn'), sealed('succeeded')], META),
    );
    expect(md).toContain('✓ no');
    expect(md).toContain('No tool failures recorded.');
    expect(md).not.toContain('## Why review is required');
    expect(md).not.toContain('Refused (denylisted)');
  });
});

// ---------------------------------------------------------------------------
// parseTraceJsonl + receiptPathsFor
// ---------------------------------------------------------------------------

describe('parseTraceJsonl', () => {
  it('skips blank and malformed lines', () => {
    const good = JSON.stringify(toolDone('bash'));
    const sealedLine = JSON.stringify(sealed('succeeded'));
    const raw = ['', good, '   ', '{not json', sealedLine, '{"partial":'].join('\n');
    const events = parseTraceJsonl(raw);
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('tool_call');
    expect(events[1]?.kind).toBe('session_sealed');
  });
});

describe('receiptPathsFor', () => {
  it('derives the label from the trace dir name', () => {
    const { label, jsonPath, mdPath } = receiptPathsFor('/a/b/witness/sess-9/trace.jsonl');
    expect(label).toBe('sess-9');
    expect(jsonPath.endsWith('sess-9.json')).toBe(true);
    expect(mdPath.endsWith('sess-9.md')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I/O: writeRunReceipt + the SessionEnd hook (isolated AFK_HOME)
// ---------------------------------------------------------------------------

describe('writeRunReceipt + runReceiptSessionEndHook (filesystem)', () => {
  let home: string;
  let savedHome: string | undefined;
  let savedState: string | undefined;
  let savedDisabled: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'afk-receipt-test-'));
    savedHome = process.env['AFK_HOME'];
    savedState = process.env['AFK_STATE_DIR'];
    savedDisabled = process.env['AFK_RUN_RECEIPT_DISABLED'];
    process.env['AFK_HOME'] = home;
    delete process.env['AFK_STATE_DIR'];
    delete process.env['AFK_RUN_RECEIPT_DISABLED'];
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = savedHome;
    if (savedState === undefined) delete process.env['AFK_STATE_DIR'];
    else process.env['AFK_STATE_DIR'] = savedState;
    if (savedDisabled === undefined) delete process.env['AFK_RUN_RECEIPT_DISABLED'];
    else process.env['AFK_RUN_RECEIPT_DISABLED'] = savedDisabled;
    await rm(home, { recursive: true, force: true });
  });

  async function writeTrace(label: string, events: TraceEvent[]): Promise<string> {
    const dir = join(home, 'witness', label);
    await mkdir(dir, { recursive: true });
    const tracePath = join(dir, 'trace.jsonl');
    await writeFile(tracePath, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    return tracePath;
  }

  it('writes JSON + Markdown receipts from a sealed trace', async () => {
    const tracePath = await writeTrace('run-1', [
      toolDone('bash', { isError: true }),
      closure('model_end_turn'),
      sealed('succeeded'),
    ]);
    const res = await writeRunReceipt({ tracePath, sessionId: 'sess-logical', reason: 'close' });
    expect(res).not.toBeNull();
    expect(res?.label).toBe('run-1');
    expect(existsSync(join(getReceiptsDir(), 'run-1.json'))).toBe(true);
    expect(existsSync(join(getReceiptsDir(), 'run-1.md'))).toBe(true);

    const parsed = JSON.parse(await readFile(join(getReceiptsDir(), 'run-1.json'), 'utf8')) as RunReceipt;
    expect(parsed.witnessLabel).toBe('run-1');
    expect(parsed.sessionId).toBe('sess-logical');
    expect(parsed.endReason).toBe('close');
    expect(parsed.toolCalls.errored).toBe(1);
    expect(parsed.schemaVersion).toBe(2);
  });

  it('returns null when the trace file is absent', async () => {
    const res = await writeRunReceipt({ tracePath: join(home, 'nope', 'trace.jsonl') });
    expect(res).toBeNull();
  });

  it('returns null for an empty trace', async () => {
    const tracePath = await writeTrace('empty', []);
    expect(await writeRunReceipt({ tracePath })).toBeNull();
  });

  it('hook writes a receipt for a top-level SessionEnd', async () => {
    const tracePath = await writeTrace('hooked', [toolDone('bash'), sealed('succeeded')]);
    const decision = await runReceiptSessionEndHook({
      event: 'SessionEnd',
      sessionId: 's1',
      reason: 'close',
      tracePath,
    });
    expect(decision).toEqual({});
    expect(existsSync(join(getReceiptsDir(), 'hooked.json'))).toBe(true);
  });

  it('hook skips forked subagents (parentSessionId set)', async () => {
    const tracePath = await writeTrace('child', [toolDone('bash'), sealed('succeeded')]);
    await runReceiptSessionEndHook({
      event: 'SessionEnd',
      sessionId: 'child-sess',
      parentSessionId: 'parent-sess',
      tracePath,
    });
    expect(existsSync(join(getReceiptsDir(), 'child.json'))).toBe(false);
  });

  it('hook respects AFK_RUN_RECEIPT_DISABLED=1', async () => {
    process.env['AFK_RUN_RECEIPT_DISABLED'] = '1';
    const tracePath = await writeTrace('disabled', [toolDone('bash'), sealed('succeeded')]);
    await runReceiptSessionEndHook({ event: 'SessionEnd', sessionId: 's2', tracePath });
    expect(existsSync(join(getReceiptsDir(), 'disabled.json'))).toBe(false);
  });

  it('hook no-ops when no tracePath is present', async () => {
    const decision = await runReceiptSessionEndHook({ event: 'SessionEnd', sessionId: 's3' });
    expect(decision).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// renderReceiptMarkdown — cost rows (#3891)
// ---------------------------------------------------------------------------

describe('renderReceiptMarkdown — cost rows', () => {
  const BASE_RECEIPT: RunReceipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    generatedAt: '2026-10-16T00:00:00.000Z',
    witnessLabel: 'sess-cost',
    tracePath: '/w/sess-cost/trace.jsonl',
    sessionId: 'sess-cost',
    status: 'succeeded',
    humanReviewRequired: false,
    humanReviewReasons: [],
    incomplete: false,
    toolCalls: {
      total: 2,
      succeeded: 2,
      errored: 0,
      erroredNotable: 0,
      refused: 0,
      circuitBreakerHits: 0,
      byTool: {},
      byFailureClass: {},
    },
    events: { total: 10, byKind: {} },
    subagents: { started: 1, succeeded: 1, failed: 0, cancelled: 0 },
    cost: {},
    failures: [],
    limitations: ['Receipt summarizes trace metadata only.'],
  };

  it('renders Cost (USD, total), Cost (USD, root) and Cost (USD, subagents) for a fan-out', () => {
    const r: RunReceipt = {
      ...BASE_RECEIPT,
      cost: {
        totalCostUsd: 0.063,
        rootCostUsd: 0.0421,
        subagentCostUsd: 0.021,
      },
    };
    const md = renderReceiptMarkdown(r);
    expect(md).toContain('| Cost (USD, total) | 0.0630 |');
    expect(md).toContain('| Cost (USD, root) | 0.0421 |');
    expect(md).toContain('| Cost (USD, subagents) | 0.0210 |');
    // Fallback row must NOT appear when totalCostUsd is present.
    expect(md).not.toContain('| Cost (USD) |');
  });

  it('renders only Cost (USD, total) when root/subagent breakdown is absent', () => {
    const r: RunReceipt = {
      ...BASE_RECEIPT,
      cost: { totalCostUsd: 0.05 },
    };
    const md = renderReceiptMarkdown(r);
    expect(md).toContain('| Cost (USD, total) | 0.0500 |');
    expect(md).not.toContain('Cost (USD, root)');
    expect(md).not.toContain('Cost (USD, subagents)');
    expect(md).not.toContain('| Cost (USD) |');
  });

  it('renders the fallback Cost (USD) row when totalCostUsd is absent', () => {
    const r: RunReceipt = {
      ...BASE_RECEIPT,
      cost: { finalCostUsd: 0.0421 },
    };
    const md = renderReceiptMarkdown(r);
    expect(md).toContain('| Cost (USD) | 0.0421 |');
    expect(md).not.toContain('Cost (USD, total)');
    expect(md).not.toContain('Cost (USD, root)');
    expect(md).not.toContain('Cost (USD, subagents)');
  });

  it('renders no cost row when both totalCostUsd and finalCostUsd are absent', () => {
    const r: RunReceipt = { ...BASE_RECEIPT, cost: {} };
    const md = renderReceiptMarkdown(r);
    expect(md).not.toContain('Cost (USD');
  });
});

// ---------------------------------------------------------------------------
// Journal enrichment (v2) — #4427
// ---------------------------------------------------------------------------

const RECEIPT_BASE: RunReceipt = {
  schemaVersion: RECEIPT_SCHEMA_VERSION,
  generatedAt: '2026-10-25T00:00:00.000Z',
  witnessLabel: 'sess-journal',
  tracePath: '/w/sess-journal/trace.jsonl',
  sessionId: 'sess-journal',
  status: 'succeeded',
  humanReviewRequired: false,
  humanReviewReasons: [],
  incomplete: false,
  toolCalls: {
    total: 0, succeeded: 0, errored: 0, erroredNotable: 0,
    refused: 0, circuitBreakerHits: 0, byTool: {}, byFailureClass: {},
  },
  events: { total: 0, byKind: {} },
  subagents: { started: 0, succeeded: 0, failed: 0, cancelled: 0 },
  cost: {},
  failures: [],
  limitations: [],
};

function userMsg(text: string): JournalMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantMsg(text: string): JournalMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function assistantWithTools(text: string, tools: string[]): JournalMessage {
  return {
    role: 'assistant',
    content: [
      ...tools.map((name) => ({
        type: 'tool_use' as const,
        id: `tu_${name}`,
        name,
        input: {},
      })),
      { type: 'text' as const, text },
    ],
  };
}

describe('extractJournalSummary (#4427)', () => {
  it('returns undefined for null messages', () => {
    expect(extractJournalSummary(null, false)).toBeUndefined();
  });

  it('returns undefined for empty array', () => {
    expect(extractJournalSummary([], false)).toBeUndefined();
  });

  it('extracts first user message and last assistant message', () => {
    const messages: JournalMessage[] = [
      userMsg('hello world'),
      assistantMsg('first reply'),
      userMsg('followup'),
      assistantMsg('final reply'),
    ];
    const summary = extractJournalSummary(messages, false)!;
    expect(summary.firstUserMessage).toBe('hello world');
    expect(summary.lastAssistantMessage).toBe('final reply');
    expect(summary.messageCount).toBe(4);
  });

  it('truncates text beyond 500 chars', () => {
    const longText = 'x'.repeat(600);
    const messages: JournalMessage[] = [userMsg(longText), assistantMsg('ok')];
    const summary = extractJournalSummary(messages, false)!;
    expect(summary.firstUserMessage!.length).toBe(501); // 500 + ellipsis
    expect(summary.firstUserMessage!.endsWith('\u2026')).toBe(true);
  });

  it('collects tool names in order and counts calls', () => {
    const messages: JournalMessage[] = [
      userMsg('do stuff'),
      assistantWithTools('done', ['read_file', 'bash', 'read_file']),
    ];
    const summary = extractJournalSummary(messages, false)!;
    expect(summary.toolNames).toEqual(['read_file', 'bash']);
    expect(summary.toolUseCount).toBe(3);
  });

  it('suppresses text when textDisabled is true', () => {
    const messages: JournalMessage[] = [
      userMsg('secret prompt'),
      assistantMsg('secret response'),
    ];
    const summary = extractJournalSummary(messages, true)!;
    expect(summary.firstUserMessage).toBeUndefined();
    expect(summary.lastAssistantMessage).toBeUndefined();
    expect(summary.textRedacted).toBe(true);
    expect(summary.messageCount).toBe(2);
  });

  it('handles text_ref blocks using preview', () => {
    const messages: JournalMessage[] = [{
      role: 'user',
      content: [{ type: 'text_ref', ref: { path: 'blobs/abc.txt', bytes: 42, sha256: 'deadbeef', mediaType: 'text/plain' }, preview: 'spilled content preview' }],
    }];
    const summary = extractJournalSummary(messages, false)!;
    expect(summary.firstUserMessage).toBe('spilled content preview');
  });

  // ---------------------------------------------------------------------------
  // Compaction survival (#4432)
  // ---------------------------------------------------------------------------

  it('reads original first user message from raw records after mid-session compaction', () => {
    // Simulate a journal that underwent mid-session compaction:
    //   - records 0-2: original conversation (user "real first message", assistant with tools, user follow-up)
    //   - truncate(0, 'compact'): compaction discards the original prefix
    //   - records 3+: compaction summary + new messages re-appended from index 0
    // foldJournal produces: [compaction-summary-user, assistant-reply]
    // rawRecords still contains the original index=0 append with the real user message.

    const V = 1 as const;

    const rawRecords: JournalRecord[] = [
      { v: V, ts: 1, kind: 'append', index: 0, message: { role: 'user', content: [{ type: 'text', text: 'real first message' }] } },
      { v: V, ts: 2, kind: 'append', index: 1, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'bash', input: {} }, { type: 'text', text: 'running bash' }] } },
      { v: V, ts: 3, kind: 'append', index: 2, message: { role: 'user', content: [{ type: 'text', text: 'follow-up' }] } },
      { v: V, ts: 4, kind: 'truncate', length: 0, reason: 'compact' },
      // After compaction: synthetic summary as first message, then new assistant reply
      { v: V, ts: 5, kind: 'append', index: 0, message: { role: 'user', content: [{ type: 'text', text: '[Summary of prior conversation]' }] } },
      { v: V, ts: 6, kind: 'append', index: 1, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'read_file', input: {} }, { type: 'text', text: 'final answer' }] } },
    ];

    // The folded view (what loadJournalMessages returns after compaction)
    const foldedMessages: JournalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: '[Summary of prior conversation]' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'read_file', input: {} }, { type: 'text', text: 'final answer' }] },
    ];

    const summary = extractJournalSummary(foldedMessages, false, rawRecords)!;

    // firstUserMessage must come from raw records — NOT the compaction summary
    expect(summary.firstUserMessage).toBe('real first message');
    // lastAssistantMessage still comes from the folded view
    expect(summary.lastAssistantMessage).toBe('final answer');
    // toolUseCount covers ALL tool_use blocks across raw records (bash + read_file)
    expect(summary.toolUseCount).toBe(2);
    expect(summary.toolNames).toContain('bash');
    expect(summary.toolNames).toContain('read_file');
    // messageCount reflects the folded (live context) count
    expect(summary.messageCount).toBe(2);
  });

  it('falls back to folded view when rawRecords is empty', () => {
    const messages: JournalMessage[] = [
      userMsg('folded first'),
      assistantMsg('folded reply'),
    ];
    const summary = extractJournalSummary(messages, false, [])!;
    expect(summary.firstUserMessage).toBe('folded first');
    expect(summary.toolUseCount).toBe(0);
  });

  it('falls back to folded view when rawRecords is omitted', () => {
    const messages: JournalMessage[] = [
      userMsg('folded first'),
      assistantMsg('folded reply'),
    ];
    const summary = extractJournalSummary(messages, false)!;
    expect(summary.firstUserMessage).toBe('folded first');
  });
});

describe('generateReceipt with journalSummary (#4427)', () => {
  it('includes journalSummary when provided in meta', () => {
    const js: JournalSummary = {
      firstUserMessage: 'hello',
      lastAssistantMessage: 'goodbye',
      toolNames: ['bash'],
      toolUseCount: 1,
      messageCount: 2,
    };
    const receipt = generateReceipt([sealed('succeeded')], {
      tracePath: '/tmp/trace.jsonl',
      witnessLabel: 'test-label',
      journalSummary: js,
    });
    expect(receipt.journalSummary).toEqual(js);
    expect(receipt.limitations.some((l) => l.includes('No message journal'))).toBe(false);
  });

  it('omits journalSummary and adds limitation when not provided', () => {
    const receipt = generateReceipt([sealed('succeeded')], {
      tracePath: '/tmp/trace.jsonl',
      witnessLabel: 'test-label',
    });
    expect(receipt.journalSummary).toBeUndefined();
    expect(receipt.limitations.some((l) => l.includes('No message journal'))).toBe(true);
  });

  it('schemaVersion is 2', () => {
    expect(RECEIPT_SCHEMA_VERSION).toBe(2);
  });
});

describe('renderReceiptMarkdown with journalSummary (#4427)', () => {
  it('renders conversation summary section', () => {
    const r: RunReceipt = {
      ...RECEIPT_BASE,
      journalSummary: {
        firstUserMessage: 'What is 2+2?',
        lastAssistantMessage: 'The answer is 4.',
        toolNames: ['bash', 'read_file'],
        toolUseCount: 5,
        messageCount: 4,
      },
    };
    const md = renderReceiptMarkdown(r);
    expect(md).toContain('## Conversation summary');
    expect(md).toContain('What is 2+2?');
    expect(md).toContain('The answer is 4.');
    expect(md).toContain('bash, read_file');
    expect(md).toContain('5 calls');
    expect(md).toContain('**Messages:** 4');
  });

  it('renders redacted notice when textRedacted', () => {
    const r: RunReceipt = {
      ...RECEIPT_BASE,
      journalSummary: {
        toolNames: [],
        toolUseCount: 0,
        messageCount: 2,
        textRedacted: true,
      },
    };
    const md = renderReceiptMarkdown(r);
    expect(md).toContain('Text fields redacted');
    expect(md).not.toContain('**Request:**');
  });

  it('omits conversation summary when journalSummary absent', () => {
    const md = renderReceiptMarkdown(RECEIPT_BASE);
    expect(md).not.toContain('Conversation summary');
  });
});
