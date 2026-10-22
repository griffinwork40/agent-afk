/**
 * Built-in language-server registry for #4272 (LSP auto-detect, lane B).
 *
 * Exports:
 *   getServerDefinitions()        — all built-in ServerDefinition entries
 *   definitionForFile(filePath)   — lookup by file extension (case-insensitive)
 *   detectProjectLanguages(root)  — definitions whose rootMarkers exist in root
 *   resolveServer                 — default ResolveServerFn instance
 *   resolveServerWith(deps)       — injectable factory for tests
 *
 * @module agent/lsp/registry
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { env } from '../../config/env.js';
import { getLspInstalledBinPath } from '../../paths.lsp.js';
import type { ResolveResult, ResolveServerFn, ServerDefinition } from './server-spec.js';

// ---------------------------------------------------------------------------
// Built-in definitions
// ---------------------------------------------------------------------------

const DEFINITIONS: readonly ServerDefinition[] = [
  {
    language: 'typescript',
    binName: 'typescript-language-server',
    args: ['--stdio'],
    install: { kind: 'npm', packages: ['typescript-language-server', 'typescript'] },
    languageIds: {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.mts': 'typescript',
      '.cts': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
    },
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
  },
  {
    language: 'python',
    binName: 'pyright-langserver',
    args: ['--stdio'],
    install: { kind: 'npm', packages: ['pyright'] },
    languageIds: {
      '.py': 'python',
      '.pyi': 'python',
    },
    rootMarkers: [
      'pyrightconfig.json',
      'pyproject.toml',
      'setup.py',
      'setup.cfg',
      'requirements.txt',
    ],
    settings: {
      python: {},
      'python.analysis': {
        autoSearchPaths: true,
        useLibraryCodeForTypes: true,
        diagnosticMode: 'openFilesOnly',
      },
    },
  },
  // Data-only entries: no install recipe; detection works when already on PATH.
  {
    language: 'go',
    binName: 'gopls',
    args: [],
    languageIds: { '.go': 'go' },
    rootMarkers: ['go.mod', 'go.sum'],
  },
  {
    language: 'rust',
    binName: 'rust-analyzer',
    args: [],
    languageIds: { '.rs': 'rust' },
    rootMarkers: ['Cargo.toml', 'Cargo.lock'],
  },
  {
    language: 'cpp',
    binName: 'clangd',
    args: [],
    languageIds: {
      '.c': 'c',
      '.h': 'c',
      '.cc': 'cpp',
      '.cpp': 'cpp',
      '.cxx': 'cpp',
      '.hpp': 'cpp',
      '.hxx': 'cpp',
    },
    rootMarkers: ['compile_commands.json', 'CMakeLists.txt', '.clangd'],
  },
];

// ---------------------------------------------------------------------------
// Public API — definitions
// ---------------------------------------------------------------------------

/** Return all built-in server definitions. */
export function getServerDefinitions(): readonly ServerDefinition[] {
  return DEFINITIONS;
}

/**
 * Return the definition whose `languageIds` map contains the extension of
 * `filePath` (case-insensitive). Returns `undefined` for unsupported files.
 */
export function definitionForFile(filePath: string): ServerDefinition | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return undefined;
  return DEFINITIONS.find((d) => ext in d.languageIds);
}

/**
 * Return definitions whose root markers exist directly inside `root`.
 * Used for warm-up / default-on heuristic.
 */
