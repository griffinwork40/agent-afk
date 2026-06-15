/**
 * Architectural boundary test: the keyboard / turn layer may control subagents
 * ONLY through the narrow `SubagentControl` interface (hasPromotableForeground /
 * promoteActiveForeground), which it receives off the handles bag. It must never
 * import or reference subagent internals (`SubagentHandleImpl`, `SubagentManager`,
 * `forkSubagent`, `runToResult`, …).
 *
 * Rationale (operator constraint): "do not let keyboard wiring leak into
 * subagent internals — build a small control bus or manager method and keep the
 * goblin plumbing civilized." The Ctrl+B → background-a-running-subagent feature
 * wires the keyboard to the executor through `SubagentControl` only; this test
 * keeps that boundary from rotting.
 *
 * Why imports (not bare substrings): a leak can only happen via an import — the
 * forbidden symbols are not reachable through the `SubagentControl` interface, so
 * referencing one requires importing it. Scanning imports avoids false positives
 * from explanatory prose in comments (e.g. a comment mentioning
 * "SubagentManager.forkSubagent" to explain the ambient sink).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

// The keyboard / turn layer. These files own Ctrl+B handling and turn
// orchestration; they may touch subagents only via `SubagentControl`.
const KEYBOARD_FILES = [
  path.join(here, 'turn-handler.ts'),
  path.join(here, '..', '..', 'input', 'input-surface.ts'),
  path.join(here, '..', '..', 'terminal-compositor.input-dispatch.ts'),
];

// Any module import whose path contains "subagent" — the keyboard layer must
// not depend on subagent modules directly. (`SubagentControl` is re-exposed
// through `TurnHandles` / `InteractiveCtx` in shared.ts, so the keyboard files
// never need to import it.)
const SUBAGENT_IMPORT = /from\s+['"][^'"]*subagent[^'"]*['"]/;

// The concrete handle class must never appear in the keyboard layer at all —
// it is the canonical "reached into internals" smell.
const FORBIDDEN_TOKEN = 'SubagentHandleImpl';

describe('subagent-control boundary (keyboard layer uses SubagentControl only)', () => {
  for (const file of KEYBOARD_FILES) {
    const name = path.basename(file);

    it(`${name} does not import any subagent module`, () => {
      const src = readFileSync(file, 'utf8');
      const offenders = src
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => SUBAGENT_IMPORT.test(line));
      expect(
        offenders,
        `${name} must not import subagent modules — control subagents via the ` +
          `SubagentControl seam on the handles bag instead. Offending import(s): ` +
          offenders.map((o) => `L${o.n}: ${o.line.trim()}`).join(' | '),
      ).toEqual([]);
    });

    it(`${name} does not reference SubagentHandleImpl`, () => {
      const src = readFileSync(file, 'utf8');
      expect(src.includes(FORBIDDEN_TOKEN), `${name} must not reference ${FORBIDDEN_TOKEN}`).toBe(
        false,
      );
    });
  }
});
