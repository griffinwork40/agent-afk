/**
 * Unit tests for accumulateStreamJson — the NDJSON accumulator that turns
 * `afk chat --format stream-json` output into a single text string with
 * tool-call markers, plus cost/token metadata.
 */

import { describe, it, expect } from 'vitest';
import { accumulateStreamJson, runEpisodeChild } from './afk-runner.run.js';
import type { SpawnFn } from './afk-runner.run.js';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ndjson(events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function contentChunk(content: string) {
  return { type: 'chunk', chunk: { type: 'content', content } };
}

/** tool_use_detail chunk — toolUseId defaults to 'tu1' for same-id tests */
function toolDetailChunk(toolName: string, toolUseId = 'tu1') {
  return { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId, toolName, toolInput: '{}' } };
}

function toolUseChunk(content: string, precedingToolUseIds?: string[]) {
  return {
    type: 'chunk',
    chunk: {
      type: 'tool_use',
      content,
      ...(precedingToolUseIds !== undefined ? { metadata: { precedingToolUseIds } } : {}),
    },
  };
}

function doneEvent(opts: { costUsd?: number; inputTokens?: number; outputTokens?: number; durationMs?: number }) {
  return {
    type: 'done',
    metadata: {
      totalCostUsd: opts.costUsd ?? 0,
      durationMs: opts.durationMs,
      usage: { input_tokens: opts.inputTokens ?? 0, output_tokens: opts.outputTokens ?? 0 },
    },
  };
}

function streamRetryEvent() {
  return { type: 'stream_retry' };
}

/** Pending twin: emitted mid-stream at content_block_start (anthropic-direct). */
function pendingDetailChunk(toolName: string, toolUseId: string) {
  return {
    type: 'chunk',
    chunk: { type: 'tool_use_detail', toolUseId, toolName, toolInput: ' …', pending: true },
  };
}

/** tool_result chunk: the round boundary (emitted after dispatch). */
function toolResultChunk(toolUseId: string) {
  return { type: 'chunk', chunk: { type: 'tool_result', toolUseId, content: 'ok', isError: false } };
}

// ---------------------------------------------------------------------------
// Tests: text accumulation
// ---------------------------------------------------------------------------

