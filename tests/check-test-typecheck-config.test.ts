/** Exercise the real CLI with fatal compiler output, without changing tsconfig. */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  existsSync: vi.fn().mockReturnValue(true),
  writeFileSync: vi.fn(),
}));

const originalArgv = process.argv;
const scriptPath = fileURLToPath(new URL('../scripts/check-test-typecheck.ts', import.meta.url));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('check-test-typecheck fatal config CLI guard', () => {
  it.each(['--check', '--update'])('rejects TS18003 in %s mode before passing or updating', async (mode) => {
    vi.resetModules();
    const diagnostic = 'error TS18003: No inputs were found in config file tsconfig.test.json.';
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error('tsc exited 2'), { stdout: diagnostic, stderr: '' });
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const writeBaseline = vi.mocked(fs.writeFileSync);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('CLI exit');
    });
    process.argv = ['node', scriptPath, mode];

    await expect(import('../scripts/check-test-typecheck.js')).rejects.toThrow('CLI exit');

    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(diagnostic));
    expect(stdout).not.toHaveBeenCalled();
    expect(writeBaseline).not.toHaveBeenCalled();
  });

  it.each(['--check', '--update'])(
    'rejects TS1xxx syntax error in %s mode — prevents false-shrink baseline lowering',
    async (mode) => {
      // A single TS1xxx syntax error causes tsc to skip semantic analysis, yielding
      // a tiny error count (often 1) far below the baseline. Without this guard the
      // check path exits 0 ("count shrank") and --update lowers the baseline to 1,
      // silently hiding every real semantic type error.
      vi.resetModules();
      const diagnostic = "src/foo.ts:1:1 - error TS1128: Declaration or statement expected.";
      vi.mocked(execFileSync).mockImplementation(() => {
        throw Object.assign(new Error('tsc exited 2'), { stdout: diagnostic, stderr: '' });
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const writeBaseline = vi.mocked(fs.writeFileSync);
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('CLI exit');
      });
      process.argv = ['node', scriptPath, mode];

      await expect(import('../scripts/check-test-typecheck.js')).rejects.toThrow('CLI exit');

      expect(exit).toHaveBeenCalledWith(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining(diagnostic));
      expect(stdout).not.toHaveBeenCalled();
      expect(writeBaseline).not.toHaveBeenCalled();
    },
  );

  it('--allow-growth does NOT bypass off-main shrink refusal', async () => {
    // Spec item 1: the guard is now `if (current < previous.errors && !isMainBranch())`
    // — allowGrowth no longer exempts it. Growth only approves increases.
    vi.resetModules();
    // tsc exits 0 with no errors (current=0 < baseline=10 → shrink).
    vi.mocked(execFileSync).mockImplementation((_cmd: string, cmdArgs?: readonly string[] | readonly string[]) => {
      const a = cmdArgs as string[] | undefined;
      // git rev-parse --abbrev-ref HEAD → off-main branch
      if (a && a.includes('--abbrev-ref')) return 'feature-branch\n' as never;
      // tsc call: exits 0, no output (zero errors)
      return '' as never;
    });
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ errors: 10 }));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const writeBaseline = vi.mocked(fs.writeFileSync);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('CLI exit'); });
    // --update --allow-growth --reason: must still refuse the shrink off-main.
    process.argv = ['node', scriptPath, '--update', '--allow-growth', '--reason', 'intentional'];

    await expect(import('../scripts/check-test-typecheck.js')).rejects.toThrow('CLI exit');

    expect(exit).toHaveBeenCalledWith(1);
    const stderrText = stderr.mock.calls.map(([arg]) => String(arg)).join('');
    expect(stderrText).toContain('refusing to lower the baseline off main');
    expect(writeBaseline).not.toHaveBeenCalled();
    void stdout; // not asserted — stderr path is the invariant
  });

  it('--no-shrink skips the off-main shrink refusal with exit 0, baseline unchanged', async () => {
    // Spec item 1: --no-shrink lets regen:generated pass through without aborting
    // when the typecheck count shrank on a feature branch.
    vi.resetModules();
    vi.mocked(execFileSync).mockImplementation((_cmd: string, cmdArgs?: readonly string[] | readonly string[]) => {
      const a = cmdArgs as string[] | undefined;
      if (a && a.includes('--abbrev-ref')) return 'feature-branch\n' as never;
      return '' as never;
    });
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ errors: 10 }));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const writeBaseline = vi.mocked(fs.writeFileSync);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('CLI exit'); });
    process.argv = ['node', scriptPath, '--update', '--no-shrink'];

    await expect(import('../scripts/check-test-typecheck.js')).rejects.toThrow('CLI exit');

    expect(exit).toHaveBeenCalledWith(0);
    const stdoutText = stdout.mock.calls.map(([arg]) => String(arg)).join('');
    expect(stdoutText).toContain('--no-shrink');
    expect(stdoutText).toContain('10'); // baseline count preserved in skip message
    expect(writeBaseline).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('does NOT reject semantic TS1xxx codes (e.g. TS1064)', async () => {
    // TS1064 (async return type) is a semantic diagnostic, not a parser error.
    // It coexists with normal type errors and must pass through to the ratchet,
    // not be routed through the fatal config-diagnostic path.
    vi.resetModules();
    const semanticTS1064 =
      "src/foo.ts:1:1 - error TS1064: The return type of an async function or method must be the global Promise<T> type.";
    const semanticTS2322 = "src/bar.ts:5:3 - error TS2322: Type 'number' is not assignable to type 'string'.";
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error('tsc exited 2'), {
        stdout: `${semanticTS1064}\n${semanticTS2322}`,
        stderr: '',
      });
    });
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ errors: 5 }));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('CLI exit');
    });
    process.argv = ['node', scriptPath, '--check'];

    await expect(import('../scripts/check-test-typecheck.js')).rejects.toThrow('CLI exit');

    // Should NOT hit the config-diagnostic stderr path — it should reach the
    // normal ratchet logic (exit 0 for pass or exit 1 for regression).
    const stderrCalls = stderr.mock.calls.map(([arg]) => String(arg)).join('');
    expect(stderrCalls).not.toContain('option/config diagnostics detected');
  });
});
