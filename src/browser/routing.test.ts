/**
 * Unit tests for src/browser/routing.ts
 *
 * Strategy: mock the Agent Browser connection module so no real filesystem
 * or network probing occurs. Tests verify routing heuristics in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserConfig } from './types.js';

// ---------------------------------------------------------------------------
// Shared mutable state for mock control
// ---------------------------------------------------------------------------

const mockAvailability = {
  available: false,
  connection: null as {
    url: string;
    token: string;
    pid: number;
    version: string;
  } | null,
  reason: null as string | null,
};

vi.mock('./agent-browser/connection.js', () => ({
  checkAvailability: async () => ({ ...mockAvailability }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { selectBackend } from './routing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<BrowserConfig>): BrowserConfig {
  return {
    headless: false,
    allowedDomains: [],
    blockedDomains: [],
    domSnapshots: false,
    backend: 'auto',
    configPath: null,
    defaultProfile: 'default',
    ...overrides,
  };
}

function setAvailable(): void {
  mockAvailability.available = true;
  mockAvailability.connection = {
    url: 'http://127.0.0.1:8833',
    token: 'test-token',
    pid: 12345,
    version: '0.3.0',
  };
  mockAvailability.reason = null;
}

function setUnavailable(reason: string): void {
  mockAvailability.available = false;
  mockAvailability.connection = null;
  mockAvailability.reason = reason;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  setUnavailable('test default: not available');
});

describe('explicit backend selection', () => {
  it('backend=playwright bypasses all heuristics', async () => {
    setAvailable(); // Should be ignored.
    const decision = await selectBackend({
      config: makeConfig({ backend: 'playwright' }),
    });
    expect(decision.backend).toBe('playwright');
    expect(decision.reason).toContain('explicit');
    expect(decision.probeMs).toBe(0);
  });

  it('backend=agent-browser probes and succeeds when available', async () => {
    setAvailable();
    const decision = await selectBackend({
      config: makeConfig({ backend: 'agent-browser' }),
    });
    expect(decision.backend).toBe('agent-browser');
    expect(decision.reason).toContain('explicit');
    expect(decision.probeMs).toBeGreaterThanOrEqual(0);
  });

  it('backend=agent-browser throws when unavailable', async () => {
    setUnavailable('health probe failed');
    await expect(
      selectBackend({ config: makeConfig({ backend: 'agent-browser' }) }),
    ).rejects.toThrow('Agent Browser is not available');
  });
});

describe('auto mode -- surface exclusions', () => {
  it('daemon surface is excluded', async () => {
    setAvailable();
    const decision = await selectBackend({
      config: makeConfig(),
      surface: 'daemon',
    });
    expect(decision.backend).toBe('playwright');
    expect(decision.reason).toContain('daemon');
  });

  it('subagent surface is excluded', async () => {
    setAvailable();
    const decision = await selectBackend({
      config: makeConfig(),
      surface: 'subagent',
    });
    expect(decision.backend).toBe('playwright');
    expect(decision.reason).toContain('subagent');
  });
});

describe('auto mode -- headless', () => {
  it('headless mode selects Playwright', async () => {
    setAvailable();
    const decision = await selectBackend({
      config: makeConfig({ headless: true }),
    });
    expect(decision.backend).toBe('playwright');
    expect(decision.reason).toContain('headless');
  });
});

describe('auto mode -- availability probing', () => {
  it('selects agent-browser when available', async () => {
    setAvailable();
    const decision = await selectBackend({
      config: makeConfig(),
    });
    expect(decision.backend).toBe('agent-browser');
    expect(decision.reason).toContain('preferred');
    expect(decision.availability).not.toBeNull();
    expect(decision.availability!.available).toBe(true);
  });

  it('falls back to playwright when unavailable', async () => {
    setUnavailable('connection file missing');
    const decision = await selectBackend({
      config: makeConfig(),
    });
    expect(decision.backend).toBe('playwright');
    expect(decision.reason).toContain('unavailable');
    expect(decision.reason).toContain('connection file missing');
  });

  it('records probe latency', async () => {
    setAvailable();
    const decision = await selectBackend({
      config: makeConfig(),
    });
    expect(typeof decision.probeMs).toBe('number');
    expect(decision.probeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('routing decision structure', () => {
  it('always includes backend, reason, probeMs, availability', async () => {
    const decision = await selectBackend({
      config: makeConfig({ backend: 'playwright' }),
    });
    expect(decision).toHaveProperty('backend');
    expect(decision).toHaveProperty('reason');
    expect(decision).toHaveProperty('probeMs');
    expect(decision).toHaveProperty('availability');
  });
});
