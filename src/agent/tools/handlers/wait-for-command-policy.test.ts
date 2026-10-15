import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { classifyRisk } from '../../risk-classifier.js';
import { evaluateCommand } from './wait-for-conditions.js';

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
