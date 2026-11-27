/**
 * Tests that buildTelegramProvider passes a permission allowlist on every
 * provider family (fix for #5275).
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TelegramSessionBuildContext } from './session-context.js';

vi.mock('./wire-telegram-executors.js', () => ({
  wireTelegramExecutors: () => ({ executors: { subagentExecutor: {}, skillExecutor: {}, composeExecutor: {} } }),
}));

import { buildTelegramProvider } from './session-provider.js';

function makeCtx(overrides?: Partial<TelegramSessionBuildContext>): TelegramSessionBuildContext {
  return {
    sessionConfig: { model: 'claude-sonnet-4-6' },
    config: {},
    sessionCwd: path.join(os.tmpdir(), 'workspace'),
    traceWriter: null,
    mcpManager: { getMcpToolWireNames: () => ['mcp__test__tool'] },
    workspaceStore: {},
    stateStore: {},
    ...overrides,
  } as unknown as TelegramSessionBuildContext;
}

const executors = { subagentExecutor: {}, skillExecutor: {}, composeExecutor: {} } as never;

function permissionsOf(provider: unknown): { allowedTools?: string[] } | undefined {
  const p = provider as Record<string, unknown>;
  // XaiProvider wraps OpenAICompatibleProvider as `inner`; check there first.
  if (p['inner'] !== undefined) {
    return permissionsOf(p['inner']);
  }
  // AnthropicDirectProvider stores opts fields directly on the instance;
  // OpenAICompatibleProvider stores them under providerOpts.
  const opts = (p['providerOpts'] ?? p) as Record<string, unknown>;
  return opts['permissions'] as { allowedTools?: string[] } | undefined;
}

describe('buildTelegramProvider — permission allowlist (#5275)', () => {
  it('passes an allowlist for the anthropic-direct family', () => {
    const provider = buildTelegramProvider(makeCtx(), executors, 'anthropic-direct');
    const perms = permissionsOf(provider);
    expect(perms?.allowedTools).toBeDefined();
    expect(Array.isArray(perms?.allowedTools)).toBe(true);
    expect((perms?.allowedTools ?? []).length).toBeGreaterThan(0);
  });

  it('passes an allowlist for the openai-compatible family', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const provider = buildTelegramProvider(makeCtx(), executors, 'openai-compatible');
    const perms = permissionsOf(provider);
    expect(perms?.allowedTools).toBeDefined();
    expect(Array.isArray(perms?.allowedTools)).toBe(true);
    expect((perms?.allowedTools ?? []).length).toBeGreaterThan(0);
    vi.unstubAllEnvs();
  });

  it('passes an allowlist for the xai family', () => {
    vi.stubEnv('XAI_API_KEY', 'xai-test');
    const provider = buildTelegramProvider(makeCtx(), executors, 'xai');
    const perms = permissionsOf(provider);
    expect(perms?.allowedTools).toBeDefined();
    expect(Array.isArray(perms?.allowedTools)).toBe(true);
    expect((perms?.allowedTools ?? []).length).toBeGreaterThan(0);
    vi.unstubAllEnvs();
  });

  it('all three families produce the same allowedTools list', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubEnv('XAI_API_KEY', 'xai-test');
    const ctx = makeCtx();
    const anthropic = permissionsOf(buildTelegramProvider(ctx, executors, 'anthropic-direct'));
    const openai = permissionsOf(buildTelegramProvider(ctx, executors, 'openai-compatible'));
    const xai = permissionsOf(buildTelegramProvider(ctx, executors, 'xai'));
    expect(new Set(anthropic?.allowedTools)).toEqual(new Set(openai?.allowedTools));
    expect(new Set(anthropic?.allowedTools)).toEqual(new Set(xai?.allowedTools));
    vi.unstubAllEnvs();
  });

  it('includes MCP wire-names in the allowlist for every family', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubEnv('XAI_API_KEY', 'xai-test');
    const ctx = makeCtx({ mcpManager: { getMcpToolWireNames: () => ['mcp__custom__op'] } as never });
    for (const family of ['anthropic-direct', 'openai-compatible', 'xai'] as const) {
      const perms = permissionsOf(buildTelegramProvider(ctx, executors, family));
      expect(perms?.allowedTools).toContain('mcp__custom__op');
    }
    vi.unstubAllEnvs();
  });
});
