/**
 * Argument policy for the structured read-only `git_read` tool (#3754).
 *
 * Safe by construction, not by denylist: the subcommand comes from a fixed
 * enum, every option token must appear in that subcommand's allowlist (exact
 * match or an allowlisted `--name=` prefix), every other token must look like
 * a revision (never starts with `-`), and pathspecs are confined lexically to
 * the session cwd and passed after `--`. Anything else is REJECTED, so
 * `-c`, `--output`, `--ext-diff`, `--textconv`, `--exec`, `-O`/
 * `--open-files-in-pager`, `--upload-pack` and every option not listed here
 * never reach git.
 *
 * Pure module: no I/O. The handler (`handlers/git-read.ts`) owns execution.
 *
 * @module agent/tools/git-read.policy
 */

import path from 'node:path';

export const GIT_READ_SUBCOMMANDS = [
  'status', 'log', 'diff', 'show', 'grep', 'tag', 'branch', 'blame', 'ls-files', 'rev-parse',
] as const;
export type GitReadSubcommand = (typeof GIT_READ_SUBCOMMANDS)[number];

interface SubcommandPolicy {
  /** Exact option tokens admitted verbatim. */
  flags: readonly string[];
  /** `--name=` prefixes whose value is free text (git never executes it). */
  valued: readonly string[];
  /** Fixed tokens always inserted right after the subcommand. */
  forced: readonly string[];
  /** Whether bare revision tokens are accepted. */
  revs: boolean;
}

const DIFF_FORMAT = ['--stat', '--numstat', '--shortstat', '--name-only', '--name-status', '--summary', '-w', '--ignore-all-space', '--word-diff'];

const POLICIES: Record<GitReadSubcommand, SubcommandPolicy> = {
  status: { flags: ['-s', '--short', '-b', '--branch', '--porcelain', '--porcelain=v1', '--porcelain=v2', '--untracked-files=no', '--untracked-files=normal', '--untracked-files=all', '--ignored'], valued: [], forced: [], revs: false },
  log: {
    flags: ['--oneline', '--graph', '--decorate', '--all', '--merges', '--no-merges', '--first-parent', '--reverse', '-p', '--patch', '--follow', ...DIFF_FORMAT],
    valued: ['--format=', '--pretty=', '--author=', '--committer=', '--grep=', '--since=', '--until=', '--after=', '--before=', '--max-count=', '--skip=', '--date=', '--unified='],
    forced: ['--no-ext-diff', '--no-textconv'], revs: true,
  },
  diff: {
    flags: ['--cached', '--staged', '--merge-base', '-p', '--patch', ...DIFF_FORMAT],
    valued: ['--unified=', '--diff-filter='],
    forced: ['--no-ext-diff', '--no-textconv'], revs: true,
  },
  show: {
    flags: ['--oneline', '--no-patch', '-s', '-p', '--patch', ...DIFF_FORMAT],
    valued: ['--format=', '--pretty=', '--unified=', '--date='],
    forced: ['--no-ext-diff', '--no-textconv'], revs: true,
  },
  grep: { flags: ['-n', '--line-number', '-i', '--ignore-case', '-w', '--word-regexp', '-l', '--files-with-matches', '--count', '-E', '--extended-regexp', '-F', '--fixed-strings', '-I', '--cached', '--untracked'], valued: ['--max-count=', '--max-depth='], forced: ['--no-textconv', '--no-color'], revs: true },
  tag: { flags: [], valued: ['--sort=', '--contains=', '--merged=', '--format='], forced: ['--list'], revs: false },
  branch: { flags: ['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose'], valued: ['--sort=', '--contains=', '--merged=', '--no-merged=', '--format='], forced: ['--list', '--no-color'], revs: false },
  blame: { flags: ['-w', '-s', '--porcelain', '--line-porcelain', '-l'], valued: ['-L'], forced: ['--no-textconv'], revs: true },
  'ls-files': { flags: ['--cached', '--others', '-o', '--exclude-standard', '--modified', '-m', '--deleted', '-d', '--stage', '-s'], valued: [], forced: [], revs: false },
  'rev-parse': { flags: ['--abbrev-ref', '--short', '--verify', '--show-toplevel', '--show-prefix', '--is-inside-work-tree', '--symbolic-full-name'], valued: [], forced: [], revs: true },
};

/** A revision-like token: refs, SHAs, ranges, `HEAD~2`, `@{u}`, `HEAD:path`. Never starts with `-`. */
const REV_RE = /^[A-Za-z0-9_./@{}^~:+][A-Za-z0-9_./@{}^~:+-]*$/;
const MAX_ARGS = 40;
const MAX_TOKEN_LEN = 512;

export interface GitReadRequest {
  subcommand: unknown;
  args?: unknown;
  paths?: unknown;
  pattern?: unknown;
}

export type GitReadPlan = { ok: true; argv: string[] } | { ok: false; error: string };

function asStringArray(v: unknown, field: string): string[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return `"${field}" must be an array of strings.`;
  if (v.length > MAX_ARGS) return `"${field}" accepts at most ${MAX_ARGS} entries.`;
  return v as string[];
}

