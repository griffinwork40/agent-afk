/**
 * Lazy-initialized singleton registry wrapping the discovery engine.
 *
 * The cache is module-level so it survives across calls within one process.
 * resetPromptRegistryCache() is the test seam — call it between tests that
 * need a fresh discovery pass.
 *
 * repoRoot default: walks up from import.meta.url until it finds a
 * package.json with `"name": "agent-afk"`.
 */

import { join, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import type { PromptEntry, PromptKind } from './types.js';
import { discoverPrompts } from './discovery.js';

// ---------------------------------------------------------------------------
// Repo root resolver
// ---------------------------------------------------------------------------

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
        if (pkg.name === 'agent-afk') return dir;
      } catch {
        // malformed package.json — keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  throw new Error(
    `Could not locate agent-afk repo root (no package.json with name "agent-afk" found above ${startDir})`,
  );
}

function defaultRepoRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return findRepoRoot(dirname(thisFile));
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let cache: PromptEntry[] | null = null;

export function resetPromptRegistryCache(): void {
  cache = null;
}

/**
 * Signal that a loader has loaded or reloaded prompts.
 * Invalidates the discovery cache so the next access re-walks the filesystem.
 * Called by individual loaders (prompt-loader, spine-classifier, etc.) via
 * fire-and-forget dynamic imports to avoid circular dependencies at startup.
 */
export function notifyPromptLoaded(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RegistryOptions {
  repoRoot?: string;
  afkHome?: string;
  cwd?: string;
}

export function getPromptRegistry(opts?: RegistryOptions): PromptEntry[] {
  if (cache !== null) return cache;
  const repoRoot = opts?.repoRoot ?? defaultRepoRoot();
  const afkHome = opts?.afkHome ?? join(homedir(), '.afk');
  const cwd = opts?.cwd;
  cache = discoverPrompts({ repoRoot, afkHome, cwd });
  return cache;
}

export function getPromptById(
  id: string,
  opts?: RegistryOptions,
): PromptEntry | undefined {
  return getPromptRegistry(opts).find((e) => e.id === id);
}

export function searchPrompts(
  query: string,
  opts?: RegistryOptions,
): PromptEntry[] {
  const lower = query.toLowerCase();
  return getPromptRegistry(opts).filter((e) => {
    return (
      e.name.toLowerCase().includes(lower) ||
      e.relativePath.toLowerCase().includes(lower) ||
      (e.skill !== undefined && e.skill.toLowerCase().includes(lower)) ||
      (e.phase !== undefined && e.phase.toLowerCase().includes(lower))
    );
  });
}

export function getPromptsByKind(
  kind: PromptKind,
  opts?: RegistryOptions,
): PromptEntry[] {
  return getPromptRegistry(opts).filter((e) => e.kind === kind);
}
