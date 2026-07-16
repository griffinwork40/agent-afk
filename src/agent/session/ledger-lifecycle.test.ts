/**
 * Unit tests for {@link LedgerLifecycle} — the lazy create-on-first-use +
 * pass-through + idempotent-seal wrapper the session holds around a
 * {@link SessionLedgerWriter}.
 *
 * Scope split from the siblings: `session-ledger.test.ts` covers the WRITER
 * (record/close/read round-trips) and `session-ledger-integration.test.ts`
 * covers the wiring through a live AgentSession. This file covers the
 * LIFECYCLE WRAPPER's own contract in isolation — the `ensure()` gates and its
 * one-attempt latch, the "silently dropped when unledgered" invariant on every
 * record method (per the method docstrings), the meta record it writes on
 * creation, and the idempotent `seal()` that resets the instance for a
 * `reset()` cycle.
 *
 * Uses a temp AFK_HOME per suite run so no real ~/.afk/state is touched (same
 * pattern as session-ledger.test.ts — env must be set before import).
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-ledger-lifecycle-test-'));
process.env['AFK_HOME'] = tmpDir;

// Import after env is set so path helpers resolve into the temp dir.
import { LedgerLifecycle, type LedgerEnsureContext } from './ledger-lifecycle.js';
import { readLedger, type LedgerRecord } from '../session-ledger.js';
import { getSessionLedgerPath } from '../../paths.js';
import type { OutputEvent } from '../types.js';
import type { ElicitationRequest } from '../types/sdk-types.js';

let seq = 0;
function freshId(): string {
  return `lifecycle-test-${Date.now()}-${seq++}`;
}

async function collect(sessionId: string): Promise<LedgerRecord[]> {
  const out: LedgerRecord[] = [];
  for await (const r of readLedger(sessionId)) out.push(r);
  return out;
}

/** A fully-ledgerable context (top-level, valid id, no trace, minimal meta). */
function ledgeredCtx(sessionId: string, over: Partial<LedgerEnsureContext> = {}): LedgerEnsureContext {
  return {
    depth: undefined,
    parentSessionId: undefined,
    sessionId,
    fallbackModel: 'sonnet',
    tracePath: undefined,
    getMetadata: () => ({}),
    ...over,
  };
}

const assistantEvent = (content: string): OutputEvent => ({
  type: 'message',
  message: { role: 'assistant', content, timestamp: new Date() },
});

const elicitationRequest: ElicitationRequest = {
  serverName: 'agent',
  origin: 'agent',
  type: 'choice',
  message: 'Pick one',
  choices: ['a', 'b'],
};

// ---------------------------------------------------------------------------
// ensure() — gates + one-attempt latch
// ---------------------------------------------------------------------------