describe('accumulateStreamJson — text', () => {
  it('concatenates plain content chunks with no tools', () => {
    const stdout = ndjson([
      contentChunk('Hello '),
      contentChunk('world'),
      doneEvent({}),
    ]);
    const { text } = accumulateStreamJson(stdout);
    expect(text).toBe('Hello world');
  });

  it('inserts a [tool: name] marker between text segments at a tool boundary', () => {
    const stdout = ndjson([
      contentChunk('Before. '),
      toolDetailChunk('bash'),
      contentChunk(' After.'),
      doneEvent({}),
    ]);
    const { text } = accumulateStreamJson(stdout);
    expect(text).toBe('Before. [tool: bash] After.');
  });

  it('inserts the marker even when no text follows the tool call', () => {
    const stdout = ndjson([
      contentChunk('Intro.'),
      toolDetailChunk('read_file'),
      doneEvent({}),
    ]);
    const { text } = accumulateStreamJson(stdout);
    expect(text).toBe('Intro.[tool: read_file]');
  });

  it('handles multiple tool calls with interleaved narration', () => {
    const stdout = ndjson([
      contentChunk('Step 1. '),
      toolDetailChunk('read_file', 'tu1'),
      toolResultChunk('tu1'),
      contentChunk(' Step 2. '),
      toolDetailChunk('bash', 'tu2'),
      toolResultChunk('tu2'),
      contentChunk(' Done.'),
      doneEvent({}),
    ]);
    const { text } = accumulateStreamJson(stdout);
    expect(text).toBe('Step 1. [tool: read_file] Step 2. [tool: bash] Done.');
  });

  it('uses tool_use summary chunk as fallback when tool_use_detail is absent', () => {
    const stdout = ndjson([
      contentChunk('Before. '),
      toolUseChunk('memory_search'),
      contentChunk(' After.'),
      doneEvent({}),
    ]);
    const { text } = accumulateStreamJson(stdout);
    expect(text).toBe('Before. [tool: memory_search] After.');
  });

  it('skips malformed lines without throwing', () => {
    const raw = 'not-json\n' + JSON.stringify(contentChunk('ok')) + '\n' + JSON.stringify(doneEvent({})) + '\n';
    const { text } = accumulateStreamJson(raw);
    expect(text).toBe('ok');
  });

  it('returns empty text for empty stdout', () => {
    const { text } = accumulateStreamJson('');
    expect(text).toBe('');
  });

  it('returns empty text when only a done event is present', () => {
    const stdout = ndjson([doneEvent({ costUsd: 0.01 })]);
    const { text } = accumulateStreamJson(stdout);
    expect(text).toBe('');
  });

  it('does not duplicate a tool marker if two tool_use_detail chunks arrive back-to-back with the same id', () => {
    // Two tool_use_detail chunks for the same call (e.g. pending then final)
    const stdout = ndjson([
      contentChunk('A '),
      toolDetailChunk('bash', 'tu1'),
      toolDetailChunk('bash', 'tu1'),
      contentChunk(' B'),
      doneEvent({}),
    ]);
    const { text } = accumulateStreamJson(stdout);
    // Only one marker should appear (second deduped by toolUseId)
    expect(text).toBe('A [tool: bash] B');
  });

  it('emits one marker per distinct tool id for parallel tool calls with different ids', () => {
    // Two concurrent tool calls: read_file (tu-A) and bash (tu-B)
    const stdout = ndjson([
      contentChunk('A '),
      toolDetailChunk('read_file', 'tu-A'),
      toolDetailChunk('bash', 'tu-B'),
      contentChunk(' B'),
      doneEvent({}),
    ]);
    const { text } = accumulateStreamJson(stdout);
    expect(text).toBe('A [tool: read_file][tool: bash] B');
  });

  it('tool_use summary does not duplicate a call already marked by tool_use_detail via precedingToolUseIds', () => {
    // tool_use_detail arrives first for tu1; tool_use summary references tu1 — should be skipped
    const stdout = ndjson([
      contentChunk('A '),
      toolDetailChunk('bash', 'tu1'),
      toolUseChunk('bash', ['tu1']),
      contentChunk(' B'),
      doneEvent({}),
    ]);
    const { text } = accumulateStreamJson(stdout);
    expect(text).toBe('A [tool: bash] B');
  });

  it('marks parallel calls once each through the full pending, summary, completed sequence', () => {
    const stdout = ndjson([
      contentChunk('Look. '),
      pendingDetailChunk('read_file', 'tu-A'),
      toolUseChunk('read_file', ['tu-A']),
      pendingDetailChunk('bash', 'tu-B'),
      toolUseChunk('bash', ['tu-B']),
      toolDetailChunk('read_file', 'tu-A'),
      toolDetailChunk('bash', 'tu-B'),
      toolResultChunk('tu-A'),
      toolResultChunk('tu-B'),
      contentChunk(' Done.'),
      doneEvent({}),
    ]);
    expect(accumulateStreamJson(stdout).text).toBe('Look. [tool: read_file][tool: bash] Done.');
  });

  it('marks a reused id again in a later round (dedup is scoped to one round)', () => {
    const stdout = ndjson([
      toolDetailChunk('bash', 'call_0'),
      toolResultChunk('call_0'),
      toolDetailChunk('bash', 'call_0'),
      toolResultChunk('call_0'),
      doneEvent({}),
    ]);
    expect(accumulateStreamJson(stdout).text).toBe('[tool: bash][tool: bash]');
  });

  it('does not collapse distinct tool_use_detail chunks that carry no id', () => {
    const noId = (toolName: string) => ({ type: 'chunk', chunk: { type: 'tool_use_detail', toolName, toolInput: '{}' } });
    const stdout = ndjson([noId('read_file'), noId('bash'), doneEvent({})]);
    expect(accumulateStreamJson(stdout).text).toBe('[tool: read_file][tool: bash]');
  });

  it('excludes thinking chunks: private reasoning is not narration', () => {
    // Deliberate: extended-thinking output is the model's private reasoning.
    // Folding it into the episode text would contaminate narration measurements.
    const stdout = ndjson([
      contentChunk('Before. '),
      { type: 'chunk', chunk: { type: 'thinking', content: 'SECRET REASONING' } },
      contentChunk('After.'),
      doneEvent({}),
    ]);
    const { text } = accumulateStreamJson(stdout);
    expect(text).toBe('Before. After.');
    expect(text).not.toContain('SECRET REASONING');
  });
});