function checkToken(tok: string, policy: SubcommandPolicy, sub: GitReadSubcommand): string | null {
  if (tok.length === 0 || tok.length > MAX_TOKEN_LEN || tok.includes('\0') || /[\r\n]/.test(tok)) {
    return `Rejected argument ${JSON.stringify(tok.slice(0, 80))}: empty, oversized, or contains control characters.`;
  }
  if (policy.flags.includes(tok)) return null;
  if (policy.valued.some((p) => tok.startsWith(p) && tok.length > p.length)) {
    // `%G?`/`%GS`/… (pretty) and `%(signature…)`/`%(*signature…)` (ref-filter, tag/branch)
    // make git run gpg.program / gpg.ssh.program to verify signatures.
    if (/^--(format|pretty)=/.test(tok) && (/%G/.test(tok) || /%\(\s*\*?\s*signature/i.test(tok))) {
      return `Rejected ${JSON.stringify(tok)}: signature placeholders (%G…, %(signature…)) run an external program.`;
    }
    // Sorting by a `signature` key verifies every ref's signature the same way.
    if (tok.startsWith('--sort=') && /signature/i.test(tok)) {
      return `Rejected ${JSON.stringify(tok)}: sorting by signature runs an external program.`;
    }
    return null;
  }
  if (tok.startsWith('-')) {
    return `Rejected option ${JSON.stringify(tok)} for git ${sub}: not in the read-only allowlist ` +
      `(allowed: ${[...policy.flags, ...policy.valued.map((p) => `${p}<value>`)].join(', ') || 'none'}).`;
  }
  if (!policy.revs) return `git ${sub} takes no revision arguments; got ${JSON.stringify(tok)}.`;
  if (!REV_RE.test(tok)) return `Rejected revision ${JSON.stringify(tok)}: unsupported characters.`;
  return null;
}

/**
 * Confine one pathspec to `cwd`. Rejects absolute paths outside the tree,
 * `..` escapes, and pathspec magic (`:(top)`, `:/`), returning the path
 * relative to `cwd` so git sees no absolute input.
 */
export function confinePathspec(cwd: string, p: string): string | { error: string } {
  if (p.length === 0 || p.length > MAX_TOKEN_LEN || p.includes('\0')) return { error: `Rejected path ${JSON.stringify(p.slice(0, 80))}.` };
  if (p.startsWith(':')) return { error: `Rejected path ${JSON.stringify(p)}: pathspec magic is not allowed.` };
  const root = path.resolve(cwd);
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel === '') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { error: `Rejected path ${JSON.stringify(p)}: outside the session working directory.` };
  }
  return rel.split(path.sep).join('/');
}

/** Validate a request and build the argv that follows the fixed global options. */
export function planGitRead(req: GitReadRequest, cwd: string): GitReadPlan {
  const sub = req.subcommand;
  if (typeof sub !== 'string' || !(GIT_READ_SUBCOMMANDS as readonly string[]).includes(sub)) {
    return { ok: false, error: `"subcommand" must be one of: ${GIT_READ_SUBCOMMANDS.join(', ')}.` };
  }
  const subcommand = sub as GitReadSubcommand;
  const policy = POLICIES[subcommand];
  const rawArgs = asStringArray(req.args, 'args');
  if (typeof rawArgs === 'string') return { ok: false, error: rawArgs };
  const fieldPaths = asStringArray(req.paths, 'paths');
  if (typeof fieldPaths === 'string') return { ok: false, error: fieldPaths };
  // Accept git's own grammar: a literal `--` in `args` separates revisions
  // from pathspecs. Tokens after it join `paths` and are confined below like
  // any other path, so this widens nothing.
  const sep = rawArgs.indexOf('--');
  const args = sep === -1 ? rawArgs : rawArgs.slice(0, sep);
  const paths = sep === -1 ? fieldPaths : [...fieldPaths, ...rawArgs.slice(sep + 1)];
  if (paths.length > MAX_ARGS) return { ok: false, error: `"paths" accepts at most ${MAX_ARGS} entries.` };
  for (const tok of args) {
    const err = checkToken(tok, policy, subcommand);
    if (err !== null) return { ok: false, error: err };
  }
  const argv: string[] = [subcommand, ...policy.forced];
  if (subcommand === 'grep') {
    if (typeof req.pattern !== 'string' || req.pattern.length === 0 || req.pattern.length > MAX_TOKEN_LEN || req.pattern.includes('\0')) {
      return { ok: false, error: 'git grep requires a non-empty "pattern" string.' };
    }
    // git grep wants options, then `-e <pattern>`, then revisions.
    const opts = args.filter((t) => t.startsWith('-'));
    const revs = args.filter((t) => !t.startsWith('-'));
    argv.push(...opts, '-e', req.pattern, ...revs);
  } else {
    if (req.pattern !== undefined) return { ok: false, error: '"pattern" is only valid for subcommand "grep".' };
    argv.push(...args);
  }
  if (subcommand === 'tag' || subcommand === 'branch') {
    // Listing only: the trailing non-option tokens of `--list` are glob patterns, not names to create.
    if (paths.length > 0) return { ok: false, error: `git ${subcommand} takes no paths.` };
    return { ok: true, argv };
  }
  const confined: string[] = [];
  for (const p of paths) {
    const r = confinePathspec(cwd, p);
    if (typeof r !== 'string') return { ok: false, error: r.error };
    confined.push(r);
  }
  if (subcommand === 'rev-parse') {
    if (confined.length > 0) return { ok: false, error: 'git rev-parse takes no paths.' };
    return { ok: true, argv };
  }
  argv.push('--', ...confined);
  return { ok: true, argv };
}
