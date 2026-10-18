/**
 * Tests for {@link module:agent/mcp/failure-notice} (#4064).
 *
 * Covers:
 *  - `buildMcpFailureNotice`: session-init notice content and no-op when healthy
 *  - `mcpUnknownToolMessage`: per-call MCP-aware unknown-tool text
 *  - `failedMcpServers`: filter helper
 */

import { describe, expect, it } from 'vitest';
import {
  buildMcpFailureNotice,
  mcpUnknownToolMessage,
  failedMcpServers,
} from './failure-notice.js';

// ---------------------------------------------------------------------------
// failedMcpServers
// ---------------------------------------------------------------------------

describe('failedMcpServers', () => {
  it('returns only error-status servers', () => {
    const states = [
      { serverName: 'alpha', status: 'connected' },
      { serverName: 'beta', status: 'error', error: 'spawn ENOENT' },
      { serverName: 'gamma', status: 'connecting' },
      { serverName: 'delta', status: 'error', error: 'timeout' },
    ];
    const result = failedMcpServers(states);
    expect(result.map((s) => s.name)).toEqual(['beta', 'delta']); // sorted
  });

  it('returns [] when all servers are healthy', () => {
    const states = [
      { serverName: 'alpha', status: 'connected' },
      { serverName: 'beta', status: 'connecting' },
    ];
    expect(failedMcpServers(states)).toEqual([]);
  });

  it('uses "unknown error" when error field is absent', () => {
    const states = [{ serverName: 'alpha', status: 'error' }];
    const result = failedMcpServers(states);
    expect(result[0]?.reason).toBe('unknown error');
  });
});

// ---------------------------------------------------------------------------
// buildMcpFailureNotice
// ---------------------------------------------------------------------------

describe('buildMcpFailureNotice', () => {
  it('returns undefined when all servers are healthy', () => {
    expect(
      buildMcpFailureNotice([
        { serverName: 'alpha', status: 'connected' },
        { serverName: 'beta', status: 'connecting' },
      ]),
    ).toBeUndefined();
  });

  it('returns undefined for empty state list', () => {
    expect(buildMcpFailureNotice([])).toBeUndefined();
  });

  it('builds a notice naming the failed server', () => {
    const notice = buildMcpFailureNotice([
      { serverName: 'cm-data', status: 'error', error: 'spawn ENOENT /usr/bin/cm-data' },
    ]);
    expect(notice).toBeDefined();
    expect(notice).toContain('[MCP]');
    expect(notice).toContain('cm-data');
    expect(notice).toContain('spawn ENOENT');
    expect(notice).toContain('mcp__cm-data__*');
    expect(notice).toContain('do not speculate');
  });

  it('includes all failed servers when multiple fail', () => {
    const notice = buildMcpFailureNotice([
      { serverName: 'alpha', status: 'error', error: 'err-alpha' },
      { serverName: 'beta', status: 'connected' },
      { serverName: 'gamma', status: 'error', error: 'err-gamma' },
    ]);
    expect(notice).toBeDefined();
    expect(notice).toContain('alpha');
    expect(notice).toContain('err-alpha');
    expect(notice).toContain('gamma');
    expect(notice).toContain('err-gamma');
    expect(notice).not.toContain('beta');
  });

  it('emits one line per failed server', () => {
    const notice = buildMcpFailureNotice([
      { serverName: 'alpha', status: 'error', error: 'e1' },
      { serverName: 'beta', status: 'error', error: 'e2' },
    ]);
    const lines = (notice ?? '').split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[MCP]');
    expect(lines[1]).toContain('[MCP]');
  });
});

// ---------------------------------------------------------------------------
// mcpUnknownToolMessage
// ---------------------------------------------------------------------------

describe('mcpUnknownToolMessage', () => {
  const failedStates = [
    { serverName: 'cm-data', status: 'error', error: 'spawn ENOENT' },
    { serverName: 'healthy', status: 'connected' },
  ];

  it('returns undefined for a non-mcp__ tool name', () => {
    expect(mcpUnknownToolMessage('bash', failedStates)).toBeUndefined();
    expect(mcpUnknownToolMessage('read_file', failedStates)).toBeUndefined();
  });

  it('returns undefined when the mcp__ server is not in error state', () => {
    expect(mcpUnknownToolMessage('mcp__healthy__search', failedStates)).toBeUndefined();
  });

  it('returns undefined when no server states are provided', () => {
    expect(mcpUnknownToolMessage('mcp__cm-data__search', [])).toBeUndefined();
  });

  it('names the failed server and its error for mcp__<failed>__tool', () => {
    const msg = mcpUnknownToolMessage('mcp__cm-data__search', failedStates);
    expect(msg).toBeDefined();
    expect(msg).toContain('cm-data');
    expect(msg).toContain('spawn ENOENT');
    expect(msg).toContain('Do NOT retry');
    expect(msg).toContain('mcp__cm-data__*');
  });

  it('includes the specific tool name in the message', () => {
    const msg = mcpUnknownToolMessage('mcp__cm-data__search', failedStates);
    expect(msg).toContain('"mcp__cm-data__search"');
  });

  it('returns undefined for a malformed mcp__ tool name with no server segment', () => {
    expect(mcpUnknownToolMessage('mcp__', failedStates)).toBeUndefined();
    expect(mcpUnknownToolMessage('mcp__cm-data', failedStates)).toBeUndefined();
  });
});
