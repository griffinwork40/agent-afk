/**
 * Verifies `lspInstallAllowed` forwarding in the OpenAI-compatible provider's
 * `interactivityOpts` helper and `buildQueryDispatcher`.
 *
 * The OpenAI path bundles interactivity opts (isNonInteractive, headless,
 * lspInstallAllowed) through `interactivityOpts()` — test both the helper
 * directly and the downstream `buildQueryDispatcher` spread.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AgentConfig } from '../../types/config-types.js';
import { interactivityOpts } from './index.dispatcher-opts.js';
import { buildQueryDispatcher } from './index.query-dispatcher.js';
import type { BuildDispatcherOpts } from './index.dispatcher-opts.js';

// ---------------------------------------------------------------------------
// interactivityOpts unit tests
// ---------------------------------------------------------------------------

describe('interactivityOpts lspInstallAllowed', () => {
  it('includes lspInstallAllowed:true for trusted interactive REPL config', () => {
    const config = { surface: 'cli', lspInstallAllowed: true } as Pick<AgentConfig, 'isNonInteractive' | 'surface' | 'lspInstallAllowed'>;
    expect(interactivityOpts(config).lspInstallAllowed).toBe(true);
  });

  it('omits lspInstallAllowed when not set', () => {
    const config = { surface: 'cli' } as Pick<AgentConfig, 'isNonInteractive' | 'surface' | 'lspInstallAllowed'>;
    const result = interactivityOpts(config);
    expect('lspInstallAllowed' in result).toBe(false);
  });

  it('omits lspInstallAllowed when explicitly false', () => {
    const config = { surface: 'cli', lspInstallAllowed: false } as Pick<AgentConfig, 'isNonInteractive' | 'surface' | 'lspInstallAllowed'>;
    const result = interactivityOpts(config);
    expect('lspInstallAllowed' in result).toBe(false);
  });

  it('still sets isNonInteractive independently of lspInstallAllowed', () => {
    const config = {
      surface: 'cli',
      isNonInteractive: true,
      lspInstallAllowed: true,
    } as Pick<AgentConfig, 'isNonInteractive' | 'surface' | 'lspInstallAllowed'>;
    const result = interactivityOpts(config);
    // Headless sessions must not forward install eligibility.
    expect(result.isNonInteractive).toBe(true);
    expect(result.lspInstallAllowed).toBeUndefined();
  });

  it('includes lspInstallAllowed:true for telegram surface', () => {
    const config = { surface: 'telegram', lspInstallAllowed: true } as Pick<AgentConfig, 'isNonInteractive' | 'surface' | 'lspInstallAllowed'>;
    expect(interactivityOpts(config).lspInstallAllowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildQueryDispatcher integration: verifies it is spread into buildDispatcher
// ---------------------------------------------------------------------------

function makeStubDispatcher() {
  return {
    dispatch: vi.fn(),
    getDisabledToolNames: () => [] as string[],
    getEnabledToolNames: () => [] as string[],
    toolDefs: [],
  };
}

describe('buildQueryDispatcher lspInstallAllowed forwarding', () => {
  it('forwards lspInstallAllowed:true from config via interactivityOpts spread', () => {
    const seen: BuildDispatcherOpts[] = [];
    const stub = makeStubDispatcher();
    const config = {
      model: 'gpt-4o',
      surface: 'cli',
      lspInstallAllowed: true,
    } as unknown as AgentConfig;
    buildQueryDispatcher({
      config,
      permissionMode: 'default',
      externalTools: undefined,
      customNames: [],
      schemas: [],
      runtimeStateSource: {
        getEnabledToolNames: () => [],
        getWorkspace: () => undefined,
        getSubagents: () => ({ active: [], backgroundJobs: [] }) as never,
        getSessionId: () => undefined,
        getDepth: () => undefined,
        getSelf: () => undefined,
      } as never,
      readRoots: undefined,
      writeRoots: undefined,
      sessionId: undefined,
      buildDispatcher: (_mode, opts) => { seen.push(opts); return stub as never; },
    });
    expect(seen[0]?.lspInstallAllowed).toBe(true);
  });

  it('does not forward lspInstallAllowed when config omits it', () => {
    const seen: BuildDispatcherOpts[] = [];
    const stub = makeStubDispatcher();
    const config = { model: 'gpt-4o', surface: 'cli' } as unknown as AgentConfig;
    buildQueryDispatcher({
      config,
      permissionMode: 'default',
      externalTools: undefined,
      customNames: [],
      schemas: [],
      runtimeStateSource: {
        getEnabledToolNames: () => [],
        getWorkspace: () => undefined,
        getSubagents: () => ({ active: [], backgroundJobs: [] }) as never,
        getSessionId: () => undefined,
        getDepth: () => undefined,
        getSelf: () => undefined,
      } as never,
      readRoots: undefined,
      writeRoots: undefined,
      sessionId: undefined,
      buildDispatcher: (_mode, opts) => { seen.push(opts); return stub as never; },
    });
    expect(seen[0]?.lspInstallAllowed).toBeUndefined();
  });
});
