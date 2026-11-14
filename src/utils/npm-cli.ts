/**
 * Locate npm's JavaScript CLI (`npm-cli.js`) inside the RUNNING Node
 * installation, so npm can be run as `process.execPath npm-cli.js ...`
 * without a shell or a `.cmd` launcher (Node refuses to execFile a `.cmd`
 * without `shell: true` since CVE-2024-27980). Shared by `afk update` and
 * the LSP server installer.
 *
 * @module utils/npm-cli
 */

import { existsSync, realpathSync } from 'fs';
import { basename, dirname, join } from 'path';

/**
 * Locate npm's JavaScript entrypoint in the running Node installation.
 * Calling a sibling npm launcher is insufficient: its env-node shebang can
 * choose a different interpreter and therefore a different global prefix.
 * Fail closed rather than silently installing with an unrelated PATH npm.
 * Explicit npm prefix configuration remains authoritative.
 */
export function resolveNpmCli(
  execPath: string = process.execPath,
  existsFn: (p: string) => boolean = existsSync,
  realpathFn: (p: string) => string = realpathSync,
): string | undefined {
  const nodeDir = dirname(execPath);
  // Homebrew links the Cellar sibling npm to the shared prefix's npm CLI.
  // Resolve that symlink, but never execute a shell/cmd wrapper with Node.
  try {
    const sibling = join(nodeDir, 'npm');
    if (existsFn(sibling)) {
      const cli = realpathFn(sibling);
      if (basename(cli) === 'npm-cli.js' && existsFn(cli)) return cli;
    }
  } catch {
    // No readable sibling link; try standard npm package layouts below.
  }
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find(existsFn);
}

