/**
 * Regression for #4884: `/clear` (`AgentSession.reset()`) must not seal the
 * owned witness trace. Before the fix the reset sealed the writer, every
 * later turn was silently rejected by the sealed writer, and the SessionEnd
 * receipt hook wrote `receipts/<label>.json` at reset and then overwrote it
 * at close with a mix of both conversations.
 *
 * Contract after the fix: one trace per process lifetime. Reset writes a
 * delimiting `closure` record and leaves the writer open; only close seals.
 * The receipt is written once, at close, from the sealed trace.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

import { AgentSession } from '../session.js';
import { createMockProvider } from '../__fixtures__/mock-provider.js';
import { createHookRegistry } from '../hooks.js';
import { NdjsonTraceWriter } from './writer.js';
import { parseTraceJsonl, runReceiptSessionEndHook, type RunReceipt } from './receipt.js';
import { getReceiptsDir } from '../../paths.js';

async function drainTurn(session: AgentSession, text: string): Promise<void> {
  for await (const event of session.sendMessageStream(text)) {
    if (event.type === 'done' || event.type === 'error') break;
  }
}

describe('reset() keeps the witness trace open (#4884)', () => {
  let home: string;
  let saved: Record<string, string | undefined>;
  const KEYS = ['AFK_HOME', 'AFK_STATE_DIR', 'AFK_RUN_RECEIPT_DISABLED', 'AFK_SESSION_LEDGER_DISABLED'];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'afk-reset-trace-'));
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env['AFK_HOME'] = home;
    delete process.env['AFK_STATE_DIR'];
    delete process.env['AFK_RUN_RECEIPT_DISABLED'];
    process.env['AFK_SESSION_LEDGER_DISABLED'] = '1';
  });

  afterEach(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(home, { recursive: true, force: true });
  });

  it('records post-reset turns in the same trace and writes the receipt once, at close', async () => {
    const label = 'reset-label';
    const writer = new NdjsonTraceWriter({ traceDir: join(home, 'witness', label) });
    const registry = createHookRegistry();
    const receiptReasons: string[] = [];
    registry.register('SessionEnd', async (ctx) => {
      if (ctx.event === 'SessionEnd' && ctx.reason !== undefined) receiptReasons.push(ctx.reason);
      return runReceiptSessionEndHook(ctx);
    });
    const session = new AgentSession(
      { model: 'sonnet', apiKey: 'k', provider: createMockProvider(), traceWriter: writer, hookRegistry: registry },
      writer,
    );

    await drainTurn(session, 'before clear');
    await session.reset();
    // The reset must not write a receipt: the trace is still live and the
    // next conversation would otherwise overwrite it at close.
    const receiptPath = join(getReceiptsDir(), `${label}.json`);
    expect(existsSync(receiptPath)).toBe(false);

    await drainTurn(session, 'after clear');
    await session.close();

    const events = parseTraceJsonl(await readFile(writer.getTracePath(), 'utf8'));
    const seals = events.filter((e) => e.kind === 'session_sealed');
    expect(seals).toHaveLength(1);
    expect(events.at(-1)?.kind).toBe('session_sealed');
    // One closure per lifecycle cycle: the reset delimiter plus the close.
    const closures = events.filter((e) => e.kind === 'closure');
    expect(closures).toHaveLength(2);
    // The post-reset cycle reached the trace: its closure lands after the
    // reset closure, and the post-reset init phase is recorded between them.
    const resetIdx = events.indexOf(closures[0]!);
    const closeIdx = events.indexOf(closures[1]!);
    expect(closeIdx).toBeGreaterThan(resetIdx);
    expect(events.slice(resetIdx + 1, closeIdx).length).toBeGreaterThan(0);

    expect(receiptReasons).toEqual(['reset', 'close']);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as RunReceipt;
    expect(receipt.endReason).toBe('close');
    expect(receipt.status).toBe('succeeded');
    expect(receipt.endedAt).toBe(seals[0]!.kind === 'session_sealed' ? seals[0]!.payload.closedAt : undefined);
  });
});
