import { describe, expect, it } from 'vitest';
import { classifyDestructiveGit } from './readonly-bash.tokenizer.js';

// Inputs only: never execute destructive commands in these regression tests.
describe('destructive git advisory regressions (#4993)', () => {
  it.each([
    "bash <<< 'git checkout main'",
    'sh <<< "git reset --hard"',
    "sudo -u root bash <<<'git restore .'",
    "cat <<<'git checkout main' | env sh",
    "<<<'git clean -fd' bash",
    "g=git; bash <<<'$g checkout main'",
    "bash <<< 'git checkout main'; echo ok",
    "cat <<<'safe'; bash <<<'git checkout main'",
    "echo ok; bash 0<<<'git checkout main'; cat <<<'safe'",
    "cat <<<'safe'; bash 0<<<'git checkout main'",
    'bash <<< git\\\\ checkout\\\\ main',
    'bash <<< "git \\\"checkout\\\" main"',
    'cat <<< "$(git reset --hard)"',
    "bash <<< $'git checkout main'",
    "script='git checkout main'; bash <<< $script",
  ])('blocks executable here-string: %s', (command) => {
    expect(classifyDestructiveGit(command).destructive).toBe(true);
  });

  it.each([
    "cat <<< 'git checkout main'",
    "bash <<< 'git status'",
    "echo 'bash <<< git checkout main'",
    "cat <<'EOF'\nbash <<<'git checkout main'\nEOF",
  ])('allows non-executing/read-only here-string: %s', (command) => {
    expect(classifyDestructiveGit(command).destructive).toBe(false);
  });

  it.each([
    'git restore --staged file',
    'git restore -S file',
    'git restore --source HEAD --staged -- file',
    'git clean -n', 'git clean --dry-run -fd', 'git clean -ndfx',
    'git -c alias.preview="clean -n" preview',
  ])('allows index-only or dry-run operation: %s', (command) => {
    expect(classifyDestructiveGit(command).destructive).toBe(false);
  });

  it.each([
    'git restore --staged --worktree file', 'git restore -SW file',
    'git restore --staged -W file', 'git restore --worktree --staged file',
    'git restore -- --staged', 'git clean -fd -- -n',
    'git restore --source --staged file', 'git restore --source -S file',
    'git clean -e -n -fd', 'git clean --exclude -n -fd',
    'git clean -fd', 'git clean --excl -n -fd',
    'git restore --staged --work file',
    'git clean -fen -fd',
  ])('does not exempt working-tree changes or option operands: %s', (command) => {
    expect(classifyDestructiveGit(command).destructive).toBe(true);
  });
});
