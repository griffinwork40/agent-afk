/**
 * Unit tests for connectMcpTraced (connect-traced.ts).
 *
 * Strategy: stub McpManager.fromConfig and emitSessionPhase so no real MCP
 * connections are made. Verify that:
 *   - mcp_connect_start is emitted before fromConfig is called.
 *   - mcp_connect_done is emitted in the finally block (even on throw).
 *   - The returned manager is the one fromConfig resolves with.
 *   - durationMs is a non-negative number.
 *   - enabledCount is derived from non-disabled servers.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { connectMcpTraced } from './connect-traced.js';
import * as managerModule from './manager.js';
import * as emitModule from '../trace/emit.js';
import type { LoadedMcpConfig } from './config-loader.js';
import type { McpManager } from './manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLoaded(overrides: Partial<LoadedMcpConfig> = {}): LoadedMcpConfig {
  return {
    mcpServers: {
      server1: { command: 'mcp-server', disabled: false } as never,
      server2: { command: 'mcp-disabled', disabled: true } as never,
    },
    warnings: [],
    serverLayers: {},
    userAllowSecretEnv: {},
    sources: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('connectMcpTraced', () => {
  let fromConfigSpy: MockInstance;
  let emitSpy: MockInstance;
  const fakeManager = { getServerStates: () => [] } as unknown as McpManager;

  beforeEach(() => {
    fromConfigSpy = vi
      .spyOn(managerModule.McpManager, 'fromConfig')
      .mockResolvedValue(fakeManager);
    emitSpy = vi.spyOn(emitModule, 'emitSessionPhase').mockResolvedValue(undefined);
  });

  it('emits mcp_connect_start before fromConfig, mcp_connect_done after', async () => {
    const order: string[] = [];
    emitSpy.mockImplementation((_tw: unknown, ev: { phase: string }) => {
      order.push(ev.phase);
      return Promise.resolve(undefined);
    });
    fromConfigSpy.mockImplementation(async () => {
      order.push('fromConfig');
      return fakeManager;
    });

    await connectMcpTraced(makeLoaded(), undefined);

    expect(order).toEqual(['mcp_connect_start', 'fromConfig', 'mcp_connect_done']);
  });

  it('returns the McpManager resolved by fromConfig', async () => {
    const result = await connectMcpTraced(makeLoaded(), undefined);
    expect(result).toBe(fakeManager);
  });

  it('passes traceSink into fromConfig and emitSessionPhase', async () => {
    const traceSink = {} as never;
    await connectMcpTraced(makeLoaded(), traceSink);

    expect(emitSpy).toHaveBeenCalledWith(traceSink, expect.objectContaining({ phase: 'mcp_connect_start' }));
    expect(fromConfigSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ traceWriter: traceSink }),
    );
    expect(emitSpy).toHaveBeenCalledWith(traceSink, expect.objectContaining({ phase: 'mcp_connect_done' }));
  });

  it('counts only non-disabled servers for serverCount metadata', async () => {
    // loaded has server1 (enabled) + server2 (disabled) → enabledCount = 1
    await connectMcpTraced(makeLoaded(), undefined);

    expect(emitSpy).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ phase: 'mcp_connect_start', metadata: { serverCount: 1 } }),
    );
    expect(emitSpy).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ phase: 'mcp_connect_done', metadata: { serverCount: 1 } }),
    );
  });

  it('emits mcp_connect_done even when fromConfig throws', async () => {
    fromConfigSpy.mockRejectedValue(new Error('alwaysLoad server failed'));

    await expect(connectMcpTraced(makeLoaded(), undefined)).rejects.toThrow('alwaysLoad server failed');

    const phases = emitSpy.mock.calls.map((c: unknown[]) => (c[1] as { phase: string }).phase);
    expect(phases).toContain('mcp_connect_start');
    expect(phases).toContain('mcp_connect_done');
  });

  it('includes a non-negative durationMs in mcp_connect_done', async () => {
    await connectMcpTraced(makeLoaded(), undefined);

    const doneCall = emitSpy.mock.calls.find(
      (c: unknown[]) => (c[1] as { phase: string }).phase === 'mcp_connect_done',
    );
    expect(doneCall).toBeDefined();
    const durationMs = (doneCall![1] as { durationMs: number }).durationMs;
    expect(typeof durationMs).toBe('number');
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does not pass traceWriter key to fromConfig when traceWriter is undefined', async () => {
    await connectMcpTraced(makeLoaded(), undefined);

    const opts = fromConfigSpy.mock.calls[0][1] as Record<string, unknown>;
    expect('traceWriter' in opts).toBe(false);
  });
});
