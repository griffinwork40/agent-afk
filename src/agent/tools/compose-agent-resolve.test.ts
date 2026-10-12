/**
 * Tests for compose-agent-resolve.ts
 *
 * Covers the leaf-invariant enforcement added in #3583: executor-backed tools
 * (`agent`, `skill`) are stripped from compose-node allowlists, and `compose`
 * is absent from CHILD_ALLOWED_TOOLS entirely.
 */

import { describe, expect, it } from 'vitest';
import { CHILD_ALLOWED_TOOLS, COMPOSE_LEAF_STRIPPED_TOOLS } from './nesting.js';
import {
  resolveComposeNodeAgent,
  resolveComposeAgentPrompt,
  COMPOSE_LEAF_NOTICE,
} from './compose-agent-resolve.js';
import type { AgentRegistry, RegisteredAgent } from '../agents/index.js';

// ---------------------------------------------------------------------------
// Invariant: 'compose' is absent from CHILD_ALLOWED_TOOLS
// This is the structural guard described in nesting.ts that keeps compose
// nodes from spawning nested DAGs. If this assertion ever fails, the comment
// block above CHILD_ALLOWED_TOOLS must be updated together with the fix.
// ---------------------------------------------------------------------------
describe('CHILD_ALLOWED_TOOLS invariant', () => {
  it('does not contain "compose"', () => {
    expect(CHILD_ALLOWED_TOOLS).not.toContain('compose');
  });

  it('COMPOSE_LEAF_STRIPPED_TOOLS contains "agent" and "skill"', () => {
    expect(COMPOSE_LEAF_STRIPPED_TOOLS.has('agent')).toBe(true);
    expect(COMPOSE_LEAF_STRIPPED_TOOLS.has('skill')).toBe(true);
  });

  it('COMPOSE_LEAF_STRIPPED_TOOLS does not contain "compose" (it is absent from CHILD_ALLOWED_TOOLS already)', () => {
    // compose is blocked upstream (absent from CHILD_ALLOWED_TOOLS), so it
    // needs no entry in COMPOSE_LEAF_STRIPPED_TOOLS.
    expect(COMPOSE_LEAF_STRIPPED_TOOLS.has('compose')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveComposeNodeAgent: stripping of executor-backed tools
// ---------------------------------------------------------------------------

function makeRegistry(tools: string[]): AgentRegistry {
  const agent: RegisteredAgent = {
    name: 'test-agent',
    definition: {
      prompt: 'do some work',
      model: 'sonnet',
      tools,
    },
    source: 'test',
  };
  return new Map([['test-agent', agent]]);
}

describe('resolveComposeNodeAgent — executor-backed tool stripping', () => {
  it('strips "agent" from the named agent allowlist', () => {
    const registry = makeRegistry([...CHILD_ALLOWED_TOOLS, 'agent']);
    const resolved = resolveComposeNodeAgent('test-agent', registry);
    expect(resolved.namedAgentAllowedTools).not.toContain('agent');
  });

  it('strips "skill" from the named agent allowlist', () => {
    const registry = makeRegistry([...CHILD_ALLOWED_TOOLS, 'skill']);
    const resolved = resolveComposeNodeAgent('test-agent', registry);
    expect(resolved.namedAgentAllowedTools).not.toContain('skill');
  });

  it('appends the leaf notice to the system prompt when tools are stripped', () => {
    const registry = makeRegistry(['read_file', 'agent']);
    const resolved = resolveComposeNodeAgent('test-agent', registry);
    expect(resolved.leafNotice).toBe(COMPOSE_LEAF_NOTICE);
    const prompt = resolveComposeAgentPrompt(resolved, 'base');
    expect(prompt).toContain(COMPOSE_LEAF_NOTICE);
  });

  it('does not append the leaf notice when no executor-backed tools were declared', () => {
    const registry = makeRegistry(['read_file', 'bash']);
    const resolved = resolveComposeNodeAgent('test-agent', registry);
    expect(resolved.leafNotice).toBeUndefined();
  });

  it('returns empty object when agentType is undefined', () => {
    expect(resolveComposeNodeAgent(undefined, new Map())).toEqual({});
  });

  it('throws on unknown agentType with available-agent list', () => {
    const registry = makeRegistry(['read_file']);
    expect(() => resolveComposeNodeAgent('no-such-agent', registry)).toThrow('not found');
  });
});
