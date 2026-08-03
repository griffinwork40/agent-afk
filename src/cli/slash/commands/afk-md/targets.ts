/**
 * Tier resolution + overview rendering for `/afk-md`.
 *
 * Mirrors the discovery rules in `cli/config/afk-md-tier.ts` (the loader) so the
 * overview reports exactly what the model will actually receive — including the
 * two states that silently surprise operators: a tier that exists but is
 * whitespace-only (the loader treats it as ABSENT) and two tiers that resolve to
 * the same file (the loader de-duplicates rather than double-counting).
 *
 * @module cli/slash/commands/afk-md/targets
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { estimateTokens } from '../../../../agent/memory/index.js';
import { getProjectAfkMdPath, getUserAfkMdPath } from '../../../../paths.js';
import { palette } from '../../../palette.js';

/** Which AFK.md tier a subcommand is aimed at. */
export type AfkMdScope = 'user' | 'project';

export interface AfkMdTarget {
  scope: AfkMdScope;
  /** `personal` / `project` — the label used in user-facing output. */
  label: string;
  path: string;
  exists: boolean;
  /** File size in bytes; 0 when absent. */
  bytes: number;
  /** Estimated tokens of the file's trimmed content; 0 when absent or blank. */
  tokens: number;
  /** True when the file exists but trims to nothing — the loader skips it. */
  blank: boolean;
  /**
   * True when this tier resolves to the same file as the other one and the
   * loader therefore ignores it as a duplicate. Only ever set on `project`,
   * matching the loader's dedup direction.
   */
  duplicate: boolean;
}

/** Warn above this estimated token count for the composed overlay. */
export const OVERLAY_TOKEN_WARN_THRESHOLD = 10_000;

function isSameFile(a: string, b: string): boolean {
  if (a === b) return true;
  if (!existsSync(a) || !existsSync(b)) return false;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function inspect(scope: AfkMdScope, path: string, duplicate: boolean): AfkMdTarget {
  const label = scope === 'user' ? 'personal' : 'project';
  if (!existsSync(path)) {
    return { scope, label, path, exists: false, bytes: 0, tokens: 0, blank: false, duplicate };
  }
  let bytes = 0;
  let trimmed = '';
  try {
    bytes = statSync(path).size;
    trimmed = readFileSync(path, 'utf-8').trim();
  } catch {
    // Unreadable is indistinguishable from absent as far as the loader is
    // concerned (readAfkMdCandidate swallows the same error), so report it as a
    // present-but-blank tier rather than crashing the command.
    return { scope, label, path, exists: true, bytes, tokens: 0, blank: true, duplicate };
  }
  return {
    scope,
    label,
    path,
    exists: true,
    bytes,
    tokens: trimmed.length > 0 ? estimateTokens(trimmed) : 0,
    blank: trimmed.length === 0,
    duplicate,
  };
}

/** Resolve both tiers, in loader order (user-scope first). */
export function resolveTargets(cwd: string = process.cwd()): AfkMdTarget[] {
  const userPath = getUserAfkMdPath();
  const projectPath = getProjectAfkMdPath(cwd);
  return [
    inspect('user', userPath, false),
    inspect('project', projectPath, isSameFile(projectPath, userPath)),
  ];
}

/** Pick one tier by scope. */
export function targetFor(scope: AfkMdScope, cwd?: string): AfkMdTarget {
  const found = resolveTargets(cwd).find((t) => t.scope === scope);
  // resolveTargets always returns both scopes, so this is unreachable; the
  // throw exists to satisfy noUncheckedIndexedAccess without a non-null assert.
  if (!found) throw new Error(`unknown AFK.md scope: ${scope}`);
  return found;
}

/** True when this tier actually contributes text to the composed overlay. */
export function contributes(t: AfkMdTarget): boolean {
  return t.exists && !t.blank && !t.duplicate;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** Compact token rendering: 940 → `~940`, 2432 → `~2.4k`. */
export function formatTokens(tokens: number): string {
  return tokens < 1000 ? `~${tokens}` : `~${(tokens / 1000).toFixed(1)}k`;
}

/** One status word per tier, describing what the loader does with it. */
function statusOf(t: AfkMdTarget): string {
  if (!t.exists) return palette.dim('missing');
  if (t.blank) return palette.warning('empty — treated as absent');
  if (t.duplicate) return palette.warning('same file as personal — counted once');
  return palette.success('loaded');
}

/**
 * Render the per-tier table rows. Returns display lines; the caller owns the
 * surrounding headings so this stays reusable by both the overview and the
 * post-reload summary.
 */
export function renderTargetRows(targets: AfkMdTarget[]): string[] {
  const lines: string[] = [];
  for (const t of targets) {
    const size = contributes(t) ? `${formatBytes(t.bytes)}  ${formatTokens(t.tokens)} tok` : '';
    const precedence =
      t.scope === 'project' && contributes(t) ? palette.dim('  ← wins on conflict') : '';
    lines.push(`  ${t.label.padEnd(9)} ${palette.dim(t.path)}`);
    lines.push(`  ${''.padEnd(9)} ${statusOf(t)}${size ? `  ${size}` : ''}${precedence}`);
  }
  return lines;
}
