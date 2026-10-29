/**
 * Phase 3 of #3904: repo map summary for the system prompt.
 *
 * Produces a concise, token-efficient structural overview of the project by
 * querying the LSP server for workspace symbols (when available) and falling
 * back to a filesystem glob scan. The result is a plain-text snippet suitable
 * for injection into the `# Environment` section of the system prompt.
 *
 * Design constraints (mirrors phases 1–2):
 *   - Feature flag: same `AFK_LSP_DIAGNOSTICS` env var as phases 1–2.
 *   - Hard timeout: `AFK_LSP_REPO_MAP_TIMEOUT_MS` (default 8000 ms).
 *   - Silent degradation: any error → empty string, never throws.
 *   - Capped output: at most `MAX_SYMBOLS` symbols and `MAX_LINES` lines.
 *   - Filesystem fallback: when LSP is disabled or times out, a directory
 *     scan builds a tree of source files grouped by top-level directory.
 *
 * LSP path: `workspace/symbol` with an empty query returns every known
 * top-level symbol in the project. We group by file and emit
 * `kind(name)` entries, capped and sorted for stability.
 *
 * Filesystem fallback: enumerate `.ts/.tsx/.js/.jsx` source files under
 * `rootDir`, group by first path segment, list up to `MAX_FILES_PER_DIR`
 * files per directory, and truncate with a count if more exist.
 *
 * @module agent/lsp/repo-map
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../config/env.js';
import { LspClient, LspClientError } from './client.js';
import { getLspPool, type LspServerPool } from './pool.js';
import {
  DEFAULT_LSP_CMD,
  typescriptRootFor,
  typescriptSpecFromCommand,
} from './typescript-default.js';
import type { ServerSpec } from './server-spec.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum number of workspace symbols to include in the map. */
export const MAX_SYMBOLS = 200;

/** Maximum lines in the final repo-map string (guards system-prompt size). */
export const MAX_LINES = 80;

/** Files per directory group in the filesystem fallback. */
const MAX_FILES_PER_DIR = 12;

/** Source extensions included by the filesystem fallback. */
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);

/**
 * Interior path segments that should never appear in repo-map output.
 * These are build artifacts / caches that would leak noise into the prompt.
 */
const DENY_SEGMENTS = new Set(['node_modules', 'dist', 'build', '.cache']);

/** Return true when a relative path contains a denied interior segment. */
function hasDeniedSegment(rel: string): boolean {
  return rel.split(/[\\/]/).some((s) => DENY_SEGMENTS.has(s));
}

/** LSP SymbolKind numbers → short labels (subset of the spec). */
const SYMBOL_KIND: Record<number, string> = {
  1: 'file', 2: 'module', 3: 'ns', 4: 'pkg', 5: 'class', 6: 'method',
  7: 'prop', 8: 'field', 9: 'ctor', 10: 'enum', 11: 'iface', 12: 'fn',
  13: 'var', 14: 'const', 15: 'str', 23: 'struct', 26: 'type',
};

// ── Public API ─────────────────────────────────────────────────────────────────

/** Options for `buildRepoMap`. All optional; defaults are production values. */
export interface RepoMapOptions {
  /** Workspace root for the LSP server and filesystem scan. Default: process.cwd(). */
  readonly rootDir?: string;
  /** Total budget in ms. Default: from `AFK_LSP_REPO_MAP_TIMEOUT_MS` or 8000. */
  readonly timeoutMs?: number;
  /** Pool override (tests). */
  readonly pool?: LspServerPool;
  /** Server command override (tests). */
  readonly serverCmd?: readonly string[];
  /** AbortSignal. */
  readonly signal?: AbortSignal;
}

/**
 * Build a repo-map summary string for the system prompt.
 *
 * Returns a non-empty string on success, or `''` on any error/timeout/skip.
 * Never throws.
 */
