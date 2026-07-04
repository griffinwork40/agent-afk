/**
 * Tests for named-agent tool-access resolution (Claude Code semantics).
 */

import { describe, expect, it } from 'vitest';
import { resolveAgentToolAccess } from './resolve.js';
import type { RegisteredAgent } from './types.js';

const POOL = ['read_file', 'grep', 'glob', 'bash', 'write_file', 'edit_file', 'agent', 'skill'];

function agent(overrides: {
  tools?: string[];
  disallowedTools?: string[];
  bashReadOnly?: boolean;
}): RegisteredAgent {
  return {
    name: 'test-agent',
    source: 'builtin',
    definition: {
      description: 'd',
      prompt: 'p',
      ...(overrides.tools !== undefined ? { tools: overrides.tools } : {}),
      ...(overrides.disallowedTools !== undefined
        ? { disallowedTools: overrides.disallowedTools }
        : {}),
    },
    ...(overrides.bashReadOnly === true ? { bashReadOnly: true } : {}),
  };
}

describe('resolveAgentToolAccess', () => {
  it('maps PascalCase Claude Code names to AFK runtime names', () => {
    const resolved = resolveAgentToolAccess(
      agent({ tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'] }),
      POOL,
    );
    expect(resolved.allowedTools).toEqual(['read_file', 'grep', 'glob', 'web_scrape']);
    expect(resolved.droppedTokens).toEqual([]);
  });

  it('returns undefined allowlist (inherit-all) when tools is omitted', () => {
    const resolved = resolveAgentToolAccess(agent({}), POOL);
    expect(resolved.allowedTools).toBeUndefined();
  });

  it('maps Task/Agent to agent and Skill to skill (opt-in nesting)', () => {
    const resolved = resolveAgentToolAccess(agent({ tools: ['Task', 'Skill', 'Read'] }), POOL);
    expect(resolved.allowedTools).toEqual(['agent', 'skill', 'read_file']);
  });

  it('strips Agent(...) paren groups and ignores their fragments silently', () => {
    const resolved = resolveAgentToolAccess(
      // parseToolsField comma-splits `Agent(worker, researcher)` into fragments
      agent({ tools: ['Agent(worker', 'researcher)', 'Read'] }),
      POOL,
    );
    expect(resolved.allowedTools).toEqual(['agent', 'read_file']);
    expect(resolved.droppedTokens).toEqual([]); // fragments are not fail-closed noise
  });

  it('drops unknown tokens fail-closed and reports them', () => {
    const resolved = resolveAgentToolAccess(
      agent({ tools: ['Read', 'NotebookEdit', 'FrobnicateTool'] }),
      POOL,
    );
    expect(resolved.allowedTools).toEqual(['read_file']);
    expect(resolved.droppedTokens).toEqual(['NotebookEdit', 'FrobnicateTool']);
  });

  it('passes mcp__* tokens through verbatim', () => {
    const resolved = resolveAgentToolAccess(
      agent({ tools: ['Read', 'mcp__github__get_issue'] }),
      POOL,
    );
    expect(resolved.allowedTools).toEqual(['read_file', 'mcp__github__get_issue']);
  });

  it('applies disallowedTools against the inherit pool when tools is omitted', () => {
    const resolved = resolveAgentToolAccess(
      agent({ disallowedTools: ['Write', 'Edit'] }),
      POOL,
    );
    expect(resolved.allowedTools).toEqual([
      'read_file',
      'grep',
      'glob',
      'bash',
      'agent',
      'skill',
    ]);
  });

  it('applies deny-first when both lists are present (tool in both is removed)', () => {
    const resolved = resolveAgentToolAccess(
      agent({ tools: ['Read', 'Bash', 'Write'], disallowedTools: ['Bash'] }),
      POOL,
    );
    expect(resolved.allowedTools).toEqual(['read_file', 'write_file']);
  });

  it('deduplicates repeated tokens', () => {
    const resolved = resolveAgentToolAccess(
      agent({ tools: ['Read', 'read_file', 'Read'] }),
      POOL,
    );
    expect(resolved.allowedTools).toEqual(['read_file']);
  });

  it('carries bashReadOnly from the registration', () => {
    expect(resolveAgentToolAccess(agent({ bashReadOnly: true }), POOL).bashReadOnly).toBe(true);
    expect(resolveAgentToolAccess(agent({}), POOL).bashReadOnly).toBe(false);
  });
});
