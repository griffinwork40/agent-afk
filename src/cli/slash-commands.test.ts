/**
 * Tests for the slash-command handlers (core + info + plugin-skills bridge).
 *
 * Each test registers the command under test via the real registry and
 * exercises dispatch. Session surfaces are stubbed with just enough of
 * AgentSession's public API to satisfy the handler.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registerAll } from './slash/index.js';
import { dispatch, list, resetRegistry, lookup } from './slash/registry.js';
import {
  registerPluginSkills,
  autoRegisterPluginPassthroughs,
} from './slash/plugin-skills.js';
import { registerPluginAgents } from './slash/plugin-agents.js';
import type { SlashContext, SessionStats } from './slash/types.js';

function makeStats(): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    planMode: false,
  };
}

interface FakeSession {
  sendMessage: ReturnType<typeof vi.fn>;
  sendMessageStream: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  waitForInitialization: ReturnType<typeof vi.fn>;
  supportedCommands: ReturnType<typeof vi.fn>;
  supportedAgents: ReturnType<typeof vi.fn>;
  getContextUsage: ReturnType<typeof vi.fn>;
}

// Minimal async generator that emits nothing (simulates an empty session stream).
async function* emptyStream() { /* no events */ }

function fakeSession(overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    sendMessage: vi.fn().mockResolvedValue({ content: 'ok' }),
    // Plugin skill handlers call sendMessageStream instead of sendMessage.
    sendMessageStream: vi.fn().mockImplementation(() => emptyStream()),
    interrupt: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    waitForInitialization: vi.fn().mockResolvedValue({ tools: ['Read', 'Edit'], mcpServers: [] }),
    supportedCommands: vi.fn().mockResolvedValue([]),
    supportedAgents: vi.fn().mockResolvedValue([]),
    // Default: reject so tests that don't opt-in exercise the local-stats
    // fallback path. Individual tests override with mockResolvedValue to
    // exercise the SDK-breakdown path.
    getContextUsage: vi.fn().mockRejectedValue(new Error('subprocess not ready')),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<SlashContext> = {}): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: (overrides.session ?? { current: fakeSession() }) as unknown as SlashContext['session'],
    stats: overrides.stats ?? makeStats(),
    out: {
      line: (t = '') => lines.push(t),
      raw: (t) => lines.push(t),
      success: (t) => lines.push(`SUCCESS:${t}`),
      info: (t) => lines.push(`INFO:${t}`),
      warn: (t) => lines.push(`WARN:${t}`),
      error: (t) => lines.push(`ERROR:${t}`),
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  };
  return { ctx, lines };
}

