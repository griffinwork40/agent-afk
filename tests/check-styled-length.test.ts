/**
 * Unit tests for scripts/check-styled-length.ts.
 *
 * The script's `scanLine` helper is exported for direct import, allowing
 * fully isolated fixture testing without spawning a subprocess — the same
 * approach used in tests/check-terminal-width.test.ts for the inline scan
 * logic, and in tests/audit-chalk-sgr.test.ts for the chalk auditor.
 *
 * We also run an end-to-end subprocess test to verify the gate exits 0 on
 * the current codebase (no violations).
 */

import * as child_process from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { scanLine } from '../scripts/check-styled-length.js';

const SCRIPT = path.resolve(import.meta.dirname, '../scripts/check-styled-length.ts');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(flags: string[] = []): RunResult {
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

// ─── Inline scanLine unit tests ───────────────────────────────────────────────

describe('check-styled-length scanLine', () => {
  describe('true positives: .padEnd/.padStart/.length on the RESULT of palette call', () => {
    it('flags palette.dim(x).padEnd(n)', () => {
      expect(scanLine('const s = palette.dim(label).padEnd(16);')).toHaveLength(1);
    });

    it('flags palette.warning(x).padStart(n)', () => {
      expect(scanLine('const s = palette.warning(val).padStart(8);')).toHaveLength(1);
    });

    it('flags palette.bold(x).length', () => {
      expect(scanLine('if (palette.bold(name).length > 20) {')).toHaveLength(1);
    });

    it('flags palette.info(x).padEnd(n) in a template literal context', () => {
      expect(scanLine('  `${palette.info(id).padEnd(18)}  ${rest}`')).toHaveLength(1);
    });

    it('flags palette.meta(x).padStart(n) assigned to const', () => {
      expect(scanLine('const cost = palette.meta(fmt(n)).padStart(8);')).toHaveLength(1);
    });

    it('reports the matched snippet in the return value', () => {
      const hits = scanLine('x = palette.dim(s).padEnd(10);');
      expect(hits[0]).toContain('palette.dim(');
      expect(hits[0]).toContain('.padEnd(');
    });

    it('flags multiple hits on one line', () => {
      const line = 'f(palette.bold(a).padEnd(4), palette.dim(b).padEnd(8));';
      expect(scanLine(line)).toHaveLength(2);
    });
  });

  describe('false positives: pad/length applied BEFORE styling (safe pattern)', () => {
    it('does NOT flag palette.dim(str.padEnd(n))', () => {
      expect(scanLine("palette.dim('Git'.padEnd(14))")).toHaveLength(0);
    });

    it('does NOT flag palette.warning(str.padStart(n))', () => {
      expect(scanLine('palette.warning(val.padStart(8))')).toHaveLength(0);
    });

    it('does NOT flag palette.bold(arr.length) inside template', () => {
      expect(scanLine('palette.bold(`MCP pending (${keys.length})`)')).toHaveLength(0);
    });

    it('does NOT flag palette.meta(fmt(n).padStart(k))', () => {
      expect(scanLine('palette.meta(formatCost(n).padStart(8))')).toHaveLength(0);
    });

    it('does NOT flag palette.dim(dateOnly(x).padEnd(w))', () => {
      expect(scanLine('palette.dim(dateOnly(c.lastSeen).padEnd(DATE_W))')).toHaveLength(0);
    });

    it('does NOT flag plain string .padEnd not involving palette', () => {
      expect(scanLine("const s = name.padEnd(20);")).toHaveLength(0);
    });

    it('does NOT flag .length on a non-styled value', () => {
      expect(scanLine('if (arr.length === 0) return;')).toHaveLength(0);
    });

    it('does NOT flag palette.bold(String(i).padStart(2))', () => {
      expect(scanLine('palette.bold(String(i + 1).padStart(2))')).toHaveLength(0);
    });
  });

  describe('comment-line exemptions', () => {
    // Comment filtering is handled by scan() (the file-level scanner), not by
    // scanLine(). scanLine() is a pure line-content detector: it reports any
    // palette().method pattern it finds regardless of leading whitespace or //.
    // The file-level scan() skips lines whose trimmed form starts with // or *.
    it('DOES flag a // comment line (comment filtering is scan() responsibility)', () => {
      // scanLine() is a pure detector; callers (scan()) are responsible for
      // skipping comment-only lines before calling scanLine().
      const hits = scanLine('// palette.dim(x).padEnd(10) — example');
      expect(hits).toHaveLength(1);
    });

    it('DOES flag a trailing inline comment (code precedes comment)', () => {
      const hits = scanLine('const s = palette.dim(label).padEnd(10); // ok?');
      expect(hits).toHaveLength(1);
    });
  });

  describe('non-call palette references (finding #2: require whitespace-only before `(`)', () => {
    it('does NOT flag palette.dim followed by semicolon (not a call)', () => {
      // `palette.dim; foo().length` — the member is referenced, not called
      expect(scanLine('const f = palette.dim; foo().length;')).toHaveLength(0);
    });

    it('does NOT flag palette.dim followed by comma (not a call)', () => {
      expect(scanLine('const x = { a: palette.dim, b: s.length };')).toHaveLength(0);
    });

    it('still flags palette.dim(x).padEnd(n) when whitespace precedes `(`', () => {
      expect(scanLine('palette.dim (x).padEnd(10)')).toHaveLength(1);
    });
  });

  describe('nested paren handling', () => {
    it('handles nested function calls inside the palette arg', () => {
      // palette.info(fmt(a, b)).padEnd(n) — the inner (a, b) must not close early
      expect(scanLine('palette.info(fmt(a, b)).padEnd(10)')).toHaveLength(1);
    });

    it('handles string literals with parens inside the palette arg', () => {
      // palette.dim('foo(bar)').padEnd(8) — the literal paren must not confuse depth
      expect(scanLine("palette.dim('foo(bar)').padEnd(8)")).toHaveLength(1);
    });

    it('does NOT flag palette.dim(fmt(a, b).padEnd(n))', () => {
      // padEnd is on fmt result inside the palette call, not on the palette result
      expect(scanLine('palette.dim(fmt(a, b).padEnd(10))')).toHaveLength(0);
    });
  });
});

// ─── End-to-end gate tests (subprocess, real codebase) ───────────────────────

// Spawns a Node subprocess — POSIX-only (matches check-terminal-width.test.ts pattern).
describe.skipIf(process.platform === 'win32')('check-styled-length gate (subprocess)', () => {
  it('exits 0 on the current codebase in --check mode (no violations)', () => {
    const result = run(['--check']);
    expect(result.exitCode, `violations found:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('0 violations');
  });

  it('exits 0 with --list on the current codebase', () => {
    const result = run(['--list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Allowlisted:');
    expect(result.stdout).toContain('Violations:');
  });
});
