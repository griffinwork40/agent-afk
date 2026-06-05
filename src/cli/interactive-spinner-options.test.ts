/**
 * Regression guard for the turn-2 REPL hang.
 *
 * The streaming spinner now lives inside TerminalCompositor (no ora), but
 * single-shot spinners still survive in the REPL — interactive startup
 * (`afk i`) and `/compact`. Both run with the compositor disarmed, so the
 * concurrency hazard is gone, but ora's default `discardStdin: true` still
 * wraps process.stdin via stdin-discarder. If a future change re-introduces
 * a per-turn ora spinner, that wrap can break readline's 'line' event and
 * silently hang the next turn.
 *
 * Fix: every ora() call in REPL-context source files spreads
 * REPL_SPINNER_OPTIONS (which sets `discardStdin: false`) or pins the option
 * inline.
 *
 * This test asserts:
 *   1. The exported constant still has discardStdin: false.
 *   2. Every ora() call in the REPL source files includes either the shared
 *      constant or `discardStdin: false` directly — no bare `ora('text')`
 *      regressions.
 */

import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import { REPL_SPINNER_OPTIONS } from './commands/interactive/shared.js';

const REPL_SOURCE_FILES = [
  '../../src/cli/commands/interactive.ts',
  '../../src/cli/slash/commands/core.ts',
];

const REPL_SRC = REPL_SOURCE_FILES
  .map((rel) => readFileSync(new URL(rel, import.meta.url), 'utf-8'))
  .join('\n// ---- next REPL source file ----\n');

describe('REPL_SPINNER_OPTIONS — turn-2 hang regression guard', () => {
  it('exports discardStdin: false (load-bearing)', () => {
    expect(REPL_SPINNER_OPTIONS.discardStdin).toBe(false);
  });

  it('pins the spinner to process.stdout (not stderr)', () => {
    expect(REPL_SPINNER_OPTIONS.stream).toBe(process.stdout);
  });

  it('disables hideCursor to prevent ANSI leaks on abrupt exit', () => {
    expect(REPL_SPINNER_OPTIONS.hideCursor).toBe(false);
  });

  it('every ora() call in the REPL spreads REPL_SPINNER_OPTIONS or sets discardStdin: false inline', () => {
    // Match ora({ ... }).start() or ora({ ... }) calls — any object-option form.
    const oraCalls = REPL_SRC.match(/\bora\(\s*\{[^}]*\}\s*\)/gs) ?? [];
    expect(oraCalls.length).toBeGreaterThan(0);

    for (const call of oraCalls) {
      const spreadsSharedOptions = call.includes('...REPL_SPINNER_OPTIONS');
      const hasDirectOption = call.includes('discardStdin: false');
      expect(
        spreadsSharedOptions || hasDirectOption,
        `ora call is missing discardStdin: false — will hang turn 2.\n  ${call}`,
      ).toBe(true);
    }
  });

  it('has no bare ora("text") call-sites (string-only form bypasses the guard)', () => {
    // ora('...') with a plain string arg would skip our options entirely.
    const bareStringCalls = REPL_SRC.match(/\bora\(\s*['"`]/g) ?? [];
    expect(
      bareStringCalls,
      'Bare ora("text") found — rewrite as ora({ text, ...REPL_SPINNER_OPTIONS })',
    ).toEqual([]);
  });
});
