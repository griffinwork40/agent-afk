/**
 * Tests for the {@link buildRuntimeStateSource} factory. Verifies that the
 * source pulls fresh data on every call, coerces surface tags, and groups
 * MCP tools by server correctly.
 */

import { describe, it, expect } from 'vitest';
import { buildRuntimeStateSource } from './runtime-source.js';
import type { AnthropicToolDef } from '../tools/types.js';
import type { RuntimeSubagents } from './types.js';

// --- Fixture builders --------------------------------------------------------

function defaultDeps() {
  return {
    surface: 'cli',
    cwd: '/work',
    modelName: 'sonnet',
    providerName: 'anthropic-direct',
    permissionMode: 'default',
    getEnabledToolNames: () => ['bash', 'read_file'],
    getMcpTools: () => [] as AnthropicToolDef[],
    getSubagents: () => ({ active: [], backgroundJobs: [] }) as RuntimeSubagents,
  };
}

function mcpTool(name: string): AnthropicToolDef {
  return {
    name,
    category: 'other',
    concurrencySafe: true,
    description: '',
    input_schema: { type: 'object', properties: {}, required: [] },
  };
}

// --- getSelf -----------------------------------------------------------------

describe('buildRuntimeStateSource.getSelf', () => {
  it('returns nulls for unset identity fields at top level', () => {
    const src = buildRuntimeStateSource(defaultDeps());
    const self = src.getSelf();
    expect(self.sessionId).toBeNull();
    expect(self.parentSessionId).toBeNull();
    expect(self.depth).toBeNull();
    expect(self.maxDepth).toBeNull();
    expect(self.phaseRole).toBeNull();
  });

  it('populates identity fields when supplied', () => {
    const src = buildRuntimeStateSource({
      ...defaultDeps(),
      sessionId: 'abc-123',
      parentSessionId: 'parent-uuid',
      depth: 2,
      maxDepth: 3,
      phaseRole: 'read-only',
    });
    const self = src.getSelf();
    expect(self.sessionId).toBe('abc-123');
    expect(self.parentSessionId).toBe('parent-uuid');
    expect(self.depth).toBe(2);
    expect(self.maxDepth).toBe(3);
    expect(self.phaseRole).toBe('read-only');
  });

  it('coerces known surface strings to the typed union', () => {
    for (const s of ['cli', 'repl', 'daemon', 'telegram', 'subagent']) {
      const src = buildRuntimeStateSource({ ...defaultDeps(), surface: s });
      expect(src.getSelf().surface).toBe(s);
    }
  });

  it('coerces unknown surface strings to "unknown"', () => {
    const src = buildRuntimeStateSource({ ...defaultDeps(), surface: 'wat' });
    expect(src.getSelf().surface).toBe('unknown');
  });

  it('embeds provider + model in the model field', () => {
    const src = buildRuntimeStateSource({
      ...defaultDeps(),
      providerName: 'openai-compatible',
      modelName: 'gpt-4o',
    });
    expect(src.getSelf().model).toEqual({
      provider: 'openai-compatible',
      name: 'gpt-4o',
    });
  });

  // ---------------------------------------------------------------------------
  // permissionMode bucketing — Phase 1 hardening against prompt-injection.
  //
  // External constraint: the snapshot must NOT leak the raw SDK permission
  // string verbatim. A prompt-injection attacker who triggers
  // get_runtime_state would otherwise confirm that the session is running
  // under `bypassPermissions` (or any other auto-accept variant), useful
  // attestation for a follow-up exfiltration prompt. Bucketing to a coarse
  // `'elevated' | 'default'` union hides the raw token while preserving the
  // useful coarse signal the model legitimately needs for orientation.
  // ---------------------------------------------------------------------------
  describe('permissionMode bucketing', () => {
    function selfFor(raw: string): string {
      return buildRuntimeStateSource({
        ...defaultDeps(),
        permissionMode: raw,
      }).getSelf().permissionMode;
    }

    it("collapses 'bypassPermissions' to 'elevated' (does not leak the raw token)", () => {
      expect(selfFor('bypassPermissions')).toBe('elevated');
    });

    it("collapses other auto-accept variants to 'elevated'", () => {
      expect(selfFor('acceptEdits')).toBe('elevated');
      expect(selfFor('dontAsk')).toBe('elevated');
      expect(selfFor('auto')).toBe('elevated');
    });

    it("maps 'default' to 'default'", () => {
      expect(selfFor('default')).toBe('default');
    });

    it("maps 'plan' to 'default' (restrictiveness shows up via real-time denials, not this field)", () => {
      expect(selfFor('plan')).toBe('default');
    });

    it("maps unrecognised values to 'default' (closed mapping, no raw leak)", () => {
      expect(selfFor('')).toBe('default');
      expect(selfFor('experimentalLooseMode')).toBe('default');
    });
  });
});

