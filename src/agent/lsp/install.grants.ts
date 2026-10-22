/**
 * Persisted per-language install grants for #4272 (LSP auto-install).
 *
 * A grant records that the user has approved installation of a specific
 * language server. Grants persist across sessions so daemon runs can install
 * without re-prompting.
 *
 * Storage: a single JSON file at `getLspGrantsPath()` (state tier, not cache,
 * so a cache wipe does not lose the user's decisions). Writes go through
 * `atomicWriteFileAsync` to prevent corrupt files on crash.
 *
 * @module agent/lsp/install.grants
 */

import { readFile } from 'node:fs/promises';
import { getLspGrantsPath } from '../../paths.lsp.js';
import { atomicWriteFileAsync } from '../../utils/atomic-write.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One persisted grant entry. */
export interface LspInstallGrant {
  /** Lowercase language registry key, e.g. 'typescript'. */
  readonly language: string;
  /** The exact package list that was approved (for auditing). */
  readonly packages: readonly string[];
  /** ISO-8601 timestamp of when the user approved. */
  readonly grantedAt: string;
}

/** Shape of the on-disk JSON file. */
interface GrantsFile {
  readonly v: 1;
  readonly grants: Record<string, LspInstallGrant>;
}

// ---------------------------------------------------------------------------
// Injectable interface (used in tests)
// ---------------------------------------------------------------------------

export interface GrantStore {
  hasGrant(language: string): Promise<boolean>;
  persistGrant(language: string, packages: readonly string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

async function readGrantsFile(path: string): Promise<GrantsFile> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as Record<string, unknown>)['v'] === 1 &&
      typeof (parsed as Record<string, unknown>)['grants'] === 'object'
    ) {
      return parsed as GrantsFile;
    }
  } catch {
    // ENOENT or malformed JSON — treat as empty.
  }
  return { v: 1, grants: {} };
}

/**
 * Default file-backed grant store.
 *
 * @param grantsPath - Override path for tests; defaults to `getLspGrantsPath()`.
 */
export function createGrantStore(grantsPath?: string): GrantStore {
  const path = grantsPath ?? getLspGrantsPath();

  return {
    async hasGrant(language: string): Promise<boolean> {
      const file = await readGrantsFile(path);
      return Object.prototype.hasOwnProperty.call(file.grants, language);
    },

    async persistGrant(language: string, packages: readonly string[]): Promise<void> {
      const file = await readGrantsFile(path);
      const grant: LspInstallGrant = {
        language,
        packages,
        grantedAt: new Date().toISOString(),
      };
      const updated: GrantsFile = {
        v: 1,
        grants: { ...file.grants, [language]: grant },
      };
      await atomicWriteFileAsync(path, JSON.stringify(updated, null, 2));
    },
  };
}
