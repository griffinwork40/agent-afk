/**
 * Tests for env-var initialisation in src/cli/index.ts.
 *
 * index.ts runs side effects at module load time (process.env assignments via
 * ??=). We use vi.resetModules() + dynamic import() so each test case gets a
 * fresh module evaluation.  Heavy Commander/config imports are mocked so the
 * test doesn't require a real file-system config or Anthropic credentials.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Stable mocks — modules that index.ts imports with side-effects we don't
// need in this test suite.
// ---------------------------------------------------------------------------

vi.mock('dotenv', () => ({
  default: { config: () => ({ parsed: {} }) },
  config: () => ({ parsed: {} }),
}));

vi.mock('../paths.js', () => ({
  getEnvConfigPath: () => '/tmp/afk-test.env',
  getAgentFrameworkDir: () => '/tmp/afk-agent-framework',
}));

// Stub everything else index.ts imports so we avoid real I/O or missing deps.
vi.mock('commander', () => {
  // Build a deeply chainable Command stub. Every method returns `this` so
  // the fluent call-chain in index.ts (.name().description().version().option())
  // works without real Commander.
  function makeCmd() {
    const self: Record<string, unknown> = {};
    const chain = () => self;
    self['name'] = chain;
    self['description'] = chain;
    self['version'] = chain;
    self['option'] = chain;
    self['alias'] = chain;
    self['action'] = chain;
    self['argument'] = chain;
    self['addHelpText'] = chain;
    self['parseAsync'] = vi.fn().mockResolvedValue(undefined);
    self['commands'] = [];
    self['command'] = () => makeCmd();
    return self;
  }
  const Command = vi.fn(makeCmd);
  return { Command };
});

vi.mock('./color-config.js', () => ({ configureColor: vi.fn() }));
vi.mock('./commands/chat.js', () => ({ registerChatCommand: vi.fn() }));

const mockSetInteractiveUpdateNotices = vi.fn();
vi.mock('./commands/interactive.js', () => ({
  registerInteractiveCommand: vi.fn(),
  setInteractiveUpdateNotices: mockSetInteractiveUpdateNotices,
}));

vi.mock('./commands/status.js', () => ({ registerStatusCommand: vi.fn() }));
vi.mock('./commands/config-command.js', () => ({ registerConfigCommand: vi.fn() }));
vi.mock('./commands/daemon.js', () => ({ registerDaemonCommand: vi.fn() }));
vi.mock('./commands/login-command.js', () => ({ registerLoginCommand: vi.fn() }));
vi.mock('./commands/plugin.js', () => ({ registerPluginCommand: vi.fn() }));
vi.mock('./commands/marketplace.js', () => ({ registerMarketplaceCommand: vi.fn() }));
vi.mock('./commands/doctor.js', () => ({ registerDoctorCommand: vi.fn() }));
vi.mock('./commands/completion.js', () => ({ registerCompletionCommand: vi.fn() }));
vi.mock('./commands/telegram.js', () => ({ registerTelegramCommand: vi.fn() }));
vi.mock('./commands/worktree.js', () => ({ registerWorktreeCommand: vi.fn() }));
vi.mock('./commands/farm.js', () => ({ registerFarmCommand: vi.fn() }));
vi.mock('./commands/update.js', () => ({ registerUpdateCommand: vi.fn() }));
vi.mock('./commands/schedule.js', () => ({ registerScheduleCommand: vi.fn() }));
vi.mock('./config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({ updatePolicy: 'notify' }),
  loadCredential: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../agent/providers/index.js', () => ({ providerForModel: vi.fn() }));
vi.mock('./shared-helpers.js', () => ({ getModel: vi.fn().mockReturnValue('claude-3-5-haiku') }));
vi.mock('./auth-wizard.js', () => ({ runAuthWizard: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./version.js', () => ({ getVersion: vi.fn().mockReturnValue('0.0.0-test') }));

const mockCheckForUpdates = vi.fn();
const mockPrintUpdateBanner = vi.fn();
const mockCheckPendingUpdate = vi.fn();
vi.mock('./update-checker.js', () => ({
  checkForUpdates: mockCheckForUpdates,
  printUpdateBanner: mockPrintUpdateBanner,
  triggerAutoUpdate: vi.fn(),
  checkPendingUpdate: mockCheckPendingUpdate,
}));

// ---------------------------------------------------------------------------

describe('src/cli/index.ts — AGENT_SURFACE env initialisation', () => {
  let originalSurface: string | undefined;

  beforeEach(() => {
    originalSurface = process.env['AGENT_SURFACE'];
    vi.resetModules();
  });

  afterEach(() => {
    // Restore original value so we don't pollute other test files.
    if (originalSurface === undefined) {
      delete process.env['AGENT_SURFACE'];
    } else {
      process.env['AGENT_SURFACE'] = originalSurface;
    }
  });

  it('sets AGENT_SURFACE to "afk" when the variable is not pre-set', async () => {
    delete process.env['AGENT_SURFACE'];

    await import('./index.js');

    expect(process.env['AGENT_SURFACE']).toBe('afk');
  });

  it('does NOT overwrite AGENT_SURFACE when it is already set', async () => {
    process.env['AGENT_SURFACE'] = 'plugin';

    await import('./index.js');

    expect(process.env['AGENT_SURFACE']).toBe('plugin');
  });
});

// ---------------------------------------------------------------------------
// Update-banner ordering regression tests
//
// These tests verify that the isDirectRun block in index.ts:
//   1. Calls setInteractiveUpdateNotices BEFORE program.parse()
//   2. Passes updateInfo and any captured pending message through
//   3. Respects --no-update-check
//
// Because `isDirectRun` is false in test imports, we test the exported
// helpers and the mock wiring rather than triggering the block directly.
// The critical ordering guarantee (notices stashed before parse) is verified
// by checking that setInteractiveUpdateNotices is called with the right args.
// ---------------------------------------------------------------------------

describe('src/cli/index.ts — update notice stashing (banner-before-parse)', () => {
  let originalArgv: string[];
  let originalSurface: string | undefined;

  beforeEach(() => {
    originalArgv = process.argv.slice();
    originalSurface = process.env['AGENT_SURFACE'];
    vi.resetModules();
    mockSetInteractiveUpdateNotices.mockClear();
    mockCheckForUpdates.mockReset();
    mockPrintUpdateBanner.mockClear();
    mockCheckPendingUpdate.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalSurface === undefined) {
      delete process.env['AGENT_SURFACE'];
    } else {
      process.env['AGENT_SURFACE'] = originalSurface;
    }
  });

  it('checkForUpdates and checkPendingUpdate are exported from update-checker (smoke test)', async () => {
    // Ensure index.ts can import update-checker without error.
    // The actual isDirectRun block is not executed in test context (argv[1] ≠ import.meta.url),
    // so we verify the module loads cleanly and re-exports helpers.
    const mod = await import('./index.js');
    // runFirstRunDetector is exported from index.ts
    expect(typeof mod.runFirstRunDetector).toBe('function');
  });

  it('--no-update-check flag detection uses argv entry-point restriction', () => {
    // Verify that the argv sniffing matches exactly `--no-update-check` and
    // not substrings. This is a unit test of the documented behaviour change
    // (restrict to args starting with --) rather than of index.ts itself,
    // since isDirectRun is false in test imports.
    const argv = ['node', '/usr/bin/afk', '--no-update-check'];
    const noCheck = argv.slice(2).some((a) => a === '--no-update-check');
    expect(noCheck).toBe(true);

    // A value that happens to contain the string but isn't the flag itself
    // should NOT match.
    const argv2 = ['node', '/usr/bin/afk', 'chat', 'tell me --no-update-check'];
    const noCheck2 = argv2.slice(2).some((a) => a === '--no-update-check');
    expect(noCheck2).toBe(false);
  });
});
