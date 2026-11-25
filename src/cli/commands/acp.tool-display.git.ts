/**
 * `git_read` content classification for ACP tool display. Pure: plans the call
 * with the tool's own argument policy and inspects the argv that would run,
 * never the filesystem or the repository.
 *
 * @module cli/commands/acp.tool-display.git
 */
import path from 'node:path';
import { planGitRead } from '../../agent/tools/git-read.policy.js';

// Contract: the handler runs git in the session cwd, so pathspecs are already
// confined there (the tool rejects others). What can still print file CONTENT
// from elsewhere in the repository is (a) any revision that is not provably a
// commit, since a ref name can point at a blob or tree (D20) and every content
// subcommand then prints it, `diff <blob-ref> -- <file>` included (as removed
// lines; red team round 2); (b) a content subcommand with no pathspec, which
// ranges over the whole repository; (c) rename following and (d) the `%(raw)`
// format atom. The rule is by subcommand class, not by case: a CONTENT
// subcommand is asked whenever any revision is not provably a commit, whatever
// its options or pathspec. A revision is a commit only as `HEAD`/`@` or in a
// commit-peeled form (`<rev>^{commit}`, `<rev>~N`, `<rev>^N`). Metadata
// subcommands are never asked; a subcommand not classified here, or a request
// the tool's own policy refuses (an argument it does not understand), is asked.
const METADATA = new Set([
  'status', 'tag', 'branch', 'rev-parse', 'merge-base', 'rev-list', 'reflog', 'for-each-ref',
  'describe', 'shortlog', 'remote', 'stash', 'worktree', 'ls-files',
]);
/** Every subcommand the tool accepts that can print object (file) content. */
const CONTENT = new Set(['show', 'diff', 'grep', 'blame', 'cat-file', 'log']);
/** Content subcommands whose default scope is already the session cwd. */
const CWD_SCOPED = new Set(['grep', 'blame']);
/** `cat-file` modes that print only an object's type, size or existence. */
const CAT_META = new Set(['-t', '-s', '-e']);
const SUPPRESS_PATCH = new Set(['--stat', '--numstat', '--shortstat', '--name-only', '--name-status', '--summary', '--no-patch', '-s']);
const OBJECT_ID = /^[0-9a-f]{4,64}$/i;
const COMMIT_PEEL = /(?:\^\{commit\}|~\d*|\^\d*)$/;
const RAW_ATOM = /%\(\s*\*?\s*raw/i;

function patchy(opts: readonly string[]): boolean {
  return opts.some((o) => o === '-p' || o === '--patch' || o === '--word-diff'
    || o.startsWith('--unified=') || (o.startsWith('-S') && o.length > 2));
}

/** D20: true only for revisions (and each end of a range) that cannot resolve to a blob or tree. */
export function provablyCommit(rev: string): boolean {
  return rev.split(/\.\.\.?/).every((part) => part === 'HEAD' || part === '@' ||
    (part.length > 0 && !part.includes(':') && !OBJECT_ID.test(part) && COMMIT_PEEL.test(part) && !part.endsWith('^{}')));
}

/** Splits the planned argv into options, revisions and pathspecs. */
function splitArgv(sub: string, rest: readonly string[]): { opts: string[]; revs: string[]; paths: string[] } {
  const sep = rest.lastIndexOf('--');
  const head = sep < 0 ? rest : rest.slice(0, sep);
  const paths = sep < 0 ? [] : rest.slice(sep + 1);
  const opts: string[] = [];
  const revs: string[] = [];
  for (let i = 0; i < head.length; i++) {
    const tok = head[i] ?? '';
    // grep's pattern follows a forced `-e`; it is text, not a revision.
    if (sub === 'grep' && tok === '-e') { i++; continue; }
    (tok.startsWith('-') ? opts : revs).push(tok);
  }
  return { opts, revs, paths };
}

/**
 * True when this `git_read` call can return file content from outside the
 * session cwd, or when the call cannot be classified (fail closed).
 */
export function gitReadReachesOutside(input: Record<string, unknown>, root: string | undefined): boolean {
  const plan = planGitRead(
    { subcommand: input['subcommand'], args: input['args'], paths: input['paths'], pattern: input['pattern'] },
    root ?? path.resolve(path.sep),
  );
  if (!plan.ok) return true;
  const [sub = '', ...rest] = plan.argv;
  // `--format=%(raw)` (for-each-ref, tag, branch) prints the referenced object itself.
  if (rest.some((t) => /^--(?:format|pretty)=/.test(t) && RAW_ATOM.test(t))) return true;
  if (METADATA.has(sub)) return false;
  if (!CONTENT.has(sub)) return true;
  const { opts, revs, paths } = splitArgv(sub, rest);
  // cat-file prints the object it is given (`-p`, or `cat-file <type> <obj>`)
  // unless only its type, size or existence is asked for, of exactly one object.
  if (sub === 'cat-file') return opts.includes('-p') || !opts.some((o) => CAT_META.has(o)) || revs.length !== 1;
  // log walks commits; without patch output it prints commit metadata only.
  if (sub === 'log' && !patchy(opts)) return false;
  if (revs.some((r) => !provablyCommit(r)) || opts.includes('--follow')) return true;
  if ((sub === 'show' || sub === 'diff') && !patchy(opts) && opts.some((o) => SUPPRESS_PATCH.has(o))) return false;
  return paths.length === 0 && !CWD_SCOPED.has(sub);
}
