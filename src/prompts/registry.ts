/**
 * PromptRegistry — discovery and cache for all prompt files in the package.
 *
 * # Architecture
 *
 * Discovery is the single source of truth: `getPromptRegistry()` walks known
 * prompt directories under the package root and returns a flat list of
 * `PromptEntry` objects. Results are cached in-process until a loader calls
 * `notifyPromptLoaded()`, which clears the cache so the next call re-walks.
 *
 * Loaders (prompt-loader.ts, spine-classifier.ts, system-prompt.ts,
 * user-skills.ts) call `notifyPromptLoaded()` after they read their files.
 * This keeps discovery as the authority while giving the registry awareness of
 * runtime-loaded prompts that may not yet be flushed to disk (e.g. a freshly
 * installed plugin whose files appeared after the last walk).
 *
 * # Two discovery paths
 *
 *   1. Static walk (this module) — covers everything present at startup.
 *   2. Runtime notification (loaders) — invalidates cache on dynamic loads.
 *
 * # Opts
 *
 * All public functions accept an optional `RegistryOpts` to inject an
 * alternative root for testing (avoids touching the real install tree).
 *
 * @module prompts/registry
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { getSkillsDir } from '../paths.js';
import type { PromptEntry, PromptKind } from './types.js';

export type { PromptEntry, PromptKind };

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** Module-level cache; replaced with null by notifyPromptLoaded(). */
let cache: PromptEntry[] | null = null;

/**
 * Invalidate the registry cache. Call this after loading any prompt at
 * runtime so the next `getPromptRegistry()` call re-discovers all files.
 *
 * Fire-and-forget callers (loaders that run synchronously at import time)
 * should call this via a dynamic import to avoid circular dependency:
 *
 * ```ts
 * import('./registry.js').then(({ notifyPromptLoaded }) => notifyPromptLoaded()).catch(() => undefined);
 * ```
 */
export function notifyPromptLoaded(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RegistryOpts {
  /**
   * Override the package root used for directory walking. Primarily for tests.
   * When omitted, the root is resolved relative to this module's location.
   */
  root?: string;
}

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

function resolvePackageRoot(opts?: RegistryOpts): string {
  if (opts?.root) return opts.root;
  // __dirname at runtime: dist/prompts/ → up two levels → package root
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..');
}

// ---------------------------------------------------------------------------
// Discovery helpers
// ---------------------------------------------------------------------------

function safeReadFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function tokenEstimate(content: string): number {
  return Math.ceil(content.length / 4);
}

function makeEntry(opts: {
  kind: PromptKind;
  sourcePath: string;
  relativePath: string;
  skill?: string;
  phase?: string;
  editable: boolean;
  pinned: boolean;
  injectionContext: string;
}): PromptEntry {
  const filename = basename(opts.sourcePath);
  const nameNoExt = filename.replace(/\.[^.]+$/, '');
  const id = `${opts.kind}:${opts.relativePath}`;

  let cachedContent: string | null = null;

  return {
    id,
    kind: opts.kind,
    name: nameNoExt,
    skill: opts.skill,
    phase: opts.phase,
    sourcePath: opts.sourcePath,
    relativePath: opts.relativePath,
    editable: opts.editable,
    pinned: opts.pinned,
    get tokenEstimate(): number {
      const content = cachedContent ?? safeReadFile(opts.sourcePath) ?? '';
      return tokenEstimate(content);
    },
    injectionContext: opts.injectionContext,
    load(): string {
      if (cachedContent === null) {
        cachedContent = safeReadFile(opts.sourcePath) ?? '';
      }
      return cachedContent;
    },
  };
}

// ---------------------------------------------------------------------------
// Directory walkers
// ---------------------------------------------------------------------------

/** Walk a flat directory of .md files and emit entries of the given kind. */
function walkFlatDir(
  dir: string,
  kind: PromptKind,
  relBase: string,
  opts: {
    skill?: string;
    editable: boolean;
    pinned: boolean;
    injectionContext: (filename: string) => string;
  },
): PromptEntry[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort();
  } catch {
    return [];
  }

  return files.map((filename) => {
    const sourcePath = join(dir, filename);
    const relativePath = `${relBase}/${filename}`;
    const phase = filename.replace(/\.[^.]+$/, '');
    return makeEntry({
      kind,
      sourcePath,
      relativePath,
      skill: opts.skill,
      phase,
      editable: opts.editable,
      pinned: opts.pinned,
      injectionContext: opts.injectionContext(filename),
    });
  });
}

/** Walk skills/<name>/prompts/ for every skill directory. */
function walkSkillPrompts(
  skillsRoot: string,
  kind: PromptKind,
  editable: boolean,
  pinned: boolean,
): PromptEntry[] {
  if (!existsSync(skillsRoot)) return [];
  let skillDirs: string[];
  try {
    skillDirs = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }

  const entries: PromptEntry[] = [];
  for (const skillName of skillDirs) {
    const promptsDir = join(skillsRoot, skillName, 'prompts');
    if (!existsSync(promptsDir)) continue;

    const relBase = `skills/${skillName}/prompts`;
    entries.push(
      ...walkFlatDir(promptsDir, kind, relBase, {
        skill: skillName,
        editable,
        pinned,
        injectionContext: (filename) =>
          `injected as phase prompt for skill "${skillName}" (${filename})`,
      }),
    );
  }
  return entries;
}