// ---------------------------------------------------------------------------
// Tests: stream_retry handling
// ---------------------------------------------------------------------------

describe('accumulateStreamJson — stream_retry', () => {
  it('discards partial text when a retry hits mid-round and keeps the re-streamed text', () => {
    const stdout = ndjson([
      contentChunk('stale '),
      streamRetryEvent(),
      contentChunk('fresh'),
      doneEvent({}),
    ]);
    expect(accumulateStreamJson(stdout).text).toBe('fresh');
  });

  it('keeps round 1 text and marker when a retry hits at the start of round 2', () => {
    // Round 1: text, pending twin, completed twin, tool_result (round boundary).
    // Round 2 is retried before its first text chunk.
    const stdout = ndjson([
      contentChunk('A '),
      pendingDetailChunk('bash', 'tu1'),
      toolUseChunk('bash', ['tu1']),
      toolDetailChunk('bash', 'tu1'),
      toolResultChunk('tu1'),
      streamRetryEvent(),
      contentChunk(' B'),
      doneEvent({}),
    ]);
    expect(accumulateStreamJson(stdout).text).toBe('A [tool: bash] B');
  });

  it('keeps prior rounds and discards only the retried round after partial text in round 2', () => {
    const stdout = ndjson([
      contentChunk('Committed. '),
      toolDetailChunk('read_file', 'tu1'),
      toolResultChunk('tu1'),
      contentChunk('stale round text'),
      streamRetryEvent(),
      contentChunk('re-driven'),
      doneEvent({}),
    ]);
    expect(accumulateStreamJson(stdout).text).toBe('Committed. [tool: read_file]re-driven');
  });

  it('drops a pending twin from the aborted attempt and re-marks it once on the re-drive', () => {
    // Real anthropic-direct ordering: the pending tool_use_detail is emitted
    // mid-stream at content_block_start, so a retry of the SAME round can
    // follow it. The re-driven attempt re-emits text and the pending twin,
    // then the completed twin arrives before dispatch.
    const stdout = ndjson([
      contentChunk('Let me check. '),
      pendingDetailChunk('bash', 'tu1'),
      streamRetryEvent(),
      contentChunk('Let me check. '),
      pendingDetailChunk('bash', 'tu1'),
      toolUseChunk('bash', ['tu1']),
      toolDetailChunk('bash', 'tu1'),
      toolResultChunk('tu1'),
      contentChunk('Done.'),
      doneEvent({}),
    ]);
    expect(accumulateStreamJson(stdout).text).toBe('Let me check. [tool: bash]Done.');
  });

  it('keeps the marker position when a retried round re-drives with a new tool id', () => {
    // Re-driven requests get fresh Anthropic block ids, so the aborted
    // attempt's id must not linger and the new id must still get a marker.
    const stdout = ndjson([
      contentChunk('X '),
      pendingDetailChunk('bash', 'old-id'),
      streamRetryEvent(),
      contentChunk('Y '),
      pendingDetailChunk('bash', 'new-id'),
      toolDetailChunk('bash', 'new-id'),
      toolResultChunk('new-id'),
      doneEvent({}),
    ]);
    expect(accumulateStreamJson(stdout).text).toBe('Y [tool: bash]');
  });
});

// ---------------------------------------------------------------------------
// Tests: doneSeen flag
// ---------------------------------------------------------------------------

