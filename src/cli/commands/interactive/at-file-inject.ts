/**
 * `@`-file content injection for REPL user turns.
 *
 * When a user submits a turn containing `@<path>` tokens, this module reads
 * each referenced file and returns its contents as text content blocks to be
 * injected into the user message (after the manifest, before the user's text —
 * see `buildUserPayload`). The `@<path>` token is intentionally LEFT in the
 * user's text so the surrounding sentence stays readable; the file content
 * rides alongside as separate blocks.
 *
 * Path forms are resolved via `resolveQuery` — the same helper the dropdown
 * picker uses — so behavior matches what the user saw while completing:
 *   - `@~/foo`      → $HOME/foo
 *   - `@/etc/hosts` → /etc/hosts          (absolute, verbatim)
 *   - `@src/x.ts`   → <cwd>/src/x.ts       (relative to cwd)
 *
 * Guards (injected content is sent to the model API, so be conservative):
 *   - `AFK_AT_FILE_INJECT=0` disables injection entirely (identity pass).
 *   - Per-file 100 KB / cumulative 400 KB caps — oversized files warn + skip.
 *   - Binary files (a NUL byte anywhere in the file) warn + skip.
 *   - Sensitive paths — credential stores (`.ssh`/`.aws`/`.gnupg`, gcloud, the
 *     AFK config/state tree), secret dotfiles (`.env`/`.netrc`/`.npmrc`),
 *     private keys, and `*.pem`/`*.key` — warn + skip. The check runs against
 *     the SYMLINK-RESOLVED real path (`safeRealpath`), so an innocently named
 *     symlink to a secret cannot bypass it. System config like `/etc/hosts`
 *     is intentionally NOT blocked — reading it is a supported use case.
 *   - Non-regular files (devices/FIFOs) and directories warn + skip, so a
 *     `@/dev/random` reference cannot hang the read.
 *   - Missing / unreadable targets warn + skip; the `@` token is left in the
 *     text untouched, matching the pre-feature behavior.
 *
 * No `@`-tokens in the text → a zero-cost identity pass (empty result).
 */

import { readFileSync, statSync } from 'fs';
import { extname, join } from 'path';
import { homedir } from 'os';
import { resolveQuery } from '../../multi-line-reader.js';
import { safeRealpath } from '../../../agent/tools/handlers/write-denylist.js';

/** Per-file injection ceiling. Files larger than this are skipped with a warning. */
export const AT_FILE_MAX_SIZE_BYTES = 100 * 1024;
/** Cumulative injection ceiling across all `@`-tokens in one turn. */
export const AT_FILE_TOTAL_MAX_BYTES = 400 * 1024;

/**
 * A text content block. Structurally a `TextBlockParam`, so an
 * `AtFileBlock[]` is assignable to `readonly ContentBlockParam[]` without
 * importing the SDK type into this module.
 */
export interface AtFileBlock {
  type: 'text';
  text: string;
}

export interface AtFileInjectResult {
  /** File-content blocks to inject (after manifest, before user text). */
  fileBlocks: AtFileBlock[];
  /** Human-readable, per-token notes for tokens that were not injected. */
  warnings: string[];
}

