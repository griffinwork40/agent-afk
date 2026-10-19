import { describe, expect, it } from 'vitest';
import { detectDestructiveCommands } from './safe-destruct-detect.js';
import { maskHookCommandData } from './hook-command-data.js';
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

  describe('shell comment handling (#3780)', () => {
    it('strips shell comments so trailing # npm publish does not trigger a block', () => {
      expect(detectReleaseBoundaryCommands('echo done # npm publish')).toEqual([]);
      expect(detectDestructiveCommands('echo done # git reset --hard')).toEqual([]);
    });

    it('does not treat # inside quotes as a comment start', () => {
      // Single-quoted: echo is a literalSearch command, so the release
      // detector (stripLiterals) strips the quoted content and it never
      // triggers a pattern.
      expect(detectReleaseBoundaryCommands("echo '# npm publish'")).toEqual([]);
      // The comment stripping itself never touches quoted #. Verify the
      // comment-stripped output still contains the quoted content.
      const cmd = 'echo "text with # in it" # real comment npm publish';
      expect(detectReleaseBoundaryCommands(cmd)).toEqual([]);
    });

    it('does not treat mid-word # as a comment', () => {
      // A # that is not preceded by whitespace is part of the word (e.g. URLs).
      const cmd = 'curl http://example.com/page#npm-publish-section';
      expect(detectReleaseBoundaryCommands(cmd)).toEqual([]);
    });

    it('continues scanning lines after a comment', () => {
      // The comment should not break scanning of subsequent lines.
      expect(detectDestructiveCommands('echo done # harmless\ngit reset --hard'))
        .toContain('git-reset-hard');
      expect(detectReleaseBoundaryCommands('echo done # harmless\nnpm publish'))
        .toContain('npm-publish');
    });
  });

  describe('multiline quoted argument handling (#3780)', () => {
    it('masks multiline single-quoted --body in gh pr create', () => {
      const cmd = "gh pr create --body 'line1\nnpm publish\nline3'";
      expect(detectReleaseBoundaryCommands(cmd)).toEqual([]);
    });

    it('masks multiline single-quoted -m in git commit', () => {
      const cmd = "git commit -m 'first line\nnpm publish\nlast line'";
      expect(detectReleaseBoundaryCommands(cmd)).toEqual([]);
    });

    it('masks multiline double-quoted --body without substitutions', () => {
      const cmd = 'gh pr create --body "line1\nnpm publish\nline3"';
      expect(detectReleaseBoundaryCommands(cmd)).toEqual([]);
    });

    it('preserves multiline double-quoted args with $() substitutions', () => {
      const cmd = 'git commit -m "$(npm publish)\nmore text"';
      expect(detectReleaseBoundaryCommands(cmd)).toContain('npm-publish');
    });

    it('preserves multiline double-quoted args with backtick substitutions', () => {
      const cmd = 'git commit -m "`npm publish`\nmore text"';
      expect(detectReleaseBoundaryCommands(cmd)).toContain('npm-publish');
    });

    it('does not mask multiline args to non-allowlisted commands', () => {
      const cmd = "bash -c 'npm publish\nmore'";
      expect(detectReleaseBoundaryCommands(cmd)).toContain('npm-publish');
    });

    it('does not mask multiline args to non-data flags', () => {
      const cmd = "gh release create --notes 'npm publish\nmore'";
      expect(detectReleaseBoundaryCommands(cmd)).toContain('npm-publish');
    });

    it('masks multiline --title in gh issue create', () => {
      const cmd = "gh issue create --title 'npm publish\nstuff'";
      expect(detectReleaseBoundaryCommands(cmd)).toEqual([]);
    });

    it('handles git commit -m with --message= form across lines', () => {
      const cmd = "git commit --message='first\nnpm publish\nlast'";
      expect(detectReleaseBoundaryCommands(cmd)).toEqual([]);
    });

    it('still detects real operations after a multiline quoted arg', () => {
      const cmd = "git commit -m 'safe body\nno triggers'\nnpm publish";
      expect(detectReleaseBoundaryCommands(cmd)).toContain('npm-publish');
    });
  });

  describe('sequential exempt heredocs and large-scale input (#4031)', () => {
    it('correctly masks multiple sequential exempt heredoc blocks (K=3)', () => {
      const blocks = Array.from({ length: 3 }, (_, k) =>
        `cat >file${k}.txt <<'EOF'\nline-a-${k}\nline-b-${k}\nEOF`);
      const command = blocks.join('\n');
      const result = maskHookCommandData(command);
      const resultLines = result.split('\n');
      // Each heredoc header should be preserved; bodies should be blanked.
      for (let k = 0; k < 3; k++) {
        expect(result).not.toContain(`line-a-${k}`);
        expect(result).not.toContain(`line-b-${k}`);
      }
      // Delimiter lines are preserved.
      expect(resultLines.filter(l => l === 'EOF')).toHaveLength(3);
    });

    it('correctly masks 5 sequential exempt heredoc blocks', () => {
      const blocks = Array.from({ length: 5 }, (_, k) =>
        `tee out${k}.txt <<'EOF'\ndata-${k}\nEOF`);
      const command = blocks.join('\n');
      const result = maskHookCommandData(command);
      for (let k = 0; k < 5; k++) {
        expect(result).not.toContain(`data-${k}`);
      }
      // Should not trigger any false-positive detections.
      expect(detectDestructiveCommands(command)).toEqual([]);
    });

    it('handles large-scale input (50k heredoc lines) without RangeError', () => {
      // This would have hit RangeError with push.apply or blown up with O(K²·B) concat.
      const bodyLines = Array.from({ length: 50_000 }, (_, i) => `line-${i}`).join('\n');
      const command = `cat >big.txt <<'EOF'\n${bodyLines}\nEOF`;
      const start = performance.now();
      const result = maskHookCommandData(command);
      const elapsed = performance.now() - start;
      // Body lines should be blanked.
      expect(result).not.toContain('line-0');
      expect(result).not.toContain('line-49999');
      // Header + blank lines + delimiter.
      const lines = result.split('\n');
      expect(lines[0]).toBe("cat >big.txt <<'EOF'");
      expect(lines[lines.length - 1]).toBe('EOF');
      // Should complete quickly (well under 5s even on slow CI).
      expect(elapsed).toBeLessThan(5000);
    });
  });
});
