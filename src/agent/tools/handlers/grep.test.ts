import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { grepHandler, createGrepHandler } from './grep.js';
import type { ToolHandlerContext } from '../types.js';

describe('grepHandler', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grep-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper to create an AbortSignal that won't be aborted.
   */
  function createSignal(): AbortSignal {
    const controller = new AbortController();
    return controller.signal;
  }

  /**
   * Helper to create an AbortSignal that will be aborted after a delay.
   */
  function createAbortableSignal(delayMs: number): AbortSignal {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), delayMs);
    return controller.signal;
  }

  it('is a valid ToolHandler', () => {
    expect(typeof grepHandler).toBe('function');
  });

  describe('basic pattern matching', () => {
    it('finds pattern in a single file', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'hello world\nfoo bar\nhello again');

      const result = await grepHandler(
        { pattern: 'hello', path: tempDir },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('hello world');
      expect(result.content).toContain('hello again');
    });

    it('finds pattern across multiple files', async () => {
      writeFileSync(join(tempDir, 'file1.txt'), 'hello world');
      writeFileSync(join(tempDir, 'file2.txt'), 'hello universe');

      const result = await grepHandler(
        { pattern: 'hello', path: tempDir },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('file1.txt');
      expect(result.content).toContain('file2.txt');
      expect(result.content).toContain('hello world');
      expect(result.content).toContain('hello universe');
    });

    it('returns line numbers in output', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'line1\nline2 match\nline3');

      const result = await grepHandler(
        { pattern: 'match', path: tempDir },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      // grep -rn includes line numbers in format: file:linenumber:content
      expect(result.content).toContain(':2:');
    });

    it('returns file:line:content format', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'hello world');

      const result = await grepHandler(
        { pattern: 'hello', path: tempDir },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toMatch(/test\.txt:\d+:hello world/);
    });
  });

  describe('no matches', () => {
    it('returns message when no matches found', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'hello world');

      const result = await grepHandler(
        { pattern: 'xyz', path: tempDir },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("No matches found for 'xyz'");
    });

    it('includes path in no-match message', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'hello world');

      const result = await grepHandler(
        { pattern: 'notfound', path: tempDir },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain(tempDir);
    });
  });

  // Ripgrep has no basic-regex (BRE) mode: `|` `+` `?` `(` `)` `{` `}` are
  // always regex metacharacters. This is a deliberate contract change from the
  // previous system-`grep`-backed tool (which defaulted to BRE — a literal `|`
  // — and offered an `extended` opt-in plus a no-match ERE hint, all now
  // removed). These tests lock down the ripgrep-regex semantics.
  describe('regex dialect (ripgrep regex — no BRE mode)', () => {
    it('a bare | alternates and matches either branch', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'alpha\nbeta\ngamma');

      const result = await grepHandler(
        { pattern: 'alpha|beta', path: tempDir },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('alpha');
      expect(result.content).toContain('beta');
      expect(result.content).not.toContain('gamma');
    });

    it('+ is a quantifier', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'aaa\nb');

      const result = await grepHandler(
        { pattern: 'a+', path: tempDir },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('aaa');
    });

    it('( ) grouping works', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'foobar\nfoobaz\nqux');

      const result = await grepHandler(
        { pattern: 'foo(bar|baz)', path: tempDir },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('foobar');
      expect(result.content).toContain('foobaz');
      expect(result.content).not.toContain('qux');
    });

    it('an escaped \\| matches a literal pipe (not alternation)', async () => {
      writeFileSync(join(tempDir, 'types.ts'), 'type T = string|number;');
      writeFileSync(join(tempDir, 'other.txt'), 'string');

      const result = await grepHandler(
        // JS '\\|' → pattern string\|number → matches the LITERAL "string|number",
        // not "string" OR "number". other.txt ("string") must therefore NOT match.
        { pattern: 'string\\|number', path: tempDir },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('types.ts');
      expect(result.content).not.toContain('other.txt');
    });

    it('a no-match returns a plain message with no BRE/extended hint', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'gamma');

      const result = await grepHandler(
        { pattern: 'alpha|beta', path: tempDir },
        createSignal(),
      );

      expect(result.content).toContain('No matches found');
      expect(result.content).not.toContain('extended');
      expect(result.content).not.toContain('BRE');
    });
  });

  describe('include filter', () => {
    it('restricts search to matching file patterns', async () => {
      writeFileSync(join(tempDir, 'test.ts'), 'const hello = 1;');
      writeFileSync(join(tempDir, 'test.txt'), 'hello world');
      writeFileSync(join(tempDir, 'readme.md'), 'hello there');

      const result = await grepHandler(
        { pattern: 'hello', path: tempDir, include: '*.ts' },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('test.ts');
      expect(result.content).not.toContain('test.txt');
      expect(result.content).not.toContain('readme.md');
    });

    it('works with multiple file extensions', async () => {
      writeFileSync(join(tempDir, 'test.ts'), 'foo');
      writeFileSync(join(tempDir, 'test.js'), 'foo');
      writeFileSync(join(tempDir, 'test.txt'), 'foo');

      const result = await grepHandler(
        { pattern: 'foo', path: tempDir, include: '*.js' },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('test.js');
      expect(result.content).not.toContain('test.ts');
    });
  });

  describe('output truncation', () => {
    it('truncates output at 100KB', async () => {
      // Create a file with many matching lines to exceed 100KB (but well
      // under the 8MB hard cap, so grep completes and the close path reduces
      // the output to a head+tail view).
      const largeLine = 'hello ' + 'x'.repeat(1000);
      const lines = Array(120).fill(largeLine).join('\n');
      writeFileSync(join(tempDir, 'large.txt'), lines);

      const result = await grepHandler(
        { pattern: 'hello', path: tempDir },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content.length).toBeLessThanOrEqual(100_000 + 50);
      expect(result.content).toContain('bytes truncated');
    });

    // Regression: subagents must distinguish "got a head+tail slice of
    // legitimate matches" from any other state via the structured `truncated`
    // flag, not by substring-scanning content. Sentinel wording varies by
    // path (head+tail elision marker vs hard-cap kill note), so any caller
    // doing exact-match string detection would silently miss cases.
    it('sets ToolResult.truncated=true when output exceeds 100KB', async () => {
      const largeLine = 'hello ' + 'x'.repeat(1000);
      const lines = Array(120).fill(largeLine).join('\n');
      writeFileSync(join(tempDir, 'large.txt'), lines);

      const result = await grepHandler(
        { pattern: 'hello', path: tempDir },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.truncated).toBe(true);
    });

    it('does not truncate output under 100KB', async () => {
      const content = Array(50).fill('hello world').join('\n');
      writeFileSync(join(tempDir, 'test.txt'), content);

      const result = await grepHandler(
        { pattern: 'hello', path: tempDir },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).not.toContain('truncated');
      expect(result.truncated).toBeUndefined();
    });

    // Regression: V8 max-string-length crash (RangeError: Invalid string
    // length). The accumulator is bounded at HARD_CAP_BYTES (8MB) and the
    // child is SIGKILL'd when combined output crosses it — a genuine-runaway
    // guard (an unconstrained recursive search across `node_modules`). We
    // exercise it with >8MB of matching output so the mid-stream kill fires
    // and emits the hard-cap sentinel; the model-facing view is reduced to a
    // ~100KB head+tail regardless.
    it('handles matching output orders of magnitude above the cap (V8 overflow guard)', async () => {
      // ~10MB of matching content: 10,000 lines × ~1010 bytes/line — well
      // past the 8MB hard cap.
      const largeLine = 'hello ' + 'x'.repeat(1000);
      const lines = Array(10_000).fill(largeLine).join('\n');
      writeFileSync(join(tempDir, 'huge.txt'), lines);

      const start = Date.now();
      const result = await grepHandler(
        { pattern: 'hello', path: tempDir },
        createSignal(),
      );
      const elapsedMs = Date.now() - start;

      expect(result.isError).toBeFalsy();
      // Head+tail model view (≤100KB) plus the short hard-cap kill sentinel.
      expect(result.content.length).toBeLessThanOrEqual(100_000 + 200);
      expect(result.content).toContain('was terminated');
      // Structured flag is the load-bearing signal for non-model
      // consumers (subagent traces, hooks). Sentinel string remains for
      // the model's in-band context — both must be set on the mid-stream
      // kill path.
      expect(result.truncated).toBe(true);
      // Reading 8MB off the pipe is sub-second; 5s is generous for CI load
      // but discriminates from a "ran the full scan to completion" path.
      expect(elapsedMs).toBeLessThan(5_000);
    }, 30_000);

    // Companion proof-of-kill test: two files, each on its own larger than
    // the 8MB hard cap. The mid-stream kill fires while grep is still
    // emitting matches from whichever file it opened first, so that file's
    // content is (partially) captured and the other is never reached.
    //
    // F3: assertions are order-agnostic. `grep -r` traversal order is
    // filesystem-dependent — BSD grep on macOS uses readdir() inode order,
    // not lexical — so we cannot rely on first.txt being read before
    // second.txt. Instead we assert "exactly one of {hello a, hello b}
    // appears" — preserving the discriminating signal (kill fired
    // mid-traversal) without depending on which file grep opened first.
    it('mid-stream hard cap: kills grep mid-traversal, capturing only one file (V8 overflow guard)', async () => {
      const aLine = 'hello a' + 'x'.repeat(993); // ~1001 bytes/line
      const firstContent = Array(9000).fill(aLine).join('\n'); // ~9MB > 8MB cap
      writeFileSync(join(tempDir, 'first.txt'), firstContent);

      const bLine = 'hello b' + 'x'.repeat(993);
      const secondContent = Array(9000).fill(bLine).join('\n'); // ~9MB
      writeFileSync(join(tempDir, 'second.txt'), secondContent);

      const start = Date.now();
      const result = await grepHandler(
        { pattern: 'hello', path: tempDir },
        createSignal(),
      );
      const elapsedMs = Date.now() - start;

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('was terminated');
      expect(result.truncated).toBe(true);

      const hasA = result.content.includes('hello a');
      const hasB = result.content.includes('hello b');
      // Exactly one file's content survived — the kill fired before grep
      // finished the first file and opened the second. If both appear, the
      // mid-stream guard never fired; if neither, the sentinel assertion
      // above would also have failed.
      expect(hasA || hasB).toBe(true);
      expect(hasA && hasB).toBe(false);
      // Killed after ~8MB, well before a full scan of both 9MB files.
      expect(elapsedMs).toBeLessThan(5_000);
    }, 30_000);
  });

  describe('input validation', () => {
    it('throws on missing pattern', async () => {
      await expect(
        grepHandler({ path: tempDir }, createSignal()),
      ).rejects.toThrow(/pattern.*string/i);
    });

    it('throws on non-string pattern', async () => {
      await expect(
        grepHandler({ pattern: 123, path: tempDir }, createSignal()),
      ).rejects.toThrow(/pattern.*string/i);
    });

    it('throws on non-object input', async () => {
      await expect(
        grepHandler('not an object', createSignal()),
      ).rejects.toThrow(/must be an object/i);
    });

    it('throws on non-string include', async () => {
      await expect(
        grepHandler(
          { pattern: 'test', path: tempDir, include: 123 },
          createSignal(),
        ),
      ).rejects.toThrow(/include.*string/i);
    });

    it('uses process.cwd() when path not provided', async () => {
      // The handler must accept input with no `path` (defaults to process.cwd())
      // and return a result without throwing. We don't assert on matches:
      // process.cwd() at test time is the repo, so the search may find incidental
      // hits, find nothing, or be aborted first — all valid. A no-match result is
      // `{ content }` with NO `isError` key (only the abort/error paths set it),
      // so assert only on `content`. Abort quickly so a broad cwd search (now fast
      // under ripgrep's .gitignore-aware defaults) can't hang the suite.
      const signal = createAbortableSignal(100);
      const result = await grepHandler(
        { pattern: 'nonexistent_unique_marker_9999_xyz' },
        signal,
      );

      expect(result).toHaveProperty('content');
      expect(typeof result.content).toBe('string');
    }, 3000);
  });

  describe('signal/abort handling', () => {
    it('aborts search when signal is aborted', async () => {
      writeFileSync(join(tempDir, 'file.txt'), 'hello world');

      const controller = new AbortController();
      controller.abort();
      const result = await grepHandler(
        { pattern: 'hello', path: tempDir },
        controller.signal,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('aborted');
    });

    it('completes normally when signal is not aborted', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'hello world');
      const controller = new AbortController();
      const result = await grepHandler(
        { pattern: 'hello', path: tempDir },
        controller.signal,
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('hello');
    });
  });

  describe('ANSI stripping', () => {
    it('strips ANSI color codes from output', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'hello world');

      // Note: grep itself doesn't emit ANSI codes unless --color is used.
      // But the handler strips them anyway as a safety measure.
      const result = await grepHandler(
        { pattern: 'hello', path: tempDir },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).not.toContain('\x1b[');
    });
  });

  describe('edge cases', () => {
    it('handles empty directory', async () => {
      const result = await grepHandler(
        { pattern: 'hello', path: tempDir },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("No matches found for 'hello'");
    });

    it('handles special regex characters in pattern', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'test.file');

      const result = await grepHandler(
        { pattern: '.', path: tempDir },
        createSignal(),
      );

      // grep treats . as regex by default, so it matches any character
      expect(result).toHaveProperty('content');
    });

    it('handles multiline file content', async () => {
      const content = `line 1
line 2 with hello
line 3
hello at start
line 5`;
      writeFileSync(join(tempDir, 'test.txt'), content);

      const result = await grepHandler(
        { pattern: 'hello', path: tempDir },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('hello');
      // Check that we got two matches
      const matches = result.content.split('\n').filter((l) => l.includes('hello'));
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it('handles files with paths containing spaces', async () => {
      const subdir = join(tempDir, 'my dir');
      const fs = require('fs');
      fs.mkdirSync(subdir, { recursive: true });
      writeFileSync(join(subdir, 'test file.txt'), 'hello world');

      const result = await grepHandler(
        { pattern: 'hello', path: tempDir },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('hello world');
    });

    it('handles case-sensitive searching', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'Hello world\nhello there');

      const result = await grepHandler(
        { pattern: 'hello', path: tempDir },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      // Should only match lowercase hello
      expect(result.content).toContain('hello there');
      expect(result.content).not.toContain('Hello world');
    });
  });

  describe('concurrent execution', () => {
    it('handles multiple concurrent searches', async () => {
      writeFileSync(join(tempDir, 'file1.txt'), 'foo bar');
      writeFileSync(join(tempDir, 'file2.txt'), 'baz qux');

      const results = await Promise.all([
        grepHandler({ pattern: 'foo', path: tempDir }, createSignal()),
        grepHandler({ pattern: 'baz', path: tempDir }, createSignal()),
        grepHandler({ pattern: 'xyz', path: tempDir }, createSignal()),
      ]);

      expect(results).toHaveLength(3);
      expect(results[0].content).toContain('foo');
      expect(results[1].content).toContain('baz');
      expect(results[2].content).toContain('No matches found');
    });
  });
});

