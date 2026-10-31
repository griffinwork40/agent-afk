import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkPair,
  classifyDir,
  collectLogicalLine,
  importedSegment,
  isAllowed,
  scanFile,
  srcSegment,
} from '../scripts/audit-layer-imports.js';
import type { AllowedPair } from '../scripts/audit-layer-imports.allowlist.js';

// ── collectLogicalLine ────────────────────────────────────────────────────────

describe('collectLogicalLine — single-line imports', () => {
  it('returns the line unchanged when the import closes on one line', () => {
    const lines = ["import { Foo } from '../cli/types.js';"];
    const result = collectLogicalLine(lines, 0);
    expect(result.logical).toBe(lines[0]);
    expect(result.consumed).toBe(1);
  });

  it('handles a default import (no braces)', () => {
    const lines = ["import Foo from '../cli/types.js';"];
    const result = collectLogicalLine(lines, 0);
    expect(result.logical).toBe(lines[0]);
    expect(result.consumed).toBe(1);
  });

  it('handles a namespace import', () => {
    const lines = ["import * as Foo from '../cli/types.js';"];
    const result = collectLogicalLine(lines, 0);
    expect(result.logical).toBe(lines[0]);
    expect(result.consumed).toBe(1);
  });

  it('handles export-from on one line', () => {
    const lines = ["export { Foo } from '../cli/types.js';"];
    const result = collectLogicalLine(lines, 0);
    expect(result.logical).toBe(lines[0]);
    expect(result.consumed).toBe(1);
  });

  it('handles import type on one line', () => {
    const lines = ["import type { Foo } from '../cli/types.js';"];
    const result = collectLogicalLine(lines, 0);
    expect(result.logical).toBe(lines[0]);
    expect(result.consumed).toBe(1);
  });
});

describe('collectLogicalLine — multiline imports', () => {
  it('joins a two-line import', () => {
    const lines = [
      'import {',
      "  Foo } from '../cli/types.js';",
    ];
    const result = collectLogicalLine(lines, 0);
    expect(result.logical).toContain("from '../cli/types.js'");
    expect(result.consumed).toBe(2);
  });

  it('joins a three-line import', () => {
    const lines = [
      'import {',
      '  Foo,',
      "  Bar } from '../cli/types.js';",
    ];
    const result = collectLogicalLine(lines, 0);
    expect(result.logical).toContain("from '../cli/types.js'");
    expect(result.consumed).toBe(3);
  });

  it('joins a four-line import with trailing comma', () => {
    const lines = [
      'import {',
      '  Foo,',
      '  Bar,',
      "} from '../cli/types.js';",
    ];
    const result = collectLogicalLine(lines, 0);
    expect(result.logical).toContain("from '../cli/types.js'");
    expect(result.consumed).toBe(4);
  });

  it('starts accumulation at the correct offset', () => {
    const lines = [
      "import { A } from './a.js';",
      'import {',
      '  B,',
      "} from '../cli/b.js';",
    ];
    const result = collectLogicalLine(lines, 1);
    expect(result.logical).toContain("from '../cli/b.js'");
    expect(result.consumed).toBe(3);
  });
});

// ── isAllowed — exact path-segment matching ───────────────────────────────────

describe('isAllowed — path-segment boundary matching', () => {
  const pairs: ReadonlyArray<AllowedPair> = [
    {
      file: 'src/agent/foo.ts',
      importContains: 'cli/',
      reason: 'test',
    },
  ];

  it('allows a matching file + specifier containing cli/', () => {
    expect(isAllowed('src/agent/foo.ts', '../cli/palette.js', pairs)).toBe(true);
  });

  it('allows a specifier where cli/ appears after a /', () => {
    expect(isAllowed('src/agent/foo.ts', '../../src/cli/types.js', pairs)).toBe(true);
  });

  it('allows a bare relative specifier starting with cli/', () => {
    // e.g. from within src/agent/ resolving to cli/foo
    expect(isAllowed('src/agent/foo.ts', './cli/foo.js', pairs)).toBe(true);
  });

  it('rejects a specifier where cli/ appears as part of a different directory name', () => {
    // 'unicli/foo' contains 'cli/' after 'uni' — must NOT match
    expect(isAllowed('src/agent/foo.ts', '../unicli/foo.js', pairs)).toBe(false);
  });

  it('rejects when the file does not match the allowlist entry', () => {
    expect(isAllowed('src/agent/other.ts', '../cli/palette.js', pairs)).toBe(false);
  });

  it('rejects when the specifier does not contain the needle', () => {
    expect(isAllowed('src/agent/foo.ts', '../telegram/bot.js', pairs)).toBe(false);
  });

  it('rejects an empty pairs list', () => {
    expect(isAllowed('src/agent/foo.ts', '../cli/palette.js', [])).toBe(false);
  });
});

