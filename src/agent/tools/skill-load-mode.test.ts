/**
 * Tests for `context: 'load'` — in-context skill execution.
 *
 * `load` mode is the progressive-disclosure counterpart to `fork`: the skill
 * body is returned as the tool result for the CURRENT agent to execute with
 * its existing tools, instead of forking an isolated sub-agent. These tests
 * pin the load-bearing guarantees:
 *   - load NEVER forks a sub-agent and NEVER calls the registry handler;
 *   - the framed body + arg echo reach the model as the tool result;
 *   - `$ARGUMENT(S)` substitution applies;
 *   - SKILL.md frontmatter `context: load` flows end-to-end to the executor;
 *   - plugin skills default to LOAD (since 2026-06); they fork ONLY when the
 *     frontmatter explicitly declares `context: fork`.
 *
 * See docs/skill-load-mode.md.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillExecutor } from './skill-executor.js';
import { registerSkill, _resetRegistry } from '../../skills/index.js';
import { SubagentManager } from '../subagent.js';
import * as promptLoader from '../../skills/_lib/prompt-loader.js';
import * as routingTelemetry from '../routing-telemetry.js';
import { discoverPluginSkillBodies, type PluginSkillBody } from './skill-bridge.js';
import type { SdkPluginConfig } from '../types/sdk-types.js';

const abortSignal = new AbortController().signal;

function makeCall(input: unknown) {
  return { id: 'test-call', name: 'skill', input, signal: abortSignal };
}

function makeExecutor() {
  return new SkillExecutor({
    parentSession: {
      sessionId: 'parent-load',
      getInputStreamRef: () => ({ pushUserMessage: () => {} }),
      abortSignal,
    },
  });
}

/** Spy that proves a fork was never dispatched. */
function spyNoFork() {
  const mockFork = vi.fn();
  vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(mockFork);
  vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);
  return mockFork;
}

function setPluginBodies(executor: SkillExecutor, entries: Array<[string, PluginSkillBody]>) {
  (executor as unknown as { pluginBodies: Map<string, PluginSkillBody> | null }).pluginBodies =
    new Map(entries);
}

describe('context: load — registry skills', () => {
  beforeEach(() => {
    _resetRegistry();
    // Telemetry is best-effort + writes to disk; stub so tests stay hermetic
    // and so we can assert the `mode: 'load'` discriminator.
    vi.spyOn(routingTelemetry, 'appendRoutingDecision').mockResolvedValue(undefined as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns the framed system.md body, never forks, never calls the handler', async () => {
    const handler = vi.fn().mockResolvedValue('HANDLER-SHOULD-NOT-RUN');
    registerSkill({ name: 'load-skill', description: 'd', context: 'load', handler });
    vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
      'system.md': 'BODY-CONTENT: do the thing.',
    });
    const mockFork = spyNoFork();

    const result = await makeExecutor().execute(
      makeCall({ name: 'load-skill', arguments: 'my-args' }),
    );

    expect(result.isError).toBeUndefined();
    // Body reaches the model verbatim…
    expect(result.content).toContain('BODY-CONTENT: do the thing.');
    // …wrapped in an execute-now framing header that echoes the args.
    expect(result.content).toContain('loaded into your current context');
    expect(result.content).toContain('my-args');
    // The discriminating guarantees: no fork, no handler.
    expect(mockFork).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('substitutes $ARGUMENT / $ARGUMENTS in the loaded body', async () => {
    registerSkill({ name: 'load-args', description: 'd', context: 'load', handler: vi.fn() });
    vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
      'system.md': 'First: $ARGUMENT. All: $ARGUMENTS.',
    });
    spyNoFork();

    const result = await makeExecutor().execute(
      makeCall({ name: 'load-args', arguments: 'GO' }),
    );

    expect(result.content).toContain('First: GO. All: GO.');
  });

  it('shows "(none)" in the header when no args are provided', async () => {
    registerSkill({ name: 'load-noargs', description: 'd', context: 'load', handler: vi.fn() });
    vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({ 'system.md': 'body' });
    spyNoFork();

    const result = await makeExecutor().execute(makeCall({ name: 'load-noargs' }));

    expect(result.content).toContain('Arguments: (none)');
  });

  it('returns an error when a load skill has no system.md', async () => {
    registerSkill({ name: 'load-no-prompt', description: 'd', context: 'load', handler: vi.fn() });
    vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({ 'other.md': 'x' });
    spyNoFork();

    const result = await makeExecutor().execute(makeCall({ name: 'load-no-prompt' }));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('load-no-prompt');
    expect(result.content).toContain('prompts/system.md');
  });

  it('emits skill.dispatched + skill.completed telemetry tagged mode: "load"', async () => {
    registerSkill({ name: 'load-telemetry', description: 'd', context: 'load', handler: vi.fn() });
    vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({ 'system.md': 'body' });
    spyNoFork();
    const appendSpy = routingTelemetry.appendRoutingDecision as unknown as ReturnType<typeof vi.fn>;

    await makeExecutor().execute(makeCall({ name: 'load-telemetry' }));

    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'skill.dispatched',
        requested_name: 'load-telemetry',
        mode: 'load',
      }),
    );
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'skill.completed',
        status: 'succeeded',
        mode: 'load',
      }),
    );
  });
});

