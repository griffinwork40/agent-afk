/**
 * session/new, session/load and session/resume against real per-session
 * records under a temp AFK state dir (profile §2). Only session construction,
 * the journal check and replay are scripted.
 *
 * @module cli/commands/acp.handlers.session-record.test
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputEvent } from '../../agent/types/session-types.js';

vi.mock('./acp.session.js', () => ({ buildAcpSession: vi.fn(), closeAcpSession: vi.fn(async () => undefined) }));
vi.mock('../../agent/journal/reader.js', () => ({ journalExists: vi.fn(() => true) }));
vi.mock('./acp.replay.js', () => ({ emitReplayUpdates: vi.fn(async () => undefined) }));
// The real writer, wrapped so one test can make the backfill write fail.
vi.mock('./acp.session-record.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./acp.session-record.js')>();
  return { ...actual, writeAcpSessionRecord: vi.fn(actual.writeAcpSessionRecord) };
});

import { env } from '../../config/env.js';
import { getAcpSessionMapPath } from '../../paths.js';
import { getAcpSessionRecordPath } from '../../paths.journal.js';
import * as acpSession from './acp.session.js';
import { AcpError, handleRestore, handleSessionNew, type ServerContext } from './acp.handlers.js';
import { writeAcpSessionMap } from './acp.session-map.js';
import { readAcpSessionRecord, writeAcpSessionRecord } from './acp.session-record.js';
import { INTERNAL_ERROR, INVALID_PARAMS } from './acp.server.protocol.js';

const mBuild = vi.mocked(acpSession.buildAcpSession);
const mClose = vi.mocked(acpSession.closeAcpSession);
let root: string;
let ws: string;
let other: string;

function fakeHandle(): acpSession.AcpSessionHandle {
  const session = {
    getTurnCount: () => 0,
    getSessionIdentity: () => ({}),
    interrupt: vi.fn(async () => undefined),
    sendMessageStream: vi.fn(async function* (): AsyncGenerator<OutputEvent> { yield { type: 'done', metadata: {} } as OutputEvent; }),
  };
  return { session, memoryStore: {}, stateStore: {} } as unknown as acpSession.AcpSessionHandle;
}

function makeCtx(sessions: ServerContext['sessions'] = new Map()): ServerContext {
  return {
    opts: { model: 'sonnet', maxTurns: 0, dangerouslySkipPermissions: true },
    peer: { request: vi.fn(), notify: vi.fn(async () => undefined) } as unknown as ServerContext['peer'],
    initialized: true, sessions, restoring: new Set(), promptWrites: new Map(), log: () => {},
  };
}

/** Block record writes portably: `acp/sessions` becomes a regular file. */
function blockRecordDir(): void {
  mkdirSync(path.join(root, 'state', 'acp'), { recursive: true });
  writeFileSync(path.join(root, 'state', 'acp', 'sessions'), 'not a directory');
}

