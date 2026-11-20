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
// directly (`HEAD:../x`, `:0:path`, `HEAD^{tree}`, or a bare object id, which
// may be a blob), (b) a content subcommand with no pathspec, which ranges over
// the whole repository, and (c) rename following. Those cases are asked.
// Plain metadata (status, branch and tag names, commit subjects and stats,
// file names) is never asked. A subcommand not classified here, or a request
// the tool's own policy refuses, is asked (fail closed on what is not understood).
const METADATA = new Set([
  'status', 'tag', 'branch', 'rev-parse', 'merge-base', 'rev-list', 'reflog', 'for-each-ref',
  'describe', 'shortlog', 'remote', 'stash', 'worktree', 'ls-files',
]);
/** Content subcommands whose default scope is already the session cwd. */
const CWD_SCOPED = new Set(['grep', 'blame']);
const SUPPRESS_PATCH = new Set(['--stat', '--numstat', '--shortstat', '--name-only', '--name-status', '--summary', '--no-patch', '-s']);
const OBJECT_ID = /^[0-9a-f]{4,64}$/i;

function patchy(opts: readonly string[]): boolean {
  return opts.some((o) => o === '-p' || o === '--patch' || o === '--word-diff'
    || o.startsWith('--unified=') || (o.startsWith('-S') && o.length > 2));
}

/** A revision that may name a blob or tree rather than a commit. */
function namesObject(rev: string): boolean {
  return rev.split(/\.\.\.?/).some((part) => part.includes(':') || part.includes('^{') || OBJECT_ID.test(part));
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
  switch (sub) {
    case 'cat-file': return opts.includes('-p') && (objectRev || revs.length === 0);
    case 'log': if (!patchy(opts)) return false; break;
    case 'show': case 'diff':
      if (!patchy(opts) && opts.some((o) => SUPPRESS_PATCH.has(o))) return objectRev;
      break;
    case 'grep': case 'blame': break;
    default: return true;
  }
  if (objectRev || opts.includes('--follow')) return true;
  return paths.length === 0 && !CWD_SCOPED.has(sub);
}
