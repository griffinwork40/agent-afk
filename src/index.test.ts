/**
 * Tests that the library entry point (src/index.ts) resolves and exports expected symbols.
 */

import { describe, it, expect } from 'vitest';

describe('library entry point', () => {
  it('exports AgentSession from agent', async () => {
    const mod = await import('./index.js');
    expect(mod.AgentSession).toBeDefined();
    expect(typeof mod.AgentSession).toBe('function');
  });

  it('exports TelegramBot and SessionManager', async () => {
    const mod = await import('./index.js');
    expect(mod.TelegramBot).toBeDefined();
    expect(mod.SessionManager).toBeDefined();
  });

});