const restore = (id: string, cwd: string, mode: 'load' | 'resume') =>
  handleRestore(makeCtx(), { sessionId: id, cwd, mcpServers: [] }, mode).catch((e: unknown) => e);

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acp-h-rec-')));
  ws = path.join(root, 'ws');
  other = path.join(root, 'other');
  mkdirSync(ws);
  mkdirSync(other);
  vi.spyOn(env, 'AFK_STATE_DIR', 'get').mockReturnValue(path.join(root, 'state'));
  vi.clearAllMocks();
  mBuild.mockImplementation(async () => fakeHandle());
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('session/new writes the per-session record', () => {
  it('writes the record before the session is registered and before the reply', async () => {
    const seen: boolean[] = [];
    const sessions: ServerContext['sessions'] = new Map();
    const set = sessions.set.bind(sessions);
    sessions.set = (id, v) => { seen.push(existsSync(getAcpSessionRecordPath(id))); return set(id, v); };
    const { sessionId } = await handleSessionNew(makeCtx(sessions), { cwd: ws, mcpServers: [] });
    expect(seen).toEqual([true]);
    expect(readAcpSessionRecord(sessionId)).toEqual({ cwd: ws });
  });

  it('does not write the shared map', async () => {
    await writeAcpSessionMap({ keep: 'afk-keep' });
    const before = readFileSync(getAcpSessionMapPath(), 'utf8');
    await handleSessionNew(makeCtx(), { cwd: ws, mcpServers: [] });
    expect(readFileSync(getAcpSessionMapPath(), 'utf8')).toBe(before);
  });

  it('a failed record write fails with internal error, leaves no live session and closes the handle', async () => {
    blockRecordDir();
    const ctx = makeCtx();
    const err = await handleSessionNew(ctx, { cwd: ws, mcpServers: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcpError);
    expect((err as AcpError).code).toBe(INTERNAL_ERROR);
    expect((err as AcpError).detail).toBe('session construction failed');
    expect(ctx.sessions.size).toBe(0);
    expect(mClose).toHaveBeenCalledTimes(1);
    expect(mClose).toHaveBeenCalledWith(await mBuild.mock.results[0]!.value);
  });
});

describe.each(['load', 'resume'] as const)('%s of a session that is not live', (mode) => {
  it('accepts the recorded directory and leaves the record unchanged', async () => {
    writeAcpSessionRecord('s-match', { cwd: ws });
    await expect(restore('s-match', ws, mode)).resolves.toEqual({});
    expect(readAcpSessionRecord('s-match')).toEqual({ cwd: ws });
  });

  it('answers another directory with invalid params and builds nothing', async () => {
    writeAcpSessionRecord('s-mismatch', { cwd: ws });
    const err = await restore('s-mismatch', other, mode);
    expect((err as AcpError).code).toBe(INVALID_PARAMS);
    expect(mBuild).not.toHaveBeenCalled();
  });

  it('accepts a symbolic-link spelling of the recorded directory', async () => {
    const link = path.join(other, 'link');
    symlinkSync(ws, link, process.platform === 'win32' ? 'junction' : 'dir');
    writeAcpSessionRecord('s-link', { cwd: ws });
    await expect(restore('s-link', link, mode)).resolves.toEqual({});
  });

  it('accepts a session without a record, then checks against the record it wrote', async () => {
    await expect(restore('s-none', other, mode)).resolves.toEqual({});
    expect(readAcpSessionRecord('s-none')).toEqual({ cwd: other });
    expect(((await restore('s-none', ws, mode)) as AcpError).code).toBe(INVALID_PARAMS);
  });

  it('a failed backfill write fails with internal error and closes the session', async () => {
    vi.mocked(writeAcpSessionRecord).mockImplementationOnce(() => { throw new Error('EACCES'); });
    const err = await restore('s-backfill', other, mode);
    expect((err as AcpError).code).toBe(INTERNAL_ERROR);
    expect(mBuild).toHaveBeenCalledTimes(1);
    expect(mClose).toHaveBeenCalledTimes(1);
    expect(readAcpSessionRecord('s-backfill')).toBeUndefined();
  });

  it('a record path blocked by a non-directory fails closed before building', async () => {
    blockRecordDir();
    expect(((await restore('s-blocked', other, mode)) as AcpError).code).toBe(INTERNAL_ERROR);
    expect(mBuild).not.toHaveBeenCalled();
  });

  it('a corrupt record fails with internal error and is not treated as missing', async () => {
    mkdirSync(path.dirname(getAcpSessionRecordPath('s-corrupt')), { recursive: true });
    writeFileSync(getAcpSessionRecordPath('s-corrupt'), '{ not json');
    const err = await restore('s-corrupt', other, mode);
    expect((err as AcpError).code).toBe(INTERNAL_ERROR);
    expect(mBuild).not.toHaveBeenCalled();
    expect(readFileSync(getAcpSessionRecordPath('s-corrupt'), 'utf8')).toBe('{ not json');
  });

  it('accepts a session with no record (predates the check) with any cwd and writes its record', async () => {
    await expect(restore('s-no-record', ws, mode)).resolves.toEqual({});
  });
});
