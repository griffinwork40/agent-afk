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
  // Added by #4058:
  'merge-base', 'rev-list', 'reflog', 'for-each-ref', 'describe', 'shortlog',
  'cat-file', 'remote', 'stash', 'worktree',
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
    // `-n` is listed in `flags` (exact-match allowlist) rather than in `valued`
    // because the allowlist checks tokens individually and `-n` takes its value
    // as the *next* positional token, not as a `=`-joined suffix. This is
    // semantically a valued option, not a boolean flag, but it is functionally
    // correct: the count-shorthand normalizer in planGitRead rewrites `-n <N>`
    // into `--max-count=<N>` before checkToken runs, so `-n` alone never
    // reaches git verbatim. The tradeoff (boolean slot for a paired option) was
    // accepted in #4371 because the normalizer makes the behavior correct and
    // the prompt steers models toward `--max-count=` anyway (see schemas.git-read.ts).
    flags: ['--oneline', '--graph', '--decorate', '--all', '--merges', '--no-merges', '--first-parent', '--reverse', '-p', '--patch', '--follow', '-n', '-i', '--regexp-ignore-case', '--not', ...DIFF_FORMAT],
    valued: ['--format=', '--pretty=', '--author=', '--committer=', '--grep=', '--since=', '--until=', '--after=', '--before=', '--max-count=', '--skip=', '--date=', '--unified=', '--diff-filter='],
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
  branch: { flags: ['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current'], valued: ['--sort=', '--contains=', '--merged=', '--no-merged=', '--format='], forced: ['--list', '--no-color'], revs: false },
  blame: { flags: ['-w', '-s', '--porcelain', '--line-porcelain', '-l'], valued: ['-L'], forced: ['--no-textconv'], revs: true },
  'ls-files': { flags: ['--cached', '--others', '-o', '--exclude-standard', '--modified', '-m', '--deleted', '-d', '--stage', '-s'], valued: [], forced: [], revs: false },
  'rev-parse': { flags: ['--abbrev-ref', '--short', '--verify', '--show-toplevel', '--show-prefix', '--is-inside-work-tree', '--symbolic-full-name'], valued: [], forced: [], revs: true },

  // --- subcommands added by #4058 ---

  // merge-base: purely reads the commit graph. --is-ancestor exits 0/1 (true/false),
  // which the handler must treat as success (like grep). No write path exists.
  // --independent/--fork-point omitted: complex semantics, revs alone are sufficient.
  'merge-base': { flags: ['--is-ancestor'], valued: [], forced: [], revs: true },

  // rev-list: walks commit graph, no writes. --objects/--disk-usage omitted (can be
  // very expensive / expose object layout). --stdin omitted (network of stdin).
  'rev-list': { flags: ['--count', '--oneline', '--reverse', '--merges', '--no-merges', '--first-parent', '--ancestry-path', '--topo-order', '--date-order', '--not', '--left-right'], valued: ['--max-count=', '--max-age=', '--min-age=', '--since=', '--until=', '--after=', '--before=', '--format=', '--pretty=', '--author=', '--committer=', '--grep='], forced: [], revs: true },

  // reflog: forced to `show` (the read-only subcommand). `expire`/`delete` are write
  // subcommands and are structurally blocked because `forced` prepends `show` and the
  // model cannot inject a second positional subcommand through the rev allowlist.
  'reflog': { flags: ['--oneline', '--decorate', '--no-walk', '--all'], valued: ['--format=', '--pretty=', '--date=', '--max-count=', '--since=', '--until=', '--after=', '--before='], forced: ['show'], revs: true },

  // for-each-ref: reads refs only, never writes. The signature guard in checkToken
  // already blocks %(signature…) and --sort=signature. --python/--shell/--tcl/--perl
  // omitted (can embed refs into shell-interpreted output; the default plain output
  // is safe). --stdin omitted.
  // revs: true so positional ref-pattern arguments (e.g. `refs/tags/`) pass REV_RE;
  // they match [A-Za-z0-9_./@{}^~:+-]* which covers all valid ref-glob prefixes.
  'for-each-ref': { flags: [], valued: ['--format=', '--sort=', '--count=', '--contains=', '--merged=', '--points-at=', '--no-merged='], forced: [], revs: true },

  // describe: reads tags/commits, no writes. --match= accepts a glob that git
  // interprets internally (no exec). --dirty/--broken omitted (reads working tree
  // state; non-fatal but unnecessary scope expansion).
  'describe': { flags: ['--tags', '--always', '--long', '--exact-match', '--all'], valued: ['--match=', '--abbrev='], forced: [], revs: true },

  // shortlog: summarises log output. When stdin is not a tty git reads commits from
  // stdin; the handler uses execFile (not a shell) so stdin is the default 'pipe'
  // which gets EOF immediately — no hang. We also force a HEAD default in planGitRead
  // so a bare `shortlog` without revs still gets a rev, which triggers the non-stdin
  // path. No write path exists.
  'shortlog': { flags: ['-s', '--summary', '-n', '--numbered', '-e', '--email', '--group=author', '--group=committer'], valued: ['--max-count=', '--since=', '--until=', '--after=', '--before=', '--format=', '--date='], forced: [], revs: true },

  // cat-file: reads object content. --batch*/--batch-all-objects omitted (stream
  // arbitrary objects; would read unrelated refs). --textconv/--filters/--path
  // omitted (can run external programs). -t/-s/-p/-e are safe single-object queries.
  'cat-file': { flags: ['-t', '-s', '-p', '-e'], valued: [], forced: [], revs: true },

  // remote: forced to `-v` (list only). `add`/`set-url`/`remove`/`rename`/`prune`/
  // `update` are write/network subcommands; they are structurally blocked because
  // `forced` prepends `-v` and revs are disabled.
  'remote': { flags: [], valued: [], forced: ['-v'], revs: false },

  // stash: forced to `list` (read-only). `push`/`pop`/`drop`/`clear`/`apply`/`show --index`
  // and other write subcommands are blocked structurally.
  'stash': { flags: [], valued: ['--format=', '--pretty=', '--date='], forced: ['list'], revs: false },

  // worktree: forced to `list` (read-only). `add`/`remove`/`prune`/`move`/`lock`/
  // `unlock` are blocked structurally.
  'worktree': { flags: ['--porcelain', '-z'], valued: [], forced: ['list'], revs: false },
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

