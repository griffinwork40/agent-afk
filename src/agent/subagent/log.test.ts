/**
 * Tests for SubagentLogWriter and SubagentLogReader.
 *
 * Uses a temp directory injected via AFK_HOME so all path helpers resolve
 * under the temp tree without touching ~/.afk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Temp AFK_HOME so path helpers resolve to a safe tmp dir
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-log-test-'));
process.env['AFK_HOME'] = tmpDir;

// Import AFTER setting AFK_HOME so paths.ts picks up the override
import { SubagentLogWriter, SubagentLogReader } from './log.js';
import type { OutputEvent } from '../types/session-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION = 'test-session';
const SUBAGENT = 'sub-abc';

function makeChunkEvent(text: string): OutputEvent {
  return {
    type: 'chunk',
    chunk: { type: 'content', content: text } as unknown as OutputEvent extends { type: 'chunk'; chunk: infer C } ? C : never,
  };
}

function makeMessageEvent(): OutputEvent {
  return {
    type: 'message',
    message: {
      role: 'assistant',
      content: 'hello',
      timestamp: new Date('2024-01-01T00:00:00Z'),
      metadata: { usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' },
    },
  };
}

// ---------------------------------------------------------------------------
// isEnabled opt-out
// ---------------------------------------------------------------------------

describe('SubagentLogWriter.isEnabled', () => {
  afterEach(() => {
    delete process.env['AFK_SUBAGENT_LOG'];
    vi.restoreAllMocks();
  });

  it('returns true when AFK_SUBAGENT_LOG is unset', () => {
    delete process.env['AFK_SUBAGENT_LOG'];
    expect(SubagentLogWriter.isEnabled()).toBe(true);
  });

  it('returns false when AFK_SUBAGENT_LOG=0', () => {
    process.env['AFK_SUBAGENT_LOG'] = '0';
    expect(SubagentLogWriter.isEnabled()).toBe(false);
  });

  it('returns true when AFK_SUBAGENT_LOG=1', () => {
    process.env['AFK_SUBAGENT_LOG'] = '1';
    expect(SubagentLogWriter.isEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Write + read round-trip
// ---------------------------------------------------------------------------

describe('SubagentLogWriter / SubagentLogReader round-trip', () => {
  let writer: SubagentLogWriter;
  const subId = 'sub-roundtrip';

  beforeEach(() => {
    writer = new SubagentLogWriter(SESSION, subId);
  });

  afterEach(async () => {
    await writer.close().catch(() => {});
  });

  it('writes events and readEvents yields them back', async () => {
    const events: OutputEvent[] = [
      makeChunkEvent('hello'),
      makeMessageEvent(),
    ];
    for (const e of events) writer.write(e);
    await writer.close();

    const read: OutputEvent[] = [];
    for await (const e of SubagentLogReader.readEvents(SESSION, subId)) {
      read.push(e);
    }
    expect(read).toHaveLength(2);
    expect(read[0]).toMatchObject({ type: 'chunk' });
    expect(read[1]).toMatchObject({ type: 'message' });
  });

  it('readEvents yields nothing for an unknown subagent id', async () => {
    const events: OutputEvent[] = [];
    for await (const e of SubagentLogReader.readEvents(SESSION, 'unknown-sub')) {
      events.push(e);
    }
    expect(events).toHaveLength(0);
  });

  it('writes to the correct path (sessionLabel/subagentId.jsonl)', async () => {
    expect(writer.logPath).toContain(SESSION);
    expect(writer.logPath).toContain(subId);
    expect(writer.logPath).toMatch(/\.jsonl$/);
  });
});

// ---------------------------------------------------------------------------
// SubagentLogReader.list
// ---------------------------------------------------------------------------

describe('SubagentLogReader.list', () => {
  const sessionForList = 'test-list-session';

  beforeEach(async () => {
    // Write two subagent logs
    for (const id of ['sub-1', 'sub-2']) {
      const w = new SubagentLogWriter(sessionForList, id);
      w.write(makeChunkEvent('x'));
      await w.close();
    }
  });

  it('returns subagent ids present on disk', async () => {
    const ids = await SubagentLogReader.list(sessionForList);
    expect(ids.sort()).toEqual(['sub-1', 'sub-2']);
  });

  it('returns empty array for unknown session', async () => {
    const ids = await SubagentLogReader.list('no-such-session');
    expect(ids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// close() flushes pending lines
// ---------------------------------------------------------------------------

describe('SubagentLogWriter.close flushes pending lines', () => {
  it('events written before close() appear in the file', async () => {
    const subId = 'sub-flush-test';
    const w = new SubagentLogWriter(SESSION, subId);
    w.write(makeChunkEvent('line-a'));
    w.write(makeChunkEvent('line-b'));
    // close() must flush pending writes before resolving
    await w.close();

    const events: OutputEvent[] = [];
    for await (const e of SubagentLogReader.readEvents(SESSION, subId)) {
      events.push(e);
    }
    expect(events).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// MAX_LOG_BYTES cap
// ---------------------------------------------------------------------------

describe('MAX_LOG_BYTES cap', () => {
  it('file does not exceed 1 MiB even when many large events are written', async () => {
    const subId = 'sub-overflow';
    const w = new SubagentLogWriter(SESSION, subId);

    // Write ~2MB worth of events (each ~2KB) to exceed the 1MB cap
    const payload = 'x'.repeat(2000);
    for (let i = 0; i < 1200; i++) {
      w.write(makeChunkEvent(payload));
    }
    await w.close();

    const stat = fs.statSync(w.logPath);
    // File must be ≤ 1 MiB (with some tolerance for the final incomplete line)
    expect(stat.size).toBeLessThanOrEqual(1_048_576 + 2100);
  });
});
