/**
 * Tests for parseWhatifArgs and tokenizeSlashArgs.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseWhatifArgs, tokenizeSlashArgs, loadSpecFile } from './args.js';
import type { ParsedWhatifArgs } from './args.js';

// ---------------------------------------------------------------------------
// tokenizeSlashArgs
// ---------------------------------------------------------------------------

describe('tokenizeSlashArgs', () => {
  it('splits on whitespace', () => {
    expect(tokenizeSlashArgs('foo bar baz')).toEqual(['foo', 'bar', 'baz']);
  });

  it('handles single-quoted strings literally', () => {
    expect(tokenizeSlashArgs("'hello world'")).toEqual(['hello world']);
  });

  it('handles double-quoted strings with backslash escapes', () => {
    expect(tokenizeSlashArgs('"say \\"hi\\""')).toEqual(['say "hi"']);
    expect(tokenizeSlashArgs('"line1\\nline2"')).toEqual(['line1\nline2']);
    expect(tokenizeSlashArgs('"back\\\\slash"')).toEqual(['back\\slash']);
  });

  it('handles bare backslash escapes', () => {
    expect(tokenizeSlashArgs('foo\\ bar')).toEqual(['foo bar']);
  });

  it('handles mixed quoted and unquoted', () => {
    expect(tokenizeSlashArgs('--append "Always ask first." --verify')).toEqual([
      '--append',
      'Always ask first.',
      '--verify',
    ]);
  });

  it('returns empty array for empty string', () => {
    expect(tokenizeSlashArgs('')).toEqual([]);
  });

  it('trims leading/trailing whitespace', () => {
    expect(tokenizeSlashArgs('  foo  ')).toEqual(['foo']);
  });

  it('joins adjacent single-quoted strings into one token (shell semantics)', () => {
    // In POSIX sh, 'a''b' is the single token "ab" — no whitespace = same token.
    expect(tokenizeSlashArgs("'a''b'")).toEqual(['ab']);
  });

  it('handles unknown double-quote escape falls through', () => {
    expect(tokenizeSlashArgs('"\\z"')).toEqual(['\\z']);
  });
});

// ---------------------------------------------------------------------------
// parseWhatifArgs — defaults
// ---------------------------------------------------------------------------

describe('parseWhatifArgs defaults', () => {
  it('returns defaults when only text is given', () => {
    const r = parseWhatifArgs(['turn', 'off', 'auto-routing']);
    expect(typeof r).toBe('object');
    if (typeof r === 'string') return;
    expect(r.text).toBe('turn off auto-routing');
    expect(r.flagChanges).toEqual([]);
    expect(r.options.verify).toBe(false);
    expect(r.options.turns).toBe(12);
    expect(r.options.samples).toBe(3);
    expect(r.options.maxUsd).toBe(5);
    expect(r.options.judge).toBe('auto');
    expect(r.options.concurrency).toBe(4);
    expect(r.options.maxTurns).toBe(3);
    expect(r.options.episodeTimeoutMs).toBe(180_000);
    expect(r.options.keepSandboxes).toBe(false);
    expect(r.yes).toBe(false);
    expect(r.json).toBe(false);
  });

  it('empty changes array is accepted (documents current behavior)', () => {
    // flagChanges defaults to [] when no change flags are supplied.
    // parseWhatifArgs does not reject an empty change list — callers that
    // produce no flag changes (e.g. --spec with an empty changes array, or
    // plain text with no --append/--model/etc.) succeed and return an empty
    // flagChanges array. This test documents that this is intentional so
    // future validators do not add a silent rejection for the empty case.
    const r = parseWhatifArgs(['some text']);
    if (typeof r === 'string') throw new Error(`expected object, got error: ${r}`);
    expect(r.flagChanges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseWhatifArgs — each flag
// ---------------------------------------------------------------------------

describe('parseWhatifArgs — individual flags', () => {
  it('--append produces user-afk-md change', () => {
    const r = parseWhatifArgs(['--append', 'Always ask first.']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.flagChanges).toContainEqual({
      kind: 'append',
      target: 'user-afk-md',
      text: 'Always ask first.',
    });
  });

  it('--append-project produces project-afk-md change', () => {
    const r = parseWhatifArgs(['--append-project', 'project note']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.flagChanges).toContainEqual({
      kind: 'append',
      target: 'project-afk-md',
      text: 'project note',
    });
  });

  it('--memory-add uses default category preference', () => {
    const r = parseWhatifArgs(['--memory-add', 'prefers pnpm']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.flagChanges).toContainEqual({
      kind: 'memory-add',
      content: 'prefers pnpm',
      category: 'preference',
    });
  });

  it('--memory-category changes the next --memory-add category', () => {
    const r = parseWhatifArgs(['--memory-category', 'convention', '--memory-add', 'use tabs']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.flagChanges).toContainEqual({
      kind: 'memory-add',
      content: 'use tabs',
      category: 'convention',
    });
  });

  it('--memory-category resets after --memory-add', () => {
    const r = parseWhatifArgs([
      '--memory-category', 'decision',
      '--memory-add', 'first',
      '--memory-add', 'second',
    ]);
    if (typeof r === 'string') throw new Error(r);
    expect(r.flagChanges[0]).toMatchObject({ category: 'decision' });
    expect(r.flagChanges[1]).toMatchObject({ category: 'preference' });
  });

  it('--memory-remove parses numeric id', () => {
    const r = parseWhatifArgs(['--memory-remove', '42']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.flagChanges).toContainEqual({ kind: 'memory-remove', id: 42 });
  });

  it('--disable-skill', () => {
    const r = parseWhatifArgs(['--disable-skill', 'diagnose']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.flagChanges).toContainEqual({ kind: 'disable-skill', name: 'diagnose' });
  });

  it('--disable-plugin', () => {
    const r = parseWhatifArgs(['--disable-plugin', 'myplugin']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.flagChanges).toContainEqual({ kind: 'disable-plugin', name: 'myplugin' });
  });

  it('--model', () => {
    const r = parseWhatifArgs(['--model', 'claude-haiku-4-5']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.flagChanges).toContainEqual({ kind: 'model', model: 'claude-haiku-4-5' });
  });

  it('--effort', () => {
    const r = parseWhatifArgs(['--effort', 'low']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.flagChanges).toContainEqual({ kind: 'effort', effort: 'low' });
  });

  it('--env', () => {
    const r = parseWhatifArgs(['--env', 'FOO=bar']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.flagChanges).toContainEqual({ kind: 'env', key: 'FOO', value: 'bar' });
  });

  it('--spec sets specFile', () => {
    const r = parseWhatifArgs(['--spec', 'my-change.json']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.specFile).toBe('my-change.json');
  });

  it('--agent-model', () => {
    const r = parseWhatifArgs(['--append', 'x', '--agent-model', 'opus']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.options.agentModel).toBe('opus');
  });

  it('--analyst-model', () => {
    const r = parseWhatifArgs(['--append', 'x', '--analyst-model', 'haiku']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.options.analystModel).toBe('haiku');
  });

  it('--verify', () => {
    const r = parseWhatifArgs(['--append', 'x', '--verify']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.options.verify).toBe(true);
  });

  it('--quick sets maxTurns=1', () => {
    const r = parseWhatifArgs(['--append', 'x', '--quick']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.options.maxTurns).toBe(1);
  });

  it('--yes', () => {
    const r = parseWhatifArgs(['--append', 'x', '--yes']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.yes).toBe(true);
  });

  it('--json', () => {
    const r = parseWhatifArgs(['--append', 'x', '--json']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.json).toBe(true);
  });

  it('--turns', () => {
    const r = parseWhatifArgs(['--append', 'x', '--turns', '5']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.options.turns).toBe(5);
  });

  it('--samples', () => {
    const r = parseWhatifArgs(['--append', 'x', '--samples', '10']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.options.samples).toBe(10);
  });

  it('--max-usd', () => {
    const r = parseWhatifArgs(['--append', 'x', '--max-usd', '2.5']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.options.maxUsd).toBe(2.5);
  });

  it('--judge claude', () => {
    const r = parseWhatifArgs(['--append', 'x', '--judge', 'claude']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.options.judge).toBe('claude');
  });

  it('--concurrency', () => {
    const r = parseWhatifArgs(['--append', 'x', '--concurrency', '8']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.options.concurrency).toBe(8);
  });

  it('--max-turns', () => {
    const r = parseWhatifArgs(['--append', 'x', '--max-turns', '5']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.options.maxTurns).toBe(5);
  });

  it('--timeout', () => {
    const r = parseWhatifArgs(['--append', 'x', '--timeout', '60']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.options.episodeTimeoutMs).toBe(60_000);
  });

  it('--keep-sandboxes', () => {
    const r = parseWhatifArgs(['--append', 'x', '--keep-sandboxes']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.options.keepSandboxes).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseWhatifArgs — accumulation
// ---------------------------------------------------------------------------

describe('parseWhatifArgs — accumulation', () => {
  it('accumulates multiple --append flags in order', () => {
    const r = parseWhatifArgs(['--append', 'first', '--append', 'second']);
    if (typeof r === 'string') throw new Error(r);
    expect(r.flagChanges).toHaveLength(2);
    expect(r.flagChanges[0]).toMatchObject({ text: 'first' });
    expect(r.flagChanges[1]).toMatchObject({ text: 'second' });
  });

  it('accumulates mixed flag types in order', () => {
    const r = parseWhatifArgs([
      '--append', 'note',
      '--model', 'haiku',
      '--memory-add', 'fact',
    ]);
    if (typeof r === 'string') throw new Error(r);
    expect(r.flagChanges.map((c) => c.kind)).toEqual(['append', 'model', 'memory-add']);
  });
});

// ---------------------------------------------------------------------------
// parseWhatifArgs — errors
// ---------------------------------------------------------------------------

describe('parseWhatifArgs — errors', () => {
  it('returns error string for empty argv', () => {
    const r = parseWhatifArgs([]);
    expect(typeof r).toBe('string');
  });

  it('returns error string for unknown flag', () => {
    const r = parseWhatifArgs(['--not-a-flag']);
    expect(typeof r).toBe('string');
    expect(r).toMatch(/Unknown flag/);
  });

  it('returns error string when --append has no value', () => {
    const r = parseWhatifArgs(['--append']);
    expect(typeof r).toBe('string');
    expect(r).toMatch(/requires/);
  });

  it('returns error when --judge is invalid', () => {
    const r = parseWhatifArgs(['--append', 'x', '--judge', 'bad']);
    expect(typeof r).toBe('string');
    expect(r).toMatch(/auto\|jev\|claude/);
  });

  it('returns error when --memory-remove is not numeric', () => {
    const r = parseWhatifArgs(['--memory-remove', 'abc']);
    expect(typeof r).toBe('string');
    expect(r).toMatch(/number/);
  });

  it('returns error when --spec is combined with flags', () => {
    const r = parseWhatifArgs(['--spec', 'x.json', '--append', 'y']);
    expect(typeof r).toBe('string');
    expect(r).toMatch(/cannot be combined/);
  });

  it('returns error when --spec is combined with text', () => {
    const r = parseWhatifArgs(['--spec', 'x.json', 'some', 'text']);
    expect(typeof r).toBe('string');
    expect(r).toMatch(/cannot be combined/);
  });

  it('returns error for invalid --turns', () => {
    const r = parseWhatifArgs(['--append', 'x', '--turns', '0']);
    expect(typeof r).toBe('string');
    expect(r).toMatch(/positive integer/);
  });

  it('returns error for bad --memory-category', () => {
    const r = parseWhatifArgs(['--memory-category', 'bad']);
    expect(typeof r).toBe('string');
    expect(r).toMatch(/preference\|convention\|decision\|learning/);
  });

  it('returns error for --file without = separator', () => {
    const r = parseWhatifArgs(['--file', 'home:somefile']);
    expect(typeof r).toBe('string');
    expect(r).toMatch(/path>=<localfile/);
  });

  it('returns error for --file with invalid path prefix', () => {
    const r = parseWhatifArgs(['--file', 'bad:path=/tmp/x']);
    expect(typeof r).toBe('string');
    expect(r).toMatch(/home: or project:/);
  });
});

// ---------------------------------------------------------------------------
// parseWhatifArgs — file reading (mock fs)
// ---------------------------------------------------------------------------

describe('parseWhatifArgs — --file and --hot', () => {
  // We need to mock readFileSync from 'node:fs'.
  // Use vi.mock at module level is not possible in this describe block, so
  // we test the error paths that don't require a real file.

  it('returns error when --hot file does not exist', () => {
    const r = parseWhatifArgs(['--hot', '/no/such/file-xyz123.txt']);
    expect(typeof r).toBe('string');
    expect(r).toMatch(/cannot read/);
  });

  it('returns error when --file local file does not exist', () => {
    const r = parseWhatifArgs(['--file', 'home:AFK.md=/no/such/file-xyz123.txt']);
    expect(typeof r).toBe('string');
    expect(r).toMatch(/cannot read/);
  });
});

// ---------------------------------------------------------------------------
// tokenizeSlashArgs + parseWhatifArgs integration
// ---------------------------------------------------------------------------

describe('tokenizeSlashArgs + parseWhatifArgs integration', () => {
  it('parses quoted multi-word text correctly', () => {
    const tokens = tokenizeSlashArgs('"turn off auto-routing" --verify');
    const r = parseWhatifArgs(tokens);
    if (typeof r === 'string') throw new Error(r);
    expect(r.text).toBe('turn off auto-routing');
    expect(r.options.verify).toBe(true);
  });

  it('parses multiple flags from tokenised input', () => {
    const tokens = tokenizeSlashArgs('--append "Always ask." --judge jev --yes');
    const r = parseWhatifArgs(tokens);
    if (typeof r === 'string') throw new Error(r);
    expect(r.flagChanges[0]).toMatchObject({ text: 'Always ask.', target: 'user-afk-md' });
    expect(r.options.judge).toBe('jev');
    expect(r.yes).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadSpecFile — schema validation (Medium fix #2295)
// ---------------------------------------------------------------------------

describe('loadSpecFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'whatif-loadspecfile-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a well-formed spec and returns a validated ChangeSpec', () => {
    const p = join(dir, 'spec.json');
    writeFileSync(p, JSON.stringify({
      title: 'Disable auto-routing',
      changes: [{ kind: 'env', key: 'AFK_AUTO_ROUTING', value: 'false' }],
    }));
    const spec = loadSpecFile(p);
    expect(spec.title).toBe('Disable auto-routing');
    expect(spec.changes).toHaveLength(1);
    expect(spec.changes[0]).toMatchObject({ kind: 'env', key: 'AFK_AUTO_ROUTING' });
  });

  it('throws on malformed JSON', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, 'not valid json {{{');
    expect(() => loadSpecFile(p)).toThrow(/not valid JSON/);
  });

  it('throws when the top-level shape is invalid (missing title)', () => {
    const p = join(dir, 'bad-shape.json');
    writeFileSync(p, JSON.stringify({ changes: [] }));
    expect(() => loadSpecFile(p)).toThrow(/invalid structure/);
  });

  it('throws when all change entries fail schema validation', () => {
    const p = join(dir, 'bad-entries.json');
    writeFileSync(p, JSON.stringify({
      title: 'Bad changes',
      changes: [
        { kind: 'unknown-kind', foo: 'bar' },
        { notAChange: true },
      ],
    }));
    expect(() => loadSpecFile(p)).toThrow(/no valid changes/);
  });

  it('warns and drops invalid change entries, returns the valid ones', () => {
    const p = join(dir, 'mixed.json');
    writeFileSync(p, JSON.stringify({
      title: 'Mixed',
      changes: [
        { kind: 'model', model: 'claude-opus-4-5' },
        { kind: 'unknown-kind', foo: 'bar' },
      ],
    }));
    const spec = loadSpecFile(p);
    expect(spec.changes).toHaveLength(1);
    expect(spec.changes[0]).toMatchObject({ kind: 'model', model: 'claude-opus-4-5' });
  });

  it('throws when the file does not exist', () => {
    expect(() => loadSpecFile(join(dir, 'no-such-file.json'))).toThrow(/cannot read/);
  });
});

// ---------------------------------------------------------------------------
// --force flag
// ---------------------------------------------------------------------------

describe('parseWhatifArgs — --force flag', () => {
  it('defaults force to false', () => {
    const r = parseWhatifArgs(['--append', 'text']) as ParsedWhatifArgs;
    expect(r.force).toBe(false);
  });

  it('sets force to true when --force is passed', () => {
    const r = parseWhatifArgs(['--append', 'text', '--force']) as ParsedWhatifArgs;
    expect(r.force).toBe(true);
  });

  it('--force can be combined with --verify and --yes', () => {
    const r = parseWhatifArgs([
      '--append', 'text', '--verify', '--yes', '--force',
    ]) as ParsedWhatifArgs;
    expect(r.force).toBe(true);
    expect(r.yes).toBe(true);
    expect(r.options.verify).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --probes and --max-predictions flags (#2477)
// ---------------------------------------------------------------------------

describe('parseWhatifArgs — --probes flag', () => {
  it('defaults probes to undefined (uses DEFAULT_PROBES at call site)', () => {
    const r = parseWhatifArgs(['--append', 'text']) as ParsedWhatifArgs;
    expect(r.options.probes).toBeUndefined();
  });

  it('parses --probes 4', () => {
    const r = parseWhatifArgs(['--append', 'text', '--probes', '4']) as ParsedWhatifArgs;
    expect(r.options.probes).toBe(4);
  });

  it('accepts boundary value 1', () => {
    const r = parseWhatifArgs(['--append', 'text', '--probes', '1']) as ParsedWhatifArgs;
    expect(r.options.probes).toBe(1);
  });

  it('accepts boundary value 12', () => {
    const r = parseWhatifArgs(['--append', 'text', '--probes', '12']) as ParsedWhatifArgs;
    expect(r.options.probes).toBe(12);
  });

  it('rejects 0 (below minimum)', () => {
    const r = parseWhatifArgs(['--append', 'text', '--probes', '0']);
    expect(typeof r).toBe('string');
    expect(r as string).toContain('1–12');
  });

  it('rejects 13 (above maximum)', () => {
    const r = parseWhatifArgs(['--append', 'text', '--probes', '13']);
    expect(typeof r).toBe('string');
    expect(r as string).toContain('1–12');
  });

  it('rejects non-integer', () => {
    const r = parseWhatifArgs(['--append', 'text', '--probes', 'abc']);
    expect(typeof r).toBe('string');
  });

  it('requires a value', () => {
    const r = parseWhatifArgs(['--append', 'text', '--probes']);
    expect(typeof r).toBe('string');
    expect(r as string).toContain('--probes requires a number');
  });
});

describe('parseWhatifArgs — --max-predictions flag', () => {
  it('defaults maxPredictions to undefined (resolved at call site)', () => {
    const r = parseWhatifArgs(['--append', 'text']) as ParsedWhatifArgs;
    expect(r.options.maxPredictions).toBeUndefined();
  });

  it('parses --max-predictions 3', () => {
    const r = parseWhatifArgs(['--append', 'text', '--max-predictions', '3']) as ParsedWhatifArgs;
    expect(r.options.maxPredictions).toBe(3);
  });

  it('accepts boundary value 1', () => {
    const r = parseWhatifArgs(['--append', 'text', '--max-predictions', '1']) as ParsedWhatifArgs;
    expect(r.options.maxPredictions).toBe(1);
  });

  it('accepts boundary value 8', () => {
    const r = parseWhatifArgs(['--append', 'text', '--max-predictions', '8']) as ParsedWhatifArgs;
    expect(r.options.maxPredictions).toBe(8);
  });

  it('rejects 0 (below minimum)', () => {
    const r = parseWhatifArgs(['--append', 'text', '--max-predictions', '0']);
    expect(typeof r).toBe('string');
    expect(r as string).toContain('1–8');
  });

  it('rejects 9 (above maximum)', () => {
    const r = parseWhatifArgs(['--append', 'text', '--max-predictions', '9']);
    expect(typeof r).toBe('string');
    expect(r as string).toContain('1–8');
  });

  it('requires a value', () => {
    const r = parseWhatifArgs(['--append', 'text', '--max-predictions']);
    expect(typeof r).toBe('string');
    expect(r as string).toContain('--max-predictions requires a number');
  });

  it('both --probes and --max-predictions can be combined', () => {
    const r = parseWhatifArgs([
      '--append', 'text', '--probes', '4', '--max-predictions', '2',
    ]) as ParsedWhatifArgs;
    expect(r.options.probes).toBe(4);
    expect(r.options.maxPredictions).toBe(2);
  });
});
