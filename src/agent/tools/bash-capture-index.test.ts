/**
 * Unit tests for the bash capture index scanner.
 *
 * Tests verify:
 * - Empty result when witness root is absent.
 * - Discovers captures across multiple sessions.
 * - Filters by session id.
 * - Applies the limit correctly.
 * - Extracts a preview from the first non-empty line.
 * - Handles empty capture files gracefully.
 * - Per-session errors (missing bash-captures dir) are swallowed.
 * - Results are sorted newest first.
 *
 * @module agent/tools/bash-capture-index.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listCaptures } from './bash-capture-index.js';

// ---------------------------------------------------------------------------
// Test isolation: redirect AFK_STATE_DIR so listCaptures reads our fixtures.
// ---------------------------------------------------------------------------

let tmpStateDir: string;
let origStateDir: string | undefined;
let origAFKHome: string | undefined;

beforeEach(() => {
  tmpStateDir = mkdtempSync(join(tmpdir(), 'afk-capture-index-test-'));
  origStateDir = process.env['AFK_STATE_DIR'];
  origAFKHome = process.env['AFK_HOME'];
  process.env['AFK_STATE_DIR'] = tmpStateDir;
  delete process.env['AFK_HOME'];
});

afterEach(() => {
  if (origStateDir !== undefined) {
    process.env['AFK_STATE_DIR'] = origStateDir;
  } else {
    delete process.env['AFK_STATE_DIR'];
  }
  if (origAFKHome !== undefined) {
    process.env['AFK_HOME'] = origAFKHome;
  } else {
    delete process.env['AFK_HOME'];
  }
  rmSync(tmpStateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function witnessRoot(): string {
  return join(tmpStateDir, 'witness');
}

function makeCapture(sessionId: string, toolUseId: string, content: string): string {
  const dir = join(witnessRoot(), sessionId, 'bash-captures');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${toolUseId}.txt`);
  writeFileSync(filePath, content, { encoding: 'utf8' });
  return filePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('listCaptures — empty state', () => {
  it('returns empty array when witness root does not exist', async () => {
    const result = await listCaptures();
    expect(result).toEqual([]);
  });

  it('returns empty array when witness root exists but has no captures', async () => {
    mkdirSync(witnessRoot(), { recursive: true });
    const result = await listCaptures();
    expect(result).toEqual([]);
  });

  it('returns empty array when session dir exists but has no bash-captures subdir', async () => {
    mkdirSync(join(witnessRoot(), 'sess-1'), { recursive: true });
    const result = await listCaptures();
    expect(result).toEqual([]);
  });
});

describe('listCaptures — basic discovery', () => {
  it('finds a single capture file', async () => {
    makeCapture('sess-1', 'tool-abc', 'hello world\nmore output\n');
    const result = await listCaptures();
    expect(result).toHaveLength(1);
    expect(result[0]!.sessionId).toBe('sess-1');
    expect(result[0]!.toolUseId).toBe('tool-abc');
    expect(result[0]!.sizeBytes).toBeGreaterThan(0);
    expect(result[0]!.mtimeMs).toBeGreaterThan(0);
  });

  it('discovers captures across multiple sessions', async () => {
    makeCapture('sess-a', 'tool-1', 'output from a\n');
    makeCapture('sess-b', 'tool-2', 'output from b\n');
    const result = await listCaptures({ limit: 10 });
    expect(result).toHaveLength(2);
    const sessionIds = result.map((e) => e.sessionId).sort();
    expect(sessionIds).toEqual(['sess-a', 'sess-b'].sort());
  });

  it('discovers multiple captures within one session', async () => {
    makeCapture('sess-multi', 'tool-1', 'first\n');
    makeCapture('sess-multi', 'tool-2', 'second\n');
    const result = await listCaptures({ limit: 10 });
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.sessionId === 'sess-multi')).toBe(true);
  });
});

describe('listCaptures — preview extraction', () => {
  it('extracts the first non-empty line as the preview', async () => {
    makeCapture('sess-p', 'tool-p', 'first line of output\nsecond line\n');
    const [entry] = await listCaptures();
    expect(entry!.preview).toBe('first line of output');
  });

  it('skips leading empty lines and returns the first non-empty one', async () => {
    makeCapture('sess-skip', 'tool-skip', '\n\nthird line is first non-empty\n');
    const [entry] = await listCaptures();
    expect(entry!.preview).toBe('third line is first non-empty');
  });

  it('returns "(empty capture)" for an empty file', async () => {
    makeCapture('sess-empty', 'tool-empty', '');
    const [entry] = await listCaptures();
    expect(entry!.preview).toBe('(empty capture)');
  });

  it('truncates very long first lines to 120 chars with an ellipsis', async () => {
    const longLine = 'A'.repeat(200);
    makeCapture('sess-long', 'tool-long', `${longLine}\n`);
    const [entry] = await listCaptures();
    expect(entry!.preview).toHaveLength(120);
    expect(entry!.preview.endsWith('…')).toBe(true);
  });
});

describe('listCaptures — session filter', () => {
  it('returns only entries for the specified session', async () => {
    makeCapture('sess-x', 'tool-1', 'from x\n');
    makeCapture('sess-y', 'tool-2', 'from y\n');
    const result = await listCaptures({ sessionId: 'sess-x', limit: 10 });
    expect(result).toHaveLength(1);
    expect(result[0]!.sessionId).toBe('sess-x');
  });

  it('returns empty array when filter matches no session', async () => {
    makeCapture('sess-z', 'tool-1', 'output\n');
    const result = await listCaptures({ sessionId: 'nonexistent', limit: 10 });
    expect(result).toEqual([]);
  });
});

describe('listCaptures — limit', () => {
  it('respects the limit option', async () => {
    for (let i = 0; i < 5; i++) {
      makeCapture('sess-limit', `tool-${i}`, `output ${i}\n`);
    }
    const result = await listCaptures({ limit: 3 });
    expect(result).toHaveLength(3);
  });

  it('uses default limit of 20 when not specified', async () => {
    for (let i = 0; i < 25; i++) {
      makeCapture('sess-default', `tool-${i}`, `output ${i}\n`);
    }
    const result = await listCaptures();
    expect(result).toHaveLength(20);
  });

  it('falls back to DEFAULT_LIMIT (20) when limit is 0', async () => {
    for (let i = 0; i < 25; i++) {
      makeCapture('sess-zero', `tool-${i}`, `output ${i}\n`);
    }
    const result = await listCaptures({ limit: 0 });
    expect(result).toHaveLength(20);
  });

  it('falls back to DEFAULT_LIMIT (20) when limit is -1', async () => {
    for (let i = 0; i < 25; i++) {
      makeCapture('sess-neg', `tool-${i}`, `output ${i}\n`);
    }
    const result = await listCaptures({ limit: -1 });
    expect(result).toHaveLength(20);
  });
});

describe('listCaptures — sort order', () => {
  it('returns captures newest-first by mtime', async () => {
    const pathOld = makeCapture('sess-sort', 'tool-old', 'older output\n');
    // Backdate the first file by 2 seconds so mtimes are distinct.
    const { utimesSync } = await import('node:fs');
    const oldTime = (Date.now() - 2000) / 1000;
    utimesSync(pathOld, oldTime, oldTime);
    makeCapture('sess-sort', 'tool-new', 'newer output\n');
    const result = await listCaptures({ limit: 10 });
    expect(result).toHaveLength(2);
    expect(result[0]!.toolUseId).toBe('tool-new');
    expect(result[1]!.toolUseId).toBe('tool-old');
    expect(result[0]!.mtimeMs).toBeGreaterThan(result[1]!.mtimeMs);
  });
});

describe('listCaptures — escape stripping', () => {
  it('strips ANSI escape sequences from the preview', async () => {
    // ESC[32m = green foreground; ESC[0m = reset. The visible text is "hello".
    makeCapture('sess-ansi', 'tool-ansi', '\x1b[32mhello\x1b[0m\nmore\n');
    const [entry] = await listCaptures();
    expect(entry!.preview).toBe('hello');
  });
});

describe('listCaptures — robustness', () => {
  it('ignores non-.txt files in the bash-captures directory', async () => {
    const dir = join(witnessRoot(), 'sess-nontxt', 'bash-captures');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'not-a-capture.json'), '{}');
    writeFileSync(join(dir, 'real-capture.txt'), 'real\n');
    const result = await listCaptures();
    expect(result).toHaveLength(1);
    expect(result[0]!.toolUseId).toBe('real-capture');
  });

  it('skips sessions whose bash-captures dir is missing without throwing', async () => {
    // One session with captures, one without bash-captures subdir.
    mkdirSync(join(witnessRoot(), 'sess-no-captures'), { recursive: true });
    makeCapture('sess-has-captures', 'tool-1', 'data\n');
    const result = await listCaptures({ limit: 10 });
    expect(result).toHaveLength(1);
    expect(result[0]!.sessionId).toBe('sess-has-captures');
  });
});

// ---------------------------------------------------------------------------
// Regression tests: path-traversal filename filter (PR #1783 / issue #1790)
// ---------------------------------------------------------------------------

describe('listCaptures — path-traversal filename filter', () => {
  // Regression: the capture filename filter /^[a-zA-Z0-9._-]+\.txt$/ must
  // reject names that contain slash characters, which are the only characters
  // that can cause path traversal when combined with join(). File system
  // entries returned by readdir() are always bare names (no slashes), so the
  // filter's job is to exclude non-.txt files and names whose characters fall
  // outside the safe set.
  //
  // Invariant: the security boundary is the slash. A bare name like "..evil.txt"
  // returned by readdir() is NOT a traversal risk because
  // join(capturesDir, "..evil.txt") stays inside capturesDir — only a name
  // containing "/" could escape it on POSIX. The regex is therefore the
  // authoritative guard for both slash-containing names and wrong extensions.

  it('rejects slash-containing filenames via the safe-name regex', () => {
    // These names cannot appear as bare readdir() entries on POSIX, but the
    // regex is the first line of defence; verify it would reject them if they
    // somehow appeared (e.g. on emulated file systems or in future code paths).
    const traversalNames = [
      '../../etc/passwd.txt',
      '../sibling.txt',
      '/absolute/path.txt',
      'foo/bar.txt',
    ];
    for (const name of traversalNames) {
      expect(/^[a-zA-Z0-9._-]+\.txt$/.test(name)).toBe(false);
    }
  });

  it('rejects non-txt extensions via the safe-name regex', () => {
    const badExtensions = ['capture.sh', 'capture.json', 'capture', 'capture.txt.sh'];
    for (const name of badExtensions) {
      expect(/^[a-zA-Z0-9._-]+\.txt$/.test(name)).toBe(false);
    }
  });

  it('accepts safe filenames via the safe-name regex', () => {
    const goodNames = [
      '1726123456.txt',
      'capture-abc.txt',
      'tool_use_id.txt',
      'a.txt',
      'UPPER.txt',
      'mix-123_abc.txt',
    ];
    for (const name of goodNames) {
      expect(/^[a-zA-Z0-9._-]+\.txt$/.test(name)).toBe(true);
    }
  });

  it('includes timestamp-style filenames in scan results', async () => {
    makeCapture('sess-ts', '1726123456', 'output from timestamp-named capture\n');
    const result = await listCaptures({ limit: 10 });
    expect(result).toHaveLength(1);
    expect(result[0]!.toolUseId).toBe('1726123456');
  });

  it('includes kebab-style filenames in scan results', async () => {
    makeCapture('sess-kebab', 'capture-abc', 'output from kebab capture\n');
    const result = await listCaptures({ limit: 10 });
    expect(result).toHaveLength(1);
    expect(result[0]!.toolUseId).toBe('capture-abc');
  });

  it('includes both legitimate filenames and excludes wrong-extension files', async () => {
    const dir = join(witnessRoot(), 'sess-mixed', 'bash-captures');
    mkdirSync(dir, { recursive: true });
    // Files with wrong extensions must be excluded by the filter.
    writeFileSync(join(dir, 'script.sh'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'data.json'), '{}');
    // Legitimate captures must pass through.
    writeFileSync(join(dir, '1726123456.txt'), 'ts-named\n');
    writeFileSync(join(dir, 'capture-abc.txt'), 'kebab-named\n');
    const result = await listCaptures({ limit: 10 });
    const toolIds = result.map((e) => e.toolUseId).sort();
    expect(toolIds).toEqual(['1726123456', 'capture-abc']);
  });

  it('excludes dot-prefixed session directory names from the scan', async () => {
    // The session-level filter /^[a-zA-Z0-9_-]+$/ rejects directory names
    // that start with "." so the scanner never descends into them even if
    // readdir() returns them (e.g. ".traversal", "..evil").
    makeCapture('sess-valid', 'tool-ok', 'valid output\n');
    const dotDir = join(witnessRoot(), '.traversal', 'bash-captures');
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(join(dotDir, 'sneaky.txt'), 'should not appear\n');
    const result = await listCaptures({ limit: 10 });
    expect(result).toHaveLength(1);
    expect(result[0]!.sessionId).toBe('sess-valid');
  });

  it('excludes session dirs containing dots from the scan', async () => {
    // A session directory name containing "." (e.g. "sess..evil") fails
    // /^[a-zA-Z0-9_-]+$/ and must be skipped entirely.
    makeCapture('sess-clean', 'tool-clean', 'clean session\n');
    const dotDir = join(witnessRoot(), 'sess..evil', 'bash-captures');
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(join(dotDir, 'bad.txt'), 'should not appear\n');
    const result = await listCaptures({ limit: 10 });
    expect(result).toHaveLength(1);
    expect(result[0]!.sessionId).toBe('sess-clean');
  });
});
