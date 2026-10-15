/**
 * Regression tests for A7: verdict-ledger renderRail() maxW must be derived
 * from contentBand(cols).width so that the budget for rail content correctly
 * accounts for the centering margin prepended by doRepaint().
 *
 * Bug: maxW = getTerminalWidth() - 2 allows content up to cols-2 wide.
 *   doRepaint() then prepends margin, making total = margin + (cols-2) > cols.
 *
 * Fix: maxW = contentBand(cols).width - 2 = (cols - marginCols) - 2,
 *   so margin + maxW = cols - 2 <= cols. Always safe.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { displayWidth } from '../../display.js';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '');
}

describe('A7: verdict-ledger maxW budget respects centering margin', () => {
  beforeEach(() => {
    vi.stubEnv('AFK_CENTER_CONTENT', '1');
    vi.stubEnv('AFK_TEXT_MEASURE', '100');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  it('budget: margin + maxW must be <= cols on a 200-col terminal', async () => {
    const cols = 200;
    Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
    const { contentBand } = await import('../../render/measure.js');
    const band = contentBand(cols);
    // margin = floor((200-100)/2) = 50; band.width = 150
    expect(band.marginCols).toBe(50);
    // Correct maxW budget: band.width - 2 = 148
    // Buggy maxW budget: cols - 2 = 198
    const correctMaxW = band.width - 2; // 148
    const buggyMaxW = cols - 2; // 198
    // With buggy budget: margin(50) + content(198) = 248 > 200 — overflow
    expect(band.marginCols + buggyMaxW).toBeGreaterThan(cols);
    // With correct budget: margin(50) + content(148) = 198 <= 200 — safe
    expect(band.marginCols + correctMaxW).toBeLessThanOrEqual(cols);
  });

  it('render() output + margin fits within terminal on 200-col centered terminal', async () => {
    const cols = 200;
    Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
    const { createVerdictLedger } = await import('./verdict-ledger.js');
    const { contentBand } = await import('../../render/measure.js');
    const band = contentBand(cols);

    const ledger = createVerdictLedger({ capacity: 8 });
    for (const kind of ['done', 'asking', 'done', 'blocked', 'done', 'asking', 'done', 'asking'] as const) {
      ledger.push({ kind, whatWasDone: 'test' });
    }
    const rail = ledger.render();
    expect(rail).not.toBeNull();
    const railWidth = displayWidth(stripAnsi(rail!));
    expect(band.marginCols + railWidth).toBeLessThanOrEqual(cols);
  });

  it('default path (no centering): maxW is cols-2 unchanged', async () => {
    vi.unstubAllEnvs();
    const cols = 200;
    Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
    const { contentBand } = await import('../../render/measure.js');
    const band = contentBand(cols);
    // centering off → margin=0, width=cols
    expect(band.marginCols).toBe(0);
    expect(band.width).toBe(cols);
    // Non-centered maxW = band.width - 2 = cols - 2 = 198 (same as before)
    expect(band.width - 2).toBe(cols - 2);
  });
});
