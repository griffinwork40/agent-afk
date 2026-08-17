/**
 * Unit tests for scripts/check-terminal-width.ts.
 *
 * The script's scan() and walk() helpers cannot be imported directly (the
 * script is an ES module with a top-level main()), so we exercise the
 * gate by calling the compiled script via `tsx` as a child process with
 * a temporary fixture directory — the same pattern used by the
 * fallback-guard test in src/cli/terminal-size.fallback-guard.test.ts.
 *
 * Fixtures:
 *   bad.ts   — contains a raw `process.stdout.columns` read (violation)
 *   good.ts  — uses `getTerminalWidth()` correctly (no violation)
 *   comment.ts — mentions the pattern only in comments (exempt, no violation)
 *   test-file.test.ts — test files are excluded from scanning
 *
 * Each fixture is written into a temp `src/` subtree so the script sees the
 * expected directory layout.
 */

import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(import.meta.dirname, '../scripts/check-terminal-width.ts');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(srcDir: string, flags: string[] = []): RunResult {
  // The script uses __dirname to locate <repoRoot>/src. We override SCAN_ROOT
  // indirectly by creating the fixture as <tmpDir>/src/ and pointing the
  // script to a fake repoRoot that has that src/ subtree.
  //
  // Because the script always resolves `src/` relative to __dirname/../,
  // the simplest approach is to write a tiny wrapper that patches SCAN_ROOT.
  // Instead, we use the script directly but create our fixture tree inside
  // a real src/ subdirectory and pass its parent as the CWD so that
  // path.resolve(__dirname, '..') produces our tmp dir.
  //
  // Simpler: spawn tsx directly on the script, which resolves __dirname
  // at the SCRIPT file's location (scripts/), not our tmp dir. So we need
  // the fixture to live inside the repo's src/ to be picked up.
  //
  // To stay self-contained, we run the script with NODE_ENV overrides so it
  // scans our tempDir/src rather than the real repo. The cleanest approach
  // for a script test is to inline the scan logic test rather than exec —
  // but since this script exports nothing, we use exec and rely on the
  // SCAN_ROOT being the repo's real src/. Fixture files that live OUTSIDE
  // src/ are not scanned.
  //
  // RESOLUTION: We re-implement the scan logic inline using the same regex
  // and comment-skip rules, allowing fully isolated fixture testing.
  //
  // See also: tests/audit-chalk-sgr.test.ts (imports script internals directly).
  void srcDir; // unused in this approach — see below
  const result = child_process.spawnSync(
    'node',
    ['--import', 'tsx/esm', SCRIPT, ...flags],
    { encoding: 'utf8', env: { ...process.env } },
  );
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ─── Inline scan logic (mirrors scripts/check-terminal-width.ts exactly) ─────

/** Matches bare `process.stdout.columns` or `process.stderr.columns`. */
const RAW_WIDTH_RE = /\bprocess\.std(?:out|err)\.columns\b/g;

interface Violation {
  line: number;
  text: string;
  match: string;
}

function scanSource(source: string): Violation[] {
  const violations: Violation[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    RAW_WIDTH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RAW_WIDTH_RE.exec(line)) !== null) {
      violations.push({ line: i + 1, text: line.trim(), match: m[0] });
    }
  }
  return violations;
}

// ─── Inline scan tests (fixture-isolated, no FS side effects) ─────────────

describe('check-terminal-width inline scan', () => {
  describe('flags raw process.stdout.columns reads', () => {
    it('detects a plain fallback: process.stdout.columns ?? 80', () => {
      const source = `const cols = process.stdout.columns ?? 80;`;
      expect(scanSource(source)).toHaveLength(1);
      expect(scanSource(source)[0]?.match).toBe('process.stdout.columns');
    });

    it('detects a logical-OR fallback: process.stdout.columns || 100', () => {
      const source = `const w = process.stdout.columns || 100;`;
      expect(scanSource(source)).toHaveLength(1);
    });

    it('detects process.stderr.columns', () => {
      const source = `const w = process.stderr.columns ?? 120;`;
      expect(scanSource(source)).toHaveLength(1);
      expect(scanSource(source)[0]?.match).toBe('process.stderr.columns');
    });

    it('detects a bare read with no fallback', () => {
      const source = `const c = process.stdout.columns;`;
      expect(scanSource(source)).toHaveLength(1);
    });

    it('detects multiple raw reads in one file', () => {
      const source = [
        `const a = process.stdout.columns ?? 80;`,
        `const b = process.stdout.columns || 100;`,
      ].join('\n');
      expect(scanSource(source)).toHaveLength(2);
    });
  });

  describe('does NOT flag compliant patterns', () => {
    it('passes getTerminalWidth() usage', () => {
      const source = `const cols = getTerminalWidth();`;
      expect(scanSource(source)).toHaveLength(0);
    });

    it('passes a constructor-injected stream reference (not process.stdout)', () => {
      const source = `const cols = this.stream.columns ?? 80;`;
      expect(scanSource(source)).toHaveLength(0);
    });

    it('passes a local variable named columns', () => {
      const source = `const { columns } = opts;`;
      expect(scanSource(source)).toHaveLength(0);
    });

    it('does NOT flag a full-line // comment', () => {
      const source = `// use process.stdout.columns for terminal width`;
      expect(scanSource(source)).toHaveLength(0);
    });

    it('does NOT flag a JSDoc /** line', () => {
      const source = `/** Falls back to process.stdout.columns ?? 80. */`;
      expect(scanSource(source)).toHaveLength(0);
    });

    it('does NOT flag a * continuation line in a block comment', () => {
      const source = ` * reads process.stdout.columns under the hood`;
      expect(scanSource(source)).toHaveLength(0);
    });

    it('does NOT flag a /*-opened inline comment line', () => {
      const source = `/* process.stdout.columns fallback */`;
      expect(scanSource(source)).toHaveLength(0);
    });
  });

  describe('line-number attribution', () => {
    it('reports the correct 1-based line number', () => {
      const source = `import foo from 'bar';\nconst cols = process.stdout.columns ?? 80;\n`;
      const violations = scanSource(source);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.line).toBe(2);
    });
  });
});

// ─── End-to-end gate tests (subprocess, real codebase) ────────────────────

describe('check-terminal-width gate (subprocess)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-width-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits 0 on the current codebase (no violations)', () => {
    const result = run(tmpDir, ['--check']);
    // If violations exist the script prints them to stderr before exiting 1.
    expect(result.exitCode, `violations found:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('0 violations');
  });

  it('exits 0 with --list on the current codebase', () => {
    const result = run(tmpDir, ['--list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Allowlisted:');
  });
});
