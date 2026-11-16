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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

import { AgentSession } from '../session.js';
import { anthropicDirectProvider } from '../providers/anthropic-direct/index.js';
import { anthropicText, anthropicToolUse, installWire, uninstallWire } from '../session/__test-utils__/model-fallback-wire.js';
import { captureGitHead, writeSessionMeta } from '../session/session-meta.js';
import { createOutcomeSessionEndHook } from '../outcomes/session-end-hook.js';
import * as outcomeStore from '../outcomes/store.js';
import { _resetSessionOutcomesCache } from '../outcomes/session-outcomes.js';
import { createHookRegistry } from '../hooks.js';
import { NdjsonTraceWriter } from './writer.js';
import { parseTraceJsonl, runReceiptSessionEndHook, type RunReceipt } from './receipt.js';
import { getReceiptsDir } from '../../paths.js';

async function drainTurn(session: AgentSession, text: string): Promise<void> {
  for await (const event of session.sendMessageStream(text)) {
    expect(event.type).not.toBe('error');
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

describe('reset() keeps the witness trace open (#4884)', () => {
  let home: string;
  let saved: Record<string, string | undefined>;
  let session: AgentSession | undefined;
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
    await session?.close();
    session = undefined;
    vi.restoreAllMocks();
    uninstallWire();
    _resetSessionOutcomesCache();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(home, { recursive: true, force: true });
  });

  it('records post-reset turns in the same trace and writes the receipt once, at close', async () => {
    // Observe completion of the fire-and-forget hook without replacing it.
    const upsert = vi.spyOn(outcomeStore, 'upsertVotes');
    const label = 'reset-label';
    const sessionId = 'reset-continuity-session';
    const model = 'claude-haiku-4-5';
    const repo = join(home, 'repo');
    await mkdir(repo);
    git(repo, 'init', '-q');
    git(repo, 'commit', '--allow-empty', '-q', '-m', 'base');
    const probePath = join(repo, 'post-reset-probe.txt');
    installWire((_model, n) => ({ events: n === 1
      ? anthropicToolUse(model, 'write_file', { file_path: probePath, content: 'post-reset turn' })
      : anthropicText(model, n === 0 ? 'before clear' : 'after clear') }));
    const writer = new NdjsonTraceWriter({ traceDir: join(home, 'witness', label) });
    const registry = createHookRegistry();
    const receiptReasons: string[] = [];
    registry.register('SessionEnd', async (ctx) => {
      if (ctx.event === 'SessionEnd' && ctx.reason !== undefined) receiptReasons.push(ctx.reason);
      return runReceiptSessionEndHook(ctx);
    });
    // Match default-hook-registry: receipt first, then the real outcome hook.
    registry.register('SessionEnd', createOutcomeSessionEndHook());
    session = new AgentSession({
      model, apiKey: 'k', cwd: repo, traceWriter: writer, hookRegistry: registry,
      // Keep the process id across /clear, as on the CLI. Only the wire is fake;
      // the real provider loop executes and traces the post-reset tool call.
      provider: { name: 'reset-continuity', query: (args) => anthropicDirectProvider.query({
        ...args, config: { ...args.config, sessionId },
      }) },
    }, writer);

    await drainTurn(session, 'before clear');
    // The ledger is disabled in this fixture; seed its normal start metadata.
    await writeSessionMeta({ v: 1, sessionId, model, cwd: repo, gitHead: captureGitHead(repo) });
    await session.reset();
    // The outcome hook is fire-and-forget. Wait for its real reset computation
    // to finish BEFORE changing HEAD, without touching the shared memo ourselves.
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    expect(outcomeStore.readRecord(sessionId)?.artifacts.commits).toEqual([]);
    // The reset must not write a receipt: the trace is still live and the
    // next conversation would otherwise overwrite it at close.
    const receiptPath = join(getReceiptsDir(), `${label}.json`);
    expect(existsSync(receiptPath)).toBe(false);

    await drainTurn(session, 'after clear');
    expect(await readFile(probePath, 'utf8')).toBe('post-reset turn');
    git(repo, 'add', 'post-reset-probe.txt');
    await writeFile(join(home, 'commit-message'), 'post-reset commit');
    git(repo, 'commit', '-q', '-F', join(home, 'commit-message'));
    const postResetSha = git(repo, 'rev-parse', 'HEAD');
    // No clock advance or cache clear: close must be fresh inside the 60s TTL.
    await session.close();
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(2));

    const events = parseTraceJsonl(await readFile(writer.getTracePath(), 'utf8'));
    const seals = events.filter((e) => e.kind === 'session_sealed');
    expect(seals).toHaveLength(1);
    expect(events.at(-1)?.kind).toBe('session_sealed');
    // One closure per lifecycle cycle: the reset delimiter plus the close.
    const closures = events.filter((e) => e.kind === 'closure');
    expect(closures).toHaveLength(2);
    // An init phase alone cannot prove the post-reset user turn was recorded.
    // This unique tool id is emitted only by the second scripted turn.
    const resetIdx = events.indexOf(closures[0]!);
    const closeIdx = events.indexOf(closures[1]!);
    expect(closeIdx).toBeGreaterThan(resetIdx);
    const completedTools = events.filter((e) => e.kind === 'tool_call' && e.payload.phase === 'completed');
    expect(completedTools).toHaveLength(1);
    expect(completedTools[0]).toMatchObject({
      kind: 'tool_call', payload: { toolUseId: 'toolu_1', name: 'write_file', phase: 'completed', isError: false },
    });
    const toolIdx = events.indexOf(completedTools[0]!);
    expect(toolIdx).toBeGreaterThan(resetIdx);
    expect(toolIdx).toBeLessThan(closeIdx);

    expect(receiptReasons).toEqual(['reset', 'close']);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as RunReceipt;
    expect(receipt.outcomes?.commits.map((c) => c.sha)).toContain(postResetSha);
    expect(receipt.endReason).toBe('close');
    expect(receipt.status).toBe('succeeded');
    expect(receipt.endedAt).toBe(seals[0]!.kind === 'session_sealed' ? seals[0]!.payload.closedAt : undefined);
  });
});
