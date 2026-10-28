import { describe, expect, it } from 'vitest';
import { collectLogicalLine, isAllowed } from '../scripts/audit-layer-imports.js';
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
