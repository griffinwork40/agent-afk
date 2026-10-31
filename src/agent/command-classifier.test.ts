import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeCommand } from './command-classifier.js';
import * as tokenizer from './tools/readonly-bash.tokenizer.js';
import * as mutationRules from './tools/readonly-bash.mutation.js';
import * as masking from './hook-command-data.js';

// These exercise the new sharing contract; the separate pre-migration golden
// corpus pins the public consumers' exact decisions, reasons, IDs, and order.
afterEach(() => vi.restoreAllMocks());

describe('shared command analysis', () => {
  it('is lazy, and risk HIGH does not parse or run mutation rules', () => {
    const tokenize = vi.spyOn(tokenizer, 'tokenizeSegments');
    const mutation = vi.spyOn(mutationRules, 'classifyCommandMutation');
    const mask = vi.spyOn(masking, 'maskHookCommandData');
    const result = analyzeCommand('rm -rf dist/');
    expect(tokenize).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
    expect(mask).not.toHaveBeenCalled();
    expect(result.risk.level).toBe('high');
    expect(tokenize).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
    expect(mask).not.toHaveBeenCalled();
  });

  it('reuses one positional tokenization across segments, safe guard, and mutation', () => {
    const tokenize = vi.spyOn(tokenizer, 'tokenizeSegments');
    const mutation = vi.spyOn(mutationRules, 'classifyCommandMutation');
    const result = analyzeCommand('curl -I https://example.com -X "POST"');
    const segments = result.segments;
    expect(result.risk.level).toBe('high');
    expect(result.mutation.mutating).toBe(true);
    expect(result.readOnly).toBe(false);
    expect(result.segments).toBe(segments);
    expect(result.risk).toBe(result.risk);
    expect(result.mutation).toBe(result.mutation);
    expect(tokenize).toHaveBeenCalledTimes(1);
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it('keeps neutral-redirect approval tokens separate from raw mutation tokens', () => {
    const tokenize = vi.spyOn(tokenizer, 'tokenizeSegments');
    const result = analyzeCommand('ls 2>&1');
    expect(result.risk.level).toBe('safe');
    expect(result.readOnly).toBe(true);
    expect(result.segments).toEqual([['ls', '2>'], ['1']]);
    expect(tokenize.mock.calls.map(([view]) => view)).toEqual(['ls  ', 'ls 2>&1']);
    expect(result.risk.level).toBe('safe');
    expect(result.readOnly).toBe(true);
    expect(tokenize).toHaveBeenCalledTimes(2); // two DISTINCT views, once each
  });

  it('memoizes false/empty results too, with no process-global command cache', () => {
    const mutation = vi.spyOn(mutationRules, 'classifyCommandMutation');
    const first = analyzeCommand('git status');
    expect(first.readOnly).toBe(true);
    expect(first.readOnly).toBe(true);
    expect(first.destructive).toBe(first.destructive);
    expect(first.releaseBoundary).toBe(first.releaseBoundary);
    const second = analyzeCommand('git status');
    expect(second.mutation).not.toBe(first.mutation);
    expect(mutation).toHaveBeenCalledTimes(2);
  });

  it('keeps approval risk and default-allow readOnly as independent policy axes', () => {
    expect(analyzeCommand('git push origin main').risk.level).toBe('medium');
    expect(analyzeCommand('git push origin main').readOnly).toBe(false);
    const quotedData = analyzeCommand('git log --grep="git push" --oneline');
    expect(quotedData.risk.level).toBe('medium');
    expect(quotedData.readOnly).toBe(true);
    const unknown = analyzeCommand('unknown-command');
    expect(unknown.risk.level).toBe('medium');
    expect(unknown.readOnly).toBe(true); // no proof of safety, no new allowlist
  });

  it('preserves mutation reason priority instead of taking the first parsed verb', () => {
    const result = analyzeCommand('git push && git config user.name "Foo"');
    expect(result.mutation.reason).toBe('git config set (`<key> <value>`; only reads allowed)');
  });

  it('memoizes each distinct hook masking view without invoking mutation', () => {
    const mask = vi.spyOn(masking, 'maskHookCommandData');
    const mutation = vi.spyOn(mutationRules, 'classifyCommandMutation');
    const result = analyzeCommand("echo 'git reset --hard; npm publish'");
    expect(result.destructive.map(({ id }) => id)).toEqual(['git-reset-hard']);
    expect(result.releaseBoundary).toEqual([]);
    expect(result.destructive).toBe(result.destructive);
    expect(result.releaseBoundary).toBe(result.releaseBoundary);
    expect(mask).toHaveBeenCalledTimes(2);
    expect(mask.mock.calls.map((call) => call[1])).toEqual([undefined, true]);
    expect(mutation).not.toHaveBeenCalled();
  });

  it('retains ordered block and observe metadata without applying gate policy', () => {
    const result = analyzeCommand('git push --force && rm -rf x && npm publish --dry-run && git push --tags');
    expect(result.destructive.map(({ id, tier }) => [id, tier])).toEqual([
      ['rm-recursive-force', 'observe'], ['git-push-force', 'block'],
    ]);
    expect(result.releaseBoundary.map(({ id, tier }) => [id, tier])).toEqual([
      ['npm-publish', 'block'], ['git-push-tags', 'observe'],
    ]);
  });

  it('retains substitution execution and does not allow piped json interpreters', () => {
    expect(analyzeCommand('echo "$(git push)"').readOnly).toBe(false);
    expect(analyzeCommand('cat data | python3 -m json.tool').mutation.reason)
      .toBe(mutationRules.PIPE_TO_SHELL_REASON);
  });
});
