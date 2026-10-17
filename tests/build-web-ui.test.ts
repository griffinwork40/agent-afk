/**
 * Tests for scripts/build-web-ui.mjs — ensureDashboardDeps()
 *
 * Strategy: vi.mock stubs for node:fs and node:child_process so no real
 * installs or disk mutations occur. The module's top-level main() call is
 * also intercepted via the existsSync stub (it gates on package.json first).
 *
 * Four branches under test:
 *  1. CI=true  + .modules.yaml absent → process.exit(1), no execSync
 *  2. local    + .modules.yaml absent → execSync called, no exit
 *  3. partial-install recovery: execSync throws + partial dir present →
 *     node_modules removed, exit(1)
 *  4. partial-install recovery: execSync throws + no partial dir →
 *     rmSync skipped, exit(1)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

// ── mock node:child_process ────────────────────────────────────────────────────

const mockExecSync = vi.fn();
vi.mock('node:child_process', () => ({ execSync: mockExecSync }));

// ── mock node:fs ──────────────────────────────────────────────────────────────
// existsSync is called by:
//   1. main() → checks dashboard/package.json  (we return true to skip that exit)
//   2. main() → checks node_modules/.modules.yaml (we control this)
//   3. catch block → checks node_modules partial dir (we control this)
// We route by path suffix so each call-site is independently controllable.

const existsMap = new Map<string, boolean>();
const mockExistsSync = vi.fn((p: string) => {
  for (const [suffix, val] of existsMap) {
    if (p.endsWith(suffix)) return val;
  }
  return false;
});
const mockRmSync = vi.fn();
const mockMkdirSync = vi.fn();
// readdirSync/statSync are called by reportSize() inside main() at import time.
// Without mocks they throw ENOENT (outDir does not exist in the test sandbox),
// which propagates through main().catch() → mockExit() → throws → unhandled
// rejection → vitest exits 1 even when all test assertions pass.
const mockReaddirSync = vi.fn(() => [] as string[]);
const mockStatSync = vi.fn(() => ({ isDirectory: () => false, size: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    rmSync: mockRmSync,
    mkdirSync: mockMkdirSync,
    readdirSync: mockReaddirSync,
    statSync: mockStatSync,
  };
});

// ── mock process.exit so tests don't terminate the runner ─────────────────────

const mockExit = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null) => {
  throw new Error(`process.exit(${_code})`);
});

// ── module under test ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type BuildWebUiModule = { ensureDashboardDeps: () => void };

// Imported once; top-level main() fires at import time. The existsMap will
// cause it to exit via process.exit(1) on package.json missing unless we seed
// package.json → true. We do that in beforeEach so main()'s first existsSync
// (package.json) returns true and its second (.modules.yaml) is controlled
// per-test. main() then calls buildDashboard() via execSync — but execSync is
// mocked and returns undefined, so it succeeds silently. reportSize() calls
// readdirSync which is NOT mocked and will throw — we catch that in main()'s
// .catch() which calls process.exit(1) via the mock. That's fine: we only care
// about ensureDashboardDeps(), which we call directly after import.
let mod: BuildWebUiModule;

// ── helpers ───────────────────────────────────────────────────────────────────

function seedExists(opts: { packageJson: boolean; modulesYaml: boolean; partialDir?: boolean }) {
  existsMap.clear();
  if (opts.packageJson) existsMap.set('package.json', true);
  existsMap.set('.modules.yaml', opts.modulesYaml);
  if (opts.partialDir !== undefined) existsMap.set('node_modules', opts.partialDir);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ensureDashboardDeps', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env['CI'];

    // Allow main() to proceed past package.json check; gate .modules.yaml per-test
    seedExists({ packageJson: true, modulesYaml: true });
    mockExecSync.mockReturnValue(undefined);

    if (!mod) {
      const _dir = dirname(fileURLToPath(import.meta.url));
      const url = pathToFileURL(resolve(_dir, '..', 'scripts', 'build-web-ui.mjs')).href;
      mod = await import(url) as BuildWebUiModule;
    }

    // Reset after import-time main() side effects
    vi.clearAllMocks();
    delete process.env['CI'];
  });

  it('CI=true + .modules.yaml absent → exits 1 without calling execSync', () => {
    process.env['CI'] = 'true';
    seedExists({ packageJson: true, modulesYaml: false });

    expect(() => mod.ensureDashboardDeps()).toThrow('process.exit(1)');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('local (no CI) + .modules.yaml absent → calls execSync, does not exit', () => {
    seedExists({ packageJson: true, modulesYaml: false });
    mockExecSync.mockReturnValue(undefined);

    mod.ensureDashboardDeps();

    expect(mockExecSync).toHaveBeenCalledOnce();
    expect(mockExecSync).toHaveBeenCalledWith(
      'pnpm install --frozen-lockfile',
      expect.objectContaining({ shell: true }),
    );
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('partial-install recovery: execSync throws + partial dir present → removes node_modules, exits 1', () => {
    seedExists({ packageJson: true, modulesYaml: false, partialDir: true });
    mockExecSync.mockImplementation(() => { throw new Error('network error'); });

    expect(() => mod.ensureDashboardDeps()).toThrow('process.exit(1)');

    expect(mockRmSync).toHaveBeenCalledOnce();
    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining('node_modules'),
      expect.objectContaining({ recursive: true, force: true }),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('partial-install recovery: execSync throws + no partial dir → skips rmSync, exits 1', () => {
    seedExists({ packageJson: true, modulesYaml: false, partialDir: false });
    mockExecSync.mockImplementation(() => { throw new Error('install failed'); });

    expect(() => mod.ensureDashboardDeps()).toThrow('process.exit(1)');

    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('CI=false string is treated as local (not CI → calls execSync)', () => {
    process.env['CI'] = 'false';
    seedExists({ packageJson: true, modulesYaml: false });
    mockExecSync.mockReturnValue(undefined);

    mod.ensureDashboardDeps();

    expect(mockExecSync).toHaveBeenCalledOnce();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('CI=0 string is treated as local (not CI → calls execSync)', () => {
    process.env['CI'] = '0';
    seedExists({ packageJson: true, modulesYaml: false });
    mockExecSync.mockReturnValue(undefined);

    mod.ensureDashboardDeps();

    expect(mockExecSync).toHaveBeenCalledOnce();
    expect(mockExit).not.toHaveBeenCalled();
  });
});