/**
 * Subcommands that take no pathspecs and return early before the `--` append.
 * Includes the new forced-subcommand entries (remote, stash, worktree, reflog,
 * for-each-ref) where pathspecs are meaningless or harmful.
 */
const NO_PATH_SUBCOMMANDS = new Set<GitReadSubcommand>([
  'tag', 'branch', 'rev-parse', 'merge-base', 'rev-list',
  'reflog', 'for-each-ref', 'describe', 'shortlog',
  'cat-file', 'remote', 'stash', 'worktree',
]);
// for-each-ref accepts positional ref-pattern args (e.g. refs/tags/) via revs:true,
// but those patterns must NOT be treated as pathspecs — for-each-ref has no path
// semantics. It is in NO_PATH_SUBCOMMANDS so it exits before the confinePathspec loop.

/**
 * Shorthand count flags for the subcommands whose allowlist already admits
 * `--max-count=<N>` (log, shortlog, rev-list, reflog). Models routinely emit
 * the shorthand forms `git log -5`, `git log -n 5`, `git log -n5`; each maps
 * onto the long form here so it lands on the allowlist instead of being
 * rejected. A non-numeric value (`-n abc`, `-nabc`) is rejected — it
 * corresponds to no valid count form, so there is nothing to widen.
 *
 * Note: `reflog` also supports `--max-count=` and therefore receives this
 * normalization, even though it was not listed in the original doc comment.
 *
 * Limitation (item 1): if the first token of `args` equals the subcommand
 * name (e.g. `{subcommand: "show", args: ["show", "HEAD"]}`), it is always
 * dropped as an echoed-subcommand artefact. A branch or tag whose name
 * coincides with a subcommand name (e.g. a branch literally named "show" or
 * "log") will be silently treated as HEAD. Runtime ref-verification during
 * policy checking is intentionally avoided, so this edge case is documented
 * here rather than fixed.
 *
 * Ambiguity (item 3): on shortlog, `-n <digits>` is always interpreted as a
 * count shorthand and normalised to `--max-count=<digits>`. An all-digit short
 * SHA (e.g. `git shortlog -n 1a2b3c` is fine, but `git shortlog -n 12345`)
 * would be treated as a count rather than a revision. This is rare but worth
 * noting if shortlog is ever used with numeric-only short SHAs.
 */
