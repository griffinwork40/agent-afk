/**
 * Real-PTY scrollback integration suite for TerminalCompositor (issue #541).
 *
 * Runs OUTSIDE the default `pnpm test` run (excluded by the `*.pty.test.ts`
 * glob in vitest.config.ts) and only via `pnpm test:pty` (vitest.pty.config.ts)
 * or the dedicated CI job — because it depends on the native `node-pty` module
 * and a real pseudo-terminal, which can be flaky and needs serial execution.
 *
 * Each scenario in tests/pty/scenarios.ts drives the real compositor through a
 * gap-class geometry inside a real pty; here we reconstruct the emulator buffer
 * and assert against the SCROLLBACK / viewport — the ground truth that the
 * in-process @xterm/headless unit tests cannot certify (docs/scrollback.md).
 *
 * Gating: node-pty is a native dep in `pnpm.onlyBuiltDependencies`, so it is
 * present after `pnpm install`. In CI (or with AFK_PTY_REQUIRED=1) a missing
 * node-pty is a hard failure; locally it degrades to a skip so a dev who has
 * not built the native module is not blocked.
 */

import { describe, it, expect } from 'vitest';
import { SCENARIOS, type PtyExpect } from './scenarios.js';
import { runScenarioInPty, nodePtyAvailable, maxBlankRun, type PtyRunResult } from './harness.js';

const ci = process.env['CI'];
const mustRun = (ci != null && ci !== '' && ci !== 'false' && ci !== '0') || process.env['AFK_PTY_REQUIRED'] === '1';
const avail = nodePtyAvailable();

function countAll(lines: string[], needle: string): number {
  return lines.filter((l) => l.includes(needle)).length;
}
function firstIndex(lines: string[], needle: string): number {
  return lines.findIndex((l) => l.includes(needle));
}