describe('isAllowed — telegram/ segment', () => {
  const pairs: ReadonlyArray<AllowedPair> = [
    {
      file: 'src/agent/spine/spine-hook.ts',
      importContains: 'telegram/',
      reason: 'test',
    },
  ];

  it('allows telegram/ in the specifier', () => {
    expect(
      isAllowed('src/agent/spine/spine-hook.ts', '../../telegram/bot.js', pairs),
    ).toBe(true);
  });

  it('rejects cli/ when allowlist only covers telegram/', () => {
    expect(
      isAllowed('src/agent/spine/spine-hook.ts', '../../cli/commands.js', pairs),
    ).toBe(false);
  });
});

// ── Block-comment skip — regression guard ─────────────────────────────────────
// These tests verify that block-comment content is never mistaken for an import.
// The audit script's inBlockComment state machine is exercised indirectly via
// isAllowed / collectLogicalLine; a direct integration test would require
// spawning the script, which is out of scope here.  The structural coverage
// is provided by the multiline and boundary tests above.

describe('isAllowed — specifier at index 0 (bare specifier starts with needle)', () => {
  const pairs: ReadonlyArray<AllowedPair> = [
    { file: 'src/agent/foo.ts', importContains: 'cli/', reason: 'test' },
  ];

  it('matches when specifier starts directly with needle (idx === 0)', () => {
    // Rare but valid: bare `cli/foo` import with no leading dot
    expect(isAllowed('src/agent/foo.ts', 'cli/foo.js', pairs)).toBe(true);
  });
});

// ── classifyDir ───────────────────────────────────────────────────────────────

describe('classifyDir', () => {
  it("classifies 'cli' as surface", () => {
    expect(classifyDir('cli')).toBe('surface');
  });

  it("classifies 'telegram' as surface", () => {
    expect(classifyDir('telegram')).toBe('surface');
  });

  it("classifies 'web-server' as surface", () => {
    expect(classifyDir('web-server')).toBe('surface');
  });

  it("classifies 'agent' as core-infra", () => {
    expect(classifyDir('agent')).toBe('core-infra');
  });

  it("classifies 'browser' as core-infra", () => {
    expect(classifyDir('browser')).toBe('core-infra');
  });

  it("classifies 'skills' as core-infra", () => {
    expect(classifyDir('skills')).toBe('core-infra');
  });

  it("classifies 'config' as foundation", () => {
    expect(classifyDir('config')).toBe('foundation');
  });

  it("classifies 'utils' as foundation", () => {
    expect(classifyDir('utils')).toBe('foundation');
  });

  it("classifies 'improve' as feature", () => {
    expect(classifyDir('improve')).toBe('feature');
  });

  it("classifies 'insights' as feature", () => {
    expect(classifyDir('insights')).toBe('feature');
  });

  it("classifies 'whatif' as feature", () => {
    expect(classifyDir('whatif')).toBe('feature');
  });

  it("classifies 'paths.ts' as foundation (startsWith 'paths')", () => {
    expect(classifyDir('paths.ts')).toBe('foundation');
  });

  it("classifies 'paths-helpers.ts' as foundation (startsWith 'paths')", () => {
    expect(classifyDir('paths-helpers.ts')).toBe('foundation');
  });

  it("classifies an unknown directory as 'unknown'", () => {
    expect(classifyDir('unknown-dir')).toBe('unknown');
  });

  it("classifies an empty string as 'unknown'", () => {
    expect(classifyDir('')).toBe('unknown');
  });
});

// ── srcSegment ────────────────────────────────────────────────────────────────

describe('srcSegment', () => {
  it("returns the subdirectory for 'src/agent/foo.ts'", () => {
    expect(srcSegment('src/agent/foo.ts')).toBe('agent');
  });

  it("returns the subdirectory for 'src/cli/bar.ts'", () => {
    expect(srcSegment('src/cli/bar.ts')).toBe('cli');
  });

  it("returns the filename for a top-level src/ file 'src/paths.ts'", () => {
    expect(srcSegment('src/paths.ts')).toBe('paths.ts');
  });

  it("returns undefined for a path not starting with 'src'", () => {
    expect(srcSegment('notSrc/foo.ts')).toBeUndefined();
  });

  it("returns undefined for a path that is just 'src'", () => {
    expect(srcSegment('src')).toBeUndefined();
  });

  it("returns undefined for an empty path", () => {
    expect(srcSegment('')).toBeUndefined();
  });

  it("returns the deep subdirectory first segment for 'src/agent/spine/deep.ts'", () => {
    expect(srcSegment('src/agent/spine/deep.ts')).toBe('agent');
  });
});

