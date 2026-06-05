/**
 * review-pr preflight: deterministically gather PR context for `/review <pr>`.
 *
 * Triggers when the rawArgs of a `/review` invocation looks like a PR
 * reference — a bare integer, `#123`, or a GitHub PR URL. For every other
 * shape of args (`/review HEAD`, `/review --staged`, etc.) returns null so
 * the existing 2-block dispatch path runs unchanged.
 *
 * Deterministic work (no model in the loop):
 *   1. `gh pr view <n> --json …` → metadata   ─┐ run concurrently
 *   2. `gh pr diff <n>`          → artifact    ─┤ (Promise.all, P02)
 *   3. `git status --porcelain`  → dirty-tree  ─┘
 *
 * The manifest hands the model: artifact paths, change stats, file list,
 * working-tree state. Includes an explicit "DO NOT stash/commit/reset"
 * directive so the review skill never mutates the working tree (a real
 * bug observed in production today).
 *
 * Failure isolation: any subprocess that fails (gh not installed, network
 * down, not a PR repo) causes the preflight to return null — the model
 * falls back to its prior bash-spelunking behavior. Preflight must never
 * block a skill from running.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync } from 'fs';
import { join } from 'path';
import type { PreflightContext, PreflightResult, SkillInvocation, SkillPreflight } from './types.js';
import { env } from '../../../config/env.js';

const execFileAsync = promisify(execFile);

/**
 * P03/F08: Reduced from 16 MiB — 4 MiB is sufficient for typical PR diffs
 * and halves the worst-case heap spike per concurrent invocation.
 */
const MAX_BUFFER = 4 * 1024 * 1024; // 4 MiB

/**
 * P03: Per-invocation concurrency guard. Only one `gatherPrState` call runs
 * at a time — concurrent `/review` invocations (e.g. Telegram + REPL) don't
 * stack three × 4 MiB buffers simultaneously. The guard is a simple boolean;
 * a second call while the first is in-flight returns null (falls through to
 * the normal skill path) rather than queuing behind a potentially slow exec.
 */
let gatherInFlight = false;

/**
 * Parse the raw args of `/review <args>` into a PR number, or null if the
 * shape doesn't look like a PR reference. Accepts:
 *   - bare integer: `277`
 *   - hash-prefixed: `#277`
 *   - GitHub URL: `https://github.com/owner/repo/pull/277`
 */
export function parsePrRef(rawArgs: string): string | null {
  const trimmed = rawArgs.trim();
  if (!trimmed) return null;

  // Strip a leading `#` if present.
  if (/^#?\d+$/.test(trimmed)) {
    const pr = trimmed.replace(/^#/, '');
    // F10: range-check — PR numbers must be positive and below 1,000,000.
    const n = parseInt(pr, 10);
    if (!(n > 0 && n < 1_000_000)) {
      throw new Error(`[afk preflight] Invalid PR number: ${pr}. Must be 1–999999.`);
    }
    return pr;
  }

  // GitHub PR URL, with or without trailing slash / query.
  const urlMatch = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
  if (urlMatch && urlMatch[1]) {
    const pr = urlMatch[1];
    // F10: range-check the URL-extracted number.
    const n = parseInt(pr, 10);
    if (!(n > 0 && n < 1_000_000)) {
      throw new Error(`[afk preflight] Invalid PR number in URL: ${pr}. Must be 1–999999.`);
    }
    return pr;
  }

  return null;
}

interface PrMetadata {
  title?: string;
  baseRefName?: string;
  headRefName?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  files?: Array<{ path?: string; additions?: number; deletions?: number }>;
}

interface GatheredState {
  pr: string;
  metadata: PrMetadata | null;
  diffPath: string | null;
  diffLineCount: number | null;
  dirty: boolean;
  dirtyFiles: number;
}

/**
 * Run a command and capture stdout.
 *
 * Returns null on failure or timeout.
 * F11: stderr is captured separately; on non-zero exit, the error message
 * includes sanitized stderr so callers get actionable diagnostics.
 * Sanitization: trim to 200 chars, strip ANSI escapes.
 */
async function tryExec(cmd: string, args: string[], opts?: { cwd?: string; maxBuffer?: number }): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      encoding: 'utf-8',
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      maxBuffer: opts?.maxBuffer ?? MAX_BUFFER,
      timeout: 8_000,
    });
    return stdout;
  } catch (err) {
    // F11: surface sanitized stderr in debug context. The error object from
    // execFile includes `.stderr` when the process exits non-zero; strip ANSI
    // codes and truncate so the message is safe to log.
    if (env.AFK_DEBUG === '1' && err instanceof Error && 'stderr' in err) {
      const raw = String((err as { stderr?: unknown }).stderr ?? '');
      // Strip ANSI escape sequences and truncate to 200 chars.
      const sanitized = raw.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 200).trim();
      if (sanitized) {
        process.stderr.write(`[afk preflight] ${cmd} stderr: ${sanitized}\n`);
      }
    }
    return null;
  }
}

