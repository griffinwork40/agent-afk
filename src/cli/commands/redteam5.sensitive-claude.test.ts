/**
 * Redteam 5 — item 2: .claude path segment coverage in sensitiveMarker.
 *
 * Verifies that every in-project path the agent reads definitions from is
 * marked sensitive, including the newly-added .claude segment (registry.ts:270
 * scans <cwd>/.claude/agents/).  All assertions should PASS on current code.
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { sensitiveMarker, AGENT_MARKER } from './acp.permission.sensitive.js';

const BASE = '/workspace/session';
const p = path.posix;

describe('redteam5: .claude segment coverage in sensitiveMarker', () => {
  it('.claude/agents/ path is AGENT_MARKER', () => {
    expect(sensitiveMarker('.claude/agents/research.md', BASE, p)).toBe(AGENT_MARKER);
  });

  it('.claude/commands/ path is AGENT_MARKER', () => {
    expect(sensitiveMarker('.claude/commands/evil.md', BASE, p)).toBe(AGENT_MARKER);
  });

  it('nested .claude/x/y/z path is AGENT_MARKER', () => {
    expect(sensitiveMarker('.claude/x/y/z.ts', BASE, p)).toBe(AGENT_MARKER);
  });

  it('absolute path with .claude segment is AGENT_MARKER', () => {
    expect(sensitiveMarker(`${BASE}/.claude/agents/x.md`, BASE, p)).toBe(AGENT_MARKER);
  });

  it('.afk/agents/ path is AGENT_MARKER (pre-existing)', () => {
    expect(sensitiveMarker('.afk/agents/my-agent.md', BASE, p)).toBe(AGENT_MARKER);
  });

  it('AFK.md is AGENT_MARKER (pre-existing)', () => {
    expect(sensitiveMarker('AFK.md', BASE, p)).toBe(AGENT_MARKER);
  });

  it('ordinary file is not sensitive', () => {
    expect(sensitiveMarker('src/index.ts', BASE, p)).toBe('');
  });
});
