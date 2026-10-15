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
 *   - /marketplaces command (renderList — empty and populated).
 *   - /marketplace bare call (printUsage).
 *   - handleMarketplaceInstall error paths.
 *   - doInstallPlugin error paths.
 *   - handlePlugins (all branches).
 *   - handleRemove (all branches).
 *   - handleUpdate (all outcome branches + error).
 *   - parseFlags (--ref, --force, -r, -f).
 *   - install with name and flags.
 *   - URL-scheme colon not treated as plugin colon form.
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
import { installFromMarketplace, listMarketplacePlugins } from '../../agent/marketplaces/resolve.js';
import { removeMarketplace } from '../../agent/marketplaces/remove.js';
import { updateMarketplace } from '../../agent/marketplaces/update.js';
import { readIndex } from '../../agent/plugins/index-store.js';
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
      model: 'sonnet', permissionMode: 'default',
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

/** Retrieve the `/marketplaces` SlashCommand captured by the register mock. */
function getMarketplacesCmd(): SlashCommand {
  const registerMock = vi.mocked(register);
  const calls = registerMock.mock.calls;
  const cmd = calls.find(([c]) => c.name === '/marketplaces')?.[0];
  if (!cmd) throw new Error('Expected /marketplaces to have been registered');
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

// ---------------------------------------------------------------------------
// /marketplaces command — renderList
// ---------------------------------------------------------------------------

describe('/marketplaces — list installed marketplaces', () => {
  it('shows "No marketplaces installed" hint when index is empty', async () => {
    vi.mocked(readIndex).mockReturnValue({ marketplaces: {} } as ReturnType<typeof readIndex>);
    const out = makeWriter();
    await getMarketplacesCmd().handler(makeCtx(out), '');

    expect(out.calls.line.some(l => l.includes('No marketplaces installed'))).toBe(true);
    expect(out.calls.line.some(l => l.includes('/marketplace install'))).toBe(true);
  });

  it('lists installed marketplaces sorted alphabetically', async () => {
    vi.mocked(readIndex).mockReturnValue({
      marketplaces: {
        'z-market': { source: 'https://z.example.com', sourceType: 'git', ref: 'main' },
        'a-market': { source: 'https://a.example.com', sourceType: 'git', ref: 'v1' },
      },
    } as unknown as ReturnType<typeof readIndex>);

    const out = makeWriter();
    await getMarketplacesCmd().handler(makeCtx(out), '');

    const lines = out.calls.line.join('\n');
    const aPos = lines.indexOf('a-market');
    const zPos = lines.indexOf('z-market');
    expect(aPos).toBeGreaterThanOrEqual(0);
    expect(zPos).toBeGreaterThanOrEqual(0);
    expect(aPos).toBeLessThan(zPos);
  });

  it('shows "(local)" for entries without a ref', async () => {
    vi.mocked(readIndex).mockReturnValue({
      marketplaces: {
        'local-mp': { source: '/path/to/local', sourceType: 'local' },
      },
    } as unknown as ReturnType<typeof readIndex>);

    const out = makeWriter();
    await getMarketplacesCmd().handler(makeCtx(out), '');

    expect(out.calls.line.some(l => l.includes('local'))).toBe(true);
  });

  it('returns "continue"', async () => {
    vi.mocked(readIndex).mockReturnValue({ marketplaces: {} } as ReturnType<typeof readIndex>);
    const result = await getMarketplacesCmd().handler(makeCtx(makeWriter()), '');
    expect(result).toBe('continue');
  });
});

// ---------------------------------------------------------------------------
// /marketplace list — alias for /marketplaces
// ---------------------------------------------------------------------------

describe('/marketplace list — alias for renderList', () => {
  it('shows "No marketplaces installed" when empty', async () => {
    vi.mocked(readIndex).mockReturnValue({ marketplaces: {} } as ReturnType<typeof readIndex>);
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'list');
    expect(out.calls.line.some(l => l.includes('No marketplaces installed'))).toBe(true);
  });

  it('lists marketplaces when populated', async () => {
    vi.mocked(readIndex).mockReturnValue({
      marketplaces: {
        'my-mp': { source: 'https://example.com', sourceType: 'git', ref: 'main' },
      },
    } as unknown as ReturnType<typeof readIndex>);
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'list');
    expect(out.calls.line.some(l => l.includes('my-mp'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /marketplace bare call — printUsage
// ---------------------------------------------------------------------------

describe('/marketplace (no args) — printUsage', () => {
  it('returns "continue"', async () => {
    const result = await getMarketplaceCmd().handler(makeCtx(makeWriter()), '');
    expect(result).toBe('continue');
  });

  it('prints usage lines for all subcommands', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), '');
    const lines = out.calls.line.join('\n');
    expect(lines).toContain('install');
    expect(lines).toContain('install-plugin');
    expect(lines).toContain('plugins');
    expect(lines).toContain('remove');
    expect(lines).toContain('update');
  });
});

// ---------------------------------------------------------------------------
// handleMarketplaceInstall error paths
// ---------------------------------------------------------------------------

describe('/marketplace install — error paths', () => {
  it('shows usage error when no source is given', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'install');
    expect(out.calls.error.some(e => e.includes('Usage'))).toBe(true);
    expect(vi.mocked(installMarketplace)).not.toHaveBeenCalled();
  });

  it('emits error when installMarketplace throws', async () => {
    vi.mocked(installMarketplace).mockRejectedValueOnce(new Error('network failure'));
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'install https://example.com/my-mp');
    expect(out.calls.error.some(e => e.includes('network failure'))).toBe(true);
  });

  it('passes name arg when provided via add alias (avoids 2-arg legacy route)', async () => {
    // `install url name` has 2 args → triggers legacy plugin-install path.
    // Use `add url name` instead: add routes directly to handleMarketplaceInstall with [url, name].
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'add https://example.com/my-mp my-name');
    expect(vi.mocked(installMarketplace)).toHaveBeenCalledWith(
      'https://example.com/my-mp',
      expect.objectContaining({ name: 'my-name' }),
    );
  });

  it('passes --force flag via the add alias (reaches parseFlags)', async () => {
    // add url --force: source='url', name='--force' (starts with '-', excluded), flagsRaw=[].
    // --force landing in name slot is skipped; only `force` from flagsRaw is set.
    // Use name + --force so flagsRaw receives '--force'.
    // add url name --force: source='url', name='name', flagsRaw=['--force'] → force=true.
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'add https://example.com/my-mp my-name --force');
    expect(vi.mocked(installMarketplace)).toHaveBeenCalledWith(
      'https://example.com/my-mp',
      expect.objectContaining({ force: true }),
    );
  });

  it('passes -r <ref> and -f short flags via the add alias', async () => {
    // add url name -r v3 -f: flagsRaw=['-r','v3','-f'] → ref='v3', force=true.
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'add https://example.com/my-mp my-name -r v3 -f');
    expect(vi.mocked(installMarketplace)).toHaveBeenCalledWith(
      'https://example.com/my-mp',
      expect.objectContaining({ ref: 'v3', force: true }),
    );
  });

  it('does NOT treat https:// URL as colon plugin form', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'install https://example.com/my-mp');
    // Should call installMarketplace, NOT installFromMarketplace
    expect(vi.mocked(installMarketplace)).toHaveBeenCalled();
    expect(vi.mocked(installFromMarketplace)).not.toHaveBeenCalled();
    expect(out.calls.warn).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// doInstallPlugin error paths
