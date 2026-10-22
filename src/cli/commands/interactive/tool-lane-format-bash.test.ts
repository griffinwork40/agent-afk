import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { stripAnsi } from '../../display.js';
import { palette } from '../../palette.js';
import { findCommandWordSpans, isBashToolName, styleBashCommand } from './tool-lane-format-bash.js';
import { formatToolLine } from './tool-lane-format-args.js';

/** The words the lexer puts at command position, in order. */
function verbs(cmd: string): string[] {
  return findCommandWordSpans(cmd).map((s) => cmd.slice(s.start, s.end));
}

describe('findCommandWordSpans', () => {
  it.each([
    ['cat foo.txt', ['cat']],
    ['curl -sS https://example.com/a/b/c', ['curl']],
    ['rm -rf dist', ['rm']],
    ['git status -s', ['git']],
    ['', []],
  ])('single command: %s', (cmd, expected) => {
    expect(verbs(cmd)).toEqual(expected);
  });

  it.each([
    ['cat x | grep y | wc -l', ['cat', 'grep', 'wc']],
    ['pnpm lint && pnpm test || echo failed', ['pnpm', 'pnpm', 'echo']],
    ['cd repo; ls -la', ['cd', 'ls']],
    ['sleep 1 & curl x', ['sleep', 'curl']],
    ['curl x |& bash', ['curl', 'bash']],
    ['(cd a && make) | tee log', ['cd', 'make', 'tee']],
    ['echo $(date +%s)', ['echo', 'date']],
    ['ls\nrm -rf build', ['ls', 'rm']],
  ])('every command position: %s', (cmd, expected) => {
    expect(verbs(cmd)).toEqual(expected);
  });

  it.each([
    ['sudo rm -rf /', ['sudo', 'rm']],
    ['sudo -u root rm x', ['sudo', 'rm']],
    ['sudo --user root rm x', ['sudo', 'rm']],
    ['env --unset FOO curl x', ['env', 'curl']],
    ['sudo --user=root rm x', ['sudo', 'rm']],
    ['env --unset=FOO curl x', ['env', 'curl']],
    ['env -i FOO=1 BAR=2 node app.js', ['env', 'node']],
    ['FOO=1 node app.js', ['node']],
    ['timeout 30 curl x', ['timeout', 'curl']],
    ['nice -n 10 make', ['nice', 'make']],
    ['find . -name "*.tmp" | xargs -n 1 rm -f', ['find', 'xargs', 'rm']],
    ['/usr/bin/sudo rm x', ['/usr/bin/sudo', 'rm']],
  ])('wrappers expose the wrapped command: %s', (cmd, expected) => {
    expect(verbs(cmd)).toEqual(expected);
  });

  it.each([
    ['echo "a | rm b"', ['echo']],
    ["grep 'x; rm y' file", ['grep']],
    ['echo a\\|b', ['echo']],
    ['echo `rm x` done', ['echo']],
  ])('separators inside quotes or escapes are not command positions: %s', (cmd, expected) => {
    expect(verbs(cmd)).toEqual(expected);
  });

  it.each([
    ['make 2>&1 | tee out', ['make', 'tee']],
    ['cmd > out.txt; next', ['cmd', 'next']],
    ['cmd &>/dev/null && next', ['cmd', 'next']],
    ['cat <<< "hi"', ['cat']],
  ])('redirections and their targets are not commands: %s', (cmd, expected) => {
    expect(verbs(cmd)).toEqual(expected);
  });

  it('skips heredoc bodies and resumes after the terminator', () => {
    const cmd = "git commit -F - <<'EOF'\nfix: rm the thing\nsecond line\nEOF\ngit push";
    expect(verbs(cmd)).toEqual(['git', 'git']);
  });

  it('a truncated heredoc body never highlights', () => {
    expect(verbs('cat <<EOF\nrm -rf x\nmore…')).toEqual(['cat']);
  });

  it.each([
    ['for f in *.ts; do rm "$f"; done', ['rm']],
    ['if [ -f x ]; then cat x; else echo none; fi', ['[', 'cat', 'echo']],
    ['while true; do curl x; done', ['true', 'curl']],
    ['! grep -q x file', ['grep']],
    ['{ ls; pwd; }', ['ls', 'pwd']],
  ])('shell keywords are skipped, the commands they introduce are not: %s', (cmd, expected) => {
    expect(verbs(cmd)).toEqual(expected);
  });

  it('comments are not commands', () => {
    expect(verbs('# rm -rf everything\nls  # then rm')).toEqual(['ls']);
  });

  it('a word cut by truncation is still highlighted', () => {
    expect(verbs('ls && cur…')).toEqual(['ls', 'cur…']);
  });

  it('stays fast on pathological input', () => {
    const cmd = '"'.repeat(20_000) + "'".repeat(20_000) + 'a|'.repeat(20_000);
    const t0 = performance.now();
    findCommandWordSpans(cmd);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('styleBashCommand', () => {
  let originalLevel: typeof chalk.level;
  beforeEach(() => {
    // The suite runs non-TTY, where the palette collapses to identity and
    // every styling assertion would be vacuous.
    originalLevel = chalk.level;
    chalk.level = 3;
  });
  afterEach(() => {
    chalk.level = originalLevel;
  });

  it('renders command words in toolVerb and the rest in toolArg', () => {
    expect(styleBashCommand('cat x | grep y')).toBe(
      palette.toolVerb('cat') + palette.toolArg(' x | ') + palette.toolVerb('grep') + palette.toolArg(' y'),
    );
  });

  it('is exactly the old toolArg rendering when there is no command word', () => {
    expect(styleBashCommand('# just a comment')).toBe(palette.toolArg('# just a comment'));
    expect(styleBashCommand('')).toBe(palette.toolArg(''));
  });

  it('never changes the visible text', () => {
    const cmd = 'sudo -u root rm -rf /tmp/x && echo "done | ok"';
    expect(stripAnsi(styleBashCommand(cmd))).toBe(cmd);
  });

  it('keeps every OSC 8 escape byte-intact and ignores them when locating verbs', () => {
    const open = '\x1b]8;;file:///Users/me/proj/bin/tool\x1b\\';
    const close = '\x1b]8;;\x1b\\';
    const out = styleBashCommand(`${open}tool${close} --flag && ls`);
    // The link text is the verb, so open/close land in neighbouring style
    // runs; each sequence must survive whole and in order.
    expect(out.indexOf(open)).toBeGreaterThan(-1);
    expect(out.indexOf(close)).toBeGreaterThan(out.indexOf(open));
    // `tool` opens the verb style (the trailing close escape may share its run).
    const verbOpen = palette.toolVerb('x').split('x')[0]!;
    expect(out).toContain(verbOpen + 'tool');
    expect(stripAnsi(out)).toBe('tool --flag && ls');
    expect(out.indexOf(palette.toolVerb('ls'))).toBeGreaterThan(-1);
  });
});

describe('formatToolLine bash integration', () => {
  let originalLevel: typeof chalk.level;
  beforeEach(() => {
    originalLevel = chalk.level;
    chalk.level = 3;
  });
  afterEach(() => {
    chalk.level = originalLevel;
  });

  it('emphasises verbs in bash rows', () => {
    const line = formatToolLine('bash curl -sS x | jq .');
    // curl is in the network family — assert the correct role, not toolVerb.
    expect(line).toContain(palette.toolVerbNetwork('curl'));
    expect(line).toContain(palette.toolVerb('jq'));
    expect(stripAnsi(line)).toContain('bash curl -sS x | jq .');
  });

  it('still strips a leading cd prefix before emphasising', () => {
    const line = formatToolLine('bash cd /Users/me/proj/repo && rm -rf dist');
    expect(stripAnsi(line)).toContain('bash rm -rf dist');
    expect(line).toContain(palette.toolVerbDanger('rm'));
  });

  it('treats a newline as a separator, then flattens it', () => {
    const line = formatToolLine('bash ls\nrm x');
    expect(line).not.toContain('\n');
    expect(line).toContain(palette.toolVerbDanger('rm'));
  });

  it('respects the width budget on plain text', () => {
    const line = formatToolLine('bash ' + 'git log --oneline '.repeat(20), 40);
    expect(stripAnsi(line).length).toBeLessThanOrEqual(40);
    expect(line).toContain(palette.toolVerb('git'));
  });

  it('leaves non-bash tools in plain toolArg', () => {
    const line = formatToolLine('read_file rm.txt');
    expect(line).not.toContain(palette.toolVerb('rm.txt'));
    expect(line).toContain(palette.toolArg(' rm.txt'));
  });
});

describe('isBashToolName', () => {
  it('matches both casings only', () => {
    expect(isBashToolName('bash')).toBe(true);
    expect(isBashToolName('Bash')).toBe(true);
    expect(isBashToolName('bash_output')).toBe(false);
  });
});