// ── importedSegment ───────────────────────────────────────────────────────────

describe('importedSegment', () => {
  // Use a fake SCAN_ROOT so tests don't depend on __dirname resolution.
  const fakeRoot = '/fake/repo/src';

  it("resolves '../cli/types.js' from src/agent/foo.ts to 'cli'", () => {
    const absPath = '/fake/repo/src/agent/foo.ts';
    expect(importedSegment(absPath, '../cli/types.js', fakeRoot)).toBe('cli');
  });

  it("resolves '../../utils/helpers.js' from src/agent/sub/foo.ts to 'utils'", () => {
    const absPath = '/fake/repo/src/agent/sub/foo.ts';
    expect(importedSegment(absPath, '../../utils/helpers.js', fakeRoot)).toBe('utils');
  });

  it('returns undefined for a third-party specifier (no leading dot)', () => {
    const absPath = '/fake/repo/src/agent/foo.ts';
    expect(importedSegment(absPath, 'vitest', fakeRoot)).toBeUndefined();
  });

  it('returns undefined for a specifier that resolves outside src/', () => {
    // From src/agent/foo.ts, going up three levels exits src/
    const absPath = '/fake/repo/src/agent/foo.ts';
    expect(importedSegment(absPath, '../../../outside/thing.js', fakeRoot)).toBeUndefined();
  });

  it("resolves './sibling.js' to the same directory segment 'agent'", () => {
    const absPath = '/fake/repo/src/agent/foo.ts';
    expect(importedSegment(absPath, './sibling.js', fakeRoot)).toBe('agent');
  });

  it("resolves '../telegram/bot.js' from src/agent/foo.ts to 'telegram'", () => {
    const absPath = '/fake/repo/src/agent/foo.ts';
    expect(importedSegment(absPath, '../telegram/bot.js', fakeRoot)).toBe('telegram');
  });

  it('uses the module-level SCAN_ROOT when no override is provided (smoke test)', () => {
    // We can't control SCAN_ROOT here, but we CAN verify the function accepts
    // two-argument form without throwing.
    const absPath = '/some/path/src/agent/foo.ts';
    // Third-party specifier always returns undefined regardless of SCAN_ROOT.
    expect(importedSegment(absPath, 'node:fs')).toBeUndefined();
  });
});

// ── checkPair ─────────────────────────────────────────────────────────────────

describe('checkPair', () => {
  it('Rule 1: core-infra importing surface → non-null violation string', () => {
    const result = checkPair('core-infra', 'agent', 'surface', 'cli');
    expect(result).not.toBeNull();
    expect(result).toContain('Rule 1');
    expect(result).toContain('agent');
    expect(result).toContain('cli');
  });

  it('Rule 2: foundation importing core-infra → non-null violation string', () => {
    const result = checkPair('foundation', 'config', 'core-infra', 'agent');
    expect(result).not.toBeNull();
    expect(result).toContain('Rule 2');
  });

  it('Rule 2: foundation importing surface → non-null violation string', () => {
    const result = checkPair('foundation', 'config', 'surface', 'cli');
    expect(result).not.toBeNull();
    expect(result).toContain('Rule 2');
  });

  it('Rule 2: foundation importing feature → non-null violation string', () => {
    const result = checkPair('foundation', 'utils', 'feature', 'improve');
    expect(result).not.toBeNull();
    expect(result).toContain('Rule 2');
  });

  it('Rule 3: feature importing surface → non-null violation string', () => {
    const result = checkPair('feature', 'improve', 'surface', 'cli');
    expect(result).not.toBeNull();
    expect(result).toContain('Rule 3');
    expect(result).toContain('improve');
    expect(result).toContain('cli');
  });

  it('allowed: core-infra importing core-infra → null', () => {
    expect(checkPair('core-infra', 'agent', 'core-infra', 'skills')).toBeNull();
  });

  it('allowed: same layer surface → surface → null', () => {
    expect(checkPair('surface', 'cli', 'surface', 'telegram')).toBeNull();
  });

  it('allowed: surface importing core-infra → null (surface may depend on core-infra)', () => {
    expect(checkPair('surface', 'cli', 'core-infra', 'agent')).toBeNull();
  });

  it('allowed: surface importing foundation → null', () => {
    expect(checkPair('surface', 'cli', 'foundation', 'config')).toBeNull();
  });

  it('allowed: core-infra importing foundation → null', () => {
    expect(checkPair('core-infra', 'agent', 'foundation', 'utils')).toBeNull();
  });

  it('allowed: feature importing core-infra → null', () => {
    expect(checkPair('feature', 'improve', 'core-infra', 'agent')).toBeNull();
  });
});