// ---------------------------------------------------------------------------

describe('/marketplace install-plugin — error paths', () => {
  it('emits error when installFromMarketplace throws', async () => {
    vi.mocked(installFromMarketplace).mockRejectedValueOnce(new Error('bad plugin'));
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'install-plugin my-mp plugA');
    expect(out.calls.error.some(e => e.includes('bad plugin'))).toBe(true);
  });

  it('shows usage error when no args given', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'install-plugin');
    expect(out.calls.error.some(e => e.includes('Usage'))).toBe(true);
  });

  it('handles colon form directly via install-plugin', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'install-plugin my-mp:plugA');
    expect(vi.mocked(installFromMarketplace)).toHaveBeenCalledWith('my-mp', 'plugA');
    expect(out.calls.warn).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handlePlugins
// ---------------------------------------------------------------------------

describe('/marketplace plugins <marketplace>', () => {
  it('shows usage error when no marketplace is given', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'plugins');
    expect(out.calls.error.some(e => e.includes('Usage'))).toBe(true);
  });

  it('shows "no plugins" message when marketplace is empty', async () => {
    vi.mocked(listMarketplacePlugins).mockReturnValue([]);
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'plugins my-mp');
    expect(out.calls.line.some(l => l.includes('no plugins') || l.includes('lists no plugins'))).toBe(true);
  });

  it('lists plugins with installed markers', async () => {
    vi.mocked(listMarketplacePlugins).mockReturnValue([
      { name: 'plugA', installed: true, description: 'desc A' },
      { name: 'plugB', installed: false, description: undefined },
    ] as ReturnType<typeof listMarketplacePlugins>);
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'plugins my-mp');
    const lines = out.calls.line.join('\n');
    expect(lines).toContain('plugA');
    expect(lines).toContain('plugB');
    expect(lines).toContain('install-plugin my-mp');
  });

  it('shows description when plugin has one', async () => {
    vi.mocked(listMarketplacePlugins).mockReturnValue([
      { name: 'plugA', installed: false, description: 'A great plugin' },
    ] as ReturnType<typeof listMarketplacePlugins>);
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'plugins my-mp');
    expect(out.calls.line.some(l => l.includes('A great plugin'))).toBe(true);
  });

  it('emits error when listMarketplacePlugins throws', async () => {
    vi.mocked(listMarketplacePlugins).mockImplementation(() => {
      throw new Error('bad manifest');
    });
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'plugins my-mp');
    expect(out.calls.error.some(e => e.includes('bad manifest'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleRemove
// ---------------------------------------------------------------------------

describe('/marketplace remove <marketplace>', () => {
  it('shows usage error when no name is given', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'remove');
    expect(out.calls.error.some(e => e.includes('Usage'))).toBe(true);
  });

  it('shows "nothing to remove" when marketplace not found', async () => {
    vi.mocked(removeMarketplace).mockReturnValue({
      removedDir: false,
      removedIndexEntry: false,
      removedPluginEntries: [],
    } as ReturnType<typeof removeMarketplace>);
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'remove no-such-mp');
    expect(out.calls.line.some(l => l.includes('no-such-mp'))).toBe(true);
    expect(out.calls.success).toHaveLength(0);
  });

  it('emits success when marketplace is removed', async () => {
    vi.mocked(removeMarketplace).mockReturnValue({
      removedDir: true,
      removedIndexEntry: true,
      removedPluginEntries: [],
    } as ReturnType<typeof removeMarketplace>);
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'remove my-mp');
    expect(out.calls.success.some(s => s.includes('my-mp'))).toBe(true);
  });

  it('mentions cascaded plugin count when plugins were removed', async () => {
    vi.mocked(removeMarketplace).mockReturnValue({
      removedDir: true,
      removedIndexEntry: true,
      removedPluginEntries: ['plugA', 'plugB'],
    } as ReturnType<typeof removeMarketplace>);
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'remove my-mp');
    expect(out.calls.success.some(s => s.includes('2 plugin'))).toBe(true);
  });

  it('returns "continue"', async () => {
    vi.mocked(removeMarketplace).mockReturnValue({
      removedDir: true,
      removedIndexEntry: true,
      removedPluginEntries: [],
    } as ReturnType<typeof removeMarketplace>);
    const result = await getMarketplaceCmd().handler(makeCtx(makeWriter()), 'remove my-mp');
    expect(result).toBe('continue');
  });
});

