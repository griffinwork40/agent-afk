/**
 * Verifies that `lspInstallAllowed` is forwarded to the dispatcher ONLY for
 * trusted top-level interactive sessions via `wireQueryDispatcher`.
 *
 * The provider filters the trusted surface opt-in before forwarding; the
 * dispatcher independently rejects child/headless contexts.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AgentConfig } from '../../../types/config-types.js';
import type { BuildDispatcherOptions } from '../build-dispatcher.js';
import { wireQueryDispatcher, type DispatcherWiringArgs } from './dispatcher-wiring.js';

function makeArgs(configOver: Partial<AgentConfig> = {}) {
  const seen: BuildDispatcherOptions[] = [];
  const stubDispatcher = {
    dispatch: vi.fn(),
    getDisabledToolNames: () => [],
    getEnabledToolNames: () => [],
  };
  const config = {
    model: 'claude-sonnet-4-5',
    surface: 'cli',
    ...configOver,
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
    getCwd: () => process.cwd(),
    getDispatcherCwd: () => undefined,
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

describe('wireQueryDispatcher lspInstallAllowed forwarding', () => {
  it('forwards lspInstallAllowed:true for a trusted top-level REPL session', () => {
    const { args, seen } = makeArgs({ lspInstallAllowed: true });
    wireQueryDispatcher(args);
    expect(seen[0]?.lspInstallAllowed).toBe(true);
  });

  it('does NOT set lspInstallAllowed when config omits it', () => {
    const { args, seen } = makeArgs({});
    wireQueryDispatcher(args);
    expect(seen[0]?.lspInstallAllowed).toBeUndefined();
  });

  it('does NOT forward lspInstallAllowed for forked child sessions', () => {
    const { args, seen } = makeArgs({
      lspInstallAllowed: true,
      parentSessionId: 'parent-123',
      depth: 1,
    });
    wireQueryDispatcher(args);
    expect(seen[0]?.lspInstallAllowed).toBeUndefined();
  });

  it('does NOT forward lspInstallAllowed when config sets it false', () => {
    const { args, seen } = makeArgs({ lspInstallAllowed: false });
    wireQueryDispatcher(args);
    expect(seen[0]?.lspInstallAllowed).toBeUndefined();
  });

  it('modelToolsFactory rebuild preserves lspInstallAllowed', () => {
    const { args, seen } = makeArgs({ lspInstallAllowed: true });
    const { modelToolsFactory } = wireQueryDispatcher(args);
    // Trigger a rebuild (simulates /model swap).
    modelToolsFactory('claude-opus-4-5', 'default');
    expect(seen).toHaveLength(2);
    expect(seen[1]?.lspInstallAllowed).toBe(true);
  });
});