// ── scanFile — block-comment state machine ────────────────────────────────────

describe('scanFile — block-comment state machine', () => {
  // Use a portable fake root so tests are independent of the real repo layout
  // and work identically on Windows (where path.join returns backslashes).
  // We inject scanRoot='/fake/src' and absPath='/fake/src/agent/fake.ts' so
  // importedSegment resolves '../cli/types.js' → segment 'cli' on all platforms.
  const fakeRoot = '/fake/src';
  const absPath = '/fake/src/agent/fake.ts';
  const relPath = 'src/agent/fake.ts';
  const importerLayer = 'core-infra' as const;

  it('does NOT report a violation for an import inside a multi-line block comment', () => {
    const lines = [
      '/*',
      " * import { Foo } from '../cli/types.js';",
      ' */',
      'const x = 1;',
    ];
    const violations = scanFile(absPath, relPath, importerLayer, lines, undefined, fakeRoot);
    expect(violations).toHaveLength(0);
  });

  it('reports a violation for an import that appears after */ on the same closing line (Item 1 fix)', () => {
    // The `*/` closes the block comment; the import on the same line is live code.
    const lines = [
      '/*',
      " * some comment",
      `*/ import { Foo } from '../cli/types.js';`,
    ];
    const violations = scanFile(absPath, relPath, importerLayer, lines, undefined, fakeRoot);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.rule).toContain('Rule 1');
  });

  it('does NOT report a violation for an import-looking string inside a line comment', () => {
    const lines = [
      "// import { Foo } from '../cli/types.js';",
      'const x = 1;',
    ];
    const violations = scanFile(absPath, relPath, importerLayer, lines, undefined, fakeRoot);
    expect(violations).toHaveLength(0);
  });

  it('reports a violation for an import after a single-line /* */ block comment on the same line', () => {
    // /* single-line block comment */ import ... — the import IS live code.
    const lines = [
      `/* intentionally ignored */ import { Foo } from '../cli/types.js';`,
    ];
    const violations = scanFile(absPath, relPath, importerLayer, lines, undefined, fakeRoot);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.rule).toContain('Rule 1');
  });

  it('does NOT report a violation for an import entirely inside a single-line /* */ comment', () => {
    // The import is inside the comment delimiters — not live code.
    const lines = [
      `/* import { Foo } from '../cli/types.js'; */`,
    ];
    const violations = scanFile(absPath, relPath, importerLayer, lines, undefined, fakeRoot);
    expect(violations).toHaveLength(0);
  });

  it('does NOT report a violation for an import inside a multi-line block comment spanning several lines', () => {
    const lines = [
      '/**',
      ' * Example:',
      " *   import { run } from '../cli/index.js';",
      ' */',
      'export {};',
    ];
    const violations = scanFile(absPath, relPath, importerLayer, lines, undefined, fakeRoot);
    expect(violations).toHaveLength(0);
  });

  it('reports a violation for a real import that follows non-comment code', () => {
    const lines = [
      "import { Foo } from '../cli/types.js';",
    ];
    const violations = scanFile(absPath, relPath, importerLayer, lines, undefined, fakeRoot);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.rule).toContain('Rule 1');
  });

  it('returns empty array for a file with no imports', () => {
    const lines = [
      'const x = 42;',
      'function hello() { return x; }',
    ];
    const violations = scanFile(absPath, relPath, importerLayer, lines, undefined, fakeRoot);
    expect(violations).toHaveLength(0);
  });

  it('reports a violation for an import after two consecutive inline block comments (double-inline fix)', () => {
    // /* a */ /* b */ import ... — both block comments must be stripped.
    const lines = [
      `/* first */ /* second */ import { Foo } from '../cli/types.js';`,
    ];
    const violations = scanFile(absPath, relPath, importerLayer, lines, undefined, fakeRoot);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.rule).toContain('Rule 1');
  });

  it('does NOT report when double inline block comments consume the entire line', () => {
    const lines = [
      '/* first */ /* second */',
    ];
    const violations = scanFile(absPath, relPath, importerLayer, lines, undefined, fakeRoot);
    expect(violations).toHaveLength(0);
  });
});