describe('LedgerLifecycle.ensure', () => {
  it('creates a ledger on first use and writes a meta record', async () => {
    const id = freshId();
    const life = new LedgerLifecycle();
    life.ensure(
      ledgeredCtx(id, { fallbackModel: 'sonnet', getMetadata: () => ({ cwd: '/tmp/work' }) }),
    );
    await life.seal('close');

    const records = await collect(id);
    expect(records[0]).toMatchObject({
      kind: 'meta',
      sessionId: id,
      model: 'sonnet',
      cwd: '/tmp/work',
    });
    // No trace wired → the id→label bridge is an explicit null.
    expect(records[0]).toMatchObject({ traceLabel: null });
  });

  it('prefers metadata.model over the fallback model', async () => {
    const id = freshId();
    const life = new LedgerLifecycle();
    life.ensure(ledgeredCtx(id, { fallbackModel: 'sonnet', getMetadata: () => ({ model: 'opus' }) }));
    await life.seal('close');

    const records = await collect(id);
    expect(records[0]).toMatchObject({ kind: 'meta', model: 'opus' });
  });

  it('reads metadata lazily — never invoked on the no-op path once latched', () => {
    const id = freshId();
    const life = new LedgerLifecycle();
    let metaCalls = 0;
    const ctx = ledgeredCtx(id, {
      getMetadata: () => {
        metaCalls++;
        return {};
      },
    });
    life.ensure(ctx);
    life.ensure(ctx);
    life.ensure(ctx);
    // Created once → metadata read exactly once, not per ensure() call.
    expect(metaCalls).toBe(1);
  });

  it('is idempotent: a second ensure() after creation is a no-op (single meta record)', async () => {
    const id = freshId();
    const life = new LedgerLifecycle();
    life.ensure(ledgeredCtx(id));
    life.ensure(ledgeredCtx(id));
    await life.seal('close');

    const records = await collect(id);
    expect(records.filter((r) => r.kind === 'meta')).toHaveLength(1);
  });

  it('latches after a FAILED attempt: never retries even if inputs later become valid', async () => {
    const id = freshId();
    const life = new LedgerLifecycle();
    // First attempt has no session id → runs unledgered and sets the latch.
    life.ensure(ledgeredCtx(id, { sessionId: undefined }));
    // A later call with a valid id must NOT create a writer (latch is sticky).
    life.ensure(ledgeredCtx(id));
    life.recordUser('should be dropped');
    await life.seal('close');

    expect(fs.existsSync(getSessionLedgerPath(id))).toBe(false);
  });

  it('gates off subagent forks (depth set)', () => {
    const id = freshId();
    const life = new LedgerLifecycle();
    life.ensure(ledgeredCtx(id, { depth: 1 }));
    life.recordUser('child');
    expect(fs.existsSync(getSessionLedgerPath(id))).toBe(false);
  });

  it('gates off subagent forks (parentSessionId set)', () => {
    const id = freshId();
    const life = new LedgerLifecycle();
    life.ensure(ledgeredCtx(id, { parentSessionId: 'parent-123' }));
    life.recordUser('child');
    expect(fs.existsSync(getSessionLedgerPath(id))).toBe(false);
  });

  it('honors AFK_SESSION_LEDGER_DISABLED=1', () => {
    const id = freshId();
    process.env['AFK_SESSION_LEDGER_DISABLED'] = '1';
    try {
      const life = new LedgerLifecycle();
      life.ensure(ledgeredCtx(id));
      life.recordUser('silent');
      expect(fs.existsSync(getSessionLedgerPath(id))).toBe(false);
    } finally {
      delete process.env['AFK_SESSION_LEDGER_DISABLED'];
    }
  });

  it('runs unledgered when no provider session id is available yet', () => {
    const id = freshId();
    const life = new LedgerLifecycle();
    life.ensure(ledgeredCtx(id, { sessionId: undefined }));
    life.recordUser('no id');
    expect(fs.existsSync(getSessionLedgerPath(id))).toBe(false);
  });

  it('runs unledgered for an unsafe (path-traversal) session id', () => {
    // SessionLedgerWriter.active is false for an unsafe id → writer discarded.
    const life = new LedgerLifecycle();
    life.ensure(ledgeredCtx('../../evil'));
    // Recording must be a silent no-op and touch nothing.
    life.recordUser('x');
    life.recordEvent(assistantEvent('y'));
  });
});

// ---------------------------------------------------------------------------
// record* — silently dropped when unledgered (per docstring contract)
// ---------------------------------------------------------------------------

