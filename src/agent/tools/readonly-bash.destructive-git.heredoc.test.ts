import { describe, expect, it } from 'vitest';
import { classifyDestructiveGit } from './readonly-bash.tokenizer.js';

// Classifier inputs only: none of these strings is executed by a shell.
const dangerous = 'git checkout main';
const doc = (header: string, body = dangerous, end = 'EOF'): string =>
  `${header}\n${body}\n${end}`;
const verdict = (command: string, blocked: boolean): void => {
  const result = classifyDestructiveGit(command);
  expect(result.destructive, `${command}: ${result.reason ?? 'allowed'}`).toBe(blocked);
  if (blocked) expect(result.reason).toBeTruthy();
};

describe('destructive git: heredoc data', () => {
  it.each([
    "git commit -F - <<'EOF'",
    "gh pr comment 1 --body-file - <<'EOF'",
    "cat > notes.md <<'EOF'",
    'cat <<EOF', 'tee notes.md <<"EOF"', 'cat <<\\EOF',
    "env cat <<E'O'F", "sudo cat <<'EOF'", 'command cat <<EOF',
    'cat 0<<EOF', 'cat << EOF',
  ])('allows data for %s', (header) => verdict(doc(header), false));

  it.each([
    ["git commit -F - <<'EOF'", 'fix: explain why git checkout main was blocked'],
    ["gh pr comment 1 --body-file - <<'EOF'", 'Run git checkout main first.'],
    ["cat > notes.md <<'EOF'", dangerous],
  ])('allows the reported PR4360 case: %s', (header, body) => verdict(doc(header, body), false));
  it('allows read-only substitutions in unquoted data', () => {
    verdict(doc('cat <<EOF', '$(git status)\n`git diff`'), false);
  });
  it('does not recursively execute quoted data', () => {
    verdict(doc("cat <<'EOF'", `sh -c '${dangerous}'\n$(${dangerous})\n\`${dangerous}\``), false);
  });
  it('strips only tabs for <<-', () => {
    verdict(doc("cat <<-'EOF'", `\t${dangerous}`, '\tEOF'), false);
    verdict(doc('cat <<-EOF', `\t${dangerous}`, '\tEOF'), false);
  });
  it('supports delimiters with spaces and partial quoting', () => {
    verdict(doc("cat <<'END DATA'", dangerous, 'END DATA'), false);
    verdict(doc('cat <<E"ND"', dangerous, 'END'), false);
  });
  it('supports multiple pending and sequential heredocs', () => {
    verdict(`cat <<'A' <<B\n${dangerous}\nA\n${dangerous}\nB`, false);
    verdict(`${doc("cat <<'EOF'")}\n${doc('cat <<EOF')}`, false);
  });
  it('attributes data to its consumer rather than unrelated header commands', () => {
    verdict(doc("echo ok; cat <<'EOF'"), false);
    verdict(doc("cat <<'EOF'; echo ok"), false);
    verdict(doc("cat <<'EOF' > bash"), false);
    verdict(doc("cat <<'EOF'; bash -c 'echo ok'"), false);
    verdict(`cat <<A; sh <<B\n${dangerous}\nA\ngit status\nB`, false);
  });
  it('retains commands before and after data', () => {
    verdict(`${dangerous}; ${doc("cat <<'EOF'", 'data')}`, true);
    verdict(`${doc("cat <<'EOF'", 'data')}\n${dangerous}`, true);
    verdict(doc("git <<'EOF' checkout main", 'data'), true);
  });
  it('does not interpret heredoc operators in quoted arguments or comments', () => {
    verdict(`echo "cat <<'EOF'"\n${dangerous}\nEOF`, true);
    verdict(`echo ok # <<'EOF'\n${dangerous}\nEOF`, true);
    verdict('echo "<<EOF"', false);
  });
});