// ── scanFile — outAllowedHits accumulator ─────────────────────────────────────

describe('scanFile — outAllowedHits accumulator', () => {
  const fakeRoot = '/fake/src';
  const absPath = '/fake/src/agent/fake.ts';
  const relPath = 'src/agent/fake.ts';
  const importerLayer = 'core-infra' as const;

  it('appends an allowlisted cross-layer import to outAllowedHits and returns no violation', () => {
    const pairs: ReadonlyArray<AllowedPair> = [
      { file: relPath, importContains: 'cli/', reason: 'test allowlist' },
    ];
    const lines = ["import { Foo } from '../cli/types.js';"];
    const hits: Array<{ file: string; line: number; rule: string }> = [];

    const violations = scanFile(absPath, relPath, importerLayer, lines, hits, fakeRoot, pairs);

    // The import is allowlisted — no violation should be reported.
    expect(violations).toHaveLength(0);
    // The hit should be recorded in the accumulator.
    expect(hits).toHaveLength(1);
    expect(hits[0]?.file).toBe(relPath);
    expect(hits[0]?.line).toBe(1);
    expect(hits[0]?.rule).toContain('Rule 1');
  });

  it('does not append to outAllowedHits for a non-allowlisted import (violation instead)', () => {
    const lines = ["import { Foo } from '../cli/types.js';"];
    const hits: Array<{ file: string; line: number; rule: string }> = [];

    // Pass empty pairs so nothing is allowlisted.
    const violations = scanFile(absPath, relPath, importerLayer, lines, hits, fakeRoot, []);

    expect(violations).toHaveLength(1);
    expect(hits).toHaveLength(0);
  });

  it('accumulates multiple allowlisted imports across lines', () => {
    const pairs: ReadonlyArray<AllowedPair> = [
      { file: relPath, importContains: 'cli/', reason: 'test' },
    ];
    const lines = [
      "import { Foo } from '../cli/types.js';",
      'const x = 1;',
      "import { Bar } from '../cli/palette.js';",
    ];
    const hits: Array<{ file: string; line: number; rule: string }> = [];

    const violations = scanFile(absPath, relPath, importerLayer, lines, hits, fakeRoot, pairs);

    expect(violations).toHaveLength(0);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.line).toBe(1);
    expect(hits[1]?.line).toBe(3);
  });
});

// ── scanFile — coordinate-space paths ─────────────────────────────────────────

describe('scanFile — multiline import coordinate space', () => {
  // Portable fake root — same strategy as the block-comment suite above.
  const fakeRoot = '/fake/src';
  const absPath = '/fake/src/agent/fake.ts';
  const relPath = 'src/agent/fake.ts';
  const importerLayer = 'core-infra' as const;

  it('reports correct line number for a multiline import (consumed > 1)', () => {
    const lines = [
      'const x = 1;',
      'import {',
      '  Foo,',
      "} from '../cli/types.js';",
      'const y = 2;',
    ];
    const violations = scanFile(absPath, relPath, importerLayer, lines, undefined, fakeRoot);
    expect(violations).toHaveLength(1);
    // The violation should point to the opening line of the import (line 2, 1-indexed).
    expect(violations[0]?.line).toBe(2);
    expect(violations[0]?.rule).toContain('Rule 1');
  });

  it('advances past multiline imports without double-counting lines', () => {
    const lines = [
      'import {',
      '  Foo,',
      "} from '../cli/types.js';",
      "import { Bar } from '../cli/palette.js';",
    ];
    const violations = scanFile(absPath, relPath, importerLayer, lines, undefined, fakeRoot);
    // Both imports are violations — one multiline, one single-line.
    expect(violations).toHaveLength(2);
    expect(violations[0]?.line).toBe(1);
    expect(violations[1]?.line).toBe(4);
  });

  it('reports correct line number for a multiline import after */ on the closing line', () => {
    // Block comment closes on line 3; the import starts on the same line
    // and spans to line 5 (multiline).
    const lines = [
      '/*',
      ' * block comment',
      `*/ import {`,
      '  Foo,',
      "} from '../cli/types.js';",
    ];
    const violations = scanFile(absPath, relPath, importerLayer, lines, undefined, fakeRoot);
    expect(violations).toHaveLength(1);
    // Line 3 (1-indexed) is where the import starts.
    expect(violations[0]?.line).toBe(3);
    expect(violations[0]?.rule).toContain('Rule 1');
  });
});