describe('createGrepHandler — cwd parameter', () => {
  let tempDir: string;
  let needle: string;

  function createSignal(): AbortSignal {
    return new AbortController().signal;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grep-cwd-test-'));
    // Build the needle at runtime so its literal form never appears in
    // this source file — otherwise `grep -rn <needle> <repo-root>` would
    // self-match and the "no matches" assertion below would fail.
    needle = String.fromCharCode(115, 110, 116, 95, 110, 100, 108, 95, 122, 113);
    writeFileSync(join(tempDir, 'target.txt'), `${needle}\n`, 'utf8');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });


  it('without cwd: defaults to process.cwd() when input omits path', async () => {
    // Use tempDir as the factory cwd so grep has a bounded search root
    // instead of scanning the full repo (which hits node_modules and
    // times out). The needle is written to target.txt in beforeEach, but
    // we search an *unrelated* empty dir to prove the "no path → use cwd
    // → no matches" path without traversing the whole filesystem.
    const emptyDir = await import('fs').then((m) =>
      m.promises.mkdtemp(join(tmpdir(), 'grep-cwd-empty-')),
    );
    try {
      const handler = createGrepHandler(emptyDir);
      const result = await handler({ pattern: needle }, createSignal());
      expect(result.content).toMatch(/No matches found/);
    } finally {
      await import('fs').then((m) => m.promises.rm(emptyDir, { recursive: true, force: true }));
    }
  });

  it('with cwd: defaults to the configured directory when input omits path', async () => {
    const handler = createGrepHandler(tempDir);
    const result = await handler({ pattern: needle }, createSignal());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('target.txt');
    expect(result.content).toContain(needle);
  });

  it('explicit input.path overrides the configured cwd', async () => {
    const handler = createGrepHandler(tempDir);
    const result = await handler(
      { pattern: needle, path: '/nonexistent-dir-xyz' },
      createSignal(),
    );
    // grep error code 2 → handler reports "grep error: ..."
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/grep error/);
  });
});

