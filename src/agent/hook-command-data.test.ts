import { describe, expect, it } from 'vitest';
import { detectDestructiveCommands } from './safe-destruct-detect.js';
import { createReleaseBoundaryDetect, detectReleaseBoundaryCommands } from './release-boundary-detect.js';

const payload = 'Mention git reset --hard and npm publish here';
const heredoc = (header: string, body = payload, delimiter = "'EOF'"): string =>
  `${header} <<${delimiter}\n${body}\nEOF`;

// All commands are detector inputs, never executed.
describe('hook command data exemptions (#3762)', () => {
  it.each([
    'git commit -F -', 'git commit --file -',
    'gh pr create --body-file -', 'gh pr edit --body-file -', 'gh pr comment --body-file -',
    'gh issue create --body-file -', 'gh issue edit --body-file -', 'gh issue comment --body-file -',
    'cat >fixtures.txt', 'cat >>journal.txt', 'tee fixtures.txt', 'tee -a journal.txt',
  ])('exempts quoted stdin data for %s', (header) => {
    expect(detectDestructiveCommands(heredoc(header))).toEqual([]);
    expect(detectReleaseBoundaryCommands(heredoc(header))).toEqual([]);
  });

  it.each([
    `git commit -m "${payload}"`, `git commit --message '${payload}'`,
    `git commit --message="${payload}"`, `git -c user.name=Agent commit -m "${payload}"`,
    ...['pr', 'issue'].flatMap((resource) => ['create', 'edit', 'comment'].flatMap((action) =>
      ['--body', '--title'].map((flag) => `gh ${resource} ${action} ${flag} "${payload}"`))),
  ])('exempts an allowlisted quoted argument: %s', (command) => {
    expect(detectDestructiveCommands(command)).toEqual([]);
    expect(detectReleaseBoundaryCommands(command)).toEqual([]);
  });

  it.each(['bash', 'sh', 'zsh', 'python3 -', 'node', 'ruby', 'perl', 'eval', 'xargs', 'unknown'])
    ('retains interpreter/unknown heredoc data for %s', (header) => {
      // Quotes inside executing bodies must not be stripped by the release gate.
      const command = heredoc(header, `run("git reset --hard"); run('npm publish')`);
      expect(detectDestructiveCommands(command)).toContain('git-reset-hard');
      expect(detectReleaseBoundaryCommands(command)).toContain('npm-publish');
    });

  it.each([
    heredoc('cat >fixture.txt', payload, 'EOF'),
    `git commit -F - <<'EOF'\n${payload}`, // unterminated
    `${heredoc('git commit -F -')}\n; git reset --hard; npm publish`,
    `${heredoc('cat >fixture.txt')}\ngit reset --hard; npm publish`,
    heredoc('cat >fixture.txt | bash'),
    heredoc('cat >fixture.txt; bash'),
    `git commit -m "$(git reset --hard; npm publish)"`,
    "git commit -m \"$(bash -c 'git reset --hard; npm publish')\"",
    'gh pr create --body "`git reset --hard; npm publish`"',
    `sh -c 'git commit -m "${payload}"'`,
    `unknown -m "${payload}"`,
    `git status -m "${payload}"`,
    `gh release create --title "${payload}"`,
    `cat "<<'EOF'"\n${payload}\nEOF`,
    `cat <<'EOF'junk\n${payload}\nEOF`,
    `cat <<'EOF' <<'OTHER'\n${payload}\nEOF\nOTHER`,
    `bash -c '\ngit commit -m "${payload}"\n'`,
    `bash -c '\n${heredoc('cat >fixture.txt')}\n'`,
    `bash -c \\\n${heredoc('cat >fixture.txt')}`,
    `cat >fixture.txt <<EOF\n$(git reset --hard; npm publish)\nEOF`,
    heredoc('cat'), // plain stdout forwarding is not the file-writing exemption
    heredoc("cat '>' fixture.txt"), // quoted redirection isn't file writing
    heredoc("git commit -m '-F -'"), // flag-looking message isn't a stdin option
    heredoc("gh pr create --body '--body-file -'"),
    heredoc('cat >fixture.txt | python3'),
    heredoc('tee fixture.txt | node'),
    heredoc('git commit -F - | sh'),
    heredoc('gh pr create --body-file - | xargs'),
    heredoc('env cat >fixture.txt'),
    heredoc('git status -F -'),
    heredoc('gh release create --body-file -'),
    `git commit -m "prefix"'${payload}'`, // mixed quote concatenation stays conservative
    `git commit -m "${payload}`, // unterminated argument
    `git commit -m "$(git reset --hard)"\nnpm publish`,
    `gh issue create --title "$(git reset --hard; npm publish)"`,
    `bash -c '${payload}'`,
  ])('keeps ambiguous/executing syntax visible: %s', (command) => {
    expect(detectDestructiveCommands(command)).toContain('git-reset-hard');
    expect(detectReleaseBoundaryCommands(command)).toContain('npm-publish');
  });

  it('supports tab-stripped and double-quoted delimiters', () => {
    for (const command of [`cat >fixture.txt <<-'EOF'\n\t${payload}\n\tEOF`, heredoc('tee fixture.txt', payload, '"EOF"')]) {
      expect(detectDestructiveCommands(command)).toEqual([]);
      expect(detectReleaseBoundaryCommands(command)).toEqual([]);
    }
  });

  it('never exempts a later real operation based on a message dry-run mention', () => {
    const command = `${heredoc('git commit -F -', '--dry-run')}\nnpm publish`;
    expect(createReleaseBoundaryDetect()({ event: 'PreToolUse', toolName: 'bash', input: { command } }).decision)
      .toBe('block');
  });
});