function assertExpectations(res: PtyRunResult, exp: PtyExpect): void {
  const dump = res.dump();

  // The driver must have reached the sentinel (final frame fully rendered).
  expect(res.sawSentinel, `driver did not emit completion sentinel (exit=${res.exitCode}):\n${dump}`).toBe(true);

  for (const needle of exp.inScrollback ?? []) {
    const hit = res.scrollback.some((l) => l.includes(needle));
    expect(hit, `"${needle}" expected in SCROLLBACK (baseY=${res.baseY}):\n${dump}`).toBe(true);
  }
  for (const needle of exp.inViewport ?? []) {
    const hit = res.viewport.some((l) => l.includes(needle));
    expect(hit, `"${needle}" expected in VIEWPORT:\n${dump}`).toBe(true);
  }
  for (const needle of exp.exactlyOnce ?? []) {
    const n = countAll(res.lines, needle);
    expect(n, `"${needle}" must appear exactly once across the whole buffer (found ${n}):\n${dump}`).toBe(1);
  }
  for (const needle of exp.absent ?? []) {
    const n = countAll(res.lines, needle);
    expect(n, `"${needle}" must NOT appear anywhere (found ${n}):\n${dump}`).toBe(0);
  }
  for (const [a, b] of exp.order ?? []) {
    const ia = firstIndex(res.lines, a);
    const ib = firstIndex(res.lines, b);
    expect(ia, `order anchor "${a}" not found:\n${dump}`).toBeGreaterThanOrEqual(0);
    expect(ib, `order anchor "${b}" not found:\n${dump}`).toBeGreaterThanOrEqual(0);
    expect(ia, `"${a}" must appear above "${b}" (idx ${ia} vs ${ib}):\n${dump}`).toBeLessThan(ib);
  }
  if (exp.maxViewportBlankRun !== undefined) {
    // Measure blank runs strictly BETWEEN committed content rows (first content
    // → last content anchor), so live-frame chrome below never counts as a void.
    // Prefer a scenario-declared content-only anchor set so live-frame chrome
    // (e.g. a StatusLine model id present in exactlyOnce) can't pull lastAnchor
    // down into the frame and widen the void scan. Falls back to the general
    // anchor sets when a scenario declares none (safe iff they hold no chrome).
    const anchors = exp.contentAnchors ?? [...(exp.inViewport ?? []), ...(exp.exactlyOnce ?? [])];
    const firstContent = res.viewport.findIndex((l) => l.trim() !== '');
    let lastAnchor = -1;
    for (let i = res.viewport.length - 1; i >= 0; i--) {
      if (anchors.some((a) => (res.viewport[i] ?? '').includes(a))) { lastAnchor = i; break; }
    }
    if (firstContent >= 0 && lastAnchor > firstContent) {
      const run = maxBlankRun(res.viewport, firstContent, lastAnchor);
      expect(
        run,
        `blank void of ${run} rows between committed content and frame (limit ${exp.maxViewportBlankRun}):\n${dump}`,
      ).toBeLessThanOrEqual(exp.maxViewportBlankRun);
    }
  }
  if (exp.logicalSpan) {
    const { from, to, minNonWrappedRows, maxNonWrappedRows, minSpanRows } = exp.logicalSpan;
    const fromIdx = firstIndex(res.lines, from);
    expect(fromIdx, `logicalSpan.from "${from}" not found:\n${dump}`).toBeGreaterThanOrEqual(0);
    const toIdx = res.lines.findIndex((l, i) => i >= fromIdx && l.includes(to));
    expect(toIdx, `logicalSpan.to "${to}" not found at/after "${from}":\n${dump}`).toBeGreaterThanOrEqual(fromIdx);
    const spanRows = toIdx - fromIdx + 1;
    if (minSpanRows !== undefined) {
      expect(
        spanRows,
        `logical span ["${from}".."${to}"] should occupy >=${minSpanRows} rows (proves the resize took effect) but had ${spanRows}:\n${dump}`,
      ).toBeGreaterThanOrEqual(minSpanRows);
    }
    // Count rows in the [from..to] span that are NOT soft-wrap continuations.
    // One = the terminal reflowed a single logical line cleanly (tmux -J rejoins
    // it); ≥2 = interior app hard-newlines fragmented it (the axis-2 bug).
    let nonWrapped = 0;
    for (let i = fromIdx; i <= toIdx; i++) if (!(res.wrapped[i] ?? false)) nonWrapped += 1;
    if (minNonWrappedRows !== undefined) {
      expect(
        nonWrapped,
        `logical line ["${from}".."${to}"] should have >=${minNonWrappedRows} non-wrapped (hard-break) rows — the axis-2 fragmentation RED guard (#540); found ${nonWrapped}. If this dropped to 1 the flush now emits logical lines: flip minNonWrappedRows -> maxNonWrappedRows: 1.\n${dump}`,
      ).toBeGreaterThanOrEqual(minNonWrappedRows);
    }
    if (maxNonWrappedRows !== undefined) {
      expect(
        nonWrapped,
        `logical line ["${from}".."${to}"] should rejoin to <=${maxNonWrappedRows} non-wrapped row(s) but had ${nonWrapped}:\n${dump}`,
      ).toBeLessThanOrEqual(maxNonWrappedRows);
    }
  }
}

describe('TerminalCompositor scrollback over a real pty (issue #541)', () => {
  if (!avail.ok) {
    if (mustRun) {
      it('node-pty must be installed and functional in CI', () => {
        throw new Error(
          `node-pty is unavailable but required (CI or AFK_PTY_REQUIRED=1): ${(avail as { reason: string }).reason}. ` +
            'Ensure "node-pty" is in pnpm.onlyBuiltDependencies and the native build succeeded.',
        );
      });
    } else {
      it.skip(`node-pty unavailable locally — skipping pty suite (${(avail as { reason: string }).reason})`, () => {});
    }
    return;
  }

  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(`${name}: ${scenario.description}`, async () => {
      const res = await runScenarioInPty({ name, cols: scenario.cols, rows: scenario.rows });
      assertExpectations(res, scenario.expect);
    }, 45_000);
  }
});