// ---------------------------------------------------------------------------
// handleUpdate — all outcome branches + error
// ---------------------------------------------------------------------------

describe('/marketplace update <marketplace>', () => {
  it('shows usage error when no name is given', async () => {
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'update');
    expect(out.calls.error.some(e => e.includes('Usage'))).toBe(true);
  });

  it('emits success on "updated" outcome with added/removed plugins', async () => {
    vi.mocked(updateMarketplace).mockResolvedValue({
      status: 'updated',
      fromRef: 'abc123',
      toRef: 'def456',
      addedPlugins: ['plugC'],
      removedPlugins: ['plugOld'],
    } as ReturnType<typeof updateMarketplace> extends Promise<infer T> ? T : never);
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'update my-mp');
    expect(out.calls.success.some(s => s.includes('abc123') && s.includes('def456'))).toBe(true);
    expect(out.calls.success.some(s => s.includes('plugC'))).toBe(true);
    expect(out.calls.success.some(s => s.includes('plugOld'))).toBe(true);
  });

  it('emits success on "updated" with no added/removed plugins', async () => {
    vi.mocked(updateMarketplace).mockResolvedValue({
      status: 'updated',
      fromRef: 'abc123',
      toRef: 'def456',
      addedPlugins: [],
      removedPlugins: [],
    } as ReturnType<typeof updateMarketplace> extends Promise<infer T> ? T : never);
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'update my-mp');
    expect(out.calls.success.some(s => s.includes('my-mp'))).toBe(true);
  });

  it('emits info on "up-to-date" outcome', async () => {
    vi.mocked(updateMarketplace).mockResolvedValue({
      status: 'up-to-date',
      ref: 'v1.2.3',
    } as ReturnType<typeof updateMarketplace> extends Promise<infer T> ? T : never);
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'update my-mp');
    expect(out.calls.info.some(i => i.includes('up-to-date') && i.includes('v1.2.3'))).toBe(true);
  });

  it('emits info on "skipped-local" outcome', async () => {
    vi.mocked(updateMarketplace).mockResolvedValue({
      status: 'skipped-local',
    } as ReturnType<typeof updateMarketplace> extends Promise<infer T> ? T : never);
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'update my-mp');
    expect(out.calls.info.some(i => i.includes('skipped'))).toBe(true);
  });

  it('emits warn on "missing-dir" outcome', async () => {
    vi.mocked(updateMarketplace).mockResolvedValue({
      status: 'missing-dir',
      dir: '/path/to/my-mp',
    } as ReturnType<typeof updateMarketplace> extends Promise<infer T> ? T : never);
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'update my-mp');
    expect(out.calls.warn.some(w => w.includes('missing'))).toBe(true);
  });

  it('emits error when updateMarketplace throws', async () => {
    vi.mocked(updateMarketplace).mockRejectedValueOnce(new Error('git pull failed'));
    const out = makeWriter();
    await getMarketplaceCmd().handler(makeCtx(out), 'update my-mp');
    expect(out.calls.error.some(e => e.includes('git pull failed'))).toBe(true);
  });
});