describe('LedgerLifecycle record methods when unledgered', () => {
  it('drops recordUser / recordEvent / recordElicitation before ensure() (no writer)', async () => {
    const id = freshId();
    const life = new LedgerLifecycle();
    // No ensure() call at all → writer is null → every record is a no-op.
    life.recordUser('dropped');
    life.recordEvent(assistantEvent('dropped'));
    life.recordElicitation('r1', elicitationRequest);
    await life.seal('close');

    expect(fs.existsSync(getSessionLedgerPath(id))).toBe(false);
    expect(await collect(id)).toEqual([]);
  });

  it('drops records when the session was gated off (subagent)', async () => {
    const id = freshId();
    const life = new LedgerLifecycle();
    life.ensure(ledgeredCtx(id, { depth: 2 }));
    life.recordUser('dropped');
    life.recordEvent(assistantEvent('dropped'));
    life.recordElicitation('r1', elicitationRequest);
    await life.seal('close');

    expect(fs.existsSync(getSessionLedgerPath(id))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// record* — written correctly when ledgered
// ---------------------------------------------------------------------------

describe('LedgerLifecycle record methods when ledgered', () => {
  it('records a user turn', async () => {
    const id = freshId();
    const life = new LedgerLifecycle();
    life.ensure(ledgeredCtx(id));
    life.recordUser('do the thing');
    await life.seal('close');

    const records = await collect(id);
    expect(records.find((r) => r.kind === 'user')).toMatchObject({
      kind: 'user',
      text: 'do the thing',
    });
  });

  it('records a projected assistant output event', async () => {
    const id = freshId();
    const life = new LedgerLifecycle();
    life.ensure(ledgeredCtx(id));
    life.recordEvent(assistantEvent('done!'));
    await life.seal('close');

    const records = await collect(id);
    expect(records.find((r) => r.kind === 'assistant')).toMatchObject({
      kind: 'assistant',
      text: 'done!',
    });
  });

  it('does not record output events the ledger projection skips (content deltas)', async () => {
    const id = freshId();
    const life = new LedgerLifecycle();
    life.ensure(ledgeredCtx(id));
    // A content-delta chunk projects to null → recordEvent is a no-op.
    life.recordEvent({ type: 'chunk', chunk: { type: 'content', content: 'tok' } });
    await life.seal('close');

    const records = await collect(id);
    expect(records.some((r) => r.kind === 'assistant')).toBe(false);
    // Only meta + closed remain.
    expect(records.map((r) => r.kind)).toEqual(['meta', 'closed']);
  });

  it('records an elicitation request', async () => {
    const id = freshId();
    const life = new LedgerLifecycle();
    life.ensure(ledgeredCtx(id));
    life.recordElicitation('req-42', elicitationRequest);
    await life.seal('close');

    const records = await collect(id);
    const elic = records.find((r) => r.kind === 'elicitation');
    expect(elic).toBeDefined();
    if (elic && elic.kind === 'elicitation') {
      expect(elic.reqId).toBe('req-42');
      expect(elic.request.type).toBe('choice');
      expect(elic.request.choices).toEqual(['a', 'b']);
    }
  });
});

// ---------------------------------------------------------------------------
// seal() — idempotent terminal record + reset-for-reuse
// ---------------------------------------------------------------------------

describe('LedgerLifecycle.seal', () => {
  it('writes a terminal closed record carrying the reason', async () => {
    const id = freshId();
    const life = new LedgerLifecycle();
    life.ensure(ledgeredCtx(id));
    life.recordUser('hi');
    await life.seal('close');

    const records = await collect(id);
    expect(records.at(-1)).toMatchObject({ kind: 'closed', reason: 'close' });
  });

  it('is a no-op (resolves) when the session was never ledgered', async () => {
    const id = freshId();
    const life = new LedgerLifecycle();
    // No ensure() → no writer → seal resolves without creating a file.
    await expect(life.seal('close')).resolves.toBeUndefined();
    expect(fs.existsSync(getSessionLedgerPath(id))).toBe(false);
  });

  it('handles a double-seal gracefully — a second seal is a no-op', async () => {
    const id = freshId();
    const life = new LedgerLifecycle();
    life.ensure(ledgeredCtx(id));
    life.recordUser('hi');
    await life.seal('close');
    // Second seal: writer already cleared → resolves, writes nothing more.
    await expect(life.seal('close')).resolves.toBeUndefined();

    const records = await collect(id);
    expect(records.filter((r) => r.kind === 'closed')).toHaveLength(1);
  });

  it('resets the instance so a reset() cycle re-ledgers with a fresh writer', async () => {
    // The session reuses ONE LedgerLifecycle across a /clear (reset) cycle:
    // seal() must clear the writer AND the latch so the next ensure() creates
    // a new ledger. Distinct ids stand in for the fresh provider session id a
    // real reset would issue.
    const life = new LedgerLifecycle();

    const idA = freshId();
    life.ensure(ledgeredCtx(idA));
    life.recordUser('cycle A');
    await life.seal('reset');

    const idB = freshId();
    life.ensure(ledgeredCtx(idB));
    life.recordUser('cycle B');
    await life.seal('close');

    const a = await collect(idA);
    expect(a.find((r) => r.kind === 'user')).toMatchObject({ text: 'cycle A' });
    expect(a.at(-1)).toMatchObject({ kind: 'closed', reason: 'reset' });

    const b = await collect(idB);
    expect(b.find((r) => r.kind === 'meta')).toBeDefined();
    expect(b.find((r) => r.kind === 'user')).toMatchObject({ text: 'cycle B' });
    expect(b.at(-1)).toMatchObject({ kind: 'closed', reason: 'close' });
  });
});
