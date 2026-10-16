import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { classifyRisk } from '../../risk-classifier.js';
import { evaluateCommand } from './wait-for-conditions.js';
import { hasUnquotedBackgroundOp } from './wait-for-poll-allowlist.js';

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));

// Exercise the REAL classifier: the older evaluator tests mock it to 'safe',
// which concealed the production refusals of test/[ and true/false.
describe('wait_for read-only command policy', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
  });

  it.each([
    'test -s result.txt', 'test -f result.txt', 'test -e result.txt',
    'test -d output', '[ -f result.txt ]', '[ -s "result with spaces.txt" ]',
    'true', 'false', 'ls', 'ls -l output', 'cat result.txt',
    'stat result.txt', 'stat -f %z result.txt', 'grep -q ready result.txt',
    'head -n 1 result.txt', 'tail -n 5 result.txt', 'wc -l result.txt',
    'pwd', 'readlink result.txt', 'cat result.txt | grep ready',
    'ls output | grep result | wc -l',
    'test -e result.txt && cat result.txt | grep ready',
    '[ -f result.txt ] && stat result.txt',
    'gh pr checks 123', 'gh run list --limit 1 --json status',
    'gh pr checks 123 | grep pass && test -s result.txt',
    'curl -I https://example.com', 'git status --short',
    // #2750 regression pin: classifier-safe polls keep quoted jq syntax.
    `gh pr checks 1 --json state --jq '.[] | select(.state=="FAILURE")'`,
  ])('executes read-only poll: %s', (command) => {
    const result = evaluateCommand({ type: 'command', command });
    expect(result.data?.['blocked']).toBeUndefined();
    expect(result.met).toBe(true);
    expect(execSync).toHaveBeenCalledWith(command, expect.any(Object));
  });

  it.each([
    'rm result.txt', 'rm -rf output', 'cat result.txt > copy.txt',
    'cat result.txt>copy.txt', 'true >>copy.txt', 'test -f x 2>/dev/null',
    'git push', 'curl -X POST https://example.com',
    'curl -I https://example.com -X "POST"',
    'true && curl -I https://example.com -X "POST"',
    'true && curl -I https://example.com --data payload',
    'gh run list && unknown-tool',
    'test -e x && gh pr merge 123',
    'true; rm result.txt', 'test -f result.txt; touch marker',
    'test -s $(cat path.txt)', 'test -s "$(cat path.txt)"',
    'cat `pwd`', 'test -f <(ls)', 'test -f result.txt | tee copy.txt',
    'true | unknown-command', 'true && git push',
    'PATH=. test -f result.txt', 'ssh host cat result.txt | grep ready',
    'true; g=git; $g push', 'true\\nrm result.txt',
    'true\nrm result.txt', 'test -f x # comment', '',
  ])('refuses before execution: %s', (command) => {
    const result = evaluateCommand({ type: 'command', command });
    expect(result.met).toBe(false);
    expect(result.data?.['blocked']).toBe(true);
    expect(result.detail).toContain('Use wait_for type=file');
    expect(execSync).not.toHaveBeenCalled();
  });

  it.each(['test -s result.txt', '[ -f result.txt ]', 'true', 'false', 'stat result.txt'])(
    'does not loosen bash classification: %s', (command) => {
      expect(classifyRisk('bash', { command }, { cwd: process.cwd() })).toBe('medium');
    },
  );

  it('treats false as an ordinary condition miss, not a policy refusal', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw Object.assign(new Error('exit 1'), { status: 1 });
    });
    const result = evaluateCommand({ type: 'command', command: 'false' });
    expect(result.met).toBe(false);
    expect(result.data?.['blocked']).toBeUndefined();
    expect(result.data?.['exitCode']).toBe(1);
  });
});

