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

  it('maps Agent(...) to the agent tool and captures the paren scope', () => {
    const resolved = resolveAgentToolAccess(
      // parseToolsField comma-splits `Agent(worker, researcher)` into fragments
      agent({ tools: ['Agent(worker', 'researcher)', 'Read'] }),
      POOL,
    );
    expect(resolved.allowedTools).toEqual(['agent', 'read_file']);
    expect(resolved.droppedTokens).toEqual([]); // fragments are not fail-closed noise
    // The paren content is no longer ignored — it becomes the nested-dispatch scope.
    expect(resolved.nestedAgentTypes).toEqual(['worker', 'researcher']);
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

describe('resolveAgentToolAccess — nested-dispatch scope', () => {
  it('captures a single scoped Agent(x) grant as nestedAgentTypes', () => {
    const resolved = resolveAgentToolAccess(
      agent({ tools: ['Read', 'Grep', 'Agent(git-investigator)'] }),
      POOL,
    );
    expect(resolved.allowedTools).toEqual(['read_file', 'grep', 'agent']);
    expect(resolved.nestedAgentTypes).toEqual(['git-investigator']);
  });

  it('treats a bare Agent grant as unrestricted (nestedAgentTypes undefined)', () => {
    const resolved = resolveAgentToolAccess(agent({ tools: ['Read', 'Agent'] }), POOL);
    expect(resolved.allowedTools).toEqual(['read_file', 'agent']);
    expect(resolved.nestedAgentTypes).toBeUndefined();
  });

  it('treats an EMPTY paren group Agent() as deny-all (nestedAgentTypes [], not undefined)', () => {
    // Regression guard (fail-open → fail-closed): `Agent()` grants the dispatch
    // tool but names zero types. It MUST resolve to [] (deny-all), NOT undefined
    // (unrestricted) — the opposite of a safe default. The distinction is what
    // the executor gate keys on: [] rejects every nested dispatch.
    const resolved = resolveAgentToolAccess(agent({ tools: ['Read', 'Agent()'] }), POOL);
    expect(resolved.allowedTools).toEqual(['read_file', 'agent']);
    expect(resolved.nestedAgentTypes).toEqual([]);
    expect(resolved.nestedAgentTypes).not.toBeUndefined();
  });

  it('treats Task() (empty parens) as deny-all too', () => {
    const resolved = resolveAgentToolAccess(agent({ tools: ['Task()'] }), POOL);
    expect(resolved.allowedTools).toEqual(['agent']);
    expect(resolved.nestedAgentTypes).toEqual([]);
  });

  it('treats a whitespace-only paren group Agent(   ) as deny-all', () => {
    const resolved = resolveAgentToolAccess(agent({ tools: ['Agent(   )'] }), POOL);
    expect(resolved.allowedTools).toEqual(['agent']);
    expect(resolved.nestedAgentTypes).toEqual([]);
  });

  it('lets a bare token win over an empty paren group (unrestricted, not deny-all)', () => {
    // Widest grant governs: bare `Agent` beats `Agent()` → undefined, not [].
    const resolved = resolveAgentToolAccess(agent({ tools: ['Agent()', 'Agent'] }), POOL);
    expect(resolved.allowedTools).toEqual(['agent']);
    expect(resolved.nestedAgentTypes).toBeUndefined();
  });

  it('lets a scoped name win over an empty paren group (named, not deny-all)', () => {
    // A real name anywhere makes the grant a named restriction, not deny-all.
    const resolved = resolveAgentToolAccess(agent({ tools: ['Agent()', 'Agent(worker)'] }), POOL);
    expect(resolved.allowedTools).toEqual(['agent']);
    expect(resolved.nestedAgentTypes).toEqual(['worker']);
  });

  it('treats Task the same as Agent for scope capture', () => {
    const resolved = resolveAgentToolAccess(agent({ tools: ['Task(worker)'] }), POOL);
    expect(resolved.allowedTools).toEqual(['agent']);
    expect(resolved.nestedAgentTypes).toEqual(['worker']);
  });

  it('lets the widest grant win: a bare token alongside a scoped one is unrestricted', () => {
    const resolved = resolveAgentToolAccess(
      agent({ tools: ['Agent', 'Task(only-this)'] }),
      POOL,
    );
    expect(resolved.allowedTools).toEqual(['agent']);
    expect(resolved.nestedAgentTypes).toBeUndefined();
  });

  it('leaves nestedAgentTypes undefined when no dispatch tool is granted', () => {
    const resolved = resolveAgentToolAccess(agent({ tools: ['Read', 'Grep'] }), POOL);
    expect(resolved.nestedAgentTypes).toBeUndefined();
  });

  it('drops the scope when the agent tool is denied out of the effective surface', () => {
    // Scoped grant present, but disallowedTools removes `agent` — a scope on an
    // agent that cannot dispatch is inert, so it is not surfaced.
    const resolved = resolveAgentToolAccess(
      agent({ tools: ['Read', 'Agent(git-investigator)'], disallowedTools: ['Agent'] }),
      POOL,
    );
    expect(resolved.allowedTools).toEqual(['read_file']);
    expect(resolved.nestedAgentTypes).toBeUndefined();
  });

  it('leaves nestedAgentTypes undefined for inherit-all (no tools field)', () => {
    const resolved = resolveAgentToolAccess(agent({}), POOL);
    expect(resolved.allowedTools).toBeUndefined();
    expect(resolved.nestedAgentTypes).toBeUndefined();
  });
});
