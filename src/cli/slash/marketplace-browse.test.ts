/**
 * Tests for the `/marketplace` slash command verb-alignment fix.
 *
 * Covers:
 *   - New canonical `install` (marketplace) routing — 1 bare arg.
 *   - New canonical `install-plugin` routing.
 *   - Legacy `add` (deprecated alias) — warns, still installs marketplace.
 *   - Legacy 2-arg `install` — warns, still installs plugin.
 *   - Legacy colon-form `install` — warns, still installs plugin.
 *   - Unknown-subcommand error path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashContext, Writer } from './types.js';

// ---------------------------------------------------------------------------
// Mock all external dependencies before importing the module under test.
// ---------------------------------------------------------------------------

vi.mock('../../agent/marketplaces/install.js', () => ({
  installMarketplace: vi.fn(),
}));

vi.mock('../../agent/marketplaces/resolve.js', () => ({
  installFromMarketplace: vi.fn(),
  listMarketplacePlugins: vi.fn(),
}));

vi.mock('../../agent/marketplaces/remove.js', () => ({
  removeMarketplace: vi.fn(),
}));

vi.mock('../../agent/marketplaces/update.js', () => ({
  updateMarketplace: vi.fn(),
}));

vi.mock('../../agent/plugins/index-store.js', () => ({
  readIndex: vi.fn().mockReturnValue({ marketplaces: {} }),
}));

vi.mock('./registry.js', () => ({
  register: vi.fn(),
}));

import { installMarketplace } from '../../agent/marketplaces/install.js';
import { installFromMarketplace } from '../../agent/marketplaces/resolve.js';
import { registerMarketplaceCommands } from './marketplace-browse.js';
import { register } from './registry.js';
import type { SlashCommand } from './types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeWriter(): Writer & { calls: Record<keyof Writer, string[]> } {
  const calls: Record<keyof Writer, string[]> = {
    line: [],
    raw: [],
    success: [],
    info: [],
    warn: [],
    error: [],
  };
  return {
    calls,
    line: vi.fn((t?: string) => { calls.line.push(t ?? ''); }) as Writer['line'],
    raw: vi.fn((t: string) => { calls.raw.push(t); }) as Writer['raw'],
    success: vi.fn((t: string) => { calls.success.push(t); }) as Writer['success'],
    info: vi.fn((t: string) => { calls.info.push(t); }) as Writer['info'],
    warn: vi.fn((t: string) => { calls.warn.push(t); }) as Writer['warn'],
    error: vi.fn((t: string) => { calls.error.push(t); }) as Writer['error'],
  };
}

function makeCtx(out: Writer): SlashContext {
  return {
    out,
    session: {} as SlashContext['session'],
    stats: {
      totalTurns: 0, totalCostUsd: 0, totalTokens: 0, totalDurationMs: 0,
      sessionStartTime: 0, turnCosts: [], turnTokens: [], turns: [],
      model: 'sonnet', planMode: false,
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  };
}

/** Retrieve the `/marketplace` SlashCommand captured by the register mock. */
function getMarketplaceCmd(): SlashCommand {
  const registerMock = vi.mocked(register);
  const calls = registerMock.mock.calls;
  const cmd = calls.find(([c]) => c.name === '/marketplace')?.[0];
  if (!cmd) throw new Error('Expected /marketplace to have been registered');
  return cmd;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default happy-path stubs.
  vi.mocked(installMarketplace).mockResolvedValue({
    name: 'my-mp',
    dir: '/path/my-mp',
    plugins: ['plugA', 'plugB'],
    entry: { source: 'https://example.com', sourceType: 'git', ref: 'main' },
  } as unknown as Awaited<ReturnType<typeof installMarketplace>>);

  vi.mocked(installFromMarketplace).mockResolvedValue({
    key: 'my-mp:plugA',
    dir: '/path/my-mp/plugA',
  } as unknown as Awaited<ReturnType<typeof installFromMarketplace>>);

  registerMarketplaceCommands();
});

// ---------------------------------------------------------------------------
// Canonical: install (marketplace)
// ---------------------------------------------------------------------------