/**
 * Gather PR state. Exposed for testing so the manifest renderer can be
 * exercised against synthetic state without invoking real `gh`.
 *
 * P02: `gh pr view`, `gh pr diff`, and `git status` are all independent —
 * they now run concurrently via `Promise.all` instead of sequentially.
 */
export async function gatherPrState(
  pr: string,
  ctx: PreflightContext,
  deps: {
    exec?: (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<string | null>;
    writeFile?: (path: string, content: string) => void | string;
  } = {},
): Promise<GatheredState> {
  const exec = deps.exec ?? tryExec;
  // C05: writeFile is sync (writeFileSync). Any thrown error propagates to the
  // try/catch in the diff-artifact block below, so write errors ARE surfaced
  // to the caller via the `diffPath === null` signal + model manifest note.
  const writeFile = deps.writeFile ?? ((p, c) => writeFileSync(p, c, 'utf-8'));

  // P02: Run all three independent subprocesses concurrently.
  // External constraint: none depends on the other's output.
  const [metaJson, diff, status] = await Promise.all([
    exec('gh', [
      'pr', 'view', pr,
      '--json', 'title,baseRefName,headRefName,additions,deletions,changedFiles,files',
    ], { cwd: ctx.cwd }),
    exec('gh', ['pr', 'diff', pr], { cwd: ctx.cwd }),
    exec('git', ['status', '--porcelain'], { cwd: ctx.cwd }),
  ]);

  let metadata: PrMetadata | null = null;
  if (metaJson) {
    try {
      metadata = JSON.parse(metaJson) as PrMetadata;
    } catch {
      metadata = null;
    }
  }

  // Write diff artifact. C05: writeFileSync is sync — no await needed.
  // Errors propagate up from writeFile and are caught here; diffPath stays
  // null so the manifest notes the artifact as UNAVAILABLE.
  let diffPath: string | null = null;
  let diffLineCount: number | null = null;
  if (diff !== null) {
    const path = join(ctx.artifactDir, `pr-${pr}.diff`);
    try {
      writeFile(path, diff);
      diffPath = path;
      diffLineCount = diff.trimEnd().split('\n').length;
    } catch {
      // Write failed — model still gets metadata, diffPath stays null.
      // The manifest will note UNAVAILABLE for the artifact.
    }
  }

  // Working-tree state. Read-only — does NOT stash, commit, or mutate.
  const dirtyFiles = status ? status.split('\n').filter((l) => l.trim().length > 0).length : 0;
  const dirty = dirtyFiles > 0;

  return { pr, metadata, diffPath, diffLineCount, dirty, dirtyFiles };
}

/**
 * Escape user-sourced strings for safe interpolation into the XML manifest.
 * Strips CR/LF to prevent line-structure injection; escapes &, <, > to prevent
 * tag injection. Note: " and ' do not need escaping here as none of these
 * values appear in XML attribute position (the `pr=` attribute is digits-only).
 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')   // must be first to avoid double-escaping
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\r\n]/g, '');  // strip CR/LF — newlines break manifest line structure
}

/**
 * Render a compressed manifest block from gathered state. Targets <=400
 * tokens (~1600 chars).
 */
export function renderManifest(state: GatheredState): string {
  const lines: string[] = [];
  lines.push(`<preflight-context skill="review" pr="${state.pr}">`);

  if (state.metadata) {
    const m = state.metadata;
    if (m.title) lines.push(`Title: ${xmlEscape(m.title)}`);
    if (m.baseRefName && m.headRefName) {
      lines.push(`Branch: ${xmlEscape(m.headRefName)} → ${xmlEscape(m.baseRefName)}`);
    }
    const stats: string[] = [];
    if (m.additions !== undefined) stats.push(`+${m.additions}`);
    if (m.deletions !== undefined) stats.push(`-${m.deletions}`);
    if (m.changedFiles !== undefined) stats.push(`${m.changedFiles} file${m.changedFiles === 1 ? '' : 's'}`);
    if (stats.length > 0) lines.push(`Stats: ${stats.join(' / ')}`);

    if (m.files && m.files.length > 0) {
      // Filter pathless entries first so cap slots and "N more" count are accurate.
      const cap = 40;
      const pathFiles = m.files.filter((f): f is typeof f & { path: string } => !!f.path);
      lines.push('Files changed:');
      for (const f of pathFiles.slice(0, cap)) {
        const adds = f.additions !== undefined ? `+${f.additions}` : '';
        const dels = f.deletions !== undefined ? `-${f.deletions}` : '';
        const stat = adds || dels ? ` (${[adds, dels].filter(Boolean).join('/')})` : '';
        lines.push(`  - ${xmlEscape(f.path)}${stat}`);
      }
      if (pathFiles.length > cap) {
        lines.push(`  …and ${pathFiles.length - cap} more (see diff artifact)`);
      }
    }
  } else {
    lines.push('PR metadata: UNAVAILABLE (gh pr view failed — check `gh auth status`)');
  }

  if (state.diffPath && state.diffLineCount !== null) {
    lines.push(`Diff artifact: ${state.diffPath} (${state.diffLineCount} lines)`);
  } else {
    lines.push('Diff artifact: UNAVAILABLE (gh pr diff failed)');
  }

  // Working-tree state. Explicit, model-visible.
  if (state.dirty) {
    lines.push(`Working tree: DIRTY (${state.dirtyFiles} uncommitted change${state.dirtyFiles === 1 ? '' : 's'})`);
    lines.push('  → DO NOT stash, commit, reset, or otherwise mutate the working tree.');
    lines.push('  → Review is read-only. The user is mid-work; preserve their state.');
  } else {
    lines.push('Working tree: clean');
    lines.push('  → Review is read-only. Do not stash, commit, or modify files.');
  }

  lines.push('Capabilities: compose available, subagents available.');
  lines.push('Use the diff artifact path above instead of re-running `gh pr diff`.');
  lines.push('</preflight-context>');

  return lines.join('\n');
}

/**
 * The registered review-pr preflight. Returns null when the args don't
 * look like a PR reference — that's the signal for "fall through, this
 * preflight doesn't apply."
 *
 * P03: Protected by a module-level `gatherInFlight` boolean so concurrent
 * `/review` invocations don't stack multiple 4 MiB exec buffers simultaneously.
 */
export const reviewPrPreflight: SkillPreflight = async (
  inv: SkillInvocation,
  ctx: PreflightContext,
): Promise<PreflightResult | null> => {
  // H2: parsePrRef is inside the try block so invalid PR refs (e.g. `/review 0`)
  // surface as real errors rather than being swallowed silently. parsePrRef can
  // throw for out-of-range PR numbers (F10 range check), so it must live here.

  // P03: concurrency guard — fall through gracefully if already in-flight.
  if (gatherInFlight) return null;
  gatherInFlight = true;
  try {
    const pr = parsePrRef(inv.rawArgs);
    if (!pr) return null;

    const state = await gatherPrState(pr, ctx);
    const manifest = renderManifest(state);

    const artifacts: Record<string, string> = {};
    if (state.diffPath) artifacts['diff'] = state.diffPath;

    return { manifestBlock: manifest, artifacts };
  } finally {
    gatherInFlight = false;
  }
};

/** Reset concurrency guard to false. Test-only. */
export function _resetConcurrencyGuardForTests(): void {
  gatherInFlight = false;
}

/** Arm the concurrency guard to the given value. Test-only. */
export function _setConcurrencyGuardForTests(value: boolean): void {
  gatherInFlight = value;
}
