/** Exercise the real CLI with fatal compiler output, without changing tsconfig. */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
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
});
