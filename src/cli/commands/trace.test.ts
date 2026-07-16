/**
 * Tests for `afk trace` CLI command group.
 *
 * Exercises the reader/formatter layer the command wraps — parsing,
 * latest-session resolution, and human formatting — using a temp AFK_HOME
 * so no real ~/.afk/state/witness/ is touched. Mirrors bg.test.ts: we test
 * the exported functions rather than driving Commander (which adds
 * process-exit complexity).
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { mkdir, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';

// Isolated temp dir for AFK_HOME. env.AFK_HOME is a lazy getter over
// process.env, so setting it here is picked up by the path helpers at call
// time.
const tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'afk-trace-cmd-test-'));
process.env['AFK_HOME'] = tmpDir;

import {
  parseTrace,
  formatTrace,
  loadTrace,
  listTraces,
  resolveLatestSession,
} from './trace.js';
import { getTraceDir, getSessionLedgerDir, getSessionLedgerPath } from '../../paths.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type EventObj = Record<string, unknown>;

function toJsonl(objs: EventObj[]): string {
  return objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
}

/** A representative session covering the kinds the formatter renders. */
function sampleEvents(): EventObj[] {
  return [
    { ts: '2026-06-05T12:30:00.000Z', seq: 0, kind: 'tool_call', payload: { phase: 'started', toolUseId: 'tu1', name: 'read_file', inputBytes: 50 } },
    { ts: '2026-06-05T12:30:01.000Z', seq: 1, kind: 'tool_call', payload: { phase: 'completed', toolUseId: 'tu1', name: 'read_file', resultBytes: 1200, isError: false, truncated: false, durationMs: 45 } },
    { ts: '2026-06-05T12:30:02.000Z', seq: 2, kind: 'tool_call', payload: { phase: 'completed', toolUseId: 'tu2', name: 'bash', resultBytes: 8000, isError: true, truncated: true, durationMs: 1300 } },
    { ts: '2026-06-05T12:30:05.000Z', seq: 3, kind: 'hook_decision', payload: { hookEvent: 'PreToolUse', decision: 'block', reason: 'plan mode: writes disabled', blockedTool: 'write_file' } },
    { ts: '2026-06-05T12:30:06.000Z', seq: 4, kind: 'subagent_lifecycle', payload: { transition: 'started', subagentId: 'sub1', parentId: 'root', model: 'sonnet' } },
    { ts: '2026-06-05T12:31:17.000Z', seq: 5, kind: 'subagent_lifecycle', payload: { transition: 'succeeded', subagentId: 'sub1', durationMs: 71000, turnCount: 12, outputBytes: 18000, totalCostUsd: 0.021 } },
    { ts: '2026-06-05T12:31:20.000Z', seq: 6, kind: 'claim', payload: { source: 'audit1', assertion: 'control plane positioning holds', evidence: ['a', 'b', 'c'], confidence: 0.9 } },
    { ts: '2026-06-05T12:31:21.000Z', seq: 7, kind: 'session_phase', payload: { phase: 'model_ttfb', durationMs: 300 } },
    { ts: '2026-06-05T12:35:00.000Z', seq: 8, kind: 'closure', payload: { reason: 'model_end_turn', finalTurnCount: 8, finalCostUsd: 0.0421, finalTokens: {} } },
    { ts: '2026-06-05T12:35:00.500Z', seq: 9, kind: 'session_sealed', payload: { status: 'succeeded', finalCostUsd: 0.0421, finalTurnCount: 8, closedAt: '2026-06-05T12:35:00.500Z', subagentCount: 1 } },
  ];
}