describe('slash commands — registration', () => {
  // Lock the internal tier (AFK_INTERNAL not '1') before registerAll() so the
  // audience gate — read at registration time inside registerBuiltinSkillCommands
  // — hides internal skills like /audit-fit regardless of the shell environment
  // (a maintainer machine may export AFK_INTERNAL=1 via ~/.afk/config/afk.env).
  // Mirrors the hermetic pattern in skill-bridge.test.ts / loading-tips.test.ts.
  beforeEach(() => {
    resetRegistry();
    vi.stubEnv('AFK_INTERNAL', '');
    registerAll();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('registers every Tier-1 + Tier-3 command at bootstrap', () => {
    const names = list().map((c) => c.name);
    for (const expected of [
      '/exit', '/clear', '/compact', '/help',
      '/cost', '/tokens', '/history', '/reset', '/model', '/tools', '/mcp', '/limits',
      '/plan', '/todo',
      '/skills', '/reload-plugins', '/agents',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('/quit is an alias for /exit', () => {
    expect(lookup('/quit')?.name).toBe('/exit');
  });

  it('registers public built-in TS skills as immediate handlers at bootstrap', () => {
    const names = list().map((c) => c.name);
    // Public-tier skills must be visible by default.
    for (const skill of ['/mint', '/diagnose']) {
      expect(names).toContain(skill);
    }
    // Internal-tier skills (audit-fit) MUST be hidden without
    // AFK_INTERNAL=1. The slash registry receives the filtered subset
    // — see src/cli/slash/builtin-skills.ts `registerBuiltinSkillCommands`.
    expect(names).not.toContain('/audit-fit');
  });

  it('plugin passthrough does not overwrite core commands like /clear', async () => {
    const session = fakeSession({
      supportedCommands: vi.fn().mockResolvedValue([
        { name: 'clear', description: 'SDK built-in clear' },
        { name: 'exit', description: 'SDK built-in exit' },
        { name: 'mint', description: 'Plugin skill' },
      ]),
    });
    await registerPluginSkills(session as unknown as SlashContext['session']);

    const { ctx, lines } = makeCtx({
      session: {
        current: {
          ...fakeSession(),
          reset: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as SlashContext['session'],
    });
    const result = await dispatch('/clear', ctx);
    expect(result.handled).toBe(true);
    expect(lines.join('\n')).toContain('Conversation history cleared');

    expect(lookup('/mint')).toBeDefined();
  });
});

describe('/help', () => {
  beforeEach(() => { resetRegistry(); registerAll(); });

  it('prints a section listing all registered commands', async () => {
    const { ctx, lines } = makeCtx();
    await dispatch('/help', ctx);
    const joined = lines.join('\n');
    expect(joined).toContain('/cost');
    expect(joined).toContain('/model');
    expect(joined).toContain('/plan');
  });
});

describe('/cost + /tokens', () => {
  beforeEach(() => { resetRegistry(); registerAll(); });

  it('/cost reports totals and per-turn breakdown', async () => {
    const stats = makeStats();
    stats.totalTurns = 3;
    stats.totalCostUsd = 0.15;
    stats.turnCosts.push(0.05, 0.04, 0.06);
    const { ctx, lines } = makeCtx({ stats });
    await dispatch('/cost', ctx);
    const joined = lines.join('\n');
    expect(joined).toContain('total');
    expect(joined).toContain('turns');
    expect(joined).toContain('3');
    expect(joined).toMatch(/\$0\.1[45]/);
  });

  it('/tokens splits input / output / cache (local-stats fallback)', async () => {
    const stats = makeStats();
    stats.turnTokens.push({ input: 1000, output: 500, cache: 2000 });
    const { ctx, lines } = makeCtx({ stats });
    await dispatch('/tokens', ctx);
    const joined = lines.join('\n');
    expect(joined).toContain('input');
    expect(joined).toContain('output');
    expect(joined).toContain('cache');
  });

  it('/tokens calls session.getContextUsage and renders SDK breakdown', async () => {
    const sess = fakeSession({
      getContextUsage: vi.fn().mockResolvedValue({
        categories: [
          { name: 'Messages', tokens: 5000, color: 'blue' },
          { name: 'System Prompt', tokens: 2000, color: 'green' },
        ],
        totalTokens: 7000,
        maxTokens: 200000,
        rawMaxTokens: 200000,
        percentage: 3.5,
        gridRows: [],
        model: 'claude-sonnet-4',
        memoryFiles: [],
        mcpTools: [{ name: 'fetch', serverName: 'web', tokens: 150 }],
        systemTools: [{ name: 'Bash', tokens: 1200 }, { name: 'Read', tokens: 800 }],
        agents: [{ agentType: 'research', source: 'plugin', tokens: 400 }],
        systemPromptSections: [{ name: 'core', tokens: 900 }],
        slashCommands: { totalCommands: 5, includedCommands: 5, tokens: 100 },
        skills: {
          totalSkills: 7,
          includedSkills: 7,
          tokens: 250,
          skillFrontmatter: [],
        },
        isAutoCompactEnabled: true,
        autoCompactThreshold: 150_000,
        apiUsage: {
          input_tokens: 1500,
          output_tokens: 700,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 3000,
        },
      }),
    });
    const { ctx, lines } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'] });
    await dispatch('/tokens', ctx);
    const joined = lines.join('\n');
    expect(sess.getContextUsage).toHaveBeenCalledTimes(1);
    expect(joined).toContain('Messages');           // top category
    expect(joined).toContain('System Prompt');      // top category
    expect(joined).toContain('system tools');       // summary line
    expect(joined).toContain('MCP tools');          // summary line
    expect(joined).toContain('agents');             // summary line
    expect(joined).toContain('skills');             // summary line
    expect(joined).toMatch(/\d+(\.\d+)?%/);
  });

  it('/tokens falls back to local stats when getContextUsage() rejects', async () => {
    const stats = makeStats();
    stats.turnTokens.push({ input: 1000, output: 500, cache: 2000 });
    const sess = fakeSession({
      getContextUsage: vi.fn().mockRejectedValue(new Error('subprocess not ready')),
    });
    const { ctx, lines } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'], stats });
    await dispatch('/tokens', ctx);
    const joined = lines.join('\n');
    // Fallback path renders the local-stats breakdown.
    expect(joined).toContain('input');
    expect(joined).toContain('output');
    expect(joined).toContain('cache');
  });

  it('/ctx is an alias for /tokens', () => {
    expect(lookup('/ctx')?.name).toBe('/tokens');
  });

  it('/tokens handles malformed getContextUsage payload without crashing', async () => {
    const sess = fakeSession({
      // Minimal payload — renderer must tolerate empty categories/tools/etc.
      getContextUsage: vi.fn().mockResolvedValue({
        categories: [],
        totalTokens: 0,
        maxTokens: 200000,
        rawMaxTokens: 200000,
        percentage: 0,
        gridRows: [],
        model: 'claude-sonnet-4',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
        isAutoCompactEnabled: false,
        apiUsage: null,
      }),
    });
    const { ctx, lines } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'] });
    await expect(dispatch('/tokens', ctx)).resolves.toBeDefined();
    // Should still produce some output — even if sparse.
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe('/history', () => {
  beforeEach(() => { resetRegistry(); registerAll(); });

  it('prints info when empty', async () => {
    const { ctx, lines } = makeCtx();
    await dispatch('/history', ctx);
    expect(lines.join('\n')).toContain('No turns yet');
  });

  it('lists turns with user and assistant previews', async () => {
    const stats = makeStats();
    stats.turns.push(
      { user: 'hello', assistant: 'hi', timestamp: Date.now() },
      { user: 'thanks', assistant: 'welcome', timestamp: Date.now() },
    );
    const { ctx, lines } = makeCtx({ stats });
    await dispatch('/history', ctx);
    const joined = lines.join('\n');
    expect(joined).toContain('hello');
    expect(joined).toContain('welcome');
  });
});

describe('/model', () => {
  beforeEach(() => { resetRegistry(); registerAll(); });

  it('switches the model and updates stats', async () => {
    const sess = fakeSession();
    const { ctx } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'] });
    await dispatch('/model opus', ctx);
    expect(sess.setModel).toHaveBeenCalledWith('opus');
    expect(ctx.stats.model).toBe('opus');
    expect(ctx.ui.repaintStatusLine).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown model names', async () => {
    const sess = fakeSession();
    const { ctx, lines } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'] });
    await dispatch('/model frogsoup', ctx);
    expect(sess.setModel).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/WARN:.*frogsoup/);
  });

  it('accepts HF-style org/model ids (openai-compatible path)', async () => {
    const sess = fakeSession();
    const { ctx } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'] });
    await dispatch('/model mlx-community/Qwen3-30B-A3B-4bit', ctx);
    // setModel called with the lowercased id (args.trim().toLowerCase())
    expect(sess.setModel).toHaveBeenCalledWith('mlx-community/qwen3-30b-a3b-4bit');
  });

  it('shows current model when called with no args', async () => {
    const { ctx, lines } = makeCtx();
    await dispatch('/model', ctx);
    expect(lines.join('\n')).toMatch(/Current model|sonnet/);
  });
});

describe('/tools + /mcp', () => {
  beforeEach(() => { resetRegistry(); registerAll(); });

  it('/tools lists session tools', async () => {
    const sess = fakeSession({
      waitForInitialization: vi.fn().mockResolvedValue({ tools: ['Read', 'Edit', 'Grep'], mcpServers: [] }),
    });
    const { ctx, lines } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'] });
    await dispatch('/tools', ctx);
    const joined = lines.join('\n');
    expect(joined).toContain('Read');
    expect(joined).toContain('Edit');
    expect(joined).toContain('Grep');
  });

  it('/mcp lists MCP servers', async () => {
    const sess = fakeSession({
      waitForInitialization: vi.fn().mockResolvedValue({
        tools: [],
        mcpServers: [{ name: 'telegram', status: 'connected' }, { name: 'imessage', status: 'connected' }],
      }),
    });
    const { ctx, lines } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'] });
    await dispatch('/mcp', ctx);
    const joined = lines.join('\n');
    expect(joined).toContain('telegram');
    expect(joined).toContain('imessage');
  });

  it('/mcp shows info when no servers', async () => {
    const sess = fakeSession({
      waitForInitialization: vi.fn().mockResolvedValue({ tools: [], mcpServers: [] }),
    });
    const { ctx, lines } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'] });
    await dispatch('/mcp', ctx);
    expect(lines.join('\n')).toContain('No MCP servers');
  });
});

describe('/plan', () => {
  beforeEach(() => { resetRegistry(); registerAll(); });

  it('toggles plan mode ON via setPermissionMode("plan")', async () => {
    const sess = fakeSession();
    const { ctx } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'] });
    await dispatch('/plan on', ctx);
    expect(sess.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(ctx.stats.planMode).toBe(true);
    expect(ctx.ui.repaintStatusLine).toHaveBeenCalledTimes(1);
  });

  it('argless /plan from default mode enters plan mode immediately', async () => {
    const sess = fakeSession();
    const { ctx } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'] });
    const res = await dispatch('/plan', ctx);
    expect(ctx.stats.planMode).toBe(true);
    expect(res.result).toBe('continue');
  });

  it('/plan <free text> sets plan mode ON and returns submit form', async () => {
    const sess = fakeSession();
    const { ctx } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'] });
    const res = await dispatch('/plan list all files', ctx);
    expect(res.handled).toBe(true);
    expect(sess.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(ctx.stats.planMode).toBe(true);
    expect(res.result).toEqual({ kind: 'submit', message: 'list all files' });
  });

  it('/plan <free text> while already in plan mode returns submit without toggling off', async () => {
    const sess = fakeSession();
    const stats = makeStats();
    stats.planMode = true;
    const { ctx } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'], stats });
    const res = await dispatch('/plan list all files', ctx);
    expect(res.handled).toBe(true);
    // setPermissionMode should NOT be called again (already in plan mode)
    expect(sess.setPermissionMode).not.toHaveBeenCalled();
    expect(ctx.stats.planMode).toBe(true);
    expect(res.result).toEqual({ kind: 'submit', message: 'list all files' });
  });

  it('/plan on while default sets mode on and returns continue', async () => {
    const sess = fakeSession();
    const { ctx } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'] });
    const res = await dispatch('/plan on', ctx);
    expect(res.handled).toBe(true);
    expect(sess.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(res.result).toBe('continue');
  });

  // ───────── exit and implement ─────────

  describe('exit and implement', () => {
    function submitMessage(res: Awaited<ReturnType<typeof dispatch>>): string {
      return typeof res.result === 'object' && res.result !== null && 'kind' in res.result
        ? (res.result as { message: string }).message
        : '';
    }
    function submitKind(res: Awaited<ReturnType<typeof dispatch>>): string | null {
      return typeof res.result === 'object' && res.result !== null && 'kind' in res.result
        ? res.result.kind
        : null;
    }

    it('/plan off while in plan mode flips to default FIRST, then seeds a save-and-implement turn', async () => {
      const sess = fakeSession();
      const stats = makeStats();
      stats.planMode = true;
      const { ctx } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'], stats });

      const res = await dispatch('/plan off', ctx);

      // The flip MUST happen before the turn so writes are permitted when the
      // seeded message runs (the model has to write the plan file + implement).
      expect(sess.setPermissionMode).toHaveBeenCalledWith('default');
      expect(ctx.stats.planMode).toBe(false);

      // A submit turn is seeded.
      expect(res.handled).toBe(true);
      expect(submitKind(res)).toBe('submit');

      const message = submitMessage(res);
      const lower = message.toLowerCase();
      // Names the exit, the save step (under .afk/plans), and the implement step.
      expect(lower).toContain('switched off plan mode');
      expect(message).toContain('.afk/plans');
      expect(lower).toContain('save the plan');
      expect(lower).toContain('implement the plan');
    });

    it('bare /plan while in plan mode also exits and seeds save-and-implement', async () => {
      const sess = fakeSession();
      const stats = makeStats();
      stats.planMode = true;
      const { ctx } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'], stats });

      const res = await dispatch('/plan', ctx);

      expect(sess.setPermissionMode).toHaveBeenCalledWith('default');
      expect(ctx.stats.planMode).toBe(false);
      expect(submitKind(res)).toBe('submit');
      expect(submitMessage(res)).toContain('.afk/plans');
    });

    it('does NOT seed an implement turn when the flip fails (writes still refused)', async () => {
      // If setPermissionMode rejects, togglePlanMode leaves planMode true and
      // surfaces an error. Seeding an implement turn while writes are refused
      // would only produce gate refusals — so the handler returns 'continue'.
      const sess = fakeSession({
        setPermissionMode: vi.fn().mockRejectedValue(new Error('handle closing')),
      });
      const stats = makeStats();
      stats.planMode = true;
      const { ctx } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'], stats });

      const res = await dispatch('/plan off', ctx);

      expect(sess.setPermissionMode).toHaveBeenCalledWith('default');
      expect(ctx.stats.planMode).toBe(true);
      expect(res.result).toBe('continue');
    });

    it('/plan off from default mode is a plain no-op flip (no plan to save)', async () => {
      const sess = fakeSession();
      const { ctx } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'] });
      const res = await dispatch('/plan off', ctx);
      // togglePlanMode sets 'default' — already default, harmless, emits OFF copy.
      // No submit turn: there is no plan to save when not in plan mode.
      expect(sess.setPermissionMode).toHaveBeenCalledWith('default');
      expect(ctx.stats.planMode).toBe(false);
      expect(res.result).toBe('continue');
    });
  });
});

describe('plugin-skills bridge', () => {
  beforeEach(() => { resetRegistry(); registerAll(); });

  it('placeholder /skills before init renders registry skills under the unified header', async () => {
    // The unified `/skills` listing covers vendored + user + plugin sources.
    // Vendored skills register synchronously via the side-effect import in
    // `src/skills/all.js`, so the placeholder already has something to show
    // before plugin discovery completes — no more "still loading" message.
    const { ctx, lines } = makeCtx();
    await dispatch('/skills', ctx);
    const joined = lines.join('\n');
    expect(joined).toMatch(/Skills\b/);
    expect(joined).toContain('/mint');
  });

  it('registerPluginSkills() installs a forward handler for non-colliding plugin skills', async () => {
    // `mint` and `diagnose` collide with vendored skills, so the bare slash
    // forms still resolve to the vendored handlers. The plugin variants live
    // under their namespaced fallback (e.g. `/plugin:mint`).
    const sess = fakeSession({
      supportedCommands: vi.fn().mockResolvedValue([
        { name: 'mint', description: 'One-prompt feature delivery', argumentHint: '<idea>' },
        { name: 'diagnose', description: 'Parallel root-cause analysis', argumentHint: '' },
        { name: 'unique-plugin-skill', description: 'No collision here', argumentHint: '' },
      ]),
    });
    const count = await registerPluginSkills(sess as unknown as Parameters<typeof registerPluginSkills>[0]);
    expect(count).toBe(3);
    const names = list().map((c) => c.name);
    // Bare /mint and /diagnose are vendored — still in the registry, not overwritten.
    expect(names).toContain('/mint');
    expect(names).toContain('/diagnose');
    // Colliding plugin variants live under namespaced fallbacks.
    expect(names).toContain('/plugin:mint');
    expect(names).toContain('/plugin:diagnose');
    // Non-colliding plugin skill registers at its bare name.
    expect(names).toContain('/unique-plugin-skill');
  });

  it('plugin skill handler dispatches via skill-invocation payload (handled: true, not forward)', async () => {
    const sess = fakeSession({
      supportedCommands: vi.fn().mockResolvedValue([
        { name: 'mint', description: 'x', argumentHint: '' },
        { name: 'plugin-only', description: 'y', argumentHint: '' },
      ]),
    });
    await registerPluginSkills(sess as unknown as Parameters<typeof registerPluginSkills>[0]);
    const { ctx } = makeCtx({
      session: { current: sess } as unknown as SlashContext['session'],
    });
    // Bare /mint is vendored, so it dispatches the immediate handler — handled.
    const vendoredRes = await dispatch('/mint add dark mode', ctx);
    expect(vendoredRes.handled).toBe(true);
    // The shadowed plugin form now also dispatches via skill-invocation payload — handled.
    const altRes = await dispatch('/plugin:mint add dark mode', ctx);
    expect(altRes.handled).toBe(true);
    // Non-colliding plugin skills also dispatch via skill-invocation payload — handled.
    const uniqueRes = await dispatch('/plugin-only run', ctx);
    expect(uniqueRes.handled).toBe(true);
  });

  it('/skills after init surfaces shadowed plugins as inline "↳ also:" alternatives', async () => {
    const sess = fakeSession({
      supportedCommands: vi.fn().mockResolvedValue([
        { name: 'mint', description: 'One-prompt feature delivery', argumentHint: '' },
        { name: 'diagnose', description: 'Parallel root-cause analysis', argumentHint: '' },
      ]),
    });
    await registerPluginSkills(sess as unknown as Parameters<typeof registerPluginSkills>[0]);
    const { ctx, lines } = makeCtx();
    await dispatch('/skills', ctx);
    const joined = lines.join('\n');
    // Vendored mains still appear with their slash forms.
    expect(joined).toContain('/mint');
    expect(joined).toContain('/diagnose');
    // Shadowed plugin collisions surface inline as compact "↳ also:" references
    // to the namespaced fallback form — visible by default, not hidden.
    expect(joined).toContain('↳ also:');
    expect(joined).toContain('/plugin:mint');
    expect(joined).toContain('/plugin:diagnose');
    // The old raw "(plugin alt)" badge + duplicated alt description are gone.
    expect(joined).not.toContain('plugin alt');
  });

  it('registerPluginSkills() handles SDK errors gracefully and returns null', async () => {
    const sess = fakeSession({
      supportedCommands: vi.fn().mockRejectedValue(new Error('subprocess not ready')),
    });
    const count = await registerPluginSkills(sess as unknown as Parameters<typeof registerPluginSkills>[0]);
    expect(count).toBeNull();
  });
});

describe('plugin-agents bridge', () => {
  beforeEach(() => { resetRegistry(); registerAll(); });

  it('placeholder /agents before init tells the user to wait', async () => {
    const { ctx, lines } = makeCtx();
    await dispatch('/agents', ctx);
    expect(lines.join('\n')).toMatch(/still loading|session is ready/);
  });

  it('registerPluginAgents() returns the discovered count', async () => {
    const sess = fakeSession({
      supportedAgents: vi.fn().mockResolvedValue([
        { name: 'research-agent', description: 'Read-only research' },
        { name: 'code-reviewer', description: 'Review proposed code changes' },
      ]),
    });
    const count = await registerPluginAgents(sess as unknown as Parameters<typeof registerPluginAgents>[0]);
    expect(count).toBe(2);
  });

  it('/agents after init lists discovered agents with name and description', async () => {
    const sess = fakeSession({
      supportedAgents: vi.fn().mockResolvedValue([
        { name: 'research-agent', description: 'Read-only research with explicit citations', model: 'haiku' },
        { name: 'code-reviewer', description: 'Review proposed code changes' },
      ]),
    });
    await registerPluginAgents(sess as unknown as Parameters<typeof registerPluginAgents>[0]);
    const { ctx, lines } = makeCtx();
    await dispatch('/agents', ctx);
    const joined = lines.join('\n');
    expect(joined).toContain('research-agent');
    expect(joined).toContain('code-reviewer');
    expect(joined).toContain('Read-only research with explicit citations');
    expect(joined).toContain('haiku');
  });

  it('/agents without agents shows a friendly empty-state hint', async () => {
    const sess = fakeSession({
      supportedAgents: vi.fn().mockResolvedValue([]),
    });
    await registerPluginAgents(sess as unknown as Parameters<typeof registerPluginAgents>[0]);
    const { ctx, lines } = makeCtx();
    await dispatch('/agents', ctx);
    expect(lines.join('\n')).toMatch(/No plugin agents/);
  });

  it('registerPluginAgents() handles SDK rejection and returns null', async () => {
    const sess = fakeSession({
      supportedAgents: vi.fn().mockRejectedValue(new Error('subprocess not ready')),
    });
    const count = await registerPluginAgents(sess as unknown as Parameters<typeof registerPluginAgents>[0]);
    expect(count).toBeNull();
  });

  it('does NOT register agents as forward-slash commands at bootstrap or post-init', async () => {
    const sess = fakeSession({
      supportedAgents: vi.fn().mockResolvedValue([
        { name: 'research-agent', description: 'Read-only research' },
      ]),
    });
    await registerPluginAgents(sess as unknown as Parameters<typeof registerPluginAgents>[0]);
    // Agents are not user-invokable as slashes — they're Task-tool dispatch
    // targets. Only /agents itself + the Tier-1 set should exist.
    const names = list().map((c) => c.name);
    expect(names).not.toContain('/research-agent');
  });
});

describe('autoRegisterPluginPassthroughs (post-init wiring)', () => {
  beforeEach(() => {
    resetRegistry();
    registerAll();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('installs skill passthroughs and refreshes /agents in one pass', async () => {
    const sess = fakeSession({
      supportedCommands: vi.fn().mockResolvedValue([
        { name: 'mint', description: 'One-prompt feature delivery', argumentHint: '<idea>' },
        { name: 'diagnose', description: 'Parallel root-cause analysis', argumentHint: '' },
      ]),
      supportedAgents: vi.fn().mockResolvedValue([
        { name: 'research-agent', description: 'Read-only research' },
      ]),
    });

    const result = await autoRegisterPluginPassthroughs(
      sess as unknown as Parameters<typeof autoRegisterPluginPassthroughs>[0],
    );

    expect(result.skillCount).toBe(2);
    expect(result.agentCount).toBe(1);
    expect(sess.supportedCommands).toHaveBeenCalledTimes(1);
    expect(sess.supportedAgents).toHaveBeenCalledTimes(1);

    // Vendored bare slashes remain in the registry (mint/diagnose collide with
    // the vendored TS skills). Plugin variants register under namespaced
    // fallbacks so they stay reachable without overwriting the winners.
    const names = list().map((c) => c.name);
    expect(names).toContain('/mint');
    expect(names).toContain('/diagnose');
    expect(names).toContain('/plugin:mint');
    expect(names).toContain('/plugin:diagnose');

    const { ctx } = makeCtx({
      session: { current: sess } as unknown as SlashContext['session'],
    });
    // Bare /mint is vendored — dispatched immediately by the slash handler.
    const vendored = await dispatch('/mint dark mode', ctx);
    expect(vendored.handled).toBe(true);
    // The plugin alt now dispatches via skill-invocation payload — also handled.
    const alt = await dispatch('/plugin:mint dark mode', ctx);
    expect(alt.handled).toBe(true);
  });

  it('plugin /forge wins the bare slash (no built-in forge to collide with)', async () => {
    // forge is not a built-in skill in the open-source build, so any plugin
    // providing `forge` takes over the bare slash unconditionally.
    const sess = fakeSession({
      supportedCommands: vi.fn().mockResolvedValue([
        { name: 'forge', description: 'Plugin-provided forge', argumentHint: '' },
      ]),
      supportedAgents: vi.fn().mockResolvedValue([]),
    });

    await autoRegisterPluginPassthroughs(
      sess as unknown as Parameters<typeof autoRegisterPluginPassthroughs>[0],
    );

    const names = list().map((c) => c.name);
    // Plugin gets the bare slash unopposed — no namespace fallback needed.
    expect(names).toContain('/forge');
    const forgeCommand = lookup('/forge');
    expect(forgeCommand?.summary).toContain('Plugin-provided');
  });

  it('after auto-register, /skills lists the live discovered set (not the placeholder)', async () => {
    const sess = fakeSession({
      supportedCommands: vi.fn().mockResolvedValue([
        { name: 'mint', description: 'One-prompt feature delivery', argumentHint: '' },
      ]),
    });
    await autoRegisterPluginPassthroughs(
      sess as unknown as Parameters<typeof autoRegisterPluginPassthroughs>[0],
    );
    const { ctx, lines } = makeCtx();
    await dispatch('/skills', ctx);
    const joined = lines.join('\n');
    expect(joined).toContain('/mint');
    expect(joined).not.toMatch(/still loading/);
  });

  it('survives SDK errors on either side and reports null counts', async () => {
    const sess = fakeSession({
      supportedCommands: vi.fn().mockRejectedValue(new Error('skills query failed')),
      supportedAgents: vi.fn().mockRejectedValue(new Error('agents query failed')),
    });
    const result = await autoRegisterPluginPassthroughs(
      sess as unknown as Parameters<typeof autoRegisterPluginPassthroughs>[0],
    );
    expect(result.skillCount).toBeNull();
    expect(result.agentCount).toBeNull();
  });
});

describe('/exit', () => {
  beforeEach(() => { resetRegistry(); registerAll(); });

  it('returns SlashResult "exit"', async () => {
    const { ctx } = makeCtx();
    const res = await dispatch('/exit', ctx);
    expect(res.handled).toBe(true);
    expect(res.result).toBe('exit');
  });
});

describe('/reset', () => {
  beforeEach(() => { resetRegistry(); registerAll(); });

  it('clears stats and calls /clear on the session', async () => {
    const sess = fakeSession();
    const stats = makeStats();
    stats.totalTurns = 5;
    stats.totalCostUsd = 0.25;
    stats.turns.push({ user: 'x', assistant: 'y', timestamp: Date.now() });
    const { ctx } = makeCtx({ session: { current: sess } as unknown as SlashContext['session'], stats });
    await dispatch('/reset', ctx);
    expect(sess.sendMessage).toHaveBeenCalledWith('/clear');
    expect(ctx.stats.totalTurns).toBe(0);
    expect(ctx.stats.totalCostUsd).toBe(0);
    expect(ctx.stats.turns).toHaveLength(0);
  });
});
