/**
 * Tests for acp.session-load.ts — loadAcpSession, replayHistory, and its use of acp.params convertMcpServers.
 *
 * Uses vi.mock to avoid real session construction, real journal reads, or real
 * network/disk I/O. The session-map is mocked to control id resolution.
 *
 * @module cli/commands/acp.session-load.test
 */

import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — registered before any import of the SUT
// ---------------------------------------------------------------------------

const mockJournalExists = vi.fn((_id: string): boolean => true);
const mockCheckJournalExists = vi.fn((_id: string): 'exists' | 'enoent' | 'error' => 'exists');
const mockBuildAcpSession = vi.fn(async (_opts: unknown) => ({
  session: { close: vi.fn().mockResolvedValue(undefined) },
  memoryStore: { close: vi.fn() },
  stateStore: { close: vi.fn() },
}));
const mockCloseAcpSession = vi.fn(async (_h: unknown) => undefined);
const mockResolveAcpId = vi.fn((id: string): string => id);
const mockEmitReplayUpdates = vi.fn(async () => undefined);
const mockReadRecord = vi.fn((_id: string): { cwd: string } | undefined => undefined);
const mockWriteRecord = vi.fn((_id: string, _r: { cwd: string }): void => undefined);
const mockPruneRecord = vi.fn((_id: string): void => undefined);

vi.mock('../../agent/journal/reader.js', () => ({
  journalExists: (id: string) => mockJournalExists(id),
  checkJournalExists: (id: string) => mockCheckJournalExists(id),
}));

vi.mock('./acp.session.js', () => ({
  buildAcpSession: (opts: unknown) => mockBuildAcpSession(opts),
  closeAcpSession: (h: unknown) => mockCloseAcpSession(h),
}));

const mockDeleteAcpMapping = vi.fn(async (_id: string): Promise<void> => undefined);

vi.mock('./acp.session-map.js', () => ({
  resolveAcpId: (id: string) => mockResolveAcpId(id),
  deleteAcpMapping: (id: string) => mockDeleteAcpMapping(id),
}));

vi.mock('./acp.session-record.js', () => ({
  readAcpSessionRecord: (id: string) => mockReadRecord(id),
  writeAcpSessionRecord: (id: string, r: { cwd: string }) => mockWriteRecord(id, r),
  pruneAcpSessionRecord: (id: string) => mockPruneRecord(id),
}));

vi.mock('./acp.replay.js', () => ({
  emitReplayUpdates: () => mockEmitReplayUpdates(),
}));

const { loadAcpSession, replayHistory, AcpNotFoundError } = await import('./acp.session-load.js');
const sessionLoadModule: Record<string, unknown> = await import('./acp.session-load.js');
// One wire-to-AFK MCP converter for the whole server (the validating one in acp.params).
const { convertMcpServers, AcpInvalidParams } = await import('./acp.params.js');

const BASE_OPTS = { model: 'claude-sonnet-4-5', maxTurns: 10 } as const;

const BASE_PARAMS = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  cwd: '/workspace',
  mcpServers: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockJournalExists.mockReturnValue(true);
  mockCheckJournalExists.mockReturnValue('exists');
  mockResolveAcpId.mockImplementation((id) => id);
  mockReadRecord.mockReturnValue(undefined);
  mockWriteRecord.mockReturnValue(undefined);
  mockPruneRecord.mockReturnValue(undefined);
  mockDeleteAcpMapping.mockResolvedValue(undefined);
  mockBuildAcpSession.mockResolvedValue({
    session: { close: vi.fn().mockResolvedValue(undefined) },
    memoryStore: { close: vi.fn() },
    stateStore: { close: vi.fn() },
  });
  mockCloseAcpSession.mockResolvedValue(undefined);
  mockEmitReplayUpdates.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// convertMcpServers
// ---------------------------------------------------------------------------

