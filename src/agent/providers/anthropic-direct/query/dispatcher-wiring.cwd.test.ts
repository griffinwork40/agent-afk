/**
 * Locks the dispatcher containment base in `wireQueryDispatcher`.
 *
 * Regression (#3704): the rebuild closure fed the DISPLAY cwd accessor
 * (`getCwd`, which falls back to `process.cwd()`) into the dispatcher. For an
 * unconfined session (no worktree, no `config.cwd`) that turned "no
 * containment" into "contained to process.cwd() with read roots []", so every
 * fork's read_file / grep / glob failed with "outside the allowed read roots []".
 *
 * Invariant under test: the dispatcher's `cwd` comes from `getDispatcherCwd`
 * on the initial build AND on every `modelToolsFactory` rebuild, and stays
 * `undefined` when that accessor returns `undefined`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AgentConfig } from '../../../types/config-types.js';
import type { BuildDispatcherOptions } from '../build-dispatcher.js';
import { wireQueryDispatcher, type DispatcherWiringArgs } from './dispatcher-wiring.js';

function makeArgs(over: { cwd?: string; liveCwd?: string } = {}) {
  const seen: BuildDispatcherOptions[] = [];
  const stubDispatcher = {
    dispatch: vi.fn(),
    getDisabledToolNames: () => [],
    getEnabledToolNames: () => [],
  };
  const config = {
    model: 'claude-sonnet-4-5',
    // A forked child: never registers presence, so no filesystem side effects.
    depth: 1,
    parentSessionId: 'parent-session',
    ...(over.cwd !== undefined ? { cwd: over.cwd } : {}),
  } as unknown as AgentConfig;
  const args: DispatcherWiringArgs = {
    config,
    model: 'claude-sonnet-4-5',
    permissionMode: 'default',
    surface: 'cli',
    providerName: 'anthropic-direct',
    externalTools: undefined,
    sharedReadRoots: [],
    sharedWriteRoots: [],
    // The display accessor always resolves to SOME path, like production.
    getCwd: () => over.liveCwd ?? over.cwd ?? '/display/fallback/process-cwd',
    getDispatcherCwd: () => over.liveCwd ?? over.cwd,
    getMcpTools: () => [],
    getMcpServerStates: () => [],
    getSubagents: () => ({ active: [], backgroundJobs: [] }) as never,
    getMintedSessionId: () => null,
    setMintedSessionId: () => {},
    getPresenceSessionId: () => null,
    setPresenceSessionId: () => {},
    buildDispatcher: (_mode, opts) => {
      seen.push(opts);
      return stubDispatcher as never;
    },
  };
  return { args, seen };
}

describe('wireQueryDispatcher dispatcher cwd', () => {
  it('leaves an unconfined session unconfined on the initial build', () => {
    const { args, seen } = makeArgs();
    wireQueryDispatcher(args);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cwd).toBeUndefined();
  });

  it('keeps an unconfined session unconfined on a model-switch rebuild', () => {
    const { args, seen } = makeArgs();
    const wiring = wireQueryDispatcher(args);
    wiring.modelToolsFactory('claude-opus-4-5', 'default');
    expect(seen).toHaveLength(2);
    expect(seen[1]?.cwd).toBeUndefined();
  });

  it('never uses the display fallback as the containment base', () => {
    const { args, seen } = makeArgs();
    const wiring = wireQueryDispatcher(args);
    wiring.modelToolsFactory('claude-opus-4-5', 'default');
    for (const opts of seen) expect(opts.cwd).not.toBe('/display/fallback/process-cwd');
  });

  it('passes the configured cwd for a confined session', () => {
    const { args, seen } = makeArgs({ cwd: '/repo/.afk-worktrees/x' });
    const wiring = wireQueryDispatcher(args);
    wiring.modelToolsFactory('claude-opus-4-5', 'default');
    expect(seen.map((o) => o.cwd)).toEqual(['/repo/.afk-worktrees/x', '/repo/.afk-worktrees/x']);
  });

  it('follows a live re-anchored cwd on rebuild', () => {
    const { args, seen } = makeArgs({ liveCwd: '/repo/.afk-worktrees/born-named' });
    const wiring = wireQueryDispatcher(args);
    wiring.modelToolsFactory('claude-opus-4-5', 'default');
    expect(seen[1]?.cwd).toBe('/repo/.afk-worktrees/born-named');
  });
});