export function detectProjectLanguages(root: string): ServerDefinition[] {
  return DEFINITIONS.filter((def) =>
    def.rootMarkers.some((marker) => {
      try {
        fs.accessSync(path.join(root, marker));
        return true;
      } catch {
        return false;
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Root-marker walk (internal)
// ---------------------------------------------------------------------------

/**
 * Walk upward from `startDir` looking for any of `markers`, stopping at or
 * before `ceiling`. Returns the first directory containing a marker, else
 * `undefined`.
 */
function findRoot(
  startDir: string,
  markers: readonly string[],
  ceiling: string,
  fsStat: (p: string) => boolean,
): string | undefined {
  const top = path.resolve(ceiling);
  let dir = path.resolve(startDir);
  while (true) {
    for (const marker of markers) {
      if (fsStat(path.join(dir, marker))) return dir;
    }
    if (dir === top || !dir.startsWith(top + path.sep)) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined; // fs root
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Injectable factory
// ---------------------------------------------------------------------------

export interface RegistryDeps {
  /** Check whether a path exists (file or dir). Must never throw. */
  readonly fsStat: (p: string) => boolean;
  /**
   * Resolve a bare binary name via PATH. Returns the absolute path when found,
   * or `undefined` when not found. Must never throw.
   */
  readonly pathLookup: (binName: string) => string | undefined;
  /** Override built-in definitions (for unit tests). */
  readonly definitions?: readonly ServerDefinition[];
}

/**
 * Create a `ResolveServerFn` with injected dependencies.
 * The default export `resolveServer` uses real fs and real PATH.
 * Tests inject fakes so no real disk or PATH is consulted.
 */
export function resolveServerWith(deps: RegistryDeps): ResolveServerFn {
  const { fsStat, pathLookup, definitions = DEFINITIONS } = deps;

  return async (filePath: string, sessionRoot?: string): Promise<ResolveResult> => {
    try {
      const ext = path.extname(filePath).toLowerCase();
      if (!ext) return { kind: 'unsupported' };

      const def = definitions.find((d) => ext in d.languageIds);
      if (!def) return { kind: 'unsupported' };

      // Workspace root: nearest ancestor with a root marker, bounded by ceiling.
      const fileDir = path.dirname(path.resolve(filePath));
      const ceiling = sessionRoot ? path.resolve(sessionRoot) : fileDir;
      const markerRoot = findRoot(fileDir, def.rootMarkers, ceiling, fsStat);
      const root = markerRoot ?? sessionRoot ?? fileDir;

      // Binary lookup: AFK install dir first (absolute), then PATH (bare name).
      const afkBin = getLspInstalledBinPath(def.language, def.binName);
      if (fsStat(afkBin)) {
        return {
          kind: 'resolved',
          spec: { definition: def, command: afkBin, args: def.args, source: 'afk-install' },
          root,
        };
      }

      const onPath = pathLookup(def.binName);
      if (onPath !== undefined) {
        return {
          kind: 'resolved',
          spec: { definition: def, command: def.binName, args: def.args, source: 'path' },
          root,
        };
      }

      return { kind: 'missing', definition: def, root };
    } catch {
      // Never throws — any unexpected error degrades to unsupported.
      return { kind: 'unsupported' };
    }
  };
}

// ---------------------------------------------------------------------------
// Default PATH lookup — portable, honours win32 PATHEXT convention
// ---------------------------------------------------------------------------

// Common win32 executable extensions. We do not read PATHEXT from process.env
// because it is not registered in ENV_REGISTRY; instead we use this safe
// fallback subset, which covers all cases the LSP server binaries need.
const WIN32_EXTS = ['.cmd', '.exe', '.bat', '.com'] as const;

/**
 * Find `binName` on PATH (win32: trying .cmd/.exe/.bat/.com). Returns the
 * absolute path, or undefined. Never throws. Exported for the win32
 * shell-free spawn path in client-process.ts.
 */
export function findOnPath(binName: string, platform: NodeJS.Platform = process.platform): string | undefined {
  try {
    const pathVar = env.PATH ?? '';
    const delimiter = platform === 'win32' ? ';' : ':';
    const dirs = pathVar.split(delimiter).filter(Boolean);
    const exts = platform === 'win32' ? WIN32_EXTS : [''];
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = (platform === 'win32' ? path.win32 : path).join(dir, binName + ext);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        } catch {
          // not this one
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function defaultFsStat(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Default `ResolveServerFn` — uses real fs and real PATH. */
export const resolveServer: ResolveServerFn = resolveServerWith({
  fsStat: defaultFsStat,
  pathLookup: (binName) => findOnPath(binName),
});
