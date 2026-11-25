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

  it('rejects a systemPrompt that exceeds 32 768 characters', () => {
    const oversized = 'x'.repeat(32_769);
    expect(() => parseSessionSetup(newParams({ systemPrompt: oversized }), 'new'))
      .toThrow(AcpInvalidParams);
  });

  it('error detail for oversized systemPrompt names the limit', () => {
    const oversized = 'x'.repeat(32_769);
    let caught: unknown;
    try { parseSessionSetup(newParams({ systemPrompt: oversized }), 'new'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(AcpInvalidParams);
    expect((caught as InstanceType<typeof AcpInvalidParams>).detail).toMatch(/32768/);
  });

  it('accepts a systemPrompt at exactly the 32 768-character limit', () => {
    const atLimit = 'x'.repeat(32_768);
    const result = parseSessionSetup(newParams({ systemPrompt: atLimit }), 'new');
    expect(result.systemPrompt).toBe(atLimit);
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

  it('rejects non-string systemPrompt on session/load with "must be a string" detail', () => {
    // R1.1: type check must fire before mode check so the error names the
    // actual constraint (type) rather than the secondary one (mode).
    let caught: unknown;
    try {
      parseSessionSetup(
        { cwd: BASE_CWD, mcpServers: BASE_MCP, sessionId: 'x', systemPrompt: 42 },
        'load',
      );
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(AcpInvalidParams);
    expect((caught as InstanceType<typeof AcpInvalidParams>).detail).toMatch(/must be a string/);
  });

  it('rejects non-string systemPrompt on session/resume with "must be a string" detail', () => {
    let caught: unknown;
    try {
      parseSessionSetup(
        { cwd: BASE_CWD, sessionId: 'x', systemPrompt: false },
        'resume',
      );
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(AcpInvalidParams);
    expect((caught as InstanceType<typeof AcpInvalidParams>).detail).toMatch(/must be a string/);
  });

  it('rejects a systemPrompt whose UTF-8 encoding exceeds 32 768 bytes (multibyte boundary)', () => {
    // '😀' encodes to 4 UTF-8 bytes but has .length === 2 (surrogate pair).
    // 16 384 repetitions → 65 536 UTF-8 bytes, well over the 32 768-byte cap,
    // but only 32 768 UTF-16 code units — the old .length check would have passed it.
    const overLimit = '😀'.repeat(16_384);
    expect(Buffer.byteLength(overLimit, 'utf8')).toBe(65_536);
    expect(() => parseSessionSetup(newParams({ systemPrompt: overLimit }), 'new'))
      .toThrow(AcpInvalidParams);
  });

  it('accepts a systemPrompt whose UTF-8 encoding is exactly at the 32 768-byte limit', () => {
    // 'A' encodes to 1 UTF-8 byte; 32 768 of them sit exactly on the boundary.
    const atLimit = 'A'.repeat(32_768);
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(32_768);
    const result = parseSessionSetup(newParams({ systemPrompt: atLimit }), 'new');
    expect(result.systemPrompt).toBe(atLimit);
  });

  it('error detail for oversized systemPrompt mentions bytes', () => {
    const overLimit = 'A'.repeat(32_769);
    let caught: unknown;
    try { parseSessionSetup(newParams({ systemPrompt: overLimit }), 'new'); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(AcpInvalidParams);
    expect((caught as InstanceType<typeof AcpInvalidParams>).detail).toMatch(/bytes/);
  });
});
