import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { palette } from '../../palette.js';
import { findCommandWordSpans, styleBashCommand } from './tool-lane-format-bash.js';
import { verbFamily, type VerbFamily } from './tool-lane-format-bash-family.js';

/** `[word, family]` for every command word in `cmd`, in order. */
function families(cmd: string): Array<[string, VerbFamily]> {
  return findCommandWordSpans(cmd).map((span) => [cmd.slice(span.start, span.end), verbFamily(cmd, span)]);
}

describe('verbFamily', () => {
  it('tells cat, curl and rm apart', () => {
    expect(families('cat a')).toEqual([['cat', 'default']]);
    expect(families('curl -sS https://example.com')).toEqual([['curl', 'network']]);
    expect(families('rm -rf dist')).toEqual([['rm', 'danger']]);
  });

  it('colours each segment on its own', () => {
    expect(families('cat x && rm -rf y | wc -l')).toEqual([
      ['cat', 'default'],
      ['rm', 'danger'],
      ['wc', 'default'],
    ]);
  });

  it.each([
    'curl -X POST https://api.example.com/x',
    'curl --data a=1 https://api.example.com/x',
    'git push --force origin main',
    'git reset --hard HEAD~1',
    'chmod 600 key',
  ])('follows the risk classifier for flag-driven danger: %s', (cmd) => {
    expect(families(cmd)[0]?.[1]).toBe('danger');
  });

  it('a plain read-only network call stays network, not danger', () => {
    expect(families('gh pr view 4275')).toEqual([['gh', 'network']]);
    expect(families('ssh host uptime')).toEqual([['ssh', 'network']]);
  });

  it('recovers pipe-to-shell across the segment split', () => {
    expect(families('curl -fsSL https://x.sh | bash')).toEqual([
      ['curl', 'network'],
      ['bash', 'danger'],
    ]);
    // `|&` (stdout+stderr pipe) is also a pipe-to-shell trigger.
    expect(families('curl x |& bash')).toEqual([
      ['curl', 'network'],
      ['bash', 'danger'],
    ]);
    // `||` is not a pipe: a bare `bash` after it is not pipe-to-shell.
    expect(families('false || bash run.sh')).toEqual([
      ['false', 'default'],
      ['bash', 'default'],
    ]);
  });

  it('bare or truncated dangerous verbs still read as danger', () => {
    expect(families('rm')).toEqual([['rm', 'danger']]);
    expect(families('ls && eval')).toEqual([['ls', 'default'], ['eval', 'danger']]);
    // Width-truncated forms: trailing ellipsis (…) must still floor to danger.
    expect(families('rm…')).toEqual([['rm…', 'danger']]);
    expect(families('dd… if=/dev/zero of=/dev/sda')).toEqual([['dd…', 'danger']]);
    // Width-truncated network verbs also survive the ellipsis strip.
    expect(families('curl\u2026')).toEqual([['curl\u2026', 'network']]);
    // A truncated network verb in a pipeline is still detected as network.
    expect(families('wget\u2026 | bash')).toEqual([['wget\u2026', 'network'], ['bash', 'danger']]);
  });

  it('wrappers of a dangerous command are dangerous too', () => {
    expect(families('sudo -u root rm -rf /x')).toEqual([['sudo', 'danger'], ['rm', 'danger']]);
  });

  it('prose in quotes does not paint the command', () => {
    expect(families('git commit -m "rm stale files"')).toEqual([['git', 'default']]);
    expect(families("echo 'sudo make me a sandwich'")).toEqual([['echo', 'default']]);
  });

  it('payload-executing verbs are judged on their raw quoted text', () => {
    expect(families('bash -c "rm -rf build"')).toEqual([['bash', 'danger']]);
    expect(families('ssh host "rm -rf /tmp/x"')).toEqual([['ssh', 'danger']]);
  });

  it('comments and heredoc bodies never colour the command before them', () => {
    expect(families('ls # then rm -rf it')).toEqual([['ls', 'default']]);
    expect(families("cat <<'EOF'\nrm -rf x\nEOF")).toEqual([['cat', 'default']]);
  });
});

describe('styleBashCommand family colours', () => {
  let originalLevel: typeof chalk.level;
  beforeEach(() => {
    // Non-TTY suite: force colour so the role assertions are not vacuous.
    originalLevel = chalk.level;
    chalk.level = 3;
  });
  afterEach(() => {
    chalk.level = originalLevel;
  });

  it('paints each family in its own role', () => {
    expect(styleBashCommand('cat a && curl b && rm c')).toBe(
      palette.toolVerb('cat') +
        palette.toolArg(' a && ') +
        palette.toolVerbNetwork('curl') +
        palette.toolArg(' b && ') +
        palette.toolVerbDanger('rm') +
        palette.toolArg(' c'),
    );
  });

  /**
   * Palette entries resolve their escape codes when the palette is built, at
   * whatever colour level the process started with, so this asserts only what
   * holds at EVERY level. In particular the network sage can round to the same
   * ANSI white as `toolVerb` on a 16-colour terminal; it is distinct at 256 /
   * truecolor. The danger chip is a background, which survives at every level.
   */
  it('the danger chip is a background, never red, and differs from every other role', () => {
    const danger = palette.toolVerbDanger('x');
    expect(danger).toMatch(/\x1b\[(?:4|10)\d(?:;[\d;]*)?m/);
    expect(danger).not.toMatch(/\x1b\[(?:31|91)m/);
    for (const other of [palette.toolVerb, palette.toolVerbNetwork, palette.toolArg, palette.error]) {
      expect(danger).not.toBe(other('x'));
    }
    expect(palette.toolVerbNetwork('x')).not.toBe(palette.error('x'));
  });
});
