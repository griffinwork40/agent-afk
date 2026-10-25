/**
 * npm-based install runner for LSP language servers (#4272).
 *
 * Runs:
 *   npm install --prefix <getLspLanguageInstallDir(lang)> --no-audit --no-fund <packages...>
 *
 * The npm executable is resolved cross-platform: `npm` on POSIX; on win32
 * npm's JS CLI is run as `process.execPath npm-cli.js` because Node refuses
 * to execFile `npm.cmd` without a shell (EINVAL, CVE-2024-27980) and a shell
 * would interpret the arguments (#4293 review C-4). Never uses a shell.
 *
 * Failure reasons are secret-redacted and capped before they leave this
 * module (they are written to the effect ledger and surfaced; review S-3).
 *
 * @module agent/lsp/install.npm
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLspLanguageInstallDir } from '../../paths.lsp.js';
import { resolveNpmCli } from '../../utils/npm-cli.js';
import { redactSecrets } from '../redact-secrets.js';

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

/** Maximum length of a failure reason stored in the ledger / returned. */
export const MAX_FAILURE_REASON_CHARS = 500;

/** Redact secrets from an npm failure message and cap its length. */
export function sanitizeFailureReason(message: string): string {
  const redacted = redactSecrets(message);
  return redacted.length > MAX_FAILURE_REASON_CHARS
    ? `${redacted.slice(0, MAX_FAILURE_REASON_CHARS)}… [truncated]`
    : redacted;
}

/** Executable + leading args for running npm (never through a shell). */
export interface NpmCommand {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * Resolve how to run npm on `platform`: `npm` on POSIX; on win32
 * `execPath <npm-cli.js>` (undefined when npm-cli.js cannot be located).
 */
export function resolveNpmCommand(
  platform: string = process.platform,
  locateCli: () => string | undefined = () => resolveNpmCli(),
  execPath: string = process.execPath,
): NpmCommand | undefined {
  if (platform !== 'win32') return { file: 'npm', args: [] };
  const cli = locateCli();
  return cli === undefined ? undefined : { file: execPath, args: [cli] };
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
 * @param locateCli - Injectable npm-cli.js locator for win32 (tests).
 */
export async function runNpmInstall(
  language: string,
  packages: readonly string[],
  signal?: AbortSignal,
  execFn: NpmExecFn = execFileAsync,
  platform: string = process.platform,
  locateCli?: () => string | undefined,
): Promise<NpmInstallResult> {
  const installDir = getLspLanguageInstallDir(language);
  const npm = resolveNpmCommand(platform, locateCli);
  if (npm === undefined) {
    return { ok: false, reason: 'Could not locate npm in the running Node installation' };
  }
  const args = [
    ...npm.args,
    'install',
    '--prefix', installDir,
    '--no-audit',
    '--no-fund',
    ...packages,
  ];

  try {
    await execFn(npm.file, args, { timeout: NPM_INSTALL_TIMEOUT_MS, signal });
    return { ok: true };
  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, reason: sanitizeFailureReason(message) };
  }
}