/** Discover a user SKILL.md file as a user-skill entry. */
function walkUserSkillMds(userSkillsRoot: string): PromptEntry[] {
  if (!existsSync(userSkillsRoot)) return [];
  let skillDirs: string[];
  try {
    skillDirs = readdirSync(userSkillsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }

  const entries: PromptEntry[] = [];
  for (const skillName of skillDirs) {
    const skillMdPath = join(userSkillsRoot, skillName, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;

    // Distinguish user root from project root by path heuristic.
    const relBase = `user-skills/${skillName}`;
    entries.push(
      makeEntry({
        kind: 'user-skill',
        sourcePath: skillMdPath,
        relativePath: `${relBase}/SKILL.md`,
        skill: skillName,
        editable: true,
        pinned: false,
        injectionContext: `loaded as user skill "${skillName}" from ${userSkillsRoot}`,
      }),
    );
  }
  return entries;
}

/** Attempt to stat a file; returns true if it exists and is a regular file. */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main discovery
// ---------------------------------------------------------------------------

function discover(root: string): PromptEntry[] {
  const entries: PromptEntry[] = [];

  // 1. Framework system prompt (dist/ or src/ root)
  const sysPaths = [
    join(root, 'system-prompt.md'),           // dist/
    join(root, 'src', 'system-prompt.md'),    // src tree (dev)
  ];
  for (const p of sysPaths) {
    if (isFile(p)) {
      entries.push(
        makeEntry({
          kind: 'framework',
          sourcePath: p,
          relativePath: 'system-prompt.md',
          editable: false,
          pinned: false,
          injectionContext: 'framework base system prompt',
        }),
      );
      break; // only one
    }
  }

  // 2. SPINE classifier prompts (src/agent/spine/prompts/ or dist equiv)
  const spineDirs = [
    join(root, 'src', 'agent', 'spine', 'prompts'),
    join(root, 'agent', 'spine', 'prompts'),
  ];
  for (const spineDir of spineDirs) {
    if (existsSync(spineDir)) {
      entries.push(
        ...walkFlatDir(spineDir, 'spine', 'agent/spine/prompts', {
          editable: false,
          pinned: false,
          injectionContext: (f) => `SPINE classifier prompt (${f})`,
        }),
      );
      break;
    }
  }

  // 3. Bundled skill prompts (src/skills/<name>/prompts/)
  const skillsRoots = [
    join(root, 'src', 'skills'),
    join(root, 'skills'),
  ];
  for (const skillsRoot of skillsRoots) {
    if (existsSync(skillsRoot)) {
      entries.push(...walkSkillPrompts(skillsRoot, 'skill-phase', false, false));
      break;
    }
  }

  // 4. Vendored agent prompts (src/skills/_agents/prompts/)
  const agentPromptsDirs = [
    join(root, 'src', 'skills', '_agents', 'prompts'),
    join(root, 'skills', '_agents', 'prompts'),
  ];
  for (const agentsDir of agentPromptsDirs) {
    if (existsSync(agentsDir)) {
      entries.push(
        ...walkFlatDir(agentsDir, 'vendored-agent', 'skills/_agents/prompts', {
          editable: false,
          pinned: true,
          injectionContext: (f) => `vendored agent prompt (${f})`,
        }),
      );
      break;
    }
  }

  // 5. User-skill SKILL.md files from ~/.afk/skills/ — optional, best-effort.
  // getSkillsDir() reads $AFK_HOME via env.ts (the mandatory env indirection).
  try {
    const userSkillsRoot = getSkillsDir();
    entries.push(...walkUserSkillMds(userSkillsRoot));
  } catch {
    // getSkillsDir() can throw when $AFK_HOME is misconfigured; skip gracefully.
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return all discovered prompt entries, using the in-process cache.
 * Call `notifyPromptLoaded()` or `resetPromptRegistryCache()` to invalidate.
 */
export function getPromptRegistry(opts?: RegistryOpts): PromptEntry[] {
  if (cache !== null && opts?.root === undefined) return cache;
  const root = resolvePackageRoot(opts);
  const entries = discover(root);
  if (opts?.root === undefined) cache = entries;
  return entries;
}

/**
 * Look up a single prompt entry by its stable `id` (`${kind}:${relativePath}`).
 * Returns `undefined` when not found.
 */
export function getPromptById(id: string, opts?: RegistryOpts): PromptEntry | undefined {
  return getPromptRegistry(opts).find((e) => e.id === id);
}

/**
 * Search prompt entries by a case-insensitive substring match against `id`,
 * `name`, `skill`, and `injectionContext`.
 */
export function searchPrompts(query: string, opts?: RegistryOpts): PromptEntry[] {
  const q = query.toLowerCase();
  return getPromptRegistry(opts).filter(
    (e) =>
      e.id.toLowerCase().includes(q) ||
      e.name.toLowerCase().includes(q) ||
      (e.skill?.toLowerCase().includes(q) ?? false) ||
      e.injectionContext.toLowerCase().includes(q),
  );
}

/**
 * Return all entries of the given kind.
 */
export function getPromptsByKind(kind: PromptKind, opts?: RegistryOpts): PromptEntry[] {
  return getPromptRegistry(opts).filter((e) => e.kind === kind);
}

/**
 * Reset the in-process cache without loading anything. Alias for
 * `notifyPromptLoaded()` — provided for test teardown symmetry.
 */
export function resetPromptRegistryCache(): void {
  cache = null;
}