// --- getTools ----------------------------------------------------------------

describe('buildRuntimeStateSource.getTools', () => {
  it('pulls live tool names through the accessor', () => {
    let names: string[] = ['a', 'b'];
    const src = buildRuntimeStateSource({
      ...defaultDeps(),
      getEnabledToolNames: () => names,
    });
    expect(src.getTools().enabled).toEqual(['a', 'b']);
    names = ['c'];
    expect(src.getTools().enabled).toEqual(['c']);
  });

  it('summarizes MCP servers by parsing the mcp__server__tool naming convention', () => {
    const src = buildRuntimeStateSource({
      ...defaultDeps(),
      getMcpTools: () => [
        mcpTool('mcp__filesystem__read'),
        mcpTool('mcp__filesystem__write'),
        mcpTool('mcp__github__list_repos'),
      ],
    });
    expect(src.getTools().mcpServers).toEqual([
      { name: 'filesystem', toolCount: 2 },
      { name: 'github', toolCount: 1 },
    ]);
  });

  it('returns mcpServers in stable alphabetical order regardless of input order', () => {
    const src = buildRuntimeStateSource({
      ...defaultDeps(),
      getMcpTools: () => [
        mcpTool('mcp__zulip__send'),
        mcpTool('mcp__alpha__one'),
        mcpTool('mcp__alpha__two'),
        mcpTool('mcp__mid__only'),
      ],
    });
    expect(src.getTools().mcpServers.map((s) => s.name)).toEqual([
      'alpha',
      'mid',
      'zulip',
    ]);
  });

  it('skips non-MCP tools and malformed mcp tool names silently', () => {
    const src = buildRuntimeStateSource({
      ...defaultDeps(),
      getMcpTools: () => [
        mcpTool('bash'), // not mcp-prefixed → ignored
        mcpTool('mcp__'), // malformed → ignored
        mcpTool('mcp__server'), // missing tool segment → ignored
        mcpTool('mcp____tool'), // empty server segment → ignored
        mcpTool('mcp__ok__tool'),
      ],
    });
    expect(src.getTools().mcpServers).toEqual([
      { name: 'ok', toolCount: 1 },
    ]);
  });

  it('returns empty mcpServers list when no MCP tools are wired', () => {
    const src = buildRuntimeStateSource(defaultDeps());
    expect(src.getTools().mcpServers).toEqual([]);
  });
});

// --- getSubagents ------------------------------------------------------------

describe('buildRuntimeStateSource.getSubagents', () => {
  it('forwards the accessor result verbatim', () => {
    const subagents: RuntimeSubagents = {
      active: [{ id: 'forge-1', status: 'running' }],
      backgroundJobs: [
        {
          jobId: 'bg-abc-1',
          status: 'running',
          startedAt: '2026-05-27T10:00:00.000Z',
          label: 'investigation',
        },
      ],
    };
    const src = buildRuntimeStateSource({
      ...defaultDeps(),
      getSubagents: () => subagents,
    });
    expect(src.getSubagents()).toEqual(subagents);
  });

  it('returns empty result shape when no subagent executor is wired', () => {
    const src = buildRuntimeStateSource(defaultDeps());
    expect(src.getSubagents()).toEqual({ active: [], backgroundJobs: [] });
  });
});
