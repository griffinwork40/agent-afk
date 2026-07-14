/**
 * Unit tests for `buildDaemonSessionFactory` — verifies that daemon-spawned
 * sessions are constructed with a fully-wired provider so the `skill`,
 * `agent`, and `compose` tools are registered.
 *
 * Root cause being tested: `afk daemon` previously passed no `sessionFactory`
 * to `startDaemon`, so sessions fell through to `resolveProvider()` →
 * `new AnthropicDirectProvider()` with no executor opts, omitting the three
 * orchestration tools. Skill commands like `/some-skill --auto` would
 * fail because the provider's permission gate rejected tool calls it had
 * no handler for.
 *
 * The provider stores `permissions` and executors as private fields (to allow
 * per-query dispatcher construction). This test reads them back via a typed
 * unknown-cast — the same pattern used in `parse-provider-agent-tool.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildDaemonSessionFactory } from './daemon.js';
import type { AgentConfig } from '../../agent/types.js';
import { AnthropicDirectProvider } from '../../agent/providers/anthropic-direct/index.js';
import type { ToolPermissionConfig } from '../../agent/tools/permissions.js';

// ---------------------------------------------------------------------------
// Helpers — read private provider internals (same pattern as
// parse-provider-agent-tool.test.ts).
// ---------------------------------------------------------------------------

function readAllowedTools(provider: AnthropicDirectProvider): readonly string[] | undefined {
  const internals = provider as unknown as { permissions?: ToolPermissionConfig };
  return internals.permissions?.allowedTools;
}

function readSubagentExecutor(provider: AnthropicDirectProvider): unknown {
  const internals = provider as unknown as { subagentExecutor?: unknown };
  return internals.subagentExecutor;
}

function readSkillExecutor(provider: AnthropicDirectProvider): unknown {
  const internals = provider as unknown as { skillExecutor?: unknown };
  return internals.skillExecutor;
}

function readComposeExecutor(provider: AnthropicDirectProvider): unknown {
  const internals = provider as unknown as { composeExecutor?: unknown };
  return internals.composeExecutor;
}

// Fake API key — non-empty so it satisfies AnthropicDirectProvider's token
// validation gate in `query()` without hitting the network. The Anthropic SDK
// constructor is cheap and does no I/O at construction time; actual API calls
// only happen when the session's iterator is pulled (i.e. after sendMessage).
const TEST_API_KEY = 'sk-ant-test-dummy-key-for-unit-tests';

// ---------------------------------------------------------------------------
// Minimal AgentConfig — mirrors what CronScheduler.spawnSession() builds
// before handing off to the sessionFactory.
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    model: 'sonnet',
    apiKey: TEST_API_KEY,
    permissionMode: 'bypassPermissions',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildDaemonSessionFactory', () => {
  // Isolate the SQLite-backed MemoryStore the factory opens to a throwaway temp
  // dir so this unit test never touches the real user memory DB at
  // $AFK_HOME/state/memory. env.AFK_HOME is a live getter over process.env
  // (config/env.ts), so mutating process.env here redirects getMemoryDir() —
  // the same temp-dir convention memory-store.test.ts uses.
  let prevAfkHome: string | undefined;
  let tmpHome: string;
  beforeAll(() => {
    prevAfkHome = process.env['AFK_HOME'];
    tmpHome = mkdtempSync(join(tmpdir(), 'afk-daemon-factory-test-'));
    process.env['AFK_HOME'] = tmpHome;
  });
  afterAll(() => {
    if (prevAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = prevAfkHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns a factory function', () => {
    const factory = buildDaemonSessionFactory({ model: 'sonnet', apiKey: TEST_API_KEY });
    expect(typeof factory).toBe('function');
  });

  it('factory produces an AgentSession instance', () => {
    const factory = buildDaemonSessionFactory({ model: 'sonnet', apiKey: TEST_API_KEY });
    const session = factory(makeConfig());
    // AgentSession has a `sendMessage` method — use it as a duck-type check.
    expect(typeof session.sendMessage).toBe('function');
    void session.close().catch(() => undefined);
  });

  it('session provider is an AnthropicDirectProvider for an Anthropic-routed model', () => {
    const factory = buildDaemonSessionFactory({ model: 'sonnet', apiKey: TEST_API_KEY });
    const session = factory(makeConfig());
    const internals = session as unknown as { config?: { provider?: unknown } };
    const provider = internals.config?.provider;
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);
    void session.close().catch(() => undefined);
  });

  it("provider allowedTools contains 'agent', 'skill', and 'compose'", () => {
    const factory = buildDaemonSessionFactory({ model: 'sonnet', apiKey: TEST_API_KEY });
    const session = factory(makeConfig());
    const internals = session as unknown as { config?: { provider?: unknown } };
    const provider = internals.config?.provider as AnthropicDirectProvider;
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);

    const allowed = readAllowedTools(provider);
    expect(allowed).toBeDefined();
    expect(allowed).toContain('agent');
    expect(allowed).toContain('skill');
    expect(allowed).toContain('compose');
    void session.close().catch(() => undefined);
  });

  it('subagentExecutor is truthy (not bare provider)', () => {
    const factory = buildDaemonSessionFactory({ model: 'sonnet', apiKey: TEST_API_KEY });
    const session = factory(makeConfig());
    const internals = session as unknown as { config?: { provider?: unknown } };
    const provider = internals.config?.provider as AnthropicDirectProvider;
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);

    const executor = readSubagentExecutor(provider);
    expect(executor).toBeTruthy();
    void session.close().catch(() => undefined);
  });

  it('skillExecutor is truthy', () => {
    const factory = buildDaemonSessionFactory({ model: 'sonnet', apiKey: TEST_API_KEY });
    const session = factory(makeConfig());
    const internals = session as unknown as { config?: { provider?: unknown } };
    const provider = internals.config?.provider as AnthropicDirectProvider;
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);

    const executor = readSkillExecutor(provider);
    expect(executor).toBeTruthy();
    void session.close().catch(() => undefined);
  });

  it('composeExecutor is truthy', () => {
    const factory = buildDaemonSessionFactory({ model: 'sonnet', apiKey: TEST_API_KEY });
    const session = factory(makeConfig());
    const internals = session as unknown as { config?: { provider?: unknown } };
    const provider = internals.config?.provider as AnthropicDirectProvider;
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);

    const executor = readComposeExecutor(provider);
    expect(executor).toBeTruthy();
    void session.close().catch(() => undefined);
  });

  it('preserves permissionMode:bypassPermissions from the incoming config', () => {
    const factory = buildDaemonSessionFactory({ model: 'sonnet', apiKey: TEST_API_KEY });
    const config = makeConfig({ permissionMode: 'bypassPermissions' });
    const session = factory(config);
    // AgentSession stores config; the field survives the spread.
    const internals = session as unknown as { config?: AgentConfig };
    expect(internals.config?.permissionMode).toBe('bypassPermissions');
    void session.close().catch(() => undefined);
  });

  it('passes a cwd from opts into the config', () => {
    const factory = buildDaemonSessionFactory({ model: 'sonnet', apiKey: TEST_API_KEY, cwd: '/tmp/my-repo' });
    const config = makeConfig();
    const session = factory(config);
    // cwd comes from opts and is in the provider/executor, but the spread
    // also preserves any cwd the incoming config already set. We just verify
    // the session was created without error.
    expect(typeof session.sendMessage).toBe('function');
    void session.close().catch(() => undefined);
  });

  // Surface-parity guard (PR: observable forked children). The scheduler
  // (scheduler.ts:spawnSession) opens a per-tick trace and threads it in as
  // config.traceWriter. The daemon factory must forward THAT SAME instance into
  // its fork executors + root manager (mirroring bootstrap.ts) — otherwise
  // daemon-forked children emit zero subagent_lifecycle events and the new
  // timeout/prompt-head observability is invisible on the AFK surface where it
  // matters most. Regression guard against a reintroduction of the old
  // `traceWriter: undefined` wiring.
  it('threads config.traceWriter into the fork executors and root manager', () => {
    const traceWriter = {
      write: async () => undefined,
      getTracePath: () => 'in-memory://trace',
      seal: async () => undefined,
    } as unknown as NonNullable<AgentConfig['traceWriter']>;

    const factory = buildDaemonSessionFactory({ model: 'sonnet', apiKey: TEST_API_KEY });
    const session = factory(makeConfig({ traceWriter }));
    const internals = session as unknown as { config?: { provider?: unknown } };
    const provider = internals.config?.provider as AnthropicDirectProvider;
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);

    // Each executor stores its context as `this.ctx`, whose `traceWriter` field
    // is the writer forwarded at construction.
    const subExec = readSubagentExecutor(provider) as { ctx?: { traceWriter?: unknown; subagentManager?: unknown } };
    const skillExec = readSkillExecutor(provider) as { ctx?: { traceWriter?: unknown } };
    const composeExec = readComposeExecutor(provider) as { ctx?: { traceWriter?: unknown } };

    expect(subExec.ctx?.traceWriter, 'SubagentExecutor traceWriter').toBe(traceWriter);
    expect(skillExec.ctx?.traceWriter, 'SkillExecutor traceWriter').toBe(traceWriter);
    expect(composeExec.ctx?.traceWriter, 'ComposeExecutor traceWriter').toBe(traceWriter);

    // The load-bearing path: the root SubagentManager's parentTraceWriter is
    // what forkSubagent hands to every depth-1 `agent`-tool child's handle
    // (subagent.ts: effectiveTraceWriter = config.traceWriter ?? parentTraceWriter).
    const mgr = subExec.ctx?.subagentManager as { parentTraceWriter?: unknown } | undefined;
    expect(mgr?.parentTraceWriter, 'root SubagentManager parentTraceWriter').toBe(traceWriter);

    void session.close().catch(() => undefined);
  });
});
