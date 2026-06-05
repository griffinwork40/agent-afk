import { describe, it, expect } from 'vitest';

import {
  buildMcpNameRegistry,
  buildMcpToolName,
  isMcpToolName,
  sanitizeNameSegment,
} from './naming.js';

describe('sanitizeNameSegment', () => {
  it('passes valid identifiers through', () => {
    expect(sanitizeNameSegment('filesystem')).toBe('filesystem');
    expect(sanitizeNameSegment('my-server_v2')).toBe('my-server_v2');
  });

  it('replaces unsafe characters with underscore', () => {
    expect(sanitizeNameSegment('my.server')).toBe('my_server');
    expect(sanitizeNameSegment('foo bar')).toBe('foo_bar');
    expect(sanitizeNameSegment('node@8')).toBe('node_8');
  });

  it('collapses underscore runs', () => {
    expect(sanitizeNameSegment('foo..bar')).toBe('foo_bar');
  });

  it('returns `_` for empty input', () => {
    expect(sanitizeNameSegment('')).toBe('_');
  });
});

describe('buildMcpToolName', () => {
  it('produces the canonical `mcp__server__tool` form for short names', () => {
    expect(buildMcpToolName('filesystem', 'read_file')).toBe('mcp__filesystem__read_file');
  });

  it('sanitizes both segments', () => {
    expect(buildMcpToolName('my.server', 'do thing')).toBe('mcp__my_server__do_thing');
  });

  it('falls back to a short-hash server prefix on overflow', () => {
    const longServer = 'super-long-server-name-that-uses-up-budget';
    const longTool = 'a-medium-tool-name';
    const out = buildMcpToolName(longServer, longTool);
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out.startsWith('mcp__')).toBe(true);
    expect(out.endsWith(longTool)).toBe(true);
  });

  it('truncates the tool tail when even the hashed form overflows', () => {
    const longServer = 'x'.repeat(100);
    const longTool = 'y'.repeat(100);
    const out = buildMcpToolName(longServer, longTool);
    expect(out.length).toBe(64);
    expect(out.startsWith('mcp__')).toBe(true);
  });

  it('is deterministic for identical inputs', () => {
    expect(buildMcpToolName('linear', 'create_issue')).toBe(
      buildMcpToolName('linear', 'create_issue'),
    );
  });
});

describe('isMcpToolName', () => {
  it('recognizes the `mcp__` prefix', () => {
    expect(isMcpToolName('mcp__fs__read')).toBe(true);
    expect(isMcpToolName('bash')).toBe(false);
    expect(isMcpToolName('skill')).toBe(false);
  });
});

describe('buildMcpNameRegistry', () => {
  it('builds a reverse map for non-overlapping servers', () => {
    const reg = buildMcpNameRegistry([
      { serverName: 'fs', toolNames: ['read', 'write'] },
      { serverName: 'gh', toolNames: ['issue_create'] },
    ]);
    expect(reg.conflicts).toEqual([]);
    expect(reg.tools.size).toBe(3);
    expect(reg.tools.get('mcp__fs__read')).toEqual({
      serverName: 'fs',
      originalToolName: 'read',
    });
  });

  it('treats identical (server, tool) pairs as idempotent', () => {
    const reg = buildMcpNameRegistry([
      { serverName: 'fs', toolNames: ['read', 'read'] },
    ]);
    expect(reg.conflicts).toEqual([]);
    expect(reg.tools.size).toBe(1);
  });

  it('reports conflicts when two distinct (server, tool) pairs collide', () => {
    // Pick names that force a collision: same wire name from sanitization.
    const reg = buildMcpNameRegistry([
      { serverName: 'my.server', toolNames: ['ping'] },
      { serverName: 'my_server', toolNames: ['ping'] },
    ]);
    expect(reg.conflicts.length).toBe(1);
    const conflict = reg.conflicts[0]!;
    expect(conflict.wireName).toBe('mcp__my_server__ping');
    expect(conflict.pairs.length).toBe(2);
  });
});
