/**
 * Issue #2229 — content-hug + banner: first reply flows UNDER the visible
 * banner, not after scrolling it into scrollback.
 *
 * Desired invariant (content-hug placement ONLY):
 *   On the first commit of an arm cycle when a banner is visible (anchorRow > 1)
 *   and contentHug=true, the pre-commit banner-scroll block MUST NOT fire.
 *   Instead committed content is placed directly below the banner rows, exactly
 *   like cursor-follow's idle placement. The banner scrolls off only once
 *   content + frame fill the viewport.
 *
 * Three tests as required by issue #2229:
 *   (1) contiguity across several commits under the banner;
 *   (2) banner scrolls off exactly once when the viewport fills (no duplicate
 *       banner rows in scrollback, no lost rows);
 *   (3) autocomplete dropdown open/close with the banner still visible
 *       (contentHugFrameSettled guard).
 *
 * Harness: headless xterm for (1)+(2) (no fake timers needed); direct internal
 * state injection for (3) (follows content-hug.test.ts's guard test pattern).
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';
import { createAutocompleteState } from './input/autocomplete-state.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
};

const COLS = 80;
const BANNER_ROWS = 10;

function makeStdout(rows: number): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true;
  s.columns = COLS;
  s.rows = rows;
  return s;
}
function makeStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => {
    s.isRaw = raw;
    return s;
  });
  return s;
}

function makeScrollRegion(stdout: MockStdout) {
  return {
    withFullScrollRegion<T>(fn: () => T): T {
      stdout.write('\x1b[s\x1b[r\x1b[u');
      try {
        return fn();
      } finally {
        stdout.write(`\x1b[s\x1b[1;${stdout.rows}r\x1b[u`);
      }
    },
    getExtraRows(): number {
      return 0;
    },
  };
}

/** Headless-xterm rig with banner pre-written. */
interface BannerRig {
  c: TerminalCompositor;
  repaint(): void;
  /** Whole buffer (scrollback + viewport), right-trimmed. */
  lines(): Promise<string[]>;
  viewportTop(): number;
  dispose(): void;
}

async function makeBannerRig(rows: number, extraOpts: { autocompleteState?: ReturnType<typeof createAutocompleteState> } = {}): Promise<BannerRig> {
  const stdout = makeStdout(rows);
  const chunks: string[] = [];
  stdout.on('data', (d: unknown) => chunks.push(String(d)));

  // Pre-arm banner, exactly like the interactive surface.
  const banner = Array.from({ length: BANNER_ROWS }, (_, i) => `BANNER-${i}`);
  for (const line of banner) stdout.write(`${line}\r\n`);

  const c = new TerminalCompositor({
    stdout,
    stdin: makeStdin(),
    onCancel: vi.fn(),
    scrollRegion: makeScrollRegion(stdout),
    anchorRow: BANNER_ROWS + 1, // 11
    contentHug: true,
    ...(extraOpts.autocompleteState !== undefined
      ? { autocompleteState: extraOpts.autocompleteState }
      : {}),
  });
  await c.arm();

  const term = new HeadlessTerminal({
    cols: COLS,
    rows,
    scrollback: 2000,
    allowProposedApi: true,
    convertEol: true,
  });
  let fed = 0;
  const feed = async (): Promise<void> => {
    const data = chunks.slice(fed).join('');
    fed = chunks.length;
    await new Promise<void>((r) => term.write(data, r));
  };

  return {
    c,
    repaint: () => (c as unknown as { repaint(): void }).repaint(),
    async lines() {
      await feed();
      const b = term.buffer.active;
      const out: string[] = [];
      for (let i = 0; i < b.length; i++) {
        out.push(b.getLine(i)?.translateToString(true).replace(/\s+$/, '') ?? '');
      }
      return out;
    },
    viewportTop: () => term.buffer.active.baseY,
    dispose() {
      term.dispose();
      c.disarm();
    },
  };
}

