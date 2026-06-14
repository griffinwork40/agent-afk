import { describe, expect, it } from 'vitest';
import { checkToolPermission, withMcpToolsAllowed } from './permissions.js';

describe('checkToolPermission', () => {
  it('allows all tools when no config provided', () => {
    expect(checkToolPermission('read_file').allowed).toBe(true);
    expect(checkToolPermission('bash').allowed).toBe(true);
    expect(checkToolPermission('write_file').allowed).toBe(true);
    expect(checkToolPermission('edit_file').allowed).toBe(true);
    expect(checkToolPermission('unknown_tool').allowed).toBe(true);
  });

  it('restricts to allowlist when config provided', () => {
    const config = { allowedTools: ['bash', 'read_file'] };
    expect(checkToolPermission('bash', config).allowed).toBe(true);
    expect(checkToolPermission('read_file', config).allowed).toBe(true);
    expect(checkToolPermission('write_file', config).allowed).toBe(false);
  });

  it('includes a reason when denied by allowlist', () => {
    const config = { allowedTools: ['read_file'] };
    const result = checkToolPermission('bash', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('bash');
  });

  it('allowlist is exclusive — unlisted tools are denied', () => {
    const config = { allowedTools: ['bash'] };
    expect(checkToolPermission('bash', config).allowed).toBe(true);
    expect(checkToolPermission('read_file', config).allowed).toBe(false);
  });
});

describe('withMcpToolsAllowed', () => {
  it('returns undefined unchanged (no allowlist → all tools allowed)', () => {
    expect(withMcpToolsAllowed(undefined, ['mcp__srv__echo'])).toBeUndefined();
  });

  it('returns base unchanged when allowedTools is absent', () => {
    const base = {} as { allowedTools?: string[] };
    expect(withMcpToolsAllowed(base, ['mcp__srv__echo'])).toBe(base);
  });

  it('returns base unchanged (same reference) when no MCP names', () => {
    const base = { allowedTools: ['read_file'] };
    expect(withMcpToolsAllowed(base, [])).toBe(base);
  });

  it('returns base unchanged (same reference) when every MCP name already present', () => {
    const base = { allowedTools: ['read_file', 'mcp__srv__echo'] };
    expect(withMcpToolsAllowed(base, ['mcp__srv__echo'])).toBe(base);
  });

  it('unions missing MCP names into a NEW config without mutating base', () => {
    const base = { allowedTools: ['read_file'] };
    const result = withMcpToolsAllowed(base, ['mcp__srv__echo', 'mcp__srv__boom']);
    expect(result).not.toBe(base);
    expect(base.allowedTools).toEqual(['read_file']); // base untouched
    expect(result?.allowedTools).toEqual(['read_file', 'mcp__srv__echo', 'mcp__srv__boom']);
  });

  it('deduplicates when some MCP names already present', () => {
    const base = { allowedTools: ['read_file', 'mcp__srv__echo'] };
    const result = withMcpToolsAllowed(base, ['mcp__srv__echo', 'mcp__srv__boom']);
    expect(result?.allowedTools).toEqual(['read_file', 'mcp__srv__echo', 'mcp__srv__boom']);
  });

  it('the unioned allowlist makes a previously-rejected MCP tool pass the gate', () => {
    // Reproduces the bug: a static allowlist that omits an MCP tool rejects it;
    // after unioning the live wire-name the gate allows it — while non-MCP
    // tools stay denied (the union is scoped, not a blanket open).
    const stale = { allowedTools: ['read_file'] };
    expect(checkToolPermission('mcp__srv__echo', stale).allowed).toBe(false);

    const refreshed = withMcpToolsAllowed(stale, ['mcp__srv__echo']);
    expect(checkToolPermission('mcp__srv__echo', refreshed).allowed).toBe(true);
    expect(checkToolPermission('read_file', refreshed).allowed).toBe(true);
    expect(checkToolPermission('write_file', refreshed).allowed).toBe(false);
  });
});
