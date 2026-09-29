/**
 * Repo-manifest builder for the what-if prediction engine.
 *
 * Produces a bounded, grounded description of the repository so the analyst
 * model can write probes that reference only real paths.
 *
 * @module whatif/repo-manifest
 */

import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of file paths to include in the prompt sample. */
const MAX_SAMPLE_PATHS = 50;

/** Maximum bytes of path text to include in the prompt sample. */
const MAX_SAMPLE_BYTES = 2048;

/** Maximum bytes returned by git ls-files before we truncate. */
const LS_FILES_MAX_BUFFER = 1_000_000;

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
// buildRepoManifest
// ---------------------------------------------------------------------------

/**
 * Build a repo manifest for `cwd`.
 *
 * Uses `git ls-files` to enumerate tracked paths. Falls back gracefully
 * (empty manifest) when not inside a git repo or when git is unavailable.
 */
export function buildRepoManifest(cwd: string): RepoManifest {
  let allLines: string[];

  try {
    const out = execFileSync('git', ['ls-files'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: LS_FILES_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    allLines = out.split('\n').filter((l) => l.length > 0);
  } catch {
    // Not a git repo or git unavailable — return empty manifest.
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

  lines.push(
    'IMPORTANT: probes must reference only paths from the sample above, or no specific paths at all.',
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
