import { describe, expect, it } from 'vitest';
import { classifyDestructiveGit } from './readonly-bash.tokenizer.js';

// Classifier inputs only: none of these strings is executed by a shell.
// Every block case in the first suite is blocked on main; the #4993 exemptions
// must not open it. The here-string suite is stricter than main in two cases
// (a consumer after a continued pipeline, and an unreadable word fed to a shell).
const verdict = (command: string, blocked: boolean): void => {
  const result = classifyDestructiveGit(command);
  expect(result.destructive, `${command}: ${result.reason ?? 'allowed'}`).toBe(blocked);
};

describe('destructive git: #4993 exemptions need plain literal flags', () => {
  it.each([
    // A shell comment is not an argument.
    'git clean -fd # -n',
    'git clean -fdx # dry run: -n',
    'git clean -f # --dry-run',
    'git restore . # --staged',
    'git restore f # -S',
    "git -c alias.p='!git clean -fd #' p -n",
    // Backslash-newline joins the next line into the same git argv.
    'git restore --staged \\\n-W f',
    'git restore --staged f \\\n--worktree',
    'git clean -n \\\n--no-dry-run -f',
    'git clean -n\\\n--no-dry-run -f',
    // Expansions can supply the destructive flag.
    'w=-W; git restore --staged $w f',
    'git restore --staged $(echo -W) f',
    'git restore --staged `echo -W` f',
    'git clean -n $(echo --no-dry-run)',
    'x=--no-dry-run; git clean -fd -n $x',
    'git restore --staged "$@"',
    'git restore --staged ${w} f',
    'git clean -n {--no-dry-run,-f}',
    'git clean -n *',
    'git restore --staged ./-?',
    '$(echo git) clean -n',
  ])('blocks %s', (command) => verdict(command, true));

  it.each([
    'git clean -n',
    'git clean -nd',
    'git clean --dry-run -fdx',
    'git restore --staged src/a.ts',
    'git restore -S -- src/a.ts',
    'git restore --staged src/a.ts && git status',
    "bash -c 'git clean -n'",
  ])('still allows %s', (command) => verdict(command, false));
});

describe('destructive git: here-strings keep main coverage', () => {
  it.each([
    // The consumer of a here-string pipeline is on the next line.
    "cat <<< 'git checkout main' |\nbash",
    "cat <<< 'git checkout main' &&\nbash",
    "tee /dev/null <<< 'git reset --hard' |\nbash",
    "cat <<< 'git checkout main' |\ntee x | bash",
    // Same-line shell after the here-string pipeline (blocked on main).
    "cat <<< 'git checkout main' && bash",
    "cat <<< 'git checkout main'; bash",
    // Unreadable word with a shell consumer and git in the command.
    "script='git checkout main'; bash <<< \"$script\"",
  ])('blocks %s', (command) => verdict(command, true));

  it.each([
    'grep foo <<< "$x"',
    'read a b <<< "$line"',
    'IFS=, read -ra arr <<< "$csv"',
    'jq . <<< "$json"',
    'cat <<< "$x"',
    'grep x <<< $var',
    'wc -l <<< `ls`',
    'bash <<< "$cmd"',
    "cat <<< 'data' |\ngrep x",
  ])('allows git-free here-string %s', (command) => verdict(command, false));
});