// Invariant: the bash risk classifier matches leading words only, so it rates
// `git diff --output=f`, `find . -fprint f` and `curl -I u -c jar` safe even
// though each writes a file. These cases run the REAL classifier and pin that
// wait_for refuses them before execSync, for safe and medium commands alike.
describe('wait_for refuses write/exec flags and background jobs', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
  });

  it.each([
    // git output/exec/config flags (classifier rates most of these safe)
    'true && git diff --output=marker', 'git diff --output=marker',
    'git diff --output marker', 'git log -p --output=x', 'git show HEAD --output=x',
    'git diff --ext-diff', 'git -c core.pager=touch git diff', 'git -c diff.external=./x diff',
    'git --config-env=core.pager=X log', 'git --exec-path=/tmp log',
    'git log --upload-pack=./evil', 'git -p log', 'git grep -O x',
    'git grep --open-files-in-pager=vi x', 'git format-patch HEAD~1',
    'git branch newbranch', 'git stash', 'git config user.name x',
    'git status && git diff --output=x', 'X=1 git diff --output=x',
    'pnpm test && git diff --output=x',
    // other allowed families with write flags
    'find . -delete', 'find . -exec cat {} +', 'find . -execdir ls ;',
    'find . -ok cat {} +', 'find . -fprint out.txt', 'find . -fprintf out.txt %p',
    'ls | find . -fls out.txt', 'ls | sort -o out.txt', 'sort -o out.txt input.txt',
    'sed -i s/a/b/ file.txt', 'cat f | sed -i s/a/b/ g', 'true | tee output.txt',
    'cat f > out', 'cat f >> out', 'ls &>out',
    'curl -I https://example.com -c jar', 'curl -I https://example.com -D h.txt',
    'curl -sI https://example.com --trace t', 'curl -I https://example.com --stderr e',
    'curl -I https://example.com -o out', 'curl -I https://example.com -w %{json}',
    'wget --spider -o log https://example.com', 'wget --spider -e robots=off https://example.com',
    // unquoted background `&`: async list exits 0 → false success
    'false &', 'true &', 'false & true', 'git status &', 'ls &',
    'test -f x & cat x', 'git log --oneline -n 1 &', 'ls |& grep x',
  ])('refuses before execution: %s', (command) => {
    const result = evaluateCommand({ type: 'command', command });
    expect(result.met).toBe(false);
    expect(result.data?.['blocked']).toBe(true);
    expect(execSync).not.toHaveBeenCalled();
  });

  it('names the background operator in the refusal', () => {
    expect(evaluateCommand({ type: 'command', command: 'false &' }).detail)
      .toContain('background operator');
  });

  it.each([
    'true && test -s result.txt', 'test -f a && cat a | grep ready', 'true && git diff --stat',
    'git diff --stat', 'git diff --name-only HEAD', 'git diff --cached --quiet',
    'git log --oneline -n 10', 'git log -1 --format=%H', 'git log -n5 --stat',
    'git status --short', 'git status -sb', 'git show HEAD --name-only',
    'git status 2>&1 | grep -q M',
    'git diff --stat 2>/dev/null', 'git status --short | grep -q M && test -s result.txt',
    'find . -name "*.txt"', 'find . -name x -print', 'curl -I https://example.com',
    'curl -sI https://example.com/health', 'curl --head --max-time 5 https://example.com',
    'wget --spider https://example.com', `grep 'a&b' result.txt`, 'grep "a & b" result.txt',
    'gh pr checks 123', 'gh pr view 456 --json state', 'gh issue list --state open',
  ])('still executes read-only poll: %s', (command) => {
    const result = evaluateCommand({ type: 'command', command });
    expect(result.data?.['blocked']).toBeUndefined();
    expect(result.met).toBe(true);
    expect(execSync).toHaveBeenCalledWith(command, expect.any(Object));
  });
});

describe('hasUnquotedBackgroundOp', () => {
  it.each([
    ['false &', true], ['a & b', true], ['ls &>out', true], ['ls |& grep x', true],
    ['a && b', false], ['ls 2>&1', false], ['ls >&2', false], ['cat <&0', false],
    [`grep 'a&b' f`, false], ['grep "a&b" f', false], ['grep a\\&b f', false],
    ['grep "a\\"&" f', false],
  ])('%s → %s', (command, expected) => {
    expect(hasUnquotedBackgroundOp(command)).toBe(expected);
  });
});
