/**
 * Tests for systemPrompt field parsing in parseSessionSetup.
 *
 * Covers: accepted on session/new, rejected on load/resume,
 * whitespace-only treated as absent, non-string rejected.
 *
 * @module cli/commands/acp.params.system-prompt.test
 */
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Stub fs so validateCwd doesn't require a real directory.
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return {
    ...real,
    realpathSync: Object.assign(vi.fn((p: string) => p), { native: vi.fn((p: string) => p) }),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
  };
});

const { parseSessionSetup, AcpInvalidParams } = await import('./acp.params.js');

const BASE_CWD = path.join(os.tmpdir(), 'acp-test');
const BASE_MCP: unknown[] = [];

function newParams(extra: Record<string, unknown> = {}) {
  return { cwd: BASE_CWD, mcpServers: BASE_MCP, ...extra };
}

describe('parseSessionSetup — systemPrompt field', () => {
  it('is accepted on session/new and surfaced in the result', () => {
    const result = parseSessionSetup(newParams({ systemPrompt: 'Project context here.' }), 'new');
    expect(result.systemPrompt).toBe('Project context here.');
  });

  it('is absent from result when not supplied', () => {
    const result = parseSessionSetup(newParams(), 'new');
    expect(result.systemPrompt).toBeUndefined();
  });

  it('treats null as absent (no field set)', () => {
    const result = parseSessionSetup(newParams({ systemPrompt: null }), 'new');
    expect(result.systemPrompt).toBeUndefined();
  });

  it('treats whitespace-only value as absent', () => {
    const result = parseSessionSetup(newParams({ systemPrompt: '   \n\t  ' }), 'new');
    expect(result.systemPrompt).toBeUndefined();
  });

  it('rejects a non-string systemPrompt on session/new', () => {
    expect(() => parseSessionSetup(newParams({ systemPrompt: 42 }), 'new'))
      .toThrow(AcpInvalidParams);
  });

  it('rejects systemPrompt on session/load', () => {
    expect(() =>
      parseSessionSetup(
        { cwd: BASE_CWD, mcpServers: BASE_MCP, sessionId: 'sid', systemPrompt: 'x' },
        'load',
      ),
    ).toThrow(AcpInvalidParams);
  });

  it('rejects systemPrompt on session/resume', () => {
    expect(() =>
      parseSessionSetup({ cwd: BASE_CWD, sessionId: 'sid', systemPrompt: 'x' }, 'resume'),
    ).toThrow(AcpInvalidParams);
  });

  it('error detail for load/resume names the session/new restriction', () => {
    let caught: unknown;
    try {
      parseSessionSetup(
        { cwd: BASE_CWD, mcpServers: BASE_MCP, sessionId: 'sid', systemPrompt: 'x' },
        'load',
      );
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(AcpInvalidParams);
    expect((caught as InstanceType<typeof AcpInvalidParams>).detail).toMatch(/session\/new/);
  });
});