export async function buildRepoMap(opts: RepoMapOptions = {}): Promise<string> {
  try {
    return await _buildRepoMapUnsafe(opts);
  } catch {
    return '';
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Timeout from env, default 8000 ms. */
function getTimeoutMs(): number {
  const raw = env.AFK_LSP_REPO_MAP_TIMEOUT_MS;
  if (!raw) return 8_000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 8_000;
}

/** Return true when the LSP feature flag is on. */
function isLspEnabled(): boolean {
  const raw = env.AFK_LSP_DIAGNOSTICS;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** Internal (may throw); wrapped by `buildRepoMap`. */
async function _buildRepoMapUnsafe(opts: RepoMapOptions): Promise<string> {
  const rootDir = opts.rootDir ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? getTimeoutMs();

  if (isLspEnabled()) {
    const lspResult = await tryLspMap(rootDir, timeoutMs, opts);
    if (lspResult) return lspResult;
    // LSP enabled but returned no result (timeout/error) → fall through to fs scan.
  }
  // Filesystem fallback runs regardless of the LSP flag: it is the always-available
  // baseline (per design: "when LSP is disabled or times out, a directory scan…").
  return fsMap(rootDir, timeoutMs, opts.signal);
}

// ── LSP path ──────────────────────────────────────────────────────────────────

interface RawSymbol {
  name: string;
  kind: number;
  location?: { uri?: string };
  containerName?: string;
}

/**
 * Query `workspace/symbol` for the empty string, which most servers interpret
 * as "return all indexed symbols". Returns null on any error.
 */
async function tryLspMap(
  rootDir: string,
  timeoutMs: number,
  opts: RepoMapOptions,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  const remainingMs = () => Math.max(0, deadline - Date.now());

  const pool = opts.pool ?? getLspPool();
  const serverCmd = opts.serverCmd ?? DEFAULT_LSP_CMD;
  const spec: ServerSpec = typescriptSpecFromCommand(serverCmd);
  // Contract: typescriptRootFor expects a *file* path and walks from its
  // dirname. We pass a synthetic child so it starts searching inside rootDir
  // itself, not its parent. The sentinel basename is arbitrary.
  const root = typescriptRootFor(path.join(rootDir, '_')) ?? rootDir;

  let client: LspClient;
  try {
    client = await pool.acquire(spec, root, { timeoutMs: remainingMs(), signal: opts.signal });
  } catch {
    return null;
  }
  let release: () => void;
  try {
    release = client.hold();
  } catch {
    // hold() failed after a successful acquire — the client stays in the pool
    // (it was never held) but we cannot proceed without a release guard.
    return null;
  }

  try {
    const raw = await client.request<unknown>(
      'workspace/symbol',
      { query: '' },
      { timeoutMs: remainingMs(), signal: opts.signal },
    );

    if (!Array.isArray(raw) || raw.length === 0) return null;

    return formatLspSymbols(raw as RawSymbol[], rootDir);
  } catch (err) {
    if (env.AFK_DEBUG) {
      const msg = err instanceof LspClientError ? err.message : String(err);
      process.stderr.write(`[afk:repo-map] workspace/symbol failed: ${msg}\n`);
    }
    return null;
  } finally {
    release();
  }
}

/** Format raw LSP symbols into a compact repo-map string. */
function formatLspSymbols(symbols: RawSymbol[], rootDir: string): string {
  // Group top-level symbols by relative file path (skip methods/properties).
  const SKIP_KINDS = new Set([6, 7, 8, 9]); // method, prop, field, ctor
  const byFile = new Map<string, string[]>();
  let totalSymbols = 0;

  for (const sym of symbols) {
    if (SKIP_KINDS.has(sym.kind)) continue;
    const uri = sym.location?.uri;
    if (!uri) continue;
    let filePath: string;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      continue;
    }
    const rel = path.relative(rootDir, filePath).split(path.sep).join('/');
    if (rel.startsWith('..') || hasDeniedSegment(rel)) continue;

    if (!byFile.has(rel)) byFile.set(rel, []);
    const kindLabel = SYMBOL_KIND[sym.kind] ?? '?';
    const safeName = sym.name.replace(/[^a-zA-Z0-9_]/g, '_');
    byFile.get(rel)!.push(`${kindLabel}(${safeName})`);
    totalSymbols++;

    if (totalSymbols >= MAX_SYMBOLS) break;
  }

  if (byFile.size === 0) return '';

  const lines: string[] = ['# Repo map (LSP workspace symbols)'];
  let symbolCount = 0;
  for (const [file, syms] of [...byFile.entries()].sort()) {
    if (lines.length >= MAX_LINES) { lines.push('…(truncated)'); break; }
    const limited = syms.slice(0, 8);
    lines.push(`${file}: ${limited.join(', ')}${syms.length > 8 ? ', …' : ''}`);
    symbolCount += limited.length;
    if (symbolCount >= MAX_SYMBOLS) { lines.push('…(truncated)'); break; }
  }

  return lines.join('\n');
}

// ── Filesystem fallback ────────────────────────────────────────────────────────

/** Glob-based fallback: group source files by top-level directory. */
async function fsMap(
  rootDir: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());

  // Abort after the remaining budget.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), remaining());
  const combined = signal
    ? AbortSignal.any([signal, ctl.signal])
    : ctl.signal;

  const byDir = new Map<string, string[]>();
  try {
    // node:fs/promises glob is available in Node ≥22; fall back gracefully.
    const entries = await globSourceFiles(rootDir, combined);
    for (const rel of entries) {
      if (hasDeniedSegment(rel) || path.basename(rel).startsWith('.')) continue;
      const parts = rel.split(/[\\/]/);
      const dir = parts.length > 1 ? parts[0]! : '.';
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir)!.push(rel);
    }
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }

  if (byDir.size === 0) return '';

  const lines: string[] = ['# Repo map'];
  for (const [dir, files] of [...byDir.entries()].sort()) {
    if (lines.length >= MAX_LINES) { lines.push('…(truncated)'); break; }
    const sorted = files.sort();
    const shown = sorted.slice(0, MAX_FILES_PER_DIR);
    const extra = sorted.length - shown.length;
    const suffix = extra > 0 ? ` (+${extra} more)` : '';
    lines.push(`${dir}/: ${shown.map((f) => f.slice(dir.length + 1)).join(', ')}${suffix}`);
  }

  return lines.join('\n');
}

