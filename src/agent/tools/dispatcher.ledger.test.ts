/**
 * Dispatch-boundary wiring of the session-scoped ToolCallLedger (#4476).
 *
 * Asserts: settled successes and failures land in the ledger under the
 * normalized repeat-failure fingerprint at the current tool round; the turn
 * window prunes across rounds; a shared wiring survives dispatcher rebuilds;
 * and a throwing ledger never breaks or alters dispatch.
 */
import { describe, expect, it } from 'vitest';
import { SessionToolDispatcher } from './dispatcher.js';
import { ToolCallLedgerWiring } from './dispatcher.ledger.js';
import { repeatFailureFingerprint } from './repeat-failure-guard.js';
import { ToolCallLedger } from './tool-call-ledger.js';
import type { ToolCall, ToolHandler } from './types.js';
import type { AnthropicToolDef } from '../providers/anthropic-direct/types.js';

function schema(name: string): AnthropicToolDef {
  return { name, description: name, input_schema: { type: 'object', properties: {} } };
}

function call(name: string, input: unknown, id = `${name}-id`): ToolCall {
  return { id, name, input, signal: new AbortController().signal };
}

const ok: ToolHandler = async (input) => ({ content: `ok:${JSON.stringify(input)}` });
const fail: ToolHandler = async () => ({ content: 'boom: no such file', isError: true });

function makeDispatcher(
  toolCallLedger?: ToolCallLedgerWiring,
  allSafe = false,
): SessionToolDispatcher {
  return new SessionToolDispatcher({
    ...(allSafe ? { concurrencyClassifier: () => true } : {}),
    handlers: new Map<string, ToolHandler>([
      ['ok_tool', ok],
      ['fail_tool', fail],
    ]),
    schemas: [schema('ok_tool'), schema('fail_tool')],
    hookRegistry: undefined,
    ...(toolCallLedger !== undefined ? { toolCallLedger } : {}),
  });
}

describe('SessionToolDispatcher — ToolCallLedger wiring (#4476)', () => {
  it('creates its own ledger when none is supplied', () => {
    const d = makeDispatcher();
    expect(d.toolCallLedger).toBeInstanceOf(ToolCallLedgerWiring);
    expect(d.toolCallLedger.ledger.entryCount).toBe(0);
  });

  it('records a success and a failure from execute() with the normalized key and round', async () => {
    const d = makeDispatcher();
    const okCall = call('ok_tool', { a: 1, timeout_ms: 5 });
    const okResult = await d.execute(okCall);
    const failCall = call('fail_tool', { path: '/x' });
    const failResult = await d.execute(failCall);

    // Round 0 for the first entry, round 1 for the second (one per execute()).
    const okHash = repeatFailureFingerprint(okCall);
    const okHist = d.toolCallLedger.ledger.lookup('ok_tool', okHash, 1);
    expect(okHist).toHaveLength(1);
    expect(okHist[0]!.turnIndex).toBe(0);
    expect(okHist[0]!.result.isError).not.toBe(true);
    expect(okHist[0]!.result.content).toBe(okResult.content);

    const failHist = d.toolCallLedger.lookup(failCall);
    expect(failHist).toHaveLength(1);
    expect(failHist[0]!.turnIndex).toBe(1);
    expect(failHist[0]!.result.isError).toBe(true);
    expect(failResult.isError).toBe(true);

    // Volatile timeout keys are normalized away, matching RepeatFailureGuard.
    expect(d.toolCallLedger.lookup(call('ok_tool', { a: 1, timeout_ms: 999 }))).toHaveLength(1);
  });

  it('records every call of a multi-call batch at one shared round', async () => {
    const d = makeDispatcher();
    await d.execute(call('ok_tool', { warmup: true })); // round 0
    const calls = [
      call('ok_tool', { n: 1 }, 'a'),
      call('fail_tool', { n: 2 }, 'b'),
      call('ok_tool', { n: 3 }, 'c'),
    ];
    const results = await d.executeBatch(calls); // round 1
    expect(results.map((r) => r.isError === true)).toEqual([false, true, false]);
    for (const c of calls) {
      const hist = d.toolCallLedger.lookup(c);
      expect(hist).toHaveLength(1);
      expect(hist[0]!.turnIndex).toBe(1);
    }
    expect(d.toolCallLedger.lookup(calls[1]!)[0]!.result.isError).toBe(true);
    expect(d.toolCallLedger.ledger.entryCount).toBe(4);
  });

  it('records calls from the concurrent (safe) batch path too', async () => {
    const d = makeDispatcher(undefined, true);
    const calls = [call('ok_tool', { k: 1 }, 'x'), call('fail_tool', { k: 2 }, 'y')];
    await d.executeBatch(calls); // round 0, runConcurrentBatch
    expect(d.toolCallLedger.lookup(calls[0]!)[0]!.turnIndex).toBe(0);
    expect(d.toolCallLedger.lookup(calls[1]!)[0]!.result.isError).toBe(true);
  });

  it('prunes entries that fall outside the turn window as rounds advance', async () => {
    const wiring = new ToolCallLedgerWiring(new ToolCallLedger(2));
    const d = makeDispatcher(wiring);
    const first = call('ok_tool', { first: true });
    await d.execute(first); // round 0
    expect(wiring.ledger.rawEntryCountFor('ok_tool', repeatFailureFingerprint(first))).toBe(1);
    await d.execute(call('ok_tool', { r: 1 })); // round 1
    await d.execute(call('ok_tool', { r: 2 })); // round 2: cutoff 0, still kept
    expect(wiring.ledger.rawEntryCountFor('ok_tool', repeatFailureFingerprint(first))).toBe(1);
    await d.execute(call('ok_tool', { r: 3 })); // round 3: cutoff 1, round-0 key pruned
    expect(wiring.ledger.rawEntryCountFor('ok_tool', repeatFailureFingerprint(first))).toBe(0);
    expect(wiring.currentRound).toBe(3);
  });

  it('shares one ledger and round counter across dispatcher rebuilds (session scope)', async () => {
    const wiring = new ToolCallLedgerWiring();
    const c = call('fail_tool', { same: true });
    await makeDispatcher(wiring).execute(c); // round 0
    await makeDispatcher(wiring).execute(c); // round 1, different dispatcher
    expect(wiring.lookup(c).map((e) => e.turnIndex)).toEqual([0, 1]);
    // A second session's wiring is fully independent.
    expect(new ToolCallLedgerWiring().lookup(c)).toHaveLength(0);
  });

  it('a throwing ledger never breaks or alters dispatch', async () => {
    class ThrowingLedger extends ToolCallLedger {
      override record(): void {
        throw new Error('ledger record exploded');
      }
      override prune(): void {
        throw new Error('ledger prune exploded');
      }
    }
    const baseline = makeDispatcher();
    const broken = makeDispatcher(new ToolCallLedgerWiring(new ThrowingLedger()));

    const single = call('ok_tool', { x: 1 });
    expect(await broken.execute(single)).toEqual(await baseline.execute(single));
    const failing = call('fail_tool', { x: 2 });
    expect(await broken.execute(failing)).toEqual(await baseline.execute(failing));

    const batch = [call('ok_tool', { y: 1 }, 'p'), call('fail_tool', { y: 2 }, 'q')];
    const strip = (rs: { content: string; isError?: boolean }[]) =>
      rs.map((r) => ({ content: r.content, isError: r.isError === true }));
    expect(strip(await broken.executeBatch(batch))).toEqual(strip(await baseline.executeBatch(batch)));
  });
});