describe('accumulateStreamJson — doneSeen', () => {
  it('returns doneSeen=true when a done event is present', () => {
    const stdout = ndjson([contentChunk('hi'), doneEvent({})]);
    const { doneSeen } = accumulateStreamJson(stdout);
    expect(doneSeen).toBe(true);
  });

  it('returns doneSeen=false when no done event is present', () => {
    const stdout = ndjson([contentChunk('partial text only')]);
    const { doneSeen } = accumulateStreamJson(stdout);
    expect(doneSeen).toBe(false);
  });

  it('returns doneSeen=false for empty stdout', () => {
    const { doneSeen } = accumulateStreamJson('');
    expect(doneSeen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: metadata extraction
// ---------------------------------------------------------------------------

describe('accumulateStreamJson — metadata', () => {
  it('extracts costUsd, inputTokens, outputTokens from done event', () => {
    const stdout = ndjson([
      contentChunk('hi'),
      doneEvent({ costUsd: 0.05, inputTokens: 200, outputTokens: 80, durationMs: 1200 }),
    ]);
    const { meta } = accumulateStreamJson(stdout);
    expect(meta.costUsd).toBe(0.05);
    expect(meta.inputTokens).toBe(200);
    expect(meta.outputTokens).toBe(80);
    expect(meta.durationMs).toBe(1200);
  });

  it('returns zero meta when done event is absent', () => {
    const stdout = ndjson([contentChunk('text')]);
    const { meta } = accumulateStreamJson(stdout);
    expect(meta.costUsd).toBe(0);
    expect(meta.inputTokens).toBe(0);
    expect(meta.outputTokens).toBe(0);
    expect(meta.durationMs).toBeUndefined();
  });

  it('returns zero cost when totalCostUsd is missing from metadata', () => {
    const stdout = ndjson([
      contentChunk('hi'),
      { type: 'done', metadata: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ]);
    const { meta } = accumulateStreamJson(stdout);
    expect(meta.costUsd).toBe(0);
    expect(meta.inputTokens).toBe(10);
    expect(meta.outputTokens).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Tests: runEpisodeChild — no-done-event error path
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake spawn implementation that returns fixed stdout/stderr
 * and exit code without actually spawning a process.
 */
function makeSpawnFn(opts: { stdout: string; stderr?: string; exitCode?: number }): SpawnFn {
  return ((_cmd: string, _args: string[], _options: object) => {
    const ee = new EventEmitter() as ReturnType<SpawnFn>;
    const stdoutEE = new EventEmitter();
    const stderrEE = new EventEmitter();
    (ee as unknown as Record<string, unknown>)['stdout'] = stdoutEE;
    (ee as unknown as Record<string, unknown>)['stderr'] = stderrEE;
    (ee as unknown as Record<string, unknown>)['kill'] = () => {};
    setImmediate(() => {
      stdoutEE.emit('data', Buffer.from(opts.stdout, 'utf-8'));
      if (opts.stderr) stderrEE.emit('data', Buffer.from(opts.stderr, 'utf-8'));
      ee.emit('close', opts.exitCode ?? 0);
    });
    return ee;
  }) as unknown as SpawnFn;
}

describe('runEpisodeChild — done-event guard', () => {
  const baseArgs = {
    command: 'afk',
    spawnArgs: ['chat', '--format', 'stream-json', 'hi'],
    spawnOptions: { env: {}, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] },
    episodeId: 'ep1',
    envLabel: 'baseline' as const,
    sample: 0,
    timeoutMs: 5000,
  };

  it('sets error when exit 0 but no done event in stdout', async () => {
    const stdout = ndjson([contentChunk('partial text')]);
    const trace = await runEpisodeChild({
      ...baseArgs,
      spawnImpl: makeSpawnFn({ stdout, stderr: 'something crashed' }),
    });
    expect(trace.error).toMatch(/stream ended without a done event/);
    expect(trace.costUsd).toBe(0);
    expect(trace.text).toBe('');
  });

  it('does not set error when done event is present', async () => {
    const stdout = ndjson([contentChunk('hello'), doneEvent({ costUsd: 0.01 })]);
    const trace = await runEpisodeChild({
      ...baseArgs,
      spawnImpl: makeSpawnFn({ stdout }),
    });
    expect(trace.error).toBeUndefined();
    expect(trace.text).toBe('hello');
    expect(trace.costUsd).toBe(0.01);
  });

  it('redacts secrets from stderr in the no-done-event error message', async () => {
    const stdout = ndjson([contentChunk('partial')]);
    const stderr = 'key=sk-ant-api03-abc123xyz failed';
    const trace = await runEpisodeChild({
      ...baseArgs,
      spawnImpl: makeSpawnFn({ stdout, stderr }),
    });
    expect(trace.error).toMatch(/stream ended without a done event/);
    expect(trace.error).not.toMatch(/sk-ant-api03-abc123xyz/);
    expect(trace.error).toMatch(/\[REDACTED\]/);
  });
});