/** Glob for TypeScript/JavaScript source files under rootDir. */
async function globSourceFiles(rootDir: string, signal: AbortSignal): Promise<string[]> {
  const results: string[] = [];
  // node:fs/promises glob (Node ≥22). We use a dynamic import so older Node
  // versions fall into the catch block above rather than failing at parse time.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fsPromises = await import('node:fs/promises') as any;
  if (typeof fsPromises.glob !== 'function') {
    // Fallback for Node <22: simple readdir walk.
    return walkSourceFiles(rootDir, rootDir, 0, signal);
  }
  // Contract: fs.promises.glob does NOT honour the `signal` option on
  // Node 22/24 — an already-aborted signal still enumerates files. We
  // enforce cancellation manually by checking `signal.aborted` on every
  // iteration and breaking out of the async iterator.
  for await (const entry of fsPromises.glob('**/*.{ts,tsx,js,jsx}', {
    cwd: rootDir,
    exclude: (name: string) => DENY_SEGMENTS.has(name) || name.startsWith('.'),
  })) {
    if (signal.aborted) break;
    results.push(entry as string);
    if (results.length >= MAX_SYMBOLS) break;
  }
  return results;
}

/** Simple recursive walk for Node <22 environments. */
async function walkSourceFiles(
  rootDir: string,
  dir: string,
  depth: number,
  signal: AbortSignal,
): Promise<string[]> {
  if (depth > 6 || signal.aborted) return [];
  const { readdir } = await import('node:fs/promises');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const e of entries) {
    if (signal.aborted) break;
    if (e.name.startsWith('.') || DENY_SEGMENTS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await walkSourceFiles(rootDir, full, depth + 1, signal);
      results.push(...sub);
    } else if (SOURCE_EXTS.has(path.extname(e.name).toLowerCase())) {
      results.push(path.relative(rootDir, full));
    }
    if (results.length >= MAX_SYMBOLS) break;
  }
  return results;
}

