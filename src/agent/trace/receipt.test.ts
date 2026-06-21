import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getReceiptsDir } from '../../paths.js';
import {
  generateReceipt,
  parseTraceJsonl,
  receiptPathsFor,
  renderReceiptMarkdown,
  runReceiptSessionEndHook,
  writeRunReceipt,
  type RunReceipt,
} from './receipt.js';
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
      toolDone('bash', { circuitBreaker: true, isError: true }),
      toolDone('read_file'),
      closure('abort'),
      sealed('failed'),
    ];
    const r = generateReceipt(events, META);

    // circuitBreaker completion is excluded from totals, counted separately.
    expect(r.toolCalls.total).toBe(5);
    expect(r.toolCalls.errored).toBe(4);
    expect(r.toolCalls.erroredNotable).toBe(2); // unclassified + timeout
    expect(r.toolCalls.circuitBreakerHits).toBe(1);
    expect(r.toolCalls.byFailureClass).toMatchObject({
      unclassified: 1,
      timeout: 1,
      'policy-refusal': 1,
      'elicitation-declined': 1,
    });

    expect(r.failures).toHaveLength(4);
    const unclassified = r.failures.find((f) => f.toolUseId === 'fail-unclassified');
    expect(unclassified?.failureClass).toBeUndefined();
    expect(unclassified?.exempt).toBe(false);
    expect(r.failures.find((f) => f.toolUseId === 'fail-timeout')?.exempt).toBe(false);
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

  it('renders a clean run without a review section', () => {
    const md = renderReceiptMarkdown(
      generateReceipt([toolDone('bash'), closure('model_end_turn'), sealed('succeeded')], META),
    );
    expect(md).toContain('✓ no');
    expect(md).toContain('No tool failures recorded.');
    expect(md).not.toContain('## Why review is required');
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
    expect(parsed.schemaVersion).toBe(1);
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