const dumpOf = (lines: string[]): string =>
  lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l)}`).join('\n');

// Contract: (rows=N) means viewport lines 0..N-1. baseY points to scrollback
// offset of viewport row 0. lines()[baseY + k] === viewport row k+1.
//
// History: banner-scroll guard (committed-band-commit.ts ~L167) fires
// unconditionally on !hasCommitted && anchorRow > 1, even in content-hug
// mode — scrolling the banner into scrollback and resetting anchorRow to 1
// before the first commit. This leaves the banner out of the live viewport
// while there is still plenty of room for content under it.
//
// Fix: gate the banner-scroll on `!self.contentHug`. In content-hug mode
// the first commit should place content directly below the banner rows.

describe.each([24, 62])('hug-banner: content-hug with anchorRow > 1 (%i rows)', (ROWS) => {
  // Contract: In content-hug mode the banner MUST remain visible (in the
  // viewport) after the first commit as long as content + frame fit below it.
  // Specifically, the banner must be on the screen at baseY > 0 rows below
  // the scrollback boundary: i.e. banner-row BANNER-0 appears at a viewport
  // index < rows (not scrolled off).

  it('(1) banner stays visible on first commit: content placed directly below banner', async () => {
    const rig = await makeBannerRig(ROWS);
    rig.c.setSpinner({ enabled: true });
    rig.c.commitAbove('REPLY-0001\n');
    rig.repaint();
    const lines = await rig.lines();
    const dump = dumpOf(lines);
    const viewBase = rig.viewportTop();

    // The banner must be visible in the current viewport (not scrolled into
    // scrollback). BANNER-0 should appear at a viewport index.
    const bannerIdx = lines.findIndex((l) => l.includes('BANNER-0'));
    expect(bannerIdx, `BANNER-0 must be in viewport (above base ${viewBase}):\n${dump}`).toBeGreaterThanOrEqual(viewBase);

    // REPLY-0001 must appear BELOW the last banner row.
    const replyIdx = lines.findIndex((l) => l.includes('REPLY-0001'));
    const lastBannerIdx = lines.reduce((acc, l, i) => (l.includes(`BANNER-${BANNER_ROWS - 1}`) ? i : acc), -1);
    expect(replyIdx, `REPLY-0001 must be below banner:\n${dump}`).toBeGreaterThan(lastBannerIdx);

    // The reply must appear exactly once (no phantom copies from banner-scroll misroute).
    expect(
      lines.filter((l) => l.includes('REPLY-0001')).length,
      `REPLY-0001 must appear exactly once:\n${dump}`,
    ).toBe(1);

    rig.dispose();
  });

  it('(1) contiguity: several commits under banner — banner, content and frame are contiguous with no gaps, banner in viewport', async () => {
    const rig = await makeBannerRig(ROWS);
    rig.repaint();

    // Three commits in a row without triggering viewport-fill.
    rig.c.setSpinner({ enabled: true });
    rig.c.commitAbove('HUG-COMMIT-0001\n');
    rig.repaint();
    rig.c.setOverlay(['card-a', 'card-b'].join('\n'));
    rig.repaint();
    rig.c.commitAbove('HUG-COMMIT-0002\nHUG-COMMIT-0003\n');
    rig.c.setOverlay('');
    rig.c.setSpinner({ enabled: false });
    rig.repaint();

    const lines = await rig.lines();
    const dump = dumpOf(lines);
    const viewBase = rig.viewportTop();

    // KEY ASSERTION: banner must still be in the viewport (not scrolled off).
    const bannerIdx = lines.findIndex((l) => l.includes('BANNER-0'));
    expect(
      bannerIdx,
      `BANNER-0 must still be in viewport (viewBase=${viewBase}), not scrolled off:\n${dump}`,
    ).toBeGreaterThanOrEqual(viewBase);

    const committed = [
      ...Array.from({ length: BANNER_ROWS }, (_, i) => `BANNER-${i}`),
      'HUG-COMMIT-0001',
      'HUG-COMMIT-0002',
      'HUG-COMMIT-0003',
    ];

    // Each committed item must appear exactly once.
    for (const m of committed) {
      expect(
        lines.filter((l) => l.includes(m)).length,
        `"${m}" must appear exactly once:\n${dump}`,
      ).toBe(1);
    }

    // Contiguity: each committed row directly follows the previous (no blank rows between).
    const idx = committed.map((m) => lines.findIndex((l) => l.includes(m)));
    for (let i = 1; i < idx.length; i++) {
      expect(
        idx[i],
        `blank/foreign row between "${committed[i - 1]}" and "${committed[i]}":\n${dump}`,
      ).toBe(idx[i - 1]! + 1);
    }

    rig.dispose();
  });

  it('(2) banner scrolls off exactly ONCE when content + frame fill the viewport — no duplicate banner rows, no lost rows', async () => {
    const rig = await makeBannerRig(ROWS);
    rig.c.setSpinner({ enabled: true });

    // Fill enough committed content that content + banner + frame must exceed ROWS.
    // That forces the banner to scroll into scrollback exactly once.
    const committed: string[] = [];
    for (let n = 0; n < ROWS; n++) {
      const m = `FILL-${String(n).padStart(4, '0')}`;
      committed.push(m);
      rig.c.commitAbove(`${m}\n`);
      rig.repaint();
    }
    rig.c.setSpinner({ enabled: false });
    rig.repaint();

    const lines = await rig.lines();
    const dump = dumpOf(lines);

    // Every banner row must appear exactly once across the full buffer.
    for (let i = 0; i < BANNER_ROWS; i++) {
      expect(
        lines.filter((l) => l.trim() === `BANNER-${i}`).length,
        `BANNER-${i} must appear exactly once (no dup from double-scroll):\n${dump}`,
      ).toBe(1);
    }

    // Every committed content row must appear exactly once.
    for (const m of committed) {
      expect(
        lines.filter((l) => l.includes(m)).length,
        `"${m}" must appear exactly once:\n${dump}`,
      ).toBe(1);
    }

    rig.dispose();
  });

  it('(3) autocomplete dropdown open/close: banner visible while dropdown is open, no premature eviction', async () => {
    const acState = createAutocompleteState();
    const rig = await makeBannerRig(ROWS, { autocompleteState: acState });

    // Make a commit so we have some band content.
    rig.c.setSpinner({ enabled: true });
    rig.c.commitAbove('PRE-DROPDOWN-COMMIT\n');
    rig.repaint();

    // Open the autocomplete dropdown.
    acState.dropdownOpen = true;
    acState.candidates = [
      { value: '/chat', display: '/chat', icon: '' },
      { value: '/clear', display: '/clear', icon: '' },
    ];
    acState.selectedIndex = 0;

    // Several repaints while dropdown open — banner must still be visible.
    rig.repaint();
    rig.repaint();

    const linesOpen = await rig.lines();
    const dumpOpen = dumpOf(linesOpen);
    const viewBase = rig.viewportTop();

    // The banner must remain in viewport while dropdown is open.
    const bannerIdxOpen = linesOpen.findIndex((l) => l.includes('BANNER-0'));
    expect(
      bannerIdxOpen,
      `BANNER-0 must remain in viewport while dropdown is open:\n${dumpOpen}`,
    ).toBeGreaterThanOrEqual(viewBase);

    // Committed content must still be present exactly once.
    expect(
      linesOpen.filter((l) => l.includes('PRE-DROPDOWN-COMMIT')).length,
      `PRE-DROPDOWN-COMMIT must appear exactly once while dropdown is open:\n${dumpOpen}`,
    ).toBe(1);

    // Close dropdown.
    acState.dropdownOpen = false;
    acState.candidates = [];
    rig.repaint();

    const linesClosed = await rig.lines();
    const dumpClosed = dumpOf(linesClosed);

    // After dropdown closes, committed content must still be exactly once.
    expect(
      linesClosed.filter((l) => l.includes('PRE-DROPDOWN-COMMIT')).length,
      `PRE-DROPDOWN-COMMIT must appear exactly once after dropdown close:\n${dumpClosed}`,
    ).toBe(1);

    rig.dispose();
  });
});
