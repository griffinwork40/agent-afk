/**
 * git read-only argv allowlist for wait_for polling.
 *
 * Invariant: POSITIVE allowlist. A git subcommand or flag not listed here is
 * refused, so write/exec options (`--output`, `--ext-diff`, `-c`, `--exec-path`,
 * `--upload-pack`, `-O`/`--open-files-in-pager`, `--config-env`, …) can never
 * pass — including ones the bash risk classifier rates `safe` because it only
 * matches the leading `git diff`/`git log` words.
 *
 * @module agent/tools/handlers/wait-for-poll-allowlist.git
 */

import { argvAllowed, type ArgvSpec } from './wait-for-poll-allowlist.argv.js';

const set = (words: string): ReadonlySet<string> => new Set(words.trim().split(/\s+/));

/** Diff/log output-shaping flags shared by diff, log and show. None writes a file or runs a program. */
const DIFF_OUTPUT = `--stat --shortstat --numstat --name-only --name-status --summary --raw
  --patch -p -u --no-patch -s --color --no-color --abbrev --abbrev-commit --oneline --format
  --pretty --decorate --no-decorate -z --quiet --exit-code --check --minimal --histogram
  --patience --word-diff --ignore-all-space -w --ignore-space-change -b --ignore-blank-lines
  -U --unified --diff-filter --relative --no-ext-diff --no-textconv --full-index -M -R`;

const GIT_SUBCOMMANDS = new Map<string, ArgvSpec>([
  ['diff', { flags: set(`${DIFF_OUTPUT} --cached --staged --merge-base`), valueShorts: 'U' }],
  ['log', {
    flags: set(`${DIFF_OUTPUT} -n --max-count --skip --since --until --after --before --author
      --committer --grep -S -G -i --all --branches --tags --remotes --graph --follow --no-merges
      --merges --first-parent --reverse --full-diff --date --left-right --topo-order --date-order`),
    valueShorts: 'nUSG', numeric: true,
  }],
  ['show', { flags: set(DIFF_OUTPUT), valueShorts: 'U', numeric: true }],
  ['status', {
    flags: set(`-s --short -b --branch --porcelain --long -v --verbose -u --untracked-files
      --ignored --ahead-behind --no-ahead-behind --renames --no-renames -z --ignore-submodules`),
  }],
  ['ls-files', {
    flags: set(`-c --cached -d --deleted -m --modified -o --others -i --ignored -s --stage -u
      --unmerged -t -z --exclude-standard --error-unmatch --full-name`),
  }],
  ['rev-parse', {
    flags: set(`--short --verify -q --quiet --abbrev-ref --show-toplevel --show-prefix
      --is-inside-work-tree --git-dir --absolute-git-dir --symbolic-full-name`),
  }],
  ['rev-list', { flags: set('--count --all -n --max-count --since --until --first-parent --no-merges --merges --left-right'), valueShorts: 'n' }],
  ['describe', { flags: set('--tags --always --long --abbrev --match --exclude --dirty --exact-match --contains') }],
  ['blame', { flags: set('-L -s -e -w -n --porcelain -p --line-porcelain -l -t --show-name --date'), valueShorts: 'L' }],
  ['grep', {
    flags: set(`-n --line-number -l --files-with-matches -L --files-without-match -i --ignore-case
      -v --invert-match -e -E --extended-regexp -F --fixed-strings -P --perl-regexp -w --word-regexp
      -c --count -q --quiet -A -B -C --cached --untracked -h -H -I --and --or --not --max-depth
      --heading --break --color --no-color`),
    valueShorts: 'eABC',
  }],
  ['cat-file', { flags: set('-t -s -e -p') }],
  // `git branch <name>` CREATES a branch, so no positional argument is allowed
  // (value flags must use the `--flag=value` form).
  ['branch', {
    flags: set('-a --all -r --remotes -v --verbose --list --show-current --contains --merged --no-merged --sort --format --color --no-color'),
    noPositional: true,
  }],
  ['remote', { flags: set('-v --verbose'), noPositional: true }],
  ['stash', { verbs: set('list show'), flags: set(`${DIFF_OUTPUT}`), valueShorts: 'U' }],
  ['worktree', { verbs: set('list'), flags: set('--porcelain -v --verbose -z') }],
  // Read modes only: one of these must be present, and no write flag
  // (`--add`, `--unset`, `--replace-all`, `--edit`, …) is on the list.
  ['config', {
    flags: set('--get --get-all --get-regexp --list -l --local --global --system --show-origin --show-scope --null -z --name-only --type --default'),
    requireAny: set('--get --get-all --get-regexp --list -l'),
  }],
]);

/**
 * Leading global options accepted before the subcommand. Anything else
 * (`-c`, `--config-env`, `--exec-path`, `--git-dir`, `-p`/`--paginate`, …) refuses.
 */
const GIT_GLOBAL_BOOL = set('--no-pager -P --no-optional-locks');

/** True when `argv` (everything after `git`) is a read-only git invocation. */
export function gitArgvAllowed(argv: readonly string[]): boolean {
  let i = 0;
  for (;;) {
    const t = argv[i];
    if (t === '-C' && argv[i + 1] !== undefined) i += 2;
    else if (t !== undefined && GIT_GLOBAL_BOOL.has(t)) i++;
    else break;
  }
  const sub = argv[i];
  const spec = sub === undefined ? undefined : GIT_SUBCOMMANDS.get(sub);
  if (spec === undefined) return false;
  let rest = argv.slice(i + 1);
  if (spec.verbs !== undefined) {
    if (rest[0] === undefined || !spec.verbs.has(rest[0])) return false;
    rest = rest.slice(1);
  }
  const required = spec.requireAny;
  if (required !== undefined && !rest.some((t) => required.has(t.split('=', 1)[0]!))) return false;
  return argvAllowed(rest, spec);
}
