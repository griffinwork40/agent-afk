/**
 * Tests for Telegram session watching (/watch, /unwatch).
 *
 * Uses a temp AFK_HOME so ledgers and session sidecars live in a temp dir
 * (env must be set before importing modules that resolve paths).
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-watch-test-'));
process.env['AFK_HOME'] = tmpDir;

import { SessionWatchManager, renderLedgerRecord, resolveWatchTarget } from './watch.js';
import { SessionLedgerWriter, type LedgerRecord } from '../agent/session-ledger.js';
import { getSessionsDir } from '../paths.js';

let seq = 0;
function freshId(): string {
  return `watch-test-${Date.now()}-${seq++}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function rec(payload: Omit<LedgerRecord, 'v' | 'ts'>): LedgerRecord {
  return { v: 1, ts: 1718000000000, ...payload } as LedgerRecord;
}

// ---------------------------------------------------------------------------
// renderLedgerRecord
// ---------------------------------------------------------------------------

describe('renderLedgerRecord', () => {
  it('renders each record kind compactly', () => {
    expect(renderLedgerRecord(rec({ kind: 'meta', sessionId: 's1', model: 'sonnet', cwd: '/x' })))
      .toContain('s1');
    expect(renderLedgerRecord(rec({ kind: 'user', text: 'hi there' }))).toBe('👤 hi there');
    expect(renderLedgerRecord(rec({ kind: 'assistant', text: 'sure' }))).toBe('🤖 sure');
    expect(renderLedgerRecord(rec({ kind: 'tool', toolName: 'bash', input: 'ls' }))).toBe('🔧 bash(ls)');
    expect(renderLedgerRecord(rec({ kind: 'tool_error', content: 'ENOENT' }))).toContain('ENOENT');
    expect(renderLedgerRecord(rec({ kind: 'done', costUsd: 0.01, durationMs: 1500 })))
      .toBe('✅ turn done (1.5s, $0.0100)');
    expect(renderLedgerRecord(rec({ kind: 'done' }))).toBe('✅ turn done');
    expect(renderLedgerRecord(rec({ kind: 'error', message: 'boom' }))).toContain('boom');
    expect(renderLedgerRecord(rec({ kind: 'paused' }))).toContain('paused');
    expect(renderLedgerRecord(rec({ kind: 'resumed' }))).toBe('▶️ resumed');
    expect(renderLedgerRecord(rec({ kind: 'closed', reason: 'close' }))).toContain('closed');
  });

  it('collapses whitespace and clips long text', () => {
    const text = `line1\nline2\t${'x'.repeat(2000)}`;
    const rendered = renderLedgerRecord(rec({ kind: 'assistant', text }));
    expect(rendered).not.toContain('\n');
    expect(rendered!.length).toBeLessThan(800);
    expect(rendered).toContain('…');
  });
});

// ---------------------------------------------------------------------------
// resolveWatchTarget
// ---------------------------------------------------------------------------

describe('resolveWatchTarget', () => {
  it('resolves a raw session id that has a ledger', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    writer.recordUser('x');
    await writer.close();
    expect(await resolveWatchTarget(id)).toBe(id);
  });

  it('resolves a session-store name to its SDK session id', async () => {
    const sdkId = freshId();
    const writer = new SessionLedgerWriter(sdkId);
    writer.recordUser('x');
    await writer.close();

    // Write a session-store sidecar pointing at the SDK id.
    const sidecar = {
      sessionId: sdkId,
      name: 'my-named-session',
      model: 'sonnet',
      startedAt: Date.now(),
      savedAt: Date.now(),
      totalTurns: 1,
      totalCostUsd: 0,
      totalTokens: { input: 0, output: 0 },
      totalDurationMs: 0,
      turns: [],
    };
    fs.mkdirSync(getSessionsDir(), { recursive: true });
    fs.writeFileSync(
      path.join(getSessionsDir(), `${sdkId}.json`),
      JSON.stringify(sidecar),
    );

    expect(await resolveWatchTarget('my-named-session')).toBe(sdkId);
  });

  it('returns null for unknown targets and traversal attempts', async () => {
    expect(await resolveWatchTarget('definitely-not-a-session')).toBeNull();
    expect(await resolveWatchTarget('../../etc/passwd')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SessionWatchManager
// ---------------------------------------------------------------------------

describe('SessionWatchManager', () => {
  it('streams batched records to the send fn and ends on closed', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    writer.recordUser('pre');
    await sleep(50);

    const sent: string[] = [];
    const manager = new SessionWatchManager();
    manager.start(7, id, async (text) => {
      sent.push(text);
    });
    expect(manager.watching(7)).toBe(id);

    await sleep(100);
    writer.recordUser('hello from CLI');
    writer.recordEvent({
      type: 'message',
      message: { role: 'assistant', content: 'on it', timestamp: new Date() },
    });
    await sleep(300);
    await writer.close('close');
    await sleep(600);

    const all = sent.join('\n');
    expect(all).toContain('👤 hello from CLI');
    expect(all).toContain('🤖 on it');
    expect(all).toContain('watch ended');
    // Watch ended → registry cleaned up.
    expect(manager.watching(7)).toBeUndefined();
    // Batching: the user+assistant records (written within one debounce
    // window) must arrive in a single message, not one send per record.
    expect(sent.some((m) => m.includes('hello from CLI') && m.includes('on it'))).toBe(true);
  });

  it('stop aborts the tail and reports the watched id', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    writer.recordUser('x');
    await sleep(50);

    const manager = new SessionWatchManager();
    manager.start(9, id, async () => {});
    expect(manager.stop(9)).toBe(id);
    expect(manager.watching(9)).toBeUndefined();
    expect(manager.stop(9)).toBeUndefined();
    await writer.close();
  });

  it('starting a new watch replaces the previous one', async () => {
    const idA = freshId();
    const idB = freshId();
    const wA = new SessionLedgerWriter(idA);
    const wB = new SessionLedgerWriter(idB);
    wA.recordUser('a');
    wB.recordUser('b');
    await sleep(50);

    const manager = new SessionWatchManager();
    manager.start(11, idA, async () => {});
    manager.start(11, idB, async () => {});
    expect(manager.watching(11)).toBe(idB);
    await manager.stopAll();
    expect(manager.watching(11)).toBeUndefined();
    await wA.close();
    await wB.close();
  });

  it('send failures do not kill the watch', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    writer.recordUser('x');
    await sleep(50);

    const sent: string[] = [];
    let failNext = true;
    const manager = new SessionWatchManager();
    manager.start(13, id, async (text) => {
      if (failNext) {
        failNext = false;
        throw new Error('telegram 429');
      }
      sent.push(text);
    });

    await sleep(100);
    writer.recordUser('first-batch');
    // Wait past the debounce window so the first batch flushes (and throws)
    // before the second batch is written.
    await sleep(1_800);
    writer.recordUser('second-batch');
    await sleep(300);
    await writer.close('close');
    await sleep(600);

    // First batch send threw; later batches must still be delivered.
    expect(sent.join('\n')).toContain('second-batch');
  });
});
