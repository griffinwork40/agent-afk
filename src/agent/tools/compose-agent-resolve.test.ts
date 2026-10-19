/**
 * Tests for compose-agent-resolve.ts
 *
 * Covers the leaf-invariant enforcement added in #3583: executor-backed tools
 * (`agent`, `skill`) are stripped from compose-node allowlists, and `compose`
 * is absent from CHILD_ALLOWED_TOOLS entirely.
 */

import { describe, expect, it } from 'vitest';
import { CHILD_ALLOWED_TOOLS } from './nesting.js';
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
  // COMPOSE_LEAF_STRIPPED_TOOLS membership and undefined/unknown-type cases
  // are covered exhaustively in compose-leaf-tool-strip.test.ts.
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

  it('names the exact allowed tools after generic guidance for restricted compose nodes', () => {
    const resolved = resolveComposeNodeAgent('test-agent', makeRegistry(['read_file', 'grep']));
    const prompt = resolveComposeAgentPrompt(resolved, 'generic guidance to use bash and workspace_query');
    expect(prompt).toContain('This compose node can use only these tools:');
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('grep');
    expect(prompt).toContain('Do not call bash, workspace_query, or other tools unless they appear in this list');
    expect(resolved.namedAgentAllowedTools).not.toContain('bash');
  });

  it('does not discourage bash when the named agent grants it', () => {
    const resolved = resolveComposeNodeAgent('test-agent', makeRegistry(['read_file', 'bash']));
    const prompt = resolveComposeAgentPrompt(resolved, 'base');
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('bash');
    // #4012: the suffix must NOT name bash as a forbidden tool when it is allowed.
    expect(prompt).not.toMatch(/Do not call bash/);
  });

  it('does not discourage workspace_query when the named agent grants it', () => {
    const resolved = resolveComposeNodeAgent('test-agent', makeRegistry(['read_file', 'workspace_query']));
    const prompt = resolveComposeAgentPrompt(resolved, 'base');
    // workspace_query must appear in the allowed-tools list.
    expect(resolved.namedAgentAllowedTools).toContain('workspace_query');
    expect(prompt).toContain('workspace_query');
    // #4012: workspace_query must not appear in the forbidden-tools clause
    // (e.g. 'Do not call bash, workspace_query, ...').
    expect(prompt).not.toMatch(/Do not call[^.]*workspace_query/);
  });

  it('names both bash and workspace_query as forbidden when neither is granted', () => {
    const resolved = resolveComposeNodeAgent('test-agent', makeRegistry(['read_file', 'grep']));
    const prompt = resolveComposeAgentPrompt(resolved, 'base');
    expect(prompt).toContain('Do not call bash, workspace_query, or other tools unless they appear in this list');
  });
  // undefined agent_type and unknown agent_type cases are covered in
  // compose-leaf-tool-strip.test.ts (returns {} / throws 'not found').
});

// #3754: `readOnly` mirrors the agent path's `childWriteCapable` (shared
// isChildWriteCapable predicate) and drives compose's dispatch-intent gate.
describe('resolveComposeNodeAgent — readOnly flag', () => {
  it('marks a read-only allowlist (no write tools, no bash) as readOnly', () => {
    expect(resolveComposeNodeAgent('test-agent', makeRegistry(['read_file', 'grep'])).readOnly).toBe(true);
  });

  it('does not mark an allowlist with write_file as readOnly', () => {
    expect(resolveComposeNodeAgent('test-agent', makeRegistry(['read_file', 'write_file'])).readOnly).toBeUndefined();
  });

  it('does not mark an allowlist with unrestricted bash as readOnly', () => {
    expect(resolveComposeNodeAgent('test-agent', makeRegistry(['read_file', 'bash'])).readOnly).toBeUndefined();
  });
});
