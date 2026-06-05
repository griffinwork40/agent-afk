/**
 * Resolves the CLI version.
 *
 * In bundled (esbuild) builds, the `__AFK_VERSION__` identifier is replaced at
 * compile time via esbuild's `define` option (see scripts/build-dist.mjs) — so
 * the version is baked into dist/cli.mjs as a string literal.
 *
 * In dev (tsx/ts-node) runs, that define isn't applied, so we fall back to
 * reading package.json from disk. The try/catch guards against any weird
 * runtime where neither path works.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

declare const __AFK_VERSION__: string | undefined;

export function getVersion(): string {
  // Build-time injected literal (esbuild define).
  try {
    if (typeof __AFK_VERSION__ === 'string' && __AFK_VERSION__.length > 0) {
      return __AFK_VERSION__;
    }
  } catch {
    // ReferenceError in environments where the define wasn't applied.
  }

  // Dev fallback: walk up from this file to find package.json.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/cli/version.ts → ../../package.json
    // dist/cli.mjs       → ../package.json  (covered by define above, but safe)
    for (const rel of ['../../package.json', '../package.json']) {
      try {
        const pkg = JSON.parse(readFileSync(join(here, rel), 'utf-8'));
        if (typeof pkg.version === 'string') return pkg.version;
      } catch {
        // try next candidate
      }
    }
  } catch {
    // Unreachable in normal Node runtimes.
  }

  return '0.0.0-unknown';
}
