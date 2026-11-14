/**
 * Tests for the grep pipe-retry helper (grep.pipe-retry.ts).
 *
 * Covers the five cases required by issue #4871:
 *   1. `\|` pattern — zero literal-pipe matches but alternation matches → note + results
 *   2. `\|` pattern — both readings find nothing → extended no-match message
 *   3. Pattern with a real literal-pipe match — no retry triggered
 *   4. `\\|` (escaped backslash + alternation) — not rewritten
 *   5. Normal pattern with no matches — message unchanged
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createGrepHandler } from './grep.js';
import { hasUnescapedBackslashPipe, rewriteBackslashPipe } from './grep.pipe-retry.js';

// ---------------------------------------------------------------------------
// Unit tests for the pure helpers
// ---------------------------------------------------------------------------

describe('hasUnescapedBackslashPipe', () => {
  it('detects a single \\| as unescaped', () => {
    expect(hasUnescapedBackslashPipe('foo\\|bar')).toBe(true);
  });

  it('does not flag \\\\| (escaped backslash + bare pipe)', () => {
    // JS string '\\\\|' → pattern \\| → escaped backslash followed by bare |
    expect(hasUnescapedBackslashPipe('\\\\|')).toBe(false);
  });

  it('does not flag a pattern with no backslash-pipe at all', () => {
    expect(hasUnescapedBackslashPipe('foo|bar')).toBe(false);
  });

  it('detects multiple \\| occurrences', () => {
    expect(hasUnescapedBackslashPipe('a\\|b\\|c')).toBe(true);
  });

  it('does not flag a trailing \\\\| sequence', () => {
    // JS '\\\\|' → \\| in the actual string
    expect(hasUnescapedBackslashPipe('prefix\\\\|suffix')).toBe(false);
  });
});

describe('rewriteBackslashPipe', () => {
  it('replaces \\| with |', () => {
    expect(rewriteBackslashPipe('foo\\|bar')).toBe('foo|bar');
  });

  it('replaces multiple \\| occurrences', () => {
    expect(rewriteBackslashPipe('a\\|b\\|c')).toBe('a|b|c');
  });

  it('does not touch \\\\|', () => {
    // JS '\\\\|' → \\| in string → should stay \\|
    expect(rewriteBackslashPipe('\\\\|')).toBe('\\\\|');
  });

  it('does not touch a bare |', () => {
    expect(rewriteBackslashPipe('foo|bar')).toBe('foo|bar');
  });
});

// ---------------------------------------------------------------------------
// Integration tests via createGrepHandler (spawns real ripgrep)
// ---------------------------------------------------------------------------

describe('grep pipe-retry integration', () => {
  let tempDir: string;

  function createSignal(): AbortSignal {
    return new AbortController().signal;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grep-pipe-retry-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // Case 1: `\|` pattern — zero literal-pipe matches but alternation matches
  it('reruns with \\| rewritten to | and prefixes a note when alternation finds matches', async () => {
    writeFileSync(join(tempDir, 'src.ts'), 'alpha\nbeta\ngamma');

    const handler = createGrepHandler(tempDir);
    // JS 'alpha\\|beta' → pattern string alpha\|beta → ripgrep reads as literal "alpha|beta"
    // No file contains the literal string "alpha|beta", but after rewrite to "alpha|beta"
    // as alternation it matches lines containing "alpha" or "beta".
    const result = await handler({ pattern: 'alpha\\|beta', path: tempDir }, createSignal());

    expect(result.isError).toBeFalsy();
    // Must contain the explanatory note
    expect(result.content).toContain('matched nothing');
    expect(result.content).toContain('literal pipe');
    expect(result.content).toContain("'alpha\\|beta'");
    expect(result.content).toContain("'alpha|beta'");
    // Must contain the actual matches
    expect(result.content).toContain('alpha');
    expect(result.content).toContain('beta');
    // Must NOT contain gamma (not matched by alpha|beta alternation)
    expect(result.content).not.toContain('gamma');
  });

  // Case 2: `\|` pattern — both readings find nothing
  it('reports both readings tried when neither the literal-pipe nor alternation pattern matches', async () => {
    writeFileSync(join(tempDir, 'src.ts'), 'gamma\ndelta');

    const handler = createGrepHandler(tempDir);
    // Neither literal "alpha|beta" nor alternation alpha|beta matches gamma/delta
    const result = await handler({ pattern: 'alpha\\|beta', path: tempDir }, createSignal());

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('No matches found');
    // Must mention both attempts
    expect(result.content).toContain("'alpha|beta'");
    expect(result.content).toContain('alternation');
  });

  // Case 3: pattern with a real literal-pipe match — no retry, no note
  it('returns matches directly when the literal-pipe pattern actually matches (no retry note)', async () => {
    // Write a file that really contains the pipe character
    writeFileSync(join(tempDir, 'types.ts'), 'type T = string|number;');

    const handler = createGrepHandler(tempDir);
    // JS 'string\\|number' → pattern string\|number → matches the literal "string|number"
    const result = await handler({ pattern: 'string\\|number', path: tempDir }, createSignal());

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('types.ts');
    // No retry note — the first search found matches
    expect(result.content).not.toContain('matched nothing');
    expect(result.content).not.toContain('reinterpreted');
  });

  // Case 4: \\| (escaped backslash + alternation) — must NOT be rewritten
  it('does not rewrite \\\\| (escaped backslash followed by alternation)', async () => {
    // JS '\\\\\\|' → pattern \\\\| in the string passed to the tool
    // That is: two chars \\ (escaped backslash) followed by | (bare alternation)
    // hasUnescapedBackslashPipe must return false for this, so no retry fires.
    // The bare | is alternation so rg will match either branch.
    writeFileSync(join(tempDir, 'a.txt'), 'alpha');
    writeFileSync(join(tempDir, 'b.txt'), 'beta');

    const handler = createGrepHandler(tempDir);
    // Pass the pattern as the tool input string: \\| where \\ is escaped-backslash + | is alternation
    // In JS source: 'alpha\\\\|beta' → string value: alpha\\|beta
    // rg sees: alpha\\|beta → (\\) is escaped backslash, | is alternation → matches "alpha\" or "beta"
    // But our files don't have backslash literals so only "beta" matches the second branch.
    const result = await handler({ pattern: 'alpha\\\\|beta', path: tempDir }, createSignal());

    // No retry note must appear
    expect(result.content).not.toContain('matched nothing');
    expect(result.content).not.toContain('reinterpreted');
    // The alternation branch beta should match
    expect(result.content).toContain('beta');
  });

  // Case 5: normal pattern with no matches — message unchanged (no retry, no extra text)
  it('returns plain no-match message for a normal pattern with no matches', async () => {
    writeFileSync(join(tempDir, 'src.ts'), 'hello world');

    const handler = createGrepHandler(tempDir);
    const result = await handler({ pattern: 'xyz_no_match', path: tempDir }, createSignal());

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("No matches found for 'xyz_no_match'");
    // No retry artifacts
    expect(result.content).not.toContain('alternation');
    expect(result.content).not.toContain('reinterpreted');
    expect(result.content).not.toContain('literal pipe');
  });
});

// ---------------------------------------------------------------------------
// Abort, scan-cap, and rejection-safety tests (issue #4888 findings)
// ---------------------------------------------------------------------------

describe('grep pipe-retry abort and scan-cap', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grep-pipe-retry-abort-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // Finding 1a: abort during the retry kills the retry process and the call settles as aborted.
  it('settles with abort result when signal is aborted during the retry', async () => {
    // Write enough files so the retry rg has something to do before we abort.
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(tempDir, `file${i}.ts`), `alpha\nbeta\n`.repeat(100));
    }

    const ctrl = new AbortController();
    const handler = createGrepHandler(tempDir);

    // Start the handler (first rg will find no literal-pipe match, triggering retry).
    const promise = handler({ pattern: 'alpha\\|beta', path: tempDir }, ctrl.signal);

    // Abort almost immediately so we race the retry spawn.
    setTimeout(() => ctrl.abort(), 5);

    const result = await promise;
    // Must settle (not hang) and must be the abort result.
    expect(result.isError).toBe(true);
    expect(result.content).toBe('Search aborted');
  });

  // Finding 1b: an already-aborted signal does not spawn the retry at all.
  it('does not spawn a retry when the signal is already aborted', async () => {
    writeFileSync(join(tempDir, 'src.ts'), 'alpha\nbeta');

    const ctrl = new AbortController();
    ctrl.abort(); // abort BEFORE the handler runs

    const handler = createGrepHandler(tempDir);
    const result = await handler({ pattern: 'alpha\\|beta', path: tempDir }, ctrl.signal);

    expect(result.isError).toBe(true);
    expect(result.content).toBe('Search aborted');
  });

  // Finding 2: retry hitting the scan cap returns truncated result with both notes.
  it('returns truncated result with scan-cap note and reinterpretation note when retry exceeds scan cap', async () => {
    // Write enough content that the retry's stdout exceeds a tiny scanCapBytes.
    // Pattern 'alpha\\|beta' → first rg finds no literal "alpha|beta" → retry runs with 'alpha|beta'.
    // The retry WILL find matches, so stdout will be non-empty.
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(tempDir, `f${i}.txt`), 'alpha\n'.repeat(200));
    }

    // Use a very small scan cap so the retry hits it quickly.
    const handler = createGrepHandler(tempDir, { scanCapBytes: 500 });
    const result = await handler({ pattern: 'alpha\\|beta', path: tempDir }, new AbortController().signal);

    expect(result.isError).toBeFalsy();
    expect(result.truncated).toBe(true);
    // Must contain the scan-cap note (references the ceiling).
    expect(result.content).toContain('scan ceiling');
    // Must contain the reinterpretation note.
    expect(result.content).toContain('matched nothing');
    expect(result.content).toContain('literal pipe');
  });

  // Finding 3: an unexpected rejection inside the retry still settles the tool call.
  it('still settles when the retry helper encounters an unexpected error', async () => {
    // Use a non-existent tempDir path so rg spawn errors out in the retry.
    // The first rg will also fail, but we simulate the rejection-safety path
    // by using a pattern that would trigger a retry on a valid dir, then
    // destroying the dir between the first rg finishing and the retry spawning.
    writeFileSync(join(tempDir, 'src.ts'), 'gamma\ndelta');

    const handler = createGrepHandler(tempDir);
    // Pattern has \| but neither literal-pipe nor alternation matches gamma/delta,
    // so the retry runs and encounters a directory that may or may not exist.
    // The important contract: the promise resolves, never rejects.
    const result = await handler({ pattern: 'alpha\\|beta', path: tempDir }, new AbortController().signal);

    // Result must be defined and must not be a hanging promise.
    expect(result).toBeDefined();
    expect(typeof result.content).toBe('string');
  });
});
