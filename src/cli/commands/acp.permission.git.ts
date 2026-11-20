/**
 * `git_read` content classification for the ACP approval policy (profile
 * section 6). Pure: plans the call with the tool's own argument policy and
 * inspects the argv that would run, never the filesystem or the repository.
 *
 * @module cli/commands/acp.permission.git
 */
import path from 'node:path';
import { planGitRead } from '../../agent/tools/git-read.policy.js';

// Contract: the handler runs git in the session cwd, so pathspecs are already
// confined there (the tool rejects others). What can still reach file CONTENT
// elsewhere in the repository is (a) a revision that names a blob or tree
// (`HEAD:../x`, `:0:path`, `HEAD^{tree}`, a bare object id, or ANY ref name,
// since a tag can point at a blob: D20), (b) a content subcommand with no
// pathspec, which ranges over the whole repository, (c) rename following and
// (d) the `%(raw)` format atom, which prints the object a ref names. Those cases
// are asked. A revision counts as a commit only in a commit-peeled form
// (`<rev>^{commit}`, `<rev>~N`, `<rev>^N`), or as `HEAD`/`@`: git refuses to
// store a non-commit in HEAD, so only a write inside the git directory (asked
// when that is outside the session cwd) or a hand-built repository can do it
// (accepted, documented in the profile). `diff` with a pathspec prints nothing
// for blobs (verified against git), so only show and grep need this rule.
// Plain metadata is never asked. A subcommand not classified here, or a
// request the tool's own policy refuses, is asked (fail closed).
const METADATA = new Set([
  'status', 'tag', 'branch', 'rev-parse', 'merge-base', 'rev-list', 'reflog', 'for-each-ref',
  'describe', 'shortlog', 'remote', 'stash', 'worktree', 'ls-files',
]);
/** Content subcommands whose default scope is already the session cwd. */
const CWD_SCOPED = new Set(['grep', 'blame']);
const SUPPRESS_PATCH = new Set(['--stat', '--numstat', '--shortstat', '--name-only', '--name-status', '--summary', '--no-patch', '-s']);
const OBJECT_ID = /^[0-9a-f]{4,64}$/i;
const COMMIT_PEEL = /(?:\^\{commit\}|~\d*|\^\d*)$/;
const RAW_ATOM = /%\(\s*\*?\s*raw/i;

function patchy(opts: readonly string[]): boolean {
  return opts.some((o) => o === '-p' || o === '--patch' || o === '--word-diff'
    || o.startsWith('--unified=') || (o.startsWith('-S') && o.length > 2));
}

/** A revision that may name a blob or tree rather than a commit. */
function namesObject(rev: string): boolean {
  return rev.split(/\.\.\.?/).some((part) => part.includes(':') || (part.includes('^{') && !part.endsWith('^{commit}')) || OBJECT_ID.test(part));
}

/** D20: true only for revisions that cannot resolve to a blob or tree. */
function provablyCommit(rev: string): boolean {
  return rev.split(/\.\.\.?/).every((part) => part === 'HEAD' || part === '@' ||
    (!part.includes(':') && !OBJECT_ID.test(part) && COMMIT_PEEL.test(part) && !part.endsWith('^{}')));
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
  const sep = rest.lastIndexOf('--');
  const head = sep < 0 ? rest : rest.slice(0, sep);
  const paths = sep < 0 ? [] : rest.slice(sep + 1);
  const opts: string[] = [];
  const revs: string[] = [];
  for (let i = 0; i < head.length; i++) {
    const tok = head[i] ?? '';
    if (sub === 'grep' && tok === '-e') { i++; continue; }
    (tok.startsWith('-') ? opts : revs).push(tok);
  }
  const objectRev = revs.some(namesObject);
  const unproven = revs.some((r) => !provablyCommit(r));
  switch (sub) {
    // `cat-file -p` prints whatever object it is given (D20).
    case 'cat-file': return opts.includes('-p');
    // `log` walks commits only: a blob revision is an error, never output.
    case 'log': if (!patchy(opts)) return false; break;
    // `show` and `grep` print a blob a ref names whatever the options or pathspec.
    case 'show': case 'grep': if (unproven) return true; break;
    case 'diff': break;
    case 'blame': break;
    default: return true;
  }
  if ((sub === 'show' || sub === 'diff') && !patchy(opts) && opts.some((o) => SUPPRESS_PATCH.has(o))) return objectRev;
  if (objectRev || opts.includes('--follow')) return true;
  return paths.length === 0 && !CWD_SCOPED.has(sub);
}