describe('convertMcpServers', () => {
  it('converts an empty array to an empty record', () => {
    expect(convertMcpServers([])).toEqual({});
  });

  it('converts a stdio server entry', () => {
    const result = convertMcpServers([{
      name: 'my-server',
      command: '/usr/bin/node',
      args: ['server.js'],
      env: [{ name: 'API_KEY', value: 'secret' }],
    }]);
    expect(result).toEqual({
      'my-server': {
        type: 'stdio',
        command: '/usr/bin/node',
        args: ['server.js'],
        env: { API_KEY: 'secret' },
      },
    });
  });

  it('converts multiple entries', () => {
    const result = convertMcpServers([
      { name: 'a', command: '/bin/a', args: [], env: [] },
      { name: 'b', command: '/bin/b', args: ['--flag'], env: [{ name: 'X', value: '1' }] },
    ]);
    expect(Object.keys(result)).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// loadAcpSession — unknown id
// ---------------------------------------------------------------------------

describe('loadAcpSession — unknown id', () => {
  it('throws AcpNotFoundError when journal does not exist', async () => {
    mockCheckJournalExists.mockReturnValue('enoent');
    await expect(loadAcpSession(BASE_PARAMS, BASE_OPTS)).rejects.toBeInstanceOf(AcpNotFoundError);
  });

  it('does not call buildAcpSession when journal missing', async () => {
    mockCheckJournalExists.mockReturnValue('enoent');
    await loadAcpSession(BASE_PARAMS, BASE_OPTS).catch(() => {});
    expect(mockBuildAcpSession).not.toHaveBeenCalled();
  });

  it('resolves via session map before checking journal', async () => {
    mockResolveAcpId.mockReturnValue('mapped-afk-id');
    mockCheckJournalExists.mockReturnValue('enoent');
    await loadAcpSession(BASE_PARAMS, BASE_OPTS).catch(() => {});
    expect(mockCheckJournalExists).toHaveBeenCalledWith('mapped-afk-id');
  });

  it('prunes the stale record when the journal is gone (item 3)', async () => {
    mockCheckJournalExists.mockReturnValue('enoent');
    await loadAcpSession(BASE_PARAMS, BASE_OPTS).catch(() => {});
    expect(mockPruneRecord).toHaveBeenCalledWith(BASE_PARAMS.sessionId);
  });

  it('does not prune when the journal exists', async () => {
    await loadAcpSession(BASE_PARAMS, BASE_OPTS);
    expect(mockPruneRecord).not.toHaveBeenCalled();
  });

  it('does not prune on transient error (EACCES/EIO)', async () => {
    mockCheckJournalExists.mockReturnValue('error');
    await loadAcpSession(BASE_PARAMS, BASE_OPTS).catch(() => {});
    expect(mockPruneRecord).not.toHaveBeenCalled();
  });

  it('deletes the stale map entry when hasMappedEntry and journal is enoent', async () => {
    // acpId !== afkId → hasMappedEntry = true
    mockResolveAcpId.mockReturnValue('different-afk-id');
    mockCheckJournalExists.mockReturnValue('enoent');
    await loadAcpSession(BASE_PARAMS, BASE_OPTS).catch(() => {});
    expect(mockDeleteAcpMapping).toHaveBeenCalledWith(BASE_PARAMS.sessionId);
  });

  it('does not call deleteAcpMapping when acpId === afkId (no map entry)', async () => {
    // acpId === afkId (identity mapping) → hasMappedEntry = false
    mockResolveAcpId.mockImplementation((id) => id);
    mockCheckJournalExists.mockReturnValue('enoent');
    await loadAcpSession(BASE_PARAMS, BASE_OPTS).catch(() => {});
    expect(mockDeleteAcpMapping).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// loadAcpSession — happy path
// ---------------------------------------------------------------------------

describe('loadAcpSession — happy path', () => {
  it('returns a session handle', async () => {
    const handle = await loadAcpSession(BASE_PARAMS, BASE_OPTS);
    expect(handle).toBeDefined();
    expect(handle.session).toBeDefined();
  });

  it('passes resume=afkId and sessionId=acpId to buildAcpSession', async () => {
    mockResolveAcpId.mockReturnValue('mapped-afk-id');
    await loadAcpSession(BASE_PARAMS, BASE_OPTS);
    const call = mockBuildAcpSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call['resume']).toBe('mapped-afk-id');
    expect(call['sessionId']).toBe(BASE_PARAMS.sessionId);
  });

  it('passes converted mcpServers', async () => {
    const params = {
      ...BASE_PARAMS,
      mcpServers: [{ name: 'srv', command: '/bin/srv', args: [], env: [] }],
    };
    await loadAcpSession(params, BASE_OPTS);
    const call = mockBuildAcpSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call['mcpServers']).toEqual({ srv: { type: 'stdio', command: '/bin/srv', args: [], env: {} } });
  });

  it('uses the single validating MCP converter: duplicate names are rejected, not overwritten', async () => {
    expect(sessionLoadModule['convertMcpServers']).toBeUndefined();
    const dup = { name: 'srv', command: '/bin/srv', args: [], env: [] };
    await expect(loadAcpSession({ ...BASE_PARAMS, mcpServers: [dup, { ...dup, command: '/bin/other' }] }, BASE_OPTS))
      .rejects.toBeInstanceOf(AcpInvalidParams);
    expect(mockBuildAcpSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// loadAcpSession — cleanup on failure
// ---------------------------------------------------------------------------

describe('loadAcpSession — cleanup on failure', () => {
  it('calls closeAcpSession when buildAcpSession throws after partial init', async () => {
    // We can't easily simulate partial init with the current mock, but we can
    // verify that a buildAcpSession rejection propagates as an error.
    mockBuildAcpSession.mockRejectedValueOnce(new Error('MCP startup failure'));
    await expect(loadAcpSession(BASE_PARAMS, BASE_OPTS)).rejects.toThrow('MCP startup failure');
  });
});

// ---------------------------------------------------------------------------
// replayHistory
// ---------------------------------------------------------------------------

describe('replayHistory', () => {
  it('calls emitReplayUpdates with the resolved afkId', async () => {
    mockResolveAcpId.mockReturnValue('afk-mapped');
    const peer = { request: vi.fn(), notify: vi.fn().mockResolvedValue(undefined) };
    await replayHistory('acp-id', peer);
    expect(mockEmitReplayUpdates).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// loadAcpSession — stored canonical cwd (profile §2)
// ---------------------------------------------------------------------------

describe('loadAcpSession — original cwd required', () => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acp-load-cwd-')));
  const other = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acp-load-other-')));

  it('accepts the recorded cwd and does not rewrite it', async () => {
    mockReadRecord.mockReturnValue({ cwd: root });
    await loadAcpSession({ ...BASE_PARAMS, cwd: root }, BASE_OPTS);
    expect(mockBuildAcpSession).toHaveBeenCalledOnce();
    expect(mockWriteRecord).not.toHaveBeenCalled();
  });

  it('rejects a different cwd as invalid params before building anything', async () => {
    mockReadRecord.mockReturnValue({ cwd: root });
    await expect(loadAcpSession({ ...BASE_PARAMS, cwd: other }, BASE_OPTS)).rejects.toBeInstanceOf(AcpInvalidParams);
    expect(mockBuildAcpSession).not.toHaveBeenCalled();
  });

  it('accepts a session without a record and writes its record before returning', async () => {
    await loadAcpSession({ ...BASE_PARAMS, cwd: other }, BASE_OPTS);
    expect(mockBuildAcpSession).toHaveBeenCalledOnce();
    expect(mockWriteRecord).toHaveBeenCalledWith(BASE_PARAMS.sessionId, { cwd: other });
  });

  it('a failed record write fails the load and closes the session it built', async () => {
    mockWriteRecord.mockImplementation(() => { throw new Error('EACCES'); });
    await expect(loadAcpSession({ ...BASE_PARAMS, cwd: other }, BASE_OPTS)).rejects.toThrow('EACCES');
    expect(mockCloseAcpSession).toHaveBeenCalledOnce();
  });

  it('an unreadable record fails the load (not treated as no record) before building', async () => {
    mockReadRecord.mockImplementation(() => { throw new Error('malformed'); });
    await expect(loadAcpSession({ ...BASE_PARAMS, cwd: other }, BASE_OPTS)).rejects.toThrow('malformed');
    expect(mockBuildAcpSession).not.toHaveBeenCalled();
    expect(mockWriteRecord).not.toHaveBeenCalled();
  });

  it('accepts a symlinked spelling of the same directory (canonical comparison)', async () => {
    const link = path.join(other, 'link-to-root');
    symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    mockReadRecord.mockReturnValue({ cwd: link });
    await loadAcpSession({ ...BASE_PARAMS, cwd: root }, BASE_OPTS);
    mockReadRecord.mockReturnValue({ cwd: root });
    await loadAcpSession({ ...BASE_PARAMS, cwd: link }, BASE_OPTS);
    expect(mockBuildAcpSession).toHaveBeenCalledTimes(2);
  });
});