async function writeTrace(sessionId: string, objs: EventObj[]): Promise<string> {
  const dir = getTraceDir(sessionId);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'trace.jsonl');
  await writeFile(file, toJsonl(objs), 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// parseTrace
// ---------------------------------------------------------------------------

describe('parseTrace', () => {
  it('parses valid events and skips/counts malformed lines', () => {
    const content = [
      JSON.stringify({ ts: 't', seq: 0, kind: 'tool_call', payload: { phase: 'completed', toolUseId: 'a', name: 'x', resultBytes: 1, isError: false, truncated: false, durationMs: 1 } }),
      'this is not json',
      '',
      JSON.stringify({ foo: 1 }), // valid JSON, not an event
    ].join('\n');

    const { events, malformed } = parseTrace(content);
    expect(events).toHaveLength(1);
    expect(malformed).toBe(2);
  });

  it('returns empty result for empty content', () => {
    expect(parseTrace('')).toEqual({ events: [], malformed: 0 });
  });
});

// ---------------------------------------------------------------------------
// formatTrace
// ---------------------------------------------------------------------------

describe('formatTrace — default human view', () => {
  const out = formatTrace('sess-aaa', '/w/sess-aaa/trace.jsonl', parseTrace(toJsonl(sampleEvents())));

  it('renders a header with status and counts', () => {
    expect(out).toContain('Trace  sess-aaa');
    expect(out).toContain('/w/sess-aaa/trace.jsonl');
    expect(out).toContain('sealed (succeeded)');
    expect(out).toContain('10 events');
    expect(out).toContain('2 tool calls');
    expect(out).toContain('(1 err)');
    expect(out).toContain('subagents');
    expect(out).toContain('1 claims');
    expect(out).toContain('1 blocks');
    expect(out).toContain('$0.0421');
  });

  it('renders tool calls with status, duration, and truncation', () => {
    expect(out).toContain('read_file');
    expect(out).toContain('ok');
    expect(out).toContain('bash');
    expect(out).toContain('ERR');
    expect(out).toContain('(truncated)');
  });

  it('renders a hook block, subagent success, claim, and seal', () => {
    expect(out).toContain('BLOCK PreToolUse write_file');
    expect(out).toContain('succeeded');
    expect(out).toContain('12 turns');
    expect(out).toContain('control plane positioning holds');
    expect(out).toContain('conf=0.9');
    expect(out).toContain('SEALED');
    expect(out).toContain('turns=8');
  });

  it('hides low-signal events by default (latency phases, paired tool starts)', () => {
    expect(out).not.toContain('model_ttfb');
    expect(out).not.toContain('started (no completion recorded)');
  });
});

describe('formatTrace — subagent timeout markers', () => {
  // PR (observable forked children): the reader must surface the new lifecycle
  // timeout signals — `[timeout]` on a failed child that blew its OWN budget
  // (failureClass:'timeout'), and `(timeout)` on a cancelled child whose
  // ancestor's budget expired (source:'cascade' + timeout:true).
  it("renders [timeout] on a failed subagent with failureClass 'timeout'", () => {
    const events: EventObj[] = [
      { ts: '2026-06-05T12:30:00.000Z', seq: 0, kind: 'subagent_lifecycle', payload: { transition: 'failed', subagentId: 'sub-to', errorClass: 'TimeoutError', errorMessage: 'timed out after 2700000ms', partialOutputBytes: 12, failureClass: 'timeout' } },
      { ts: '2026-06-05T12:35:00.000Z', seq: 1, kind: 'session_sealed', payload: { status: 'succeeded', finalCostUsd: 0.01, finalTurnCount: 1, closedAt: '2026-06-05T12:35:00.000Z' } },
    ];
    const out = formatTrace('s', '/p', parseTrace(toJsonl(events)));
    expect(out).toContain('FAILED');
    expect(out).toContain('[timeout]');
    expect(out).toContain('[sub-to]');
  });

  it('does NOT render [timeout] on an ordinary failed subagent (no failureClass)', () => {
    const events: EventObj[] = [
      { ts: '2026-06-05T12:30:00.000Z', seq: 0, kind: 'subagent_lifecycle', payload: { transition: 'failed', subagentId: 'sub-err', errorClass: 'Error', errorMessage: 'boom', partialOutputBytes: 0 } },
      { ts: '2026-06-05T12:35:00.000Z', seq: 1, kind: 'session_sealed', payload: { status: 'failed', finalCostUsd: 0, finalTurnCount: 1, closedAt: '2026-06-05T12:35:00.000Z' } },
    ];
    const out = formatTrace('s', '/p', parseTrace(toJsonl(events)));
    expect(out).toContain('FAILED');
    expect(out).not.toContain('[timeout]');
  });

  it('renders (timeout) on a cascade-cancelled subagent with the timeout flag', () => {
    const events: EventObj[] = [
      { ts: '2026-06-05T12:30:00.000Z', seq: 0, kind: 'subagent_lifecycle', payload: { transition: 'cancelled', subagentId: 'sub-casc', source: 'cascade', timeout: true } },
      { ts: '2026-06-05T12:35:00.000Z', seq: 1, kind: 'session_sealed', payload: { status: 'succeeded', finalCostUsd: 0.01, finalTurnCount: 1, closedAt: '2026-06-05T12:35:00.000Z' } },
    ];
    const out = formatTrace('s', '/p', parseTrace(toJsonl(events)));
    expect(out).toContain('cancelled (cascade)');
    expect(out).toContain('(timeout)');
    expect(out).toContain('[sub-casc]');
  });

  it('does NOT render (timeout) on an ordinary cancel (no timeout flag)', () => {
    const events: EventObj[] = [
      { ts: '2026-06-05T12:30:00.000Z', seq: 0, kind: 'subagent_lifecycle', payload: { transition: 'cancelled', subagentId: 'sub-cx', source: 'explicit' } },
      { ts: '2026-06-05T12:35:00.000Z', seq: 1, kind: 'session_sealed', payload: { status: 'succeeded', finalCostUsd: 0.01, finalTurnCount: 1, closedAt: '2026-06-05T12:35:00.000Z' } },
    ];
    const out = formatTrace('s', '/p', parseTrace(toJsonl(events)));
    expect(out).toContain('cancelled (explicit)');
    expect(out).not.toContain('(timeout)');
  });
});

describe('formatTrace — subagentId attribution on tool_call (issue #612)', () => {
  // A forked child resumes the parent's sessionId and writes into the shared
  // parent trace, so `afk trace show` must render `[subagentId]` on the child's
  // tool_call lines — otherwise a timed-out child's actual work is unattributable.
  it('renders [subagentId] on a completed tool_call emitted by a fork', () => {
    const events: EventObj[] = [
      { ts: '2026-06-05T12:30:00.000Z', seq: 0, kind: 'tool_call', payload: { phase: 'completed', toolUseId: 'tu-child', name: 'bash', resultBytes: 40, isError: false, truncated: false, durationMs: 20, subagentId: 'research-agent-1700000000000-3' } },
    ];
    const out = formatTrace('s', '/p', parseTrace(toJsonl(events)));
    expect(out).toContain('bash');
    expect(out).toContain('[research-agent-1700000000000-3]');
  });

  it('renders an orphan started tool_call from a fork with its [subagentId]', () => {
    // An orphaned `started` (no matching completed) is shown by default — the
    // exact "child crashed/timed out mid-tool" case issue #612 is about.
    const events: EventObj[] = [
      { ts: '2026-06-05T12:30:00.000Z', seq: 0, kind: 'tool_call', payload: { phase: 'started', toolUseId: 'tu-orphan', name: 'bash', inputBytes: 30, subagentId: 'research-agent-1700000000000-3' } },
    ];
    const out = formatTrace('s', '/p', parseTrace(toJsonl(events)));
    expect(out).toContain('started (no completion recorded)');
    expect(out).toContain('[research-agent-1700000000000-3]');
  });

  it('renders no [subagentId] suffix for a root (non-fork) tool_call', () => {
    const events: EventObj[] = [
      { ts: '2026-06-05T12:30:00.000Z', seq: 0, kind: 'tool_call', payload: { phase: 'completed', toolUseId: 'tu-root', name: 'read_file', resultBytes: 40, isError: false, truncated: false, durationMs: 20 } },
    ];
    const out = formatTrace('s', '/p', parseTrace(toJsonl(events)));
    // Target the tool line specifically — the header may legitimately contain
    // brackets, but a root tool_call line must carry no `[id]` suffix.
    const toolLine = out.split('\n').find((l) => l.includes('read_file'));
    expect(toolLine).toBeDefined();
    expect(toolLine).not.toContain('[');
  });
});

describe('formatTrace — rate_limit is high-signal (shown by default)', () => {
  // Regression: a rate_limit event is a session_phase, and session_phase is
  // hidden by default (latency waterfall). But throttling is the whole reason a
  // stuck turn is stuck, so it must appear WITHOUT --all — otherwise the
  // observability it provides is invisible to an operator who doesn't already
  // know to enable low-signal output.
  const events: EventObj[] = [
    { ts: '2026-06-05T12:30:00.000Z', seq: 0, kind: 'session_phase', payload: { phase: 'model_ttfb', durationMs: 300 } },
    { ts: '2026-06-05T12:30:01.000Z', seq: 1, kind: 'session_phase', payload: { phase: 'rate_limit', durationMs: 30000, metadata: { status: 429, reason: 'rate-limit', source: 'sdk-fetch', retryAfterMs: 30000 } } },
    { ts: '2026-06-05T12:35:00.000Z', seq: 2, kind: 'session_sealed', payload: { status: 'succeeded', finalCostUsd: 0.01, finalTurnCount: 1, closedAt: '2026-06-05T12:35:00.000Z' } },
  ];
  const out = formatTrace('s', '/p', parseTrace(toJsonl(events)));

  it('renders the rate_limit event in the DEFAULT view (no --all)', () => {
    expect(out).toContain('throttle');
    expect(out).toContain('rate-limit');
    expect(out).toContain('429');
    expect(out).toContain('retry-after 30.0s');
    expect(out).toContain('(sdk-fetch)');
  });

  it('still hides the low-signal model_ttfb phase by default', () => {
    expect(out).not.toContain('model_ttfb');
  });

  it('surfaces a throttled count in the summary header', () => {
    expect(out).toContain('1 throttled');
  });

  it('omits the throttled count when there are none', () => {
    const clean = formatTrace(
      's',
      '/p',
      parseTrace(
        toJsonl([
          { ts: '2026-06-05T12:35:00.000Z', seq: 0, kind: 'session_sealed', payload: { status: 'succeeded', finalCostUsd: 0.01, finalTurnCount: 1, closedAt: '2026-06-05T12:35:00.000Z' } },
        ]),
      ),
    );
    expect(clean).not.toContain('throttled');
  });
});

describe('formatTrace — closure stop_reason rendering', () => {
  const seal: EventObj = {
    ts: '2026-06-05T12:35:00.500Z',
    seq: 2,
    kind: 'session_sealed',
    payload: {
      status: 'succeeded',
      finalCostUsd: 0.01,
      finalTurnCount: 1,
      closedAt: '2026-06-05T12:35:00.500Z',
    },
  };

  // Regression: the raw provider stop_reason (e.g. `refusal`) is persisted on
  // the closure event but was previously unrendered, so a silent stop (turn
  // ends with no output and no error) was only diagnosable from raw
  // trace.jsonl. `afk trace show` must now surface it.
  it('renders the raw provider stop_reason on the closure line when present', () => {
    const closure: EventObj = {
      ts: '2026-06-05T12:35:00.000Z',
      seq: 1,
      kind: 'closure',
      payload: {
        reason: 'model_end_turn',
        finalTurnCount: 1,
        finalCostUsd: 0.01,
        finalTokens: {},
        lastStopReason: 'refusal',
      },
    };
    const out = formatTrace('s', '/p', parseTrace(toJsonl([closure, seal])));
    expect(out).toContain('stop=refusal');
  });

  it('omits stop= when the closure carries no lastStopReason', () => {
    const closure: EventObj = {
      ts: '2026-06-05T12:35:00.000Z',
      seq: 1,
      kind: 'closure',
      payload: {
        reason: 'model_end_turn',
        finalTurnCount: 1,
        finalCostUsd: 0.01,
        finalTokens: {},
      },
    };
    const out = formatTrace('s', '/p', parseTrace(toJsonl([closure, seal])));
    expect(out).not.toContain('stop=');
  });
});

describe('formatTrace — root model provenance header', () => {
  const initStart = (model: string, resolvedModel: string): EventObj => ({
    ts: '2026-06-05T12:30:00.000Z',
    seq: 0,
    kind: 'session_phase',
    payload: { phase: 'session_init_start', model, resolvedModel },
  });
  const seal: EventObj = {
    ts: '2026-06-05T12:35:00.500Z',
    seq: 1,
    kind: 'session_sealed',
    payload: { status: 'succeeded', finalCostUsd: 0, finalTurnCount: 0, closedAt: '2026-06-05T12:35:00.500Z' },
  };

  it('renders a Model line with alias → resolved when they differ', () => {
    const out = formatTrace(
      's',
      '/p',
      parseTrace(toJsonl([initStart('sonnet', 'claude-sonnet-5'), seal])),
    );
    expect(out).toContain('Model  sonnet → claude-sonnet-5');
  });

  it('renders the model once (no arrow) when alias === resolved (raw passthrough)', () => {
    const out = formatTrace('s', '/p', parseTrace(toJsonl([initStart('gpt-4o', 'gpt-4o'), seal])));
    expect(out).toContain('Model  gpt-4o');
    expect(out).not.toContain('gpt-4o → gpt-4o');
  });

  it('omits the Model line when no session_init_start carries a model', () => {
    // sampleEvents() has no session_init_start → no provenance to show.
    const out = formatTrace('s', '/p', parseTrace(toJsonl(sampleEvents())));
    expect(out).not.toContain('Model  ');
  });

  it('--all surfaces the model on the session_init_start phase line', () => {
    const out = formatTrace(
      's',
      '/p',
      parseTrace(toJsonl([initStart('sonnet', 'claude-sonnet-5'), seal])),
      { showAll: true },
    );
    expect(out).toMatch(/session_init_start.*sonnet/);
  });
});

describe('formatTrace — flags and edge cases', () => {
  it('--all surfaces latency phases and paired tool starts', () => {
    const out = formatTrace('s', '/p', parseTrace(toJsonl(sampleEvents())), { showAll: true });
    expect(out).toContain('model_ttfb');
    expect(out).toMatch(/read_file\s+started/);
  });

  it('surfaces an orphaned tool start (no completion) even by default', () => {
    const orphan: EventObj[] = [
      { ts: '2026-06-05T12:30:00.000Z', seq: 0, kind: 'tool_call', payload: { phase: 'started', toolUseId: 'orphan1', name: 'bash', inputBytes: 5 } },
    ];
    const out = formatTrace('s', '/p', parseTrace(toJsonl(orphan)));
    expect(out).toContain('started (no completion recorded)');
  });

  it('renders an unknown future event kind instead of dropping it', () => {
    const future: EventObj[] = [
      { ts: '2026-06-05T12:30:00.000Z', seq: 0, kind: 'future_kind', payload: { x: 1 } },
    ];
    const out = formatTrace('s', '/p', parseTrace(toJsonl(future)));
    expect(out).toContain('future_kind');
    expect(out).toContain('unrecognized');
  });

  it('reports unsealed status when no seal record is present', () => {
    const noSeal = sampleEvents().filter((e) => e['kind'] !== 'session_sealed');
    const out = formatTrace('s', '/p', parseTrace(toJsonl(noSeal)));
    expect(out).toContain('unsealed (live or crashed)');
  });

  it('honors --limit and notes hidden events', () => {
    const out = formatTrace('s', '/p', parseTrace(toJsonl(sampleEvents())), { limit: 2 });
    expect(out).toMatch(/earlier event\(s\) hidden/);
  });
});

// ---------------------------------------------------------------------------
// Witness discovery (touches the temp filesystem)
// ---------------------------------------------------------------------------

describe('witness discovery', () => {
  it('resolves "latest" to the most recently written trace', async () => {
    await writeTrace('sess-old', sampleEvents());
    await writeTrace('sess-new', sampleEvents());
    await utimes(join(getTraceDir('sess-old'), 'trace.jsonl'), new Date(1000), new Date(1000));
    await utimes(join(getTraceDir('sess-new'), 'trace.jsonl'), new Date(2000), new Date(2000));

    expect(await resolveLatestSession()).toBe('sess-new');

    const loaded = await loadTrace('latest');
    expect(loaded.sessionId).toBe('sess-new');
    expect(loaded.events).toHaveLength(10);
  });

  it('lists traces most-recent first', async () => {
    const ids = (await listTraces()).map((t) => t.sessionId);
    expect(ids).toContain('sess-new');
    expect(ids).toContain('sess-old');
    expect(ids.indexOf('sess-new')).toBeLessThan(ids.indexOf('sess-old'));
  });

  it('throws a helpful error for a missing session', async () => {
    await expect(loadTrace('does-not-exist-xyz')).rejects.toThrow(/No trace found/);
  });
});

// ---------------------------------------------------------------------------
// Ledger fallback: fresh sessions label the witness dir with a random UUID
// (not the session id), so loadTrace(sessionId) must recover the real label
// from the session ledger's `meta.traceLabel`.
// ---------------------------------------------------------------------------

async function writeLedger(sessionId: string, records: EventObj[]): Promise<void> {
  await mkdir(getSessionLedgerDir(sessionId), { recursive: true });
  await writeFile(getSessionLedgerPath(sessionId), toJsonl(records), 'utf8');
}

describe('loadTrace ledger fallback', () => {
  it('resolves a trace whose witness label differs from the session id', async () => {
    // Trace lives under a random-UUID label; nothing under <witness>/<sessionId>/.
    await writeTrace('random-label-abc123', sampleEvents());
    await writeLedger('sess-fresh-a', [
      { v: 1, ts: 1000, kind: 'meta', sessionId: 'sess-fresh-a', model: 'sonnet', traceLabel: 'random-label-abc123' },
      { v: 1, ts: 1001, kind: 'user', text: 'hi' },
    ]);

    const loaded = await loadTrace('sess-fresh-a');
    expect(loaded.sessionId).toBe('sess-fresh-a');
    expect(loaded.tracePath).toContain('random-label-abc123');
    expect(loaded.events).toHaveLength(10);
  });

  it('reports tracing-disabled when the ledger meta records traceLabel: null', async () => {
    await writeLedger('sess-notrace', [
      { v: 1, ts: 1000, kind: 'meta', sessionId: 'sess-notrace', model: 'sonnet', traceLabel: null },
    ]);

    await expect(loadTrace('sess-notrace')).rejects.toThrow(/tracing disabled/);
  });

  it('falls through to "No trace found" when the ledger meta predates the field', async () => {
    await writeLedger('sess-legacy', [
      { v: 1, ts: 1000, kind: 'meta', sessionId: 'sess-legacy', model: 'sonnet' },
    ]);

    await expect(loadTrace('sess-legacy')).rejects.toThrow(/No trace found/);
  });
});
