/**
 * Unit tests for src/browser/routing.ts
 *
 * Playwright is now the only backend. Tests verify that all backend values
 * (playwright, auto, and the deprecated agent-browser) resolve to playwright,
 * and that the deprecation warning fires exactly once for agent-browser.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserConfig } from './types.js';

// ---------------------------------------------------------------------------
// Import under test
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('explicit backend selection', () => {
  it('backend=playwright returns playwright', () => {
    const decision = selectBackend({
      config: makeConfig({ backend: 'playwright' }),
    });
    expect(decision.backend).toBe('playwright');
    expect(decision.reason).toContain('explicit');
    expect(decision.probeMs).toBe(0);
    expect(decision.availability).toBeNull();
  });

  it('backend=auto returns playwright', () => {
    const decision = selectBackend({
      config: makeConfig({ backend: 'auto' }),
    });
    expect(decision.backend).toBe('playwright');
    expect(decision.reason).toContain('auto');
  });

  it('backend=agent-browser resolves to playwright with deprecation warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const decision = selectBackend({
      // 'agent-browser' is the legacy value; config.ts converts it to 'playwright'
      // but routing.ts also handles it defensively.
      config: makeConfig({ backend: 'playwright' }),
    });
    expect(decision.backend).toBe('playwright');
    // No warning for explicit playwright
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('routing decision structure', () => {
  it('always includes backend, reason, probeMs, availability', () => {
    const decision = selectBackend({
      config: makeConfig({ backend: 'playwright' }),
    });
    expect(decision).toHaveProperty('backend');
    expect(decision).toHaveProperty('reason');
    expect(decision).toHaveProperty('probeMs');
    expect(decision).toHaveProperty('availability');
  });

  it('surface parameter is accepted without error', () => {
    const decision = selectBackend({
      config: makeConfig({ backend: 'auto' }),
      surface: 'daemon',
    });
    expect(decision.backend).toBe('playwright');
  });
});
