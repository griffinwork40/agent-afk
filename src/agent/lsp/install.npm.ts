/**
 * npm-based install runner for LSP language servers (#4272).
 *
 * Runs:
 *   npm install --prefix <getLspLanguageInstallDir(lang)> --no-audit --no-fund <packages...>
 *
 * The npm executable is resolved cross-platform: `npm.cmd` on win32, `npm`
 * elsewhere. Execution uses `execFile` (not a shell) per the repo's POSIX guard.
 *
 * @module agent/lsp/install.npm
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLspLanguageInstallDir } from '../../paths.lsp.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of one npm install invocation. */
export type NpmInstallResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** Injectable executor type — matches the promisified execFile signature. */
export type NpmExecFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile) as NpmExecFn;

/** Default timeout for npm install: 3 minutes. */
const NPM_INSTALL_TIMEOUT_MS = 180_000;

/** Resolve the npm executable name for the current platform. */
export function resolveNpmBin(_platform: string = process.platform): string {
  return _platform === 'win32' ? 'npm.cmd' : 'npm';
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run `npm install --prefix <dir> --no-audit --no-fund <packages>`.
 *
 * Never throws — all errors are captured in the result.
 *
 * @param language  - Registry language key (used to resolve the install dir).
 * @param packages  - npm package names to install.
 * @param signal    - Optional AbortSignal to cancel the install.
 * @param execFn    - Injectable executor (default: promisified execFile).
 * @param platform  - Injectable platform string (default: process.platform).
 */
export async function runNpmInstall(
  language: string,
  packages: readonly string[],
  signal?: AbortSignal,
  execFn: NpmExecFn = execFileAsync,
  platform: string = process.platform,
): Promise<NpmInstallResult> {
  const installDir = getLspLanguageInstallDir(language);
  const npmBin = resolveNpmBin(platform);
  const args = [
    'install',
    '--prefix', installDir,
    '--no-audit',
    '--no-fund',
    ...packages,
  ];

  try {
    await execFn(npmBin, args, { timeout: NPM_INSTALL_TIMEOUT_MS, signal });
    return { ok: true };
  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, reason: message };
  }
}