const COUNT_SHORT_RE = /^-(?:n(\d+)|(\d+))$/;

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
  // Models sometimes echo the subcommand into `args` (e.g. `{subcommand:
  // "show", args: ["show", "HEAD"]}`). git would treat the echo as an
  // operand and fail, so drop a leading echo before any other handling.
  const argsIn = rawArgs.length > 0 && rawArgs[0] === subcommand ? rawArgs.slice(1) : rawArgs;
  // Contract: models naturally echo forced tokens (e.g. `git stash list`,
  // `git reflog show`). The policy prepends them unconditionally, so the
  // echo would be rejected as an unlisted option or bare revision. Strip
  // echoed tokens from the pre-separator segment only — post-separator
  // tokens are pathspecs and must never be filtered.
  const forcedTokens = new Set(policy.forced);
  const rawSep = argsIn.indexOf('--');
  const preRaw = rawSep === -1 ? argsIn : argsIn.slice(0, rawSep);
  const postRaw = rawSep === -1 ? [] : argsIn.slice(rawSep + 1);
  const argsClean = forcedTokens.size > 0
    ? preRaw.filter((t) => !forcedTokens.has(t))
    : preRaw;
  // A pattern is only meaningful for grep. Models that fill optional string
  // fields with "" must not trip the grep-only guard below, so an
  // empty/whitespace-only pattern counts as absent for every other subcommand.
  // grep is excluded: whitespace is a legitimate search term there (indentation,
  // literal spaces), and grep's own validation rejects a truly empty pattern.
  const pattern =
    subcommand !== 'grep' && typeof req.pattern === 'string' && req.pattern.trim().length === 0
      ? undefined
      : req.pattern;
  // Accept git's own grammar: a literal `--` in `args` separates revisions
  // from pathspecs. Tokens after it join `paths` and are confined below like
  // any other path, so this widens nothing.
  const preSep = argsClean;
  // Normalise shorthand count flags to `--max-count=<N>` before validation —
  // only where the allowlist already admits --max-count=.
  const args: string[] = [];
  if (subcommand !== 'grep' && policy.valued.includes('--max-count=')) {
    const countOnly = subcommand === 'log' || subcommand === 'rev-list';
    for (let i = 0; i < preSep.length; i++) {
      const tok = preSep[i] ?? '';
      const next = preSep[i + 1];
      const m = COUNT_SHORT_RE.exec(tok);
      if (m !== null) {
        args.push(`--max-count=${m[1] ?? m[2]}`);
        continue;
      }
      if (tok === '-n' && next !== undefined && !next.startsWith('-')) {
        if (!/^\d+$/.test(next)) {
          // Not a count: for shortlog, a bare `-n` without a digit argument
          // means --numbered (a separate flag), so only log/rev-list reject
          // the non-digit pair; shortlog passes both tokens through.
          if (countOnly) return { ok: false, error: `Rejected count flag "-n ${next}": expected a non-negative integer.` };
          args.push(tok, next);
          i++;
        } else {
          args.push(`--max-count=${next}`);
          i++;
        }
      } else if (tok === '-n' && countOnly) {
        // An unpaired -n is meaningless for log/rev-list (they have no
        // --numbered); reject instead of letting it reach git verbatim.
        return { ok: false, error: `Rejected argument "-n": "${subcommand}" expects --max-count=<N> (or -n <N> / -<N>).` };
      } else {
        args.push(tok);
      }
    }
  } else {
    args.push(...preSep);
  }
  const paths = [...fieldPaths, ...postRaw];
  if (paths.length > MAX_ARGS) return { ok: false, error: `"paths" accepts at most ${MAX_ARGS} entries.` };
  for (const tok of args) {
    const err = checkToken(tok, policy, subcommand);
    if (err !== null) return { ok: false, error: err };
  }
  // Invariant: branch --show-current is a read-only query that returns the
  // current branch name. It is incompatible with the forced --list flag
  // (which switches branch to pattern-matching mode). Skip --list when
  // --show-current is present; the safety contract holds because
  // --show-current never creates branches.
  const forced = subcommand === 'branch' && args.includes('--show-current')
    ? policy.forced.filter((f) => f !== '--list')
    : policy.forced;
  const argv: string[] = [subcommand, ...forced];
  if (subcommand === 'grep') {
    if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_TOKEN_LEN || pattern.includes('\0')) {
      return { ok: false, error: 'git grep requires a non-empty "pattern" string.' };
    }
    // git grep wants options, then `-e <pattern>`, then revisions.
    const opts = args.filter((t) => t.startsWith('-'));
    const revs = args.filter((t) => !t.startsWith('-'));
    argv.push(...opts, '-e', pattern, ...revs);
  } else {
    if (pattern !== undefined) return { ok: false, error: '"pattern" is only valid for subcommand "grep".' };
    argv.push(...args);
  }

  // shortlog: if no rev was supplied, inject HEAD so git uses the commit-graph
  // path (not stdin). This prevents a hang when stdin is closed/pipe.
  if (subcommand === 'shortlog' && !args.some((t) => !t.startsWith('-'))) {
    argv.push('HEAD');
  }

  if (NO_PATH_SUBCOMMANDS.has(subcommand)) {
    if (paths.length > 0) return { ok: false, error: `git ${subcommand} takes no paths.` };
    return { ok: true, argv };
  }

  const confined: string[] = [];
  for (const p of paths) {
    const r = confinePathspec(cwd, p);
    if (typeof r !== 'string') return { ok: false, error: r.error };
    confined.push(r);
  }
  argv.push('--', ...confined);
  return { ok: true, argv };
}