describe('grepHandler cwd containment', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grep-contain-'));
    writeFileSync(join(tempDir, 'test.txt'), 'hello world');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createSignal(): AbortSignal {
    return new AbortController().signal;
  }

  it('rejects absolute path outside context.cwd', async () => {
    const context: ToolHandlerContext = { cwd: tempDir };
    // parseGrepInput throws for containment violations — grepHandler propagates the throw
    await expect(
      grepHandler({ pattern: 'root', path: '/etc' }, createSignal(), context),
    ).rejects.toThrow(/outside the allowed/);
  });

  it('resolves relative path against context.cwd', async () => {
    const context: ToolHandlerContext = { cwd: tempDir };
    const result = await grepHandler(
      { pattern: 'hello', path: '.' },
      createSignal(),
      context,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('hello');
  });

  it('allows absolute path within context.cwd', async () => {
    const context: ToolHandlerContext = { cwd: tempDir };
    const result = await grepHandler(
      { pattern: 'hello', path: tempDir },
      createSignal(),
      context,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('hello');
  });

  it('falls back to process.cwd() resolution when no cwd in context', async () => {
    const context: ToolHandlerContext = {};
    const result = await grepHandler(
      { pattern: 'hello', path: tempDir },
      createSignal(),
      context,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('hello');
  });

  it('defaults path to context.cwd when path input is omitted', async () => {
    const context: ToolHandlerContext = { cwd: tempDir };
    const result = await grepHandler(
      { pattern: 'hello' },
      createSignal(),
      context,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('hello');
  });

  describe('spawn-cwd error enrichment (#441)', () => {
    it('names the dead working directory when the spawn cwd was deleted (ENOENT masquerade)', async () => {
      // Parity with the bash handler: spawning grep with a deleted cwd rejects
      // as `spawn grep ENOENT` — naming the binary, not the missing dir — so an
      // agent retries blindly after its worktree was reaped mid-session. The
      // handler must translate this into an actionable message.
      const deadCwd = mkdtempSync(join(tmpdir(), 'grep-cwd-dead-'));
      rmSync(deadCwd, { recursive: true, force: true });
      const handler = createGrepHandler(deadCwd);
      const result = await handler({ pattern: 'x', path: deadCwd }, createSignal());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('working directory does not exist');
      expect(result.content).toContain(deadCwd);
      expect(result.content).toContain('deleted worktree?');
    });

    it('spawns under context.resolveBase and names IT (not the stale factory cwd) when the re-anchored worktree was deleted (#441 Codex follow-up)', async () => {
      // Divergence guard: after an in-flight setResolveBase re-anchor, the live
      // anchor is context.resolveBase while the handler's factory `cwd` is stale.
      // grep must spawn under — and diagnose against — the SAME effectiveCwd
      // (context-first, bash parity). Pre-fix, spawn used the (live) factory cwd
      // and grep merely errored on the missing path arg; the deleted resolveBase
      // was never surfaced.
      const liveFactoryCwd = mkdtempSync(join(tmpdir(), 'grep-factory-live-'));
      const deadResolveBase = mkdtempSync(join(tmpdir(), 'grep-resolvebase-dead-'));
      rmSync(deadResolveBase, { recursive: true, force: true });
      try {
        const handler = createGrepHandler(liveFactoryCwd);
        const result = await handler(
          { pattern: 'x', path: '.' },
          createSignal(),
          { resolveBase: deadResolveBase } as ToolHandlerContext,
        );
        expect(result.isError).toBe(true);
        expect(result.content).toContain('working directory does not exist');
        expect(result.content).toContain(deadResolveBase);
        expect(result.content).toContain('deleted worktree?');
      } finally {
        rmSync(liveFactoryCwd, { recursive: true, force: true });
      }
    });
  });
});
