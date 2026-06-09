/**
 * Tests for the {@link buildRuntimeStateSource} factory. Verifies that the
 * source pulls fresh data on every call, coerces surface tags, and groups
 * MCP tools by server correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildRuntimeStateSource } from './runtime-source.js';
import { gatherWorkspace } from './workspace-source.js';
import type { AnthropicToolDef } from '../tools/types.js';
import type { RuntimeSubagents, RuntimeWorkspace } from './types.js';

// `getWorkspace()` delegates to the real `gatherWorkspace`, which spawns git
// subprocesses against the test's cwd — nondeterministic and slow. Mock it so
// the tests can assert the *call discipline* (fresh per read vs. frozen at
// construction) deterministically, without depending on a real repo.
vi.mock('./workspace-source.js', () => ({
  gatherWorkspace: vi.fn(),
}));

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

// --- getWorkspace ------------------------------------------------------------

describe('buildRuntimeStateSource.getWorkspace', () => {
  const ws = (dirtyCount: number): RuntimeWorkspace => ({
    branch: 'main',
    headSha: 'abc1234',
    dirty: dirtyCount > 0,
    dirtyCount,
    remoteUrl: 'git@github.com:acme/repo.git',
  });

  beforeEach(() => {
    vi.mocked(gatherWorkspace).mockReset();
  });

  it('recomputes workspace state on every call — not frozen at construction', () => {
    // Regression guard: getWorkspace() previously returned a single
    // construction-time snapshot, so the model saw a stale dirtyCount no matter
    // how many files changed mid-session. It must now pull fresh on each read,
    // mirroring the live getTools()/getSubagents() accessors.
    vi.mocked(gatherWorkspace)
      .mockReturnValueOnce(ws(0)) // clean at first orientation
      .mockReturnValueOnce(ws(3)); // 3 files written since

    const src = buildRuntimeStateSource(defaultDeps());

    expect(src.getWorkspace().dirtyCount).toBe(0);
    // The frozen implementation would still report 0 here — this is the line
    // that fails against the pre-unfreeze code.
    expect(src.getWorkspace().dirtyCount).toBe(3);
    expect(vi.mocked(gatherWorkspace)).toHaveBeenCalledTimes(2);
  });

  it('does not gather eagerly at construction (no spawn until first read)', () => {
    vi.mocked(gatherWorkspace).mockReturnValue(ws(0));
    buildRuntimeStateSource(defaultDeps());
    // The old code spawned 4 git processes at construction even if no one ever
    // read the workspace. The unfrozen version is lazy.
    expect(vi.mocked(gatherWorkspace)).not.toHaveBeenCalled();
  });

  it('passes deps.cwd through to gatherWorkspace on each read', () => {
    vi.mocked(gatherWorkspace).mockReturnValue(ws(0));
    const src = buildRuntimeStateSource({ ...defaultDeps(), cwd: '/custom/work' });
    src.getWorkspace();
    expect(vi.mocked(gatherWorkspace)).toHaveBeenCalledWith('/custom/work');
  });
});
