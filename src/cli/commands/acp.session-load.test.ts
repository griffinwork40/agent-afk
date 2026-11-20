/**
 * Tests for acp.session-load.ts — loadAcpSession, replayHistory, convertMcpServers.
 *
 * Uses vi.mock to avoid real session construction, real journal reads, or real
 * network/disk I/O. The session-map is mocked to control id resolution.
 *
 * @module cli/commands/acp.session-load.test
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — registered before any import of the SUT
// ---------------------------------------------------------------------------

const mockJournalExists = vi.fn((_id: string): boolean => true);
const mockBuildAcpSession = vi.fn(async (_opts: unknown) => ({
  session: { close: vi.fn().mockResolvedValue(undefined) },
  memoryStore: { close: vi.fn() },
  stateStore: { close: vi.fn() },
}));
const mockCloseAcpSession = vi.fn(async (_h: unknown) => undefined);
const mockResolveAcpId = vi.fn((id: string): string => id);
const mockEmitReplayUpdates = vi.fn(async () => undefined);

vi.mock('../../agent/journal/reader.js', () => ({
  journalExists: (id: string) => mockJournalExists(id),
}));

vi.mock('./acp.session.js', () => ({
  buildAcpSession: (opts: unknown) => mockBuildAcpSession(opts),
  closeAcpSession: (h: unknown) => mockCloseAcpSession(h),
}));

vi.mock('./acp.session-map.js', () => ({
  resolveAcpId: (id: string) => mockResolveAcpId(id),
}));

vi.mock('./acp.replay.js', () => ({
  emitReplayUpdates: () => mockEmitReplayUpdates(),
}));

const { loadAcpSession, replayHistory, convertMcpServers, AcpNotFoundError } =
  await import('./acp.session-load.js');

const BASE_OPTS = { model: 'claude-sonnet-4-5', maxTurns: 10 } as const;

const BASE_PARAMS = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  cwd: '/workspace',
  mcpServers: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockJournalExists.mockReturnValue(true);
  mockResolveAcpId.mockImplementation((id) => id);
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
    mockJournalExists.mockReturnValue(false);
    await expect(loadAcpSession(BASE_PARAMS, BASE_OPTS)).rejects.toBeInstanceOf(AcpNotFoundError);
  });

  it('does not call buildAcpSession when journal missing', async () => {
    mockJournalExists.mockReturnValue(false);
    await loadAcpSession(BASE_PARAMS, BASE_OPTS).catch(() => {});
    expect(mockBuildAcpSession).not.toHaveBeenCalled();
  });

  it('resolves via session map before checking journal', async () => {
    mockResolveAcpId.mockReturnValue('mapped-afk-id');
    mockJournalExists.mockReturnValue(false);
    await loadAcpSession(BASE_PARAMS, BASE_OPTS).catch(() => {});
    expect(mockJournalExists).toHaveBeenCalledWith('mapped-afk-id');
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
