/**
 * Tests for tool-failure-density.normalize.ts
 *
 * Coverage:
 *   - normalizeErrorHead collapses digits, ids, paths, quoted strings, durations
 *   - heads differing only in numbers/ids land in the same cluster
 *   - clusterErrorHeads returns top-N sorted descending by count
 *   - failures with no errorHead are silently skipped
 *   - MAX_ERROR_CLUSTERS cap is respected
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeErrorHead,
  clusterErrorHeads,
  MAX_ERROR_CLUSTERS,
} from './tool-failure-density.normalize.js';

describe('normalizeErrorHead — digit/id collapsing', () => {
  it('collapses bare digit sequences to <N>', () => {
    expect(normalizeErrorHead('timeout after 5000 ms')).not.toContain('5000');
  });

  it('two heads differing only in a number produce the same key', () => {
    expect(normalizeErrorHead('timeout after 3000ms')).toBe(
      normalizeErrorHead('timeout after 9000ms'),
    );
  });

  it('collapses bg-* ids', () => {
    const a = normalizeErrorHead('subagent bg-abc123 failed');
    const b = normalizeErrorHead('subagent bg-xyz999 failed');
    expect(a).toBe(b);
    expect(a).toContain('<id>');
  });

  it('collapses toolu_* ids', () => {
    const a = normalizeErrorHead('call toolu_01AbCdEfGh failed');
    const b = normalizeErrorHead('call toolu_99ZzZzZzZz failed');
    expect(a).toBe(b);
  });

  it('collapses long hex run ids', () => {
    const a = normalizeErrorHead('run 1a2b3c4d5e6f7890 errored');
    const b = normalizeErrorHead('run deadbeefcafebabe errored');
    expect(a).toBe(b);
  });
});

describe('normalizeErrorHead — path collapsing', () => {
  it('replaces /Users/… absolute paths with <path>', () => {
    const n = normalizeErrorHead('no such file /Users/alice/repo/src/foo.ts');
    expect(n).not.toContain('/Users');
    expect(n).toContain('<path>');
  });

  it('replaces /home/… absolute paths with <path>', () => {
    const n = normalizeErrorHead('ENOENT /home/runner/work/agent/src/index.ts');
    expect(n).toContain('<path>');
    expect(n).not.toContain('/home');
  });

  it('two heads differing only in path produce the same key', () => {
    expect(normalizeErrorHead('no such file /Users/alice/foo.ts')).toBe(
      normalizeErrorHead('no such file /Users/bob/bar.ts'),
    );
  });
});

describe('normalizeErrorHead — quoted string collapsing', () => {
  it('replaces double-quoted values with <str>', () => {
    const n = normalizeErrorHead('command "git status" failed');
    expect(n).not.toContain('git status');
    expect(n).toContain('<str>');
  });

  it('replaces single-quoted values with <str>', () => {
    const n = normalizeErrorHead("old_string 'foo bar' not found");
    expect(n).not.toContain('foo bar');
    expect(n).toContain('<str>');
  });

  it('two heads differing only in quoted value produce the same key', () => {
    expect(normalizeErrorHead('command "git status" failed')).toBe(
      normalizeErrorHead('command "npm install" failed'),
    );
  });
});

describe('normalizeErrorHead — duration collapsing', () => {
  it('collapses Nms tokens', () => {
    const a = normalizeErrorHead('timed out after 3000ms');
    const b = normalizeErrorHead('timed out after 9999ms');
    expect(a).toBe(b);
    expect(a).toContain('<nms>');
  });

  it('collapses "N s elapsed" tokens', () => {
    const a = normalizeErrorHead('wait_for: 120 s elapsed');
    const b = normalizeErrorHead('wait_for: 60 s elapsed');
    expect(a).toBe(b);
  });
});

describe('normalizeErrorHead — error prefix stripping', () => {
  it('strips "Error: " prefix', () => {
    const a = normalizeErrorHead('Error: command not found');
    const b = normalizeErrorHead('command not found');
    expect(a).toBe(b);
  });

  it('strips "TypeError: " prefix', () => {
    const a = normalizeErrorHead('TypeError: cannot read properties of undefined');
    const b = normalizeErrorHead('cannot read properties of undefined');
    expect(a).toBe(b);
  });
});

describe('normalizeErrorHead — edge cases', () => {
  it('returns <empty> for an empty string', () => {
    expect(normalizeErrorHead('')).toBe('<empty>');
  });

  it('lowercases the result', () => {
    expect(normalizeErrorHead('COMMAND BLOCKED BY RISK CLASSIFIER')).toBe(
      'command blocked by risk classifier',
    );
  });
});

describe('clusterErrorHeads — basic clustering', () => {
  it('groups identical normalized heads into one cluster', () => {
    const heads = [
      'timeout after 3000ms',
      'timeout after 9000ms',
      'timeout after 1000ms',
    ];
    const clusters = clusterErrorHeads(heads);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.count).toBe(3);
    expect(clusters[0]!.sample).toBe('timeout after 3000ms');
  });

  it('keeps distinct clusters separate', () => {
    const heads = [
      'command blocked by risk classifier',
      'command blocked by risk classifier',
      'enoent no such file',
    ];
    const clusters = clusterErrorHeads(heads);
    expect(clusters).toHaveLength(2);
  });

  it('sorts descending by count', () => {
    const heads = [
      'enoent no such file',           // count 1
      'timeout after 1000ms',          // count 3
      'timeout after 2000ms',
      'timeout after 3000ms',
      'command not found',             // count 2
      'command not found',
    ];
    const clusters = clusterErrorHeads(heads);
    expect(clusters[0]!.count).toBeGreaterThanOrEqual(clusters[1]!.count);
    expect(clusters[1]!.count).toBeGreaterThanOrEqual(clusters[2]!.count);
  });

  it('caps at MAX_ERROR_CLUSTERS (5 by default)', () => {
    // Word-distinct heads so normalization preserves distinctness.
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet',
                   'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango'];
    const heads = words.map((w) => `${w} tool failed`);
    const clusters = clusterErrorHeads(heads);
    expect(clusters.length).toBeLessThanOrEqual(MAX_ERROR_CLUSTERS);
    expect(clusters).toHaveLength(MAX_ERROR_CLUSTERS);
  });

  it('respects a custom maxClusters argument', () => {
    // Use word-distinct heads so normalization does not collapse them.
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
    const heads = words.map((w) => `${w} error occurred`);
    expect(clusterErrorHeads(heads, 3)).toHaveLength(3);
  });

  it('skips undefined and empty heads', () => {
    const heads: (string | undefined)[] = [undefined, '', undefined, 'real error'];
    const clusters = clusterErrorHeads(heads);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.count).toBe(1);
  });

  it('returns empty array when all heads are undefined', () => {
    expect(clusterErrorHeads([undefined, undefined])).toEqual([]);
  });

  it('preserves the raw sample from the FIRST occurrence in each cluster', () => {
    const heads = ['timeout after 3000ms', 'timeout after 9000ms'];
    const clusters = clusterErrorHeads(heads);
    expect(clusters[0]!.sample).toBe('timeout after 3000ms');
  });
});
