import { join } from 'path';

import { getAfkCacheDir } from './paths.js';

/**
 * Language-server install paths (#4272). Servers AFK installs on the user's
 * behalf live under an AFK-owned cache dir, never in a global prefix:
 *
 *   cache/lsp-servers/<language>/            npm --prefix root for one language
 *   cache/lsp-servers/<language>/node_modules/.bin/<binName>
 *
 * Cache tier (not state) because every byte here is re-downloadable.
 */

const LANGUAGE_SAFE = /^[a-z0-9][a-z0-9_-]*$/;

export function getLspServersDir(): string {
  return join(getAfkCacheDir(), 'lsp-servers');
}

/** @throws if `language` is not a lowercase registry key (path-safety). */
export function getLspLanguageInstallDir(language: string): string {
  if (!LANGUAGE_SAFE.test(language)) {
    throw new Error(`Invalid LSP language key for install path: ${JSON.stringify(language)}`);
  }
  return join(getLspServersDir(), language);
}

/** Path of an npm-installed server binary for `language`. Does not check existence. */
export function getLspInstalledBinPath(language: string, binName: string): string {
  const bin = process.platform === 'win32' ? `${binName}.cmd` : binName;
  return join(getLspLanguageInstallDir(language), 'node_modules', '.bin', bin);
}
