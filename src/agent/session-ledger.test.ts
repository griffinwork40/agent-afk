/**
 * Tests for the per-session durable event ledger.
 *
 * Uses a temp AFK_HOME per suite run so no real ~/.afk/state is touched
 * (same pattern as bg-job-log.test.ts — env must be set before import).
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-ledger-test-'));
process.env['AFK_HOME'] = tmpDir;

// Import after env is set so path helpers resolve into the temp dir.
import {
  SessionLedgerWriter,
  projectOutputEvent,
  readLedger,
  tailLedger,
  ledgerExists,
  type LedgerRecord,
} from './session-ledger.js';
import { getSessionLedgerPath, isSafeLedgerSessionId } from '../paths.js';
import type { OutputEvent } from './types/session-types.js';

let seq = 0;
function freshId(): string {
  return `ledger-test-${Date.now()}-${seq++}`;
}

async function collect(gen: AsyncGenerator<LedgerRecord>): Promise<LedgerRecord[]> {
  const out: LedgerRecord[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// projectOutputEvent
// ---------------------------------------------------------------------------

describe('projectOutputEvent', () => {
  it('projects assistant messages', () => {
    const event: OutputEvent = {
      type: 'message',
      message: { role: 'assistant', content: 'hello world', timestamp: new Date() },
    };
    expect(projectOutputEvent(event)).toEqual({ kind: 'assistant', text: 'hello world' });
  });

  it('skips user-role message events (recorded separately via recordUser)', () => {
    const event: OutputEvent = {
      type: 'message',
      message: { role: 'user', content: 'hi', timestamp: new Date() },
    };
    expect(projectOutputEvent(event)).toBeNull();
  });

  it('skips content deltas and progress (projection, not transcript)', () => {
    expect(
      projectOutputEvent({
        type: 'chunk',
        chunk: { type: 'content', content: 'tok' },
      }),
    ).toBeNull();
    expect(
      projectOutputEvent({
        type: 'progress',
        progress: {
          taskId: 't1',
          description: 'd',
          totalTokens: 1,
          toolUses: 0,
          durationMs: 5,
        },
      }),
    ).toBeNull();
    expect(projectOutputEvent({ type: 'stream_retry' })).toBeNull();
  });

  it('projects tool starts with a capped input preview', () => {
    const event: OutputEvent = {
      type: 'chunk',
      chunk: {
        type: 'tool_use_detail',
        toolUseId: 'tu1',
        toolName: 'bash',
        toolInput: 'x'.repeat(1000),
      },
    };
    const payload = projectOutputEvent(event);
    expect(payload).toMatchObject({ kind: 'tool', toolName: 'bash' });
    if (payload?.kind === 'tool') {
      expect(payload.input.length).toBeLessThan(500);
      expect(payload.input).toContain('[truncated]');
    }
  });

  it('projects failed tool results but skips successful ones', () => {
    const failed: OutputEvent = {
      type: 'chunk',
      chunk: { type: 'tool_result', toolUseId: 'tu1', content: 'boom', isError: true },
    };
    expect(projectOutputEvent(failed)).toEqual({ kind: 'tool_error', content: 'boom' });

    const ok: OutputEvent = {
      type: 'chunk',
      chunk: { type: 'tool_result', toolUseId: 'tu2', content: 'fine' },
    };
    expect(projectOutputEvent(ok)).toBeNull();
  });

  it('projects done with cost and duration when present', () => {
    const event: OutputEvent = {
      type: 'done',
      metadata: { totalCostUsd: 0.0123, durationMs: 4200 },
    };
    expect(projectOutputEvent(event)).toEqual({ kind: 'done', costUsd: 0.0123, durationMs: 4200 });
    expect(projectOutputEvent({ type: 'done' })).toEqual({ kind: 'done' });
  });

  it('projects errors as message strings', () => {
    const payload = projectOutputEvent({ type: 'error', error: new Error('nope') });
    expect(payload).toEqual({ kind: 'error', message: 'nope' });
  });

  it('projects paused/resumed', () => {
    const resetsAt = new Date('2026-06-10T00:00:00Z');
    expect(
      projectOutputEvent({ type: 'paused', reason: 'usage-limit', resetsAt }),
    ).toEqual({ kind: 'paused', resetsAt: resetsAt.toISOString() });
    expect(projectOutputEvent({ type: 'resumed', hotSwapped: false })).toEqual({ kind: 'resumed' });
  });
});

// ---------------------------------------------------------------------------
// Writer + reader round trip
// ---------------------------------------------------------------------------

describe('SessionLedgerWriter', () => {
  it('writes records and round-trips through readLedger', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    expect(writer.active).toBe(true);

    writer.record({ kind: 'meta', sessionId: id, model: 'sonnet' });
    writer.recordUser('do the thing');
    writer.recordEvent({
      type: 'message',
      message: { role: 'assistant', content: 'done!', timestamp: new Date() },
    });
    await writer.close('close');

    const records = await collect(readLedger(id));
    expect(records.map((r) => r.kind)).toEqual(['meta', 'user', 'assistant', 'closed']);
    expect(records.every((r) => r.v === 1 && typeof r.ts === 'number')).toBe(true);
    const closed = records[3];
    expect(closed).toMatchObject({ kind: 'closed', reason: 'close' });
  });

  it('recordEvent no-ops for skipped event types (no file created)', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    writer.recordEvent({ type: 'chunk', chunk: { type: 'content', content: 'tok' } });
    // No ledger-worthy record yet → lazy stream not opened → no events.jsonl.
    expect(fs.existsSync(getSessionLedgerPath(id))).toBe(false);
    await writer.close();
    // close() writes the terminal record, which opens the stream.
    expect(await ledgerExists(id)).toBe(true);
  });

  it('rejects unsafe session ids without throwing', () => {
    const writer = new SessionLedgerWriter('../../evil');
    expect(writer.active).toBe(false);
    // Recording must be a silent no-op.
    writer.record({ kind: 'user', text: 'x' });
  });

  it('close is idempotent and writes a single closed record', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    writer.recordUser('hi');
    await writer.close('close');
    await writer.close('close');
    const records = await collect(readLedger(id));
    expect(records.filter((r) => r.kind === 'closed')).toHaveLength(1);
  });

  it('skips malformed lines on read', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    writer.recordUser('first');
    await writer.close();
    fs.appendFileSync(getSessionLedgerPath(id), 'not-json\n{"v":2,"ts":1,"kind":"user","text":"wrong-version"}\n');
    const records = await collect(readLedger(id));
    expect(records.map((r) => r.kind)).toEqual(['user', 'closed']);
  });
});

// ---------------------------------------------------------------------------
// isSafeLedgerSessionId
// ---------------------------------------------------------------------------

describe('isSafeLedgerSessionId', () => {
  it('accepts uuids and slugs', () => {
    expect(isSafeLedgerSessionId('0806444d-1234-5678-9abc-def012345678')).toBe(true);
    expect(isSafeLedgerSessionId('my-session_2')).toBe(true);
  });
  it('rejects traversal, separators, and empties', () => {
    expect(isSafeLedgerSessionId('../../etc/passwd')).toBe(false);
    expect(isSafeLedgerSessionId('a/b')).toBe(false);
    expect(isSafeLedgerSessionId('')).toBe(false);
    expect(isSafeLedgerSessionId('x'.repeat(129))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tailLedger
// ---------------------------------------------------------------------------

describe('tailLedger', () => {
  it('replays history with fromStart and stops at the closed record', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    writer.recordUser('one');
    writer.recordUser('two');
    await writer.close('close');

    const records = await collect(tailLedger(id, { fromStart: true }));
    expect(records.map((r) => r.kind)).toEqual(['user', 'user', 'closed']);
  });

  it('yields records appended after the tail started', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    writer.recordUser('pre-existing');
    // Give the lazy stream a beat to flush the first line.
    await sleep(50);

    const seen: LedgerRecord[] = [];
    const done = (async () => {
      for await (const rec of tailLedger(id)) {
        seen.push(rec);
      }
    })();

    await sleep(100);
    writer.recordUser('live-one');
    await sleep(400);
    await writer.close('close');
    await done;

    // Started at end-of-file: must NOT include 'pre-existing'.
    expect(seen.some((r) => r.kind === 'user' && 'text' in r && r.text === 'pre-existing')).toBe(false);
    expect(seen.some((r) => r.kind === 'user' && 'text' in r && r.text === 'live-one')).toBe(true);
    expect(seen.at(-1)?.kind).toBe('closed');
  });

  it('terminates when the abort signal fires', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    writer.recordUser('hello');
    await sleep(50);

    const abort = new AbortController();
    const tailPromise = collect(tailLedger(id, { signal: abort.signal }));
    await sleep(100);
    abort.abort();
    const records = await tailPromise;
    // No closed record was written — abort alone must end the generator.
    expect(records.every((r) => r.kind !== 'closed')).toBe(true);
    await writer.close();
  });

  it('returns immediately for unsafe ids', async () => {
    const records = await collect(tailLedger('../escape'));
    expect(records).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AFK remote-control records (cross-process elicitation / abort protocol)
// ---------------------------------------------------------------------------

describe('AFK remote-control ledger records', () => {
  it('round-trips an elicitation request through the ledger', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    writer.record({
      kind: 'elicitation',
      reqId: 'r1',
      request: {
        serverName: 'agent',
        origin: 'agent',
        type: 'choice',
        message: 'Pick one',
        choices: ['a', 'b'],
      },
    });
    await writer.close();

    const records = await collect(readLedger(id));
    const elic = records.find((r) => r.kind === 'elicitation');
    expect(elic).toBeDefined();
    if (elic && elic.kind === 'elicitation') {
      expect(elic.reqId).toBe('r1');
      expect(elic.request.type).toBe('choice');
      expect(elic.request.choices).toEqual(['a', 'b']);
    }
  });

  it('round-trips a signed response and an abort request', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    writer.record({
      kind: 'elicitation_response',
      reqId: 'r1',
      result: { action: 'accept', content: { value: 'b' } },
      hmac: 'deadbeef',
    });
    writer.record({ kind: 'abort_request', nonce: 'n1', hmac: 'cafef00d' });
    await writer.close();

    const records = await collect(readLedger(id));
    const resp = records.find((r) => r.kind === 'elicitation_response');
    const abort = records.find((r) => r.kind === 'abort_request');
    expect(resp && resp.kind === 'elicitation_response' && resp.result.action).toBe('accept');
    expect(abort && abort.kind === 'abort_request' && abort.nonce).toBe('n1');
  });
});
