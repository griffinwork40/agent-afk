/**
 * Repo-manifest builder for the what-if prediction engine.
 *
 * Produces a bounded, grounded description of the repository so the analyst
 * model can write probes that reference only real paths.
 *
 * @module whatif/repo-manifest
 */

import * as path from 'node:path';
import { statSync } from 'node:fs';
import { errorMessage } from '../utils/errors.js';
import { execFileAsync } from '../utils/exec-file.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of file paths to include in the prompt sample. */
const MAX_SAMPLE_PATHS = 50;

/** Maximum bytes of path text to include in the prompt sample. */
const MAX_SAMPLE_BYTES = 2048;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepoManifest {
  /** Primary language(s) detected from tracked extensions, e.g. ["TypeScript", "Markdown"]. */
  languages: string[];
  /**
   * Small sample of real tracked paths (capped at MAX_SAMPLE_PATHS / MAX_SAMPLE_BYTES).
   * Used in the prediction prompt.
   */
  paths: string[];
  /**
   * Full set of tracked paths (from git ls-files). Used for path validation.
   * Empty when outside a git repo.
   */
  allPaths: Set<string>;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const EXT_TO_LANG: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  rb: 'Ruby',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  cs: 'C#',
  cpp: 'C++',
  c: 'C',
  swift: 'Swift',
  md: 'Markdown',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  sh: 'Shell',
};

function detectLanguages(paths: string[]): string[] {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const ext = p.split('.').pop()?.toLowerCase() ?? '';
    const lang = EXT_TO_LANG[ext];
    if (lang) {
      counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
  }
  // Return top languages by file count (max 5).
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lang]) => lang);
}

// ---------------------------------------------------------------------------
// isNotGitRepo — classify git exit-code / stderr
// ---------------------------------------------------------------------------

/**
 * Return true when the error looks like "not a git repo" (exit 128, the
 * standard git code for "not a git repo or git not found"). Anything else is
 * an unexpected failure (permissions, timeout, etc.).
 */
function isNotGitRepo(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    // git exits 128 when cwd is not inside a repository.
    return (err as { code: unknown }).code === 128;
  }
  return false;
}

// ---------------------------------------------------------------------------
// buildRepoManifest
// ---------------------------------------------------------------------------

/**
 * Build a repo manifest for `cwd`.
 *
 * Uses `git ls-files` to enumerate tracked paths. Falls back gracefully
 * (empty manifest) when not inside a git repo or when git is unavailable.
 * Logs a warning when git is available but fails for an unexpected reason
 * (permissions, timeout, etc.) so the silent fail-open is observable.
 *
 * The call is async to avoid blocking the event loop on large repositories.
 * No buffer cap is applied — streaming the full path list is safe because
 * the output is split line-by-line (not held in memory as a monolithic
 * string beyond what Node already buffers for execFile).
 */
export async function buildRepoManifest(cwd: string): Promise<RepoManifest> {
  let allLines: string[];

  try {
    const { stdout } = await execFileAsync('git', ['ls-files'], {
      cwd,
      encoding: 'utf8',
      // No maxBuffer cap: the default (1 MB) was the source of ENOBUFS in
      // large repos. Pass Infinity to let Node accumulate the full output.
      maxBuffer: Infinity,
    });
    allLines = stdout.split('\n').filter((l) => l.length > 0);
  } catch (err) {
    if (!isNotGitRepo(err)) {
      // Unexpected failure (permissions, timeout, etc.) — warn so it is
      // visible in logs rather than silently switching grounding off.
      console.warn(
        '[whatif] buildRepoManifest: git ls-files failed unexpectedly; ' +
          'probe grounding is disabled for this run.',
        errorMessage(err),
      );
    }
    // Both "not a git repo" and unexpected errors fall back to an empty
    // manifest so downstream logic (makeSetChecker) passes everything through.
    return { languages: [], paths: [], allPaths: new Set() };
  }

  const allPaths = new Set(allLines);
  const languages = detectLanguages(allLines);

  // Build the prompt sample: cap by count and byte size.
  const sample: string[] = [];
  let byteCount = 0;
  for (const p of allLines) {
    if (sample.length >= MAX_SAMPLE_PATHS) break;
    const lineBytes = p.length + 1; // +1 for newline
    if (byteCount + lineBytes > MAX_SAMPLE_BYTES) break;
    sample.push(p);
    byteCount += lineBytes;
  }

  return { languages, paths: sample, allPaths };
}

// ---------------------------------------------------------------------------
// formatRepoManifest
// ---------------------------------------------------------------------------

/**
 * Format a repo manifest as a prompt section string.
 *
 * Returns an empty string when the manifest has no data (outside git).
 * When data is present, the returned string includes the grounding
 * instruction clause so it is structurally absent when no manifest is
 * injected (finding #5 from the advisory review of #2430).
 */
export function formatRepoManifest(manifest: RepoManifest): string {
  if (manifest.paths.length === 0 && manifest.languages.length === 0) {
    return '';
  }

  const lines: string[] = ['## Repo context'];

  if (manifest.languages.length > 0) {
    lines.push(`Primary language(s): ${manifest.languages.join(', ')}`);
  }

  if (manifest.paths.length > 0) {
    lines.push(
      `Tracked paths (sample, up to ${MAX_SAMPLE_PATHS}):\n${manifest.paths.map((p) => `  ${p}`).join('\n')}`,
    );
  }

  // Grounding instruction: emitted here (with the manifest) so it is
  // structurally absent when no manifest is injected (finding #5 — advisory
  // review of #2430). The system prompt no longer duplicates this clause.
  lines.push(
    'IMPORTANT: probes MUST reference only paths listed in the sample above, ' +
      'or no specific file paths at all. Never invent file names.',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// pathExists (filesystem check)
// ---------------------------------------------------------------------------

/**
 * Check whether a relative path exists in `cwd` on the filesystem.
 * Used by probe-grounding as a secondary validation layer.
 */
export function pathExistsInCwd(cwd: string, relPath: string): boolean {
  try {
    statSync(path.join(cwd, relPath));
    return true;
  } catch {
    return false;
  }
}