describe('/marketplace install <source> — canonical marketplace install', () => {
  it('calls installMarketplace with the source', async () => {
    const out = makeWriter();
    const ctx = makeCtx(out);
    const cmd = getMarketplaceCmd();

    await cmd.handler(ctx, 'install https://example.com/my-mp');

    expect(vi.mocked(installMarketplace)).toHaveBeenCalledWith(
      'https://example.com/my-mp',
      expect.objectContaining({}),
    );
    expect(vi.mocked(installFromMarketplace)).not.toHaveBeenCalled();
  });

  it('emits success message and next-step hint', async () => {
    const out = makeWriter();
    const cmd = getMarketplaceCmd();

    await cmd.handler(makeCtx(out), 'install my-org/my-mp');

    expect(out.calls.success.some(s => s.includes('my-mp'))).toBe(true);
    expect(out.calls.line.some(l => l.includes('/marketplace plugins'))).toBe(true);
  });

  it('does NOT emit a deprecation warning', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'install my-org/my-mp');
    expect(out.calls.warn).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Canonical: install-plugin
// ---------------------------------------------------------------------------

describe('/marketplace install-plugin — canonical plugin install', () => {
  it('calls installFromMarketplace with marketplace and plugin', async () => {
    const out = makeWriter();
    const cmd = getMarketplaceCmd();

    await cmd.handler(makeCtx(out), 'install-plugin my-mp plugA');

    expect(vi.mocked(installFromMarketplace)).toHaveBeenCalledWith('my-mp', 'plugA');
    expect(vi.mocked(installMarketplace)).not.toHaveBeenCalled();
  });

  it('emits success and /reload-plugins hint', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'install-plugin my-mp plugA');

    expect(out.calls.success.some(s => s.includes('my-mp:plugA'))).toBe(true);
    expect(out.calls.line.some(l => l.includes('/reload-plugins'))).toBe(true);
  });

  it('does NOT emit a deprecation warning', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'install-plugin my-mp plugA');
    expect(out.calls.warn).toHaveLength(0);
  });

  it('shows usage error when marketplace or plugin is missing', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'install-plugin my-mp');
    expect(out.calls.error.some(e => e.includes('install-plugin'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Legacy: add (deprecated alias for marketplace install)
// ---------------------------------------------------------------------------

describe('/marketplace add — deprecated alias, still installs marketplace', () => {
  it('warns about deprecation and points to `install`', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'add https://example.com/my-mp');

    expect(out.calls.warn.some(w => w.includes('install'))).toBe(true);
    expect(out.calls.warn.length).toBeGreaterThan(0);
  });

  it('still calls installMarketplace (same effect as install)', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'add https://example.com/my-mp');

    expect(vi.mocked(installMarketplace)).toHaveBeenCalledWith(
      'https://example.com/my-mp',
      expect.objectContaining({}),
    );
  });

  it('does NOT call installFromMarketplace', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'add https://example.com/my-mp');
    expect(vi.mocked(installFromMarketplace)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Legacy: install <mp> <plugin> (2-arg form) — warns, still installs plugin
// ---------------------------------------------------------------------------

describe('/marketplace install <mp> <plugin> (2 args) — legacy plugin install with warning', () => {
  it('warns about deprecation and points to `install-plugin`', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'install my-mp plugA');

    expect(out.calls.warn.some(w => w.includes('install-plugin'))).toBe(true);
  });

  it('still calls installFromMarketplace with the correct args', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'install my-mp plugA');

    expect(vi.mocked(installFromMarketplace)).toHaveBeenCalledWith('my-mp', 'plugA');
    expect(vi.mocked(installMarketplace)).not.toHaveBeenCalled();
  });

  it('emits the /reload-plugins hint', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'install my-mp plugA');
    expect(out.calls.line.some(l => l.includes('/reload-plugins'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Legacy: install <mp>:<plugin> (colon form) — warns, still installs plugin
// ---------------------------------------------------------------------------

describe('/marketplace install <mp>:<plugin> (colon form) — legacy plugin install with warning', () => {
  it('warns about deprecation', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'install my-mp:plugA');

    expect(out.calls.warn.some(w => w.includes('install-plugin'))).toBe(true);
  });

  it('still calls installFromMarketplace correctly', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'install my-mp:plugA');

    expect(vi.mocked(installFromMarketplace)).toHaveBeenCalledWith('my-mp', 'plugA');
    expect(vi.mocked(installMarketplace)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Unknown subcommand
// ---------------------------------------------------------------------------

describe('/marketplace unknown-sub — error path', () => {
  it('emits an error listing valid subcommands', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'frobnicate');

    expect(out.calls.error.some(e => e.includes('frobnicate'))).toBe(true);
  });

  it('does not call installMarketplace or installFromMarketplace', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'frobnicate');

    expect(vi.mocked(installMarketplace)).not.toHaveBeenCalled();
    expect(vi.mocked(installFromMarketplace)).not.toHaveBeenCalled();
  });
});