describe('destructive git: executable heredoc consumers', () => {
  it.each(['bash', 'sh', 'dash', 'zsh', 'ksh', '/bin/bash', 'sudo sh',
    'env bash', 'command sh', 'env -u NAME /bin/sh', 'sudo -u root bash'])
    ('blocks scripts for %s', (shell) => verdict(doc(`${shell} <<'EOF'`), true));
  it.each(['cat <<EOF | bash', "cat <<'EOF' | env sh", 'cat <<EOF | sudo -u root bash',
    "cat <<'EOF' | command /bin/zsh", "if true; then bash <<'EOF'"])
    ('blocks forwarded scripts for %s', (header) => verdict(doc(header), true));
  it('keeps read-only shell heredocs allowed', () => verdict(doc("bash <<'EOF'", 'git status'), false));
  it('classifies nested shell programs with their own heredocs', () => {
    verdict(`bash -c "${doc("cat <<'EOF'")}"`, false);
    verdict(`bash -c "${doc("sh <<'EOF'")}"`, true);
  });
  it('does not loosen positional -c over-blocking', () => {
    verdict(`bash -c 'echo ok' '${dangerous}'`, true);
  });
  it('preserves assignment resolution in shell bodies and expansions', () => {
    verdict(doc("g=git; bash <<'EOF'", '$g checkout main'), true);
    verdict(`g=git\n${doc("sh <<'EOF'", '$g checkout main')}`, true);
    verdict(doc('g=git; cat <<EOF', '$($g checkout main)'), true);
    verdict(doc("g=git; s=sh; $s <<'EOF'", '$g checkout main'), true);
    verdict(`${doc("g=git; sh <<'EOF'", '$g checkout main')}\ng=echo`, true);
    verdict(`${doc('g=git; cat <<EOF', '$($g checkout main)')}\ng=echo`, true);
    verdict(doc("g=git; sh <<'EOF'; g=echo", '$g checkout main'), true);
    verdict(doc('g=git; cat <<EOF; g=echo', '$($g checkout main)'), true);
  });
  it('does not let one data heredoc hide another shell heredoc', () => {
    verdict(`cat <<A; sh <<B\ndata\nA\n${dangerous}\nB`, true);
  });
});

describe('destructive git: heredoc uncertainty fails closed', () => {
  it.each([
    `$(${dangerous})`, `\`${dangerous}\``, `'$( ${dangerous} )'`,
    `"$( ${dangerous} )"`, `$(echo $(${dangerous}))`,
    `$\\\n(${dangerous})`, `$((1 + $(${dangerous})))`,
  ])('blocks executable unquoted expansion: %s', (body) => verdict(doc('cat <<EOF', body), true));
  it('allows escaped expansion markers in unquoted data', () => {
    verdict(doc('cat <<EOF', `\\$(${dangerous})\n\\\`${dangerous}\\\``), false);
  });
  it.each([
    `cat <<'EOF'\n${dangerous}`, `cat <<EOF\n${dangerous}\n EOF`,
    `cat <<-EOF\n${dangerous}\n EOF`, `cat <<$END\n${dangerous}\nEND`,
    `cat <<A <<B\ndata\nA\n${dangerous}`, `unknown <<'EOF'\n${dangerous}\nEOF`,
  ])('does not hide an uncertain body: %s', (command) => verdict(command, true));
  it.each([
    `echo ok # <<'EOF'\n${dangerous}\nEOF`,
    `echo '<<EOF'; ${dangerous}`,
    `s=sh; cat <<'EOF' | $s\n${dangerous}\nEOF`,
    `cat <<EOF\n$(sh -c '${dangerous}')\nEOF`,
    `cat <<EOF\n\`sh -c '${dangerous}'\`\nEOF`,
    `cat <<EOF\n\\\\$(${dangerous})\nEOF`,
    `cat <<EOF\n$((1 + $(sh -c '${dangerous}')))\nEOF`,
    `cat <<EOF\n$(${dangerous}\nEOF`,
    `cat <<EOF\n\`${dangerous}\nEOF`,
    `cat <<'EOF' | xargs sh -c\n${dangerous}\nEOF`,
    `cat <<'EOF' | env -S 'sh -s'\n${dangerous}\nEOF`,
    `cat <<'EOF' | unknown\n${dangerous}\nEOF`,
    `cat <<'EOF' | python3\n${dangerous}\nEOF`,
    `cat <<'EOF' |\n${dangerous}\nEOF\nbash`,
    `cat <<'EOF' |&\n${dangerous}\nEOF\nsh`,
    `bash <<'EOF'\nsh -c '${dangerous}'\nEOF`,
  ])('preserves executable and ambiguous boundaries: %s', (command) => verdict(command, true));
  it('does not mistake a here-string for a heredoc', () => {
    verdict(`cat <<<'EOF'\n${dangerous}\nEOF`, true);
  });
});
