/**
 * Handler-level tests: turn cap answered as a stop reason (profile §3) and the
 * original-cwd rule for session/load and session/resume (profile §2).
 *
 * @module cli/commands/acp.handlers.test
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { OutputEvent } from '../../agent/types/session-types.js';

vi.mock('./acp.session.js', () => ({ buildAcpSession: vi.fn(), closeAcpSession: vi.fn(async () => undefined) }));
vi.mock('../../agent/journal/reader.js', () => ({
  journalExists: vi.fn(() => true),
  checkJournalExists: vi.fn(() => 'exists' as const),
}));
vi.mock('./acp.replay.js', () => ({ emitReplayUpdates: vi.fn(async () => undefined) }));

import * as acpSession from './acp.session.js';
import { AcpError, handleRestore, handleSessionNew, startPrompt, type ServerContext } from './acp.handlers.js';
import { writeAcpSessionMap } from './acp.session-map.js';
import { readAcpSessionRecord, writeAcpSessionRecord } from './acp.session-record.js';
import { INVALID_PARAMS } from './acp.server.protocol.js';

const mBuild = vi.mocked(acpSession.buildAcpSession);
const WS = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acp-h-ws-')));
const OTHER = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acp-h-other-')));

/** A fake session whose completed-turn count advances once per finished stream. */
function fakeHandle(): acpSession.AcpSessionHandle {
  let turns = 0;
  const session = {
    getTurnCount: () => turns,
    getSessionIdentity: () => ({}),
    interrupt: vi.fn(async () => undefined),
    sendMessageStream: vi.fn(async function* (): AsyncGenerator<OutputEvent> {
      turns++;
      yield { type: 'done', metadata: {} } as OutputEvent;
    }),
  };
  return { session, memoryStore: {}, stateStore: {} } as unknown as acpSession.AcpSessionHandle;
}

function makeCtx(maxTurns: number): ServerContext {
  return {
    opts: { model: 'sonnet', maxTurns, dangerouslySkipPermissions: true },
    peer: { request: vi.fn(), notify: vi.fn(async () => undefined) } as unknown as ServerContext['peer'],
    initialized: true, sessions: new Map(), restoring: new Set(), promptWrites: new Map(), log: () => {},
  };
}

const prompt = (sessionId: string) => ({ sessionId, prompt: [{ type: 'text', text: 'hi' }] });

beforeEach(() => {
  vi.clearAllMocks();
  mBuild.mockImplementation(async () => fakeHandle());
});

describe('turn cap (profile §3)', () => {
  it('answers the prompt past --max-turns with max_turn_requests and keeps the session', async () => {
    const ctx = makeCtx(1);
    const { sessionId } = await handleSessionNew(ctx, { cwd: WS, mcpServers: [] });
    expect(await startPrompt(ctx, prompt(sessionId))).toEqual({ stopReason: 'end_turn' });
    expect(await startPrompt(ctx, prompt(sessionId))).toEqual({ stopReason: 'max_turn_requests' });
    expect(ctx.sessions.has(sessionId)).toBe(true);
    expect(vi.mocked(acpSession.closeAcpSession)).not.toHaveBeenCalled();
    // Still usable: a further prompt is answered the same way, not as an error.
    expect(await startPrompt(ctx, prompt(sessionId))).toEqual({ stopReason: 'max_turn_requests' });
  });
});

describe('original cwd on load/resume (profile §2)', () => {
  it('session/new records the canonical cwd', async () => {
    const ctx = makeCtx(0);
    const { sessionId } = await handleSessionNew(ctx, { cwd: WS, mcpServers: [] });
    expect(readAcpSessionRecord(sessionId)).toEqual({ cwd: WS });
  });

  it.each(['load', 'resume'] as const)('%s of a non-live session with another cwd is invalid params', async (mode) => {
    const id = `cwd-mismatch-${mode}`;
    writeAcpSessionRecord(id, { cwd: WS });
    const err = await handleRestore(makeCtx(0), { sessionId: id, cwd: OTHER, mcpServers: [] }, mode).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcpError);
    expect((err as AcpError).code).toBe(INVALID_PARAMS);
    expect(mBuild).not.toHaveBeenCalled();
  });

  it('the live-session mismatch path uses the same code', async () => {
    const ctx = makeCtx(0);
    const { sessionId } = await handleSessionNew(ctx, { cwd: WS, mcpServers: [] });
    const err = await handleRestore(ctx, { sessionId, cwd: OTHER, mcpServers: [] }, 'resume').catch((e: unknown) => e);
    expect((err as AcpError).code).toBe(INVALID_PARAMS);
  });

  it('a session without a record is restored and its record written', async () => {
    const id = 'legacy-entry';
    await writeAcpSessionMap({ [id]: id });
    await expect(handleRestore(makeCtx(0), { sessionId: id, cwd: OTHER, mcpServers: [] }, 'resume')).resolves.toEqual({});
    expect(readAcpSessionRecord(id)).toEqual({ cwd: OTHER });
  });
});