describe('context: load — plugin skills', () => {
  beforeEach(() => {
    _resetRegistry();
    vi.spyOn(routingTelemetry, 'appendRoutingDecision').mockResolvedValue(undefined as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('loads the plugin SKILL.md body in-context (no fork) when context: load', async () => {
    const mockFork = spyNoFork();
    const executor = makeExecutor();
    setPluginBodies(executor, [
      ['plugin-load', { body: 'PLUGIN-BODY for $ARGUMENTS', pluginPath: '/fake', context: 'load' }],
    ]);

    const result = await executor.execute(makeCall({ name: 'plugin-load', arguments: 'task-x' }));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('PLUGIN-BODY for task-x');
    expect(result.content).toContain('loaded into your current context');
    expect(mockFork).not.toHaveBeenCalled();
  });

  it('a plugin skill WITHOUT a context field now LOADS in-context (default flipped 2026-06)', async () => {
    const mockFork = spyNoFork();
    const executor = makeExecutor();
    setPluginBodies(executor, [
      ['plugin-default', { body: 'DEFAULT-BODY for $ARGUMENTS', pluginPath: '/fake' }],
    ]);

    const result = await executor.execute(makeCall({ name: 'plugin-default', arguments: 'task-y' }));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('DEFAULT-BODY for task-y');
    expect(result.content).toContain('loaded into your current context');
    expect(mockFork).not.toHaveBeenCalled();
  });

  it('a plugin skill with context: fork still forks a subagent (explicit opt-in)', async () => {
    const mockFork = vi.fn().mockResolvedValue({
      runToResult: vi.fn().mockResolvedValue({ status: 'succeeded', message: { content: 'forked' } }),
      teardown: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(mockFork);
    vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

    const executor = makeExecutor();
    setPluginBodies(executor, [
      ['plugin-fork', { body: 'fork body', pluginPath: '/fake', context: 'fork' }],
    ]);

    const result = await executor.execute(makeCall({ name: 'plugin-fork' }));

    expect(result.content).toBe('forked');
    expect(mockFork).toHaveBeenCalledOnce();
  });

  it('forces FORK by name for a DEFAULT_FORK_SKILLS skill whose frontmatter lacks context: fork', async () => {
    // Regression: first-registrant-wins registration lets a user/project
    // copy shadow a bundled fork-mode skill. A stale copy missing
    // `context: fork` previously degraded to load mode — instruction text
    // instead of the structured envelope (broke diagnose's shadow-verify
    // parsing) and bypassed name-keyed read-only enforcement.
    const mockFork = vi.fn().mockResolvedValue({
      runToResult: vi.fn().mockResolvedValue({ status: 'succeeded', message: { content: 'forced-fork' } }),
      teardown: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(mockFork);
    vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const executor = makeExecutor();
    // 'shadow-verify' is in DEFAULT_FORK_SKILLS; this copy has NO context field.
    setPluginBodies(executor, [
      ['shadow-verify', { body: 'stale private copy', pluginPath: '/fake/private-plugin' }],
    ]);

    const result = await executor.execute(makeCall({ name: 'shadow-verify' }));

    expect(result.content).toBe('forced-fork');
    expect(mockFork).toHaveBeenCalledOnce();
    // The override must be observable — never a silent frontmatter override.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('fork-enforced by name'),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('shadow-verify'));
  });

  it('does NOT warn when a DEFAULT_FORK_SKILLS skill already declares context: fork', async () => {
    const mockFork = vi.fn().mockResolvedValue({
      runToResult: vi.fn().mockResolvedValue({ status: 'succeeded', message: { content: 'ok' } }),
      teardown: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(mockFork);
    vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const executor = makeExecutor();
    setPluginBodies(executor, [
      ['shadow-verify', { body: 'proper copy', pluginPath: '/fake', context: 'fork' }],
    ]);

    await executor.execute(makeCall({ name: 'shadow-verify' }));

    expect(mockFork).toHaveBeenCalledOnce();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a plugin skill NOT in DEFAULT_FORK_SKILLS still loads in-context by default', async () => {
    const mockFork = spyNoFork();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const executor = makeExecutor();
    setPluginBodies(executor, [
      ['ordinary-skill', { body: 'ordinary body', pluginPath: '/fake' }],
    ]);

    const result = await executor.execute(makeCall({ name: 'ordinary-skill' }));

    expect(result.content).toContain('ordinary body');
    expect(result.content).toContain('loaded into your current context');
    expect(mockFork).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('expands ${PLUGIN_ROOT} and $PLUGIN_ROOT in body to pluginPath when context: load', async () => {
    const mockFork = spyNoFork();
    const executor = makeExecutor();
    const PLUGIN_PATH = '/home/user/.afk/plugins/my-plugin';
    setPluginBodies(executor, [
      [
        'plugin-root-load',
        {
          body: 'Run: python3 "${PLUGIN_ROOT}/scripts/foo.py" and $PLUGIN_ROOT/bin/bar',
          pluginPath: PLUGIN_PATH,
          context: 'load',
        },
      ],
    ]);

    const result = await executor.execute(makeCall({ name: 'plugin-root-load' }));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(`python3 "${PLUGIN_PATH}/scripts/foo.py"`);
    expect(result.content).toContain(`${PLUGIN_PATH}/bin/bar`);
    // No unexpanded placeholders
    expect(result.content).not.toContain('$PLUGIN_ROOT');
    expect(result.content).not.toContain('${PLUGIN_ROOT}');
    expect(mockFork).not.toHaveBeenCalled();
  });

  it('expands the ${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}} portability idiom to pluginPath when context: load', async () => {
    // Regression: the previous /\$\{?PLUGIN_ROOT\}?/g regex matched only
    // `${PLUGIN_ROOT` of the Claude-Code fallback idiom and left `:-${CLAUDE_
    // PLUGIN_ROOT}}` dangling, producing a broken path. Skills using the
    // portable `${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}` form (forge-gate-check,
    // distill, forge-l2-eval, ceiling-test) failed their python3 invocations
    // in load mode as a result.
    const mockFork = spyNoFork();
    const executor = makeExecutor();
    const PLUGIN_PATH = '/home/user/.afk/plugins/my-plugin';
    setPluginBodies(executor, [
      [
        'plugin-root-fallback',
        {
          body: 'python3 ${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/foo.py and "${PLUGIN_ROOT:-/tmp/x}/bin/bar"',
          pluginPath: PLUGIN_PATH,
          context: 'load',
        },
      ],
    ]);

    const result = await executor.execute(makeCall({ name: 'plugin-root-fallback' }));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(`python3 ${PLUGIN_PATH}/scripts/foo.py`);
    expect(result.content).toContain(`"${PLUGIN_PATH}/bin/bar"`);
    // The whole `${PLUGIN_ROOT:-...}` fallback (incl. the nested ${...})
    // collapses to pluginPath — nothing of the placeholder or fallback survives.
    expect(result.content).not.toContain('$PLUGIN_ROOT');
    expect(result.content).not.toContain('${PLUGIN_ROOT');
    expect(result.content).not.toContain('CLAUDE_PLUGIN_ROOT');
    expect(result.content).not.toContain(':-');
    expect(mockFork).not.toHaveBeenCalled();
  });
});

describe('context: load — SKILL.md frontmatter parsing (end-to-end)', () => {
  it('parses `context: load` from frontmatter into PluginSkillBody.context', () => {
    const dir = mkdtempSync(join(tmpdir(), 'afk-load-fm-'));
    try {
      const skillDir = join(dir, 'skills', 'demo');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---\nname: demo-load\ndescription: a load demo\ncontext: load\n---\nIn-context body.`,
      );

      const bodies = discoverPluginSkillBodies([
        { type: 'local', path: dir } as unknown as SdkPluginConfig,
      ]);

      const entry = bodies.get('demo-load');
      expect(entry).toBeDefined();
      expect(entry?.context).toBe('load');
      expect(entry?.body).toContain('In-context body.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parser leaves context undefined when frontmatter omits it (executor applies the load default)', () => {
    // The PARSER stays neutral: an omitted `context:` yields `undefined`. The
    // load-vs-fork default is applied downstream by SkillExecutor.execute()
    // (undefined → load since 2026-06), NOT baked in at parse time.
    const dir = mkdtempSync(join(tmpdir(), 'afk-load-fm-'));
    try {
      const skillDir = join(dir, 'skills', 'demo2');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---\nname: demo-fork\ndescription: no context field\n---\nBody.`,
      );

      const bodies = discoverPluginSkillBodies([
        { type: 'local', path: dir } as unknown as SdkPluginConfig,
      ]);

      expect(bodies.get('demo-fork')?.context).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