export interface AtFileInjectOpts {
  /** Base for relative paths. Defaults to `process.cwd()`. */
  rootDir?: string;
  /** Home directory for `~/` expansion. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Environment for the opt-out check. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

// Mirror `FILE_TOKEN_RE` (input-highlight.ts): an `@`-token must follow
// whitespace or buffer start and be followed by whitespace or end, so
// `email@host.com` is never matched. Requires ≥1 path char after `@`.
const AT_TOKEN_RE = /(?<=\s|^)@([~\w./-]+)(?=\s|$)/g;

// Injected content is forwarded to the model API verbatim — never auto-read
// obvious secret stores. Matched (case-insensitively) against the
// symlink-RESOLVED real path so a benign-looking symlink to a secret is still
// caught. `safeRealpath` is shared with the write-side denylist; the patterns
// here are READ-oriented — we deliberately do NOT block `/etc` (reading e.g.
// `@/etc/hosts` is supported); only secret stores/files are denied.
// `.git/config` (credential-helper output, `url.<token>@…insteadOf` rewrites),
// `.git-credentials` (plaintext credential store) and shell history files
// (inline-typed secrets) are denied even though they live in ordinary repos /
// home dirs — see SEC-1, PR #688 review.
const SENSITIVE_RE =
  /(^|\/)\.(ssh|aws|gnupg|kube|docker)(\/|$)|(^|\/)[^/]*\.env(\.[^/]+)?$|(^|\/)\.(netrc|npmrc|pypirc)$|(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$|\.(pem|key|p12|pfx)$|(^|\/)credentials$|(^|\/)\.git\/config$|(^|\/)\.git-credentials$|(^|\/)\.(bash|zsh|fish|sh)_history$/i;

// Secret directories that aren't a single recognizable path segment (so the
// regex above can't catch them). Resolved per call against the effective home.
// `.config/gh` holds the GitHub CLI OAuth token / PAT (hosts.yml) — SEC-1.
const SENSITIVE_DIRS_REL: readonly string[] = [
  '.afk/config',
  '.afk/state',
  '.config/gcloud',
  '.config/gh',
];

/**
 * Smallest backtick fence the body cannot prematurely close: one backtick
 * longer than the longest backtick run in `body` (min 3). Without this a file
 * containing a ``` line would close the wrapper early and let trailing file
 * text escape into the user message as unfenced model instructions.
 */
function fenceFor(body: string): string {
  let longest = 0;
  const runs = body.match(/`+/g);
  if (runs) for (const run of runs) if (run.length > longest) longest = run.length;
  return '`'.repeat(Math.max(3, longest + 1));
}

/** True if `realPath` (already symlink-resolved) points at a secret store. */
function isSensitiveRead(realPath: string, sensitiveDirs: readonly string[]): boolean {
  if (SENSITIVE_RE.test(realPath)) return true;
  for (const dir of sensitiveDirs) {
    if (realPath === dir || realPath.startsWith(dir + '/')) return true;
  }
  return false;
}

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.py': 'python',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.rs': 'rust',
  '.go': 'go',
  '.rb': 'ruby',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cs': 'csharp',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sql': 'sql',
  '.xml': 'xml',
  '.txt': '',
};

function extToLang(ext: string): string {
  return EXT_TO_LANG[ext.toLowerCase()] ?? '';
}

/**
 * Whether `@`-file content injection is enabled. Operators can set
 * `AFK_AT_FILE_INJECT=0` to disable it (e.g. for automated sessions that rely
 * on the agent's `read_file` tool instead of front-loaded file blobs).
 */
export function detectAtFileInject(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['AFK_AT_FILE_INJECT'] !== '0';
}

/**
 * Scan `text` for `@<path>` tokens, read each referenced file, and return the
 * content blocks to inject plus any per-token warnings. Pure with respect to
 * `text` — the input string is never mutated; the token is left in place.
 */
export function expandAtFileTokens(
  text: string,
  opts: AtFileInjectOpts = {},
): AtFileInjectResult {
  // `detectAtFileInject` defaults its `env` to `process.env` when given
  // `undefined`, so the whole-object read stays confined to that one default
  // parameter (the env-access audit's sanctioned injectable-seam pattern).
  const empty: AtFileInjectResult = { fileBlocks: [], warnings: [] };
  if (!detectAtFileInject(opts.env)) return empty;

  const rawPaths: string[] = [];
  for (const m of text.matchAll(AT_TOKEN_RE)) {
    const p = m[1];
    if (p) rawPaths.push(p);
  }
  if (rawPaths.length === 0) return empty;

  const rootDir = opts.rootDir ?? process.cwd();
  const home = opts.homeDir ?? homedir();
  // Symlink-resolved secret dirs (computed once). `safeRealpath` dereferences
  // links the same way each target is resolved below, so prefix matches hold.
  const sensitiveDirs = SENSITIVE_DIRS_REL.map((d) => safeRealpath(join(home, d)));
  const fileBlocks: AtFileBlock[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const rawPath of rawPaths) {
    const { scanDir, leafPrefix } = resolveQuery(rawPath, rootDir, home);
    const absPath = leafPrefix ? join(scanDir, leafPrefix) : scanDir;
    // Resolve symlinks BEFORE every guard so a benign-named link to a secret
    // is caught, and dedupe on the resolved path so `@x` and `@./x` count once.
    const realPath = safeRealpath(absPath);

    if (seen.has(realPath)) continue;
    seen.add(realPath);

    if (isSensitiveRead(realPath, sensitiveDirs)) {
      warnings.push(`@${rawPath}: sensitive path, not injected`);
      continue;
    }

    let stat;
    try {
      stat = statSync(realPath);
    } catch {
      warnings.push(`@${rawPath}: not found, left as text`);
      continue;
    }
    if (stat.isDirectory()) {
      warnings.push(`@${rawPath}: is a directory, skipped`);
      continue;
    }
    if (!stat.isFile()) {
      warnings.push(`@${rawPath}: not a regular file, skipped`);
      continue;
    }
    if (stat.size > AT_FILE_MAX_SIZE_BYTES) {
      warnings.push(
        `@${rawPath}: too large (${Math.round(stat.size / 1024)} KB > 100 KB), skipped`,
      );
      continue;
    }
    if (totalBytes + stat.size > AT_FILE_TOTAL_MAX_BYTES) {
      warnings.push(`@${rawPath}: 400 KB total injection budget exceeded, skipped`);
      continue;
    }

    let buf: Buffer;
    try {
      buf = readFileSync(realPath);
    } catch {
      warnings.push(`@${rawPath}: could not read, skipped`);
      continue;
    }

    // Full-buffer NUL scan (buf is already ≤ the per-file cap, so this is
    // cheap) — a NUL beyond the first 8 KB no longer evades the binary guard.
    if (buf.includes(0)) {
      warnings.push(`@${rawPath}: binary file, skipped`);
      continue;
    }

    totalBytes += stat.size;
    const lang = extToLang(extname(realPath));
    const body = buf.toString('utf8');
    const fence = fenceFor(body);
    fileBlocks.push({
      type: 'text',
      text: `Contents of ${rawPath}:\n${fence}${lang}\n${body}\n${fence}`,
    });
  }

  return { fileBlocks, warnings };
}
