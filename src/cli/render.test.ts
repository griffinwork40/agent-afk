/**
 * Tests for src/cli/render.ts
 *
 * Validates that statusPanel, welcomeBanner, and helpTable produce output that
 * contains all expected content.  The tests strip ANSI colour codes before
 * asserting so they remain stable whether chalk is in colour mode or not.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import stringWidth from 'string-width';
import type { ChalkInstance } from 'chalk';
import {
  statusPanel,
  welcomeBanner,
  helpTable,
  divider,
  errorBox,
  card,
  usageLimitBox,
} from './render.js';
import { palette } from './palette.js';

/** Remove ANSI escape sequences so assertions work in any chalk level. */
function strip(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

/**
 * A stand-in `ChalkInstance` that renders `<tag>:<text>` uncolored. Used to
 * prove a "read `palette.<role>` at call time" invariant deterministically —
 * chalk's own `hex()` builders bake their ANSI-downsample approximation at
 * property-access time, so two different hex tones can coincidentally
 * render identical bytes once downsampled to a low color level, which would
 * make a raw before/after string-equality check against real theme colors
 * flaky. A sentinel marker function sidesteps that entirely. `.bold` is
 * attached too since `drawBox` (card.ts's bordered-card path) chains it off
 * the border color for the title chip.
 */
function sentinelChalk(tag: string): ChalkInstance {
  const fn = ((...text: unknown[]) => `${tag}:${text.join(' ')}`) as ChalkInstance;
  fn.bold = ((...text: unknown[]) => `${tag}-bold:${text.join(' ')}`) as unknown as ChalkInstance;
  return fn;
}

// ─── statusPanel ──────────────────────────────────────────────────────────────

describe('statusPanel', () => {
  it('includes the panel title', () => {
    const out = strip(statusPanel('My Status', []));
    expect(out).toContain('My Status');
  });

  it('renders box-drawing border characters', () => {
    const out = strip(statusPanel('Test', []));
    expect(out).toContain('╭');
    expect(out).toContain('╰');
    expect(out).toContain('│');
    expect(out).toContain('├');
  });

  it('includes row labels', () => {
    const out = strip(statusPanel('Status', [
      { label: 'SDK',   value: 'Connected' },
      { label: 'Model', value: 'sonnet'    },
    ]));
    expect(out).toContain('SDK');
    expect(out).toContain('Model');
  });

  it('includes row values', () => {
    const out = strip(statusPanel('Status', [
      { label: 'SDK',   value: 'Connected' },
      { label: 'Model', value: 'sonnet'    },
    ]));
    expect(out).toContain('Connected');
    expect(out).toContain('sonnet');
  });

  it('includes the coloured dot character when kind is set', () => {
    const out = strip(statusPanel('Status', [
      { label: 'SDK', value: 'Up', kind: 'ok' },
    ]));
    // After stripping ANSI the raw dot character must survive.
    expect(out).toContain('●');
  });

  it('renders correctly with an empty row list', () => {
    const out = strip(statusPanel('Empty Panel', []));
    expect(out).toContain('Empty Panel');
    expect(out).toContain('╭');
  });

  it('handles a long title without clipping', () => {
    const title = 'Agent AFK · Status Check (long title)';
    const out = strip(statusPanel(title, []));
    expect(out).toContain(title);
  });

  it('resolves the status dot glyph from `palette` at call time, not at module load (no theme-swap freeze)', () => {
    // Regression: the dot glyph used to live in a module-level const built
    // from `palette.<role>` at import time, so a theme swap (which mutates
    // `palette`'s members in place — see applyTheme()) left it frozen to
    // whatever theme was active at module load. Swapping `palette.success`
    // to two distinct sentinel renderers directly (the same mechanism
    // applyTheme uses) proves the glyph is re-read on every call rather
    // than captured once. See PR #643 review.
    const savedSuccess = palette.success;
    try {
      palette.success = sentinelChalk('SENTINEL-A');
      const a = statusPanel('Status', [{ label: 'SDK', value: 'Up', kind: 'ok' }]);
      expect(a).toContain('SENTINEL-A');

      palette.success = sentinelChalk('SENTINEL-B');
      const b = statusPanel('Status', [{ label: 'SDK', value: 'Up', kind: 'ok' }]);
      expect(b).toContain('SENTINEL-B');
      expect(b).not.toContain('SENTINEL-A');
    } finally {
      palette.success = savedSuccess;
    }
  });
});

// ─── welcomeBanner ────────────────────────────────────────────────────────────

describe('welcomeBanner', () => {
  const prevCols = process.stdout.columns;

  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', {
      value: prevCols,
      configurable: true,
    });
  });

  it('includes the mode name', () => {
    const out = strip(welcomeBanner({ mode: 'Interactive Mode' }));
    expect(out).toContain('Interactive Mode');
  });

  it('includes Agent AFK branding', () => {
    const out = strip(welcomeBanner({ mode: 'Interactive Mode' }));
    expect(out).toContain('Agent AFK');
  });

  it('renders box-drawing border characters', () => {
    const out = strip(welcomeBanner({ mode: 'Interactive Mode' }));
    expect(out).toContain('╭');
    expect(out).toContain('╰');
    expect(out).toContain('│');
  });

  it('includes metaLine when provided', () => {
    const out = strip(
      welcomeBanner({ mode: 'Test', metaLine: 'Model: sonnet · Max tokens: 4096' }),
    );
    expect(out).toContain('Model: sonnet');
    expect(out).toContain('Max tokens: 4096');
  });

  it('includes hintLine when provided', () => {
    const out = strip(
      welcomeBanner({ mode: 'Test', hintLine: '/help for commands' }),
    );
    expect(out).toContain('/help for commands');
  });

  it('omits metaLine when not provided', () => {
    const out = strip(welcomeBanner({ mode: 'Test' }));
    // The literal string 'metaLine' should never appear in the output.
    expect(out).not.toContain('metaLine');
  });

  it('omits hintLine when not provided', () => {
    const out = strip(welcomeBanner({ mode: 'Test' }));
    expect(out).not.toContain('hintLine');
  });

  it('renders the hybrid header with title-case branding and a normalized version chip', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    const out = strip(welcomeBanner({
      mode: 'Interactive Mode',
      model: 'opus_1m',
      version: '2.31.1',
      cwd: '/tmp/agent-afk',
      hintLine: '/help  ·  /model',
    }));
    expect(out).toContain('Agent AFK');
    expect(out).toContain('v2.31.1');
    expect(out).toContain('opus_1m');
    expect(out).toContain('Interactive Mode');
    expect(out).toContain('/help · /model');
  });

  it('renders the product tagline full-width in the hybrid banner', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    const out = strip(welcomeBanner({
      mode: 'Interactive Mode',
      model: 'sonnet',
      version: '5.10.1',
      cwd: '/tmp/agent-afk',
    }));
    // Tagline present (first-run identity). It renders as a full-width row below
    // the composition, so it spans the terminal rather than the narrow sprite-
    // side column.
    expect(out).toContain('run coding agents without babysitting them');
    // The weight-accented wordmark ("Agent " regular + "AFK" bold) must still
    // strip to the contiguous product name — the accent is a weight step, not
    // a fragmenting insertion.
    expect(out).toContain('Agent AFK');
  });

  it('keeps the full tagline un-truncated in the mid-width band beside the sprite', () => {
    // Regression guard for the 55–72-col "dead zone": the mascot still renders
    // here (drops only below 55 cols), but the 42-col tagline used to live in
    // the ~(cols−31) column beside the 27-col sprite — only ~33 cols at 64 — and
    // truncated to "Run coding agents without ba…". Hoisting it to a full-width
    // row fixed that; assert the whole thesis survives, un-ellipsized, WITH the
    // goblin present.
    Object.defineProperty(process.stdout, 'columns', { value: 64, configurable: true });
    const out = strip(welcomeBanner({
      mode: 'Interactive Mode',
      model: 'opus_1m',
      version: '5.52.0',
      worktree: 'afk/polish-goblin-banner',
      cwd: '/Users/example/projects/agent-afk',
    }));
    // Mascot is present at 64 cols (proves we're in the previously-broken band).
    expect(/[▀▄]/.test(out)).toBe(true);
    // The full tagline survives with no ellipsis eating the tail.
    expect(out).toContain('run coding agents without babysitting them');
    expect(out).not.toContain('without ba…');
  });

  describe('block-art AFK logo + footer links', () => {
    // The gradient-shaded "AFK" logo leaves a run of full blocks that the plain
    // text name caption never would. (Gradient color itself is not asserted —
    // these tests strip ANSI to stay chalk-level-independent, as elsewhere.)
    const hasBlockArt = (s: string): boolean => /█{3,}/.test(s);

    it('renders the block-art AFK logo on a wide terminal, keeping the readable name as a caption', () => {
      Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
      const out = strip(welcomeBanner({
        mode: 'Interactive Mode',
        model: 'opus_1m',
        version: '5.25.8',
        cwd: '/tmp/agent-afk',
      }));
      expect(hasBlockArt(out)).toBe(true);
      // Readable identity survives the block art (grep / screen-reader / tests).
      expect(out).toContain('Agent AFK');
      expect(out).toContain('v5.25.8');
      expect(out).toContain('run coding agents without babysitting them');
    });

    it('keeps the compact AFK logo (no text fallback) even when the mascot is dropped on a narrow terminal', () => {
      // The "AFK" acronym logo is only ~14 cols, so — unlike the retired full
      // "AGENT AFK" header — it survives narrow terminals that drop the goblin,
      // rather than degrading to a plain text wordmark.
      Object.defineProperty(process.stdout, 'columns', { value: 48, configurable: true });
      const out = strip(welcomeBanner({
        mode: 'Interactive Mode',
        model: 'opus_1m',
        version: '5.25.8',
        cwd: '/tmp/agent-afk',
      }));
      expect(hasBlockArt(out)).toBe(true);
      // No goblin at this width, but the readable name is still present.
      expect(/[▀▄]/.test(out)).toBe(false);
      expect(out).toContain('Agent AFK');
    });

    it('surfaces the docs + github links in the footer', () => {
      Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
      const out = strip(welcomeBanner({
        mode: 'Interactive Mode',
        model: 'opus_1m',
        version: '5.25.8',
        cwd: '/tmp/agent-afk',
      }));
      expect(out).toContain('docs.agentafk.com');
      expect(out).toContain('github.com/griffinwork40/agent-afk');
    });

    it('keeps the banner links in sync with package.json (drift guard)', () => {
      const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        homepage: string;
        repository: { url: string };
      };
      Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
      const out = strip(welcomeBanner({ mode: 'Interactive Mode', model: 'opus_1m', cwd: '/tmp' }));
      // Display forms: scheme stripped from homepage; `git+`/scheme/`.git`
      // stripped from repository.url.
      const docsDisplay = pkg.homepage.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const repoDisplay = pkg.repository.url
        .replace(/^git\+/, '')
        .replace(/^https?:\/\//, '')
        .replace(/\.git$/, '');
      expect(out).toContain(docsDisplay);
      expect(out).toContain(repoDisplay);
    });
  });

  describe('responsive mascot layout', () => {
    // The sprite is rendered with half-block glyphs; their presence is a
    // reliable proxy for "the goblin is drawn".
    const hasSprite = (s: string): boolean => /[▀▄]/.test(s);

    it('keeps the mascot sprite on a standard-width terminal', () => {
      Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
      const out = strip(welcomeBanner({
        mode: 'Interactive Mode',
        model: 'opus_1m',
        version: '5.11.0',
        worktree: 'afk/polish-goblin-banner',
        cwd: '/Users/example/projects/agent-afk',
      }));
      expect(hasSprite(out)).toBe(true);
      expect(out).toContain('Agent AFK');
    });

    it('drops the mascot and stacks info flush-left on a very narrow terminal', () => {
      // Below the sprite budget (cols − 2 − 27 − 2 < 24, i.e. cols < 55) the
      // 27-col goblin would crush every info row into a one-char sliver. The
      // compact fallback drops the sprite and stacks the info full-width so the
      // identity signals stay legible instead of ellipsizing to nothing.
      Object.defineProperty(process.stdout, 'columns', { value: 44, configurable: true });
      const out = strip(welcomeBanner({
        mode: 'Interactive Mode',
        model: 'opus_1m',
        version: '5.11.0',
        worktree: 'afk/polish-goblin-banner',
        cwd: '/Users/example/projects/agent-afk',
        hintLine: '/help · /model · /exit to quit',
      }));
      // No sprite glyphs — the goblin is suppressed at this width.
      expect(hasSprite(out)).toBe(false);
      // …but every identity signal still survives, full-width.
      expect(out).toContain('Agent AFK');
      expect(out).toContain('run coding agents without babysitting them');
      expect(out).toContain('opus_1m');
      expect(out).toContain('afk/polish-goblin-banner');
    });

    it('keeps every compact-banner row within the terminal width', () => {
      Object.defineProperty(process.stdout, 'columns', { value: 44, configurable: true });
      const out = strip(welcomeBanner({
        mode: 'Interactive Mode',
        model: 'claude-opus-4-very-long-model-name',
        version: '5.11.0',
        worktree: 'a-very-long-worktree-branch-name-that-overflows',
        cwd: '/Users/example/projects/agent-afk/very/deep/path',
        hintLine: '/help · /model · /resume · Esc to interrupt · /exit to quit',
      }));
      const maxLine = Math.max(...out.split('\n').map((l) => stringWidth(l)));
      expect(maxLine).toBeLessThanOrEqual(44);
    });
  });

  describe('right-column vertical centering', () => {
    // The block-art hero is the ONLY source of full-block (█) glyphs — the
    // sprite is drawn with half-blocks (▀▄) only — so the first output line
    // carrying a █ marks where the right column begins, i.e. its top pad.
    const heroTopRow = (s: string): number =>
      s.split('\n').findIndex((l) => /█/.test(l));

    it('centers the right column onto the sprite, round-biased DOWN (not floor)', () => {
      // A full column — model·mode + worktree + cwd + metaLine — is 12 rows
      // against the 13-row sprite. (13−12)/2 = 0.5, so Math.round lands the top
      // pad at 1, where Math.floor would strand the column at the cap tip (row
      // 0). Pinning the exact top row is the direct guard for the round-not-floor
      // bias the layout comment promises (welcome-banner.ts renderHybridBanner).
      Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
      const out = strip(welcomeBanner({
        mode: 'Interactive Mode',
        model: 'opus_1m',
        version: '5.11.0',
        worktree: 'afk/polish-goblin-banner',
        cwd: '/Users/example/projects/agent-afk',
        metaLine: 'Resuming abc123',
      }));
      expect(/[▀▄]/.test(out)).toBe(true); // sprite present → mascot layout
      expect(heroTopRow(out)).toBe(1); // padded DOWN by one row (round, not floor)
    });

    it('pushes the hero lower when the info column is shorter', () => {
      // Centering responds to column height: a minimal column (model·mode only)
      // is shorter than a full one, so it earns a larger top pad and its hero
      // sits strictly lower. This exercises the round-biased centering across
      // two different column heights without over-pinning either exact value.
      Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
      const fuller = strip(welcomeBanner({
        mode: 'Interactive Mode',
        model: 'opus_1m',
        version: '5.11.0',
        worktree: 'afk/polish-goblin-banner',
        cwd: '/Users/example/projects/agent-afk',
        metaLine: 'Resuming abc123',
      }));
      const minimal = strip(welcomeBanner({ mode: 'Interactive Mode', model: 'opus_1m' }));
      expect(heroTopRow(minimal)).toBeGreaterThan(heroTopRow(fuller));
    });
  });

  describe('AFK_BANNER_PLAIN=1 fallback', () => {
    const prevPlain = process.env['AFK_BANNER_PLAIN'];

    afterEach(() => {
      if (prevPlain === undefined) {
        delete process.env['AFK_BANNER_PLAIN'];
      } else {
        process.env['AFK_BANNER_PLAIN'] = prevPlain;
      }
    });

    it('preserves model/version/cwd/worktree in the plain banner when extended fields are passed', () => {
      process.env['AFK_BANNER_PLAIN'] = '1';
      const out = strip(welcomeBanner({
        mode: 'Interactive Mode',
        model: 'sonnet',
        version: '2.31.1',
        worktree: 'afk-20260520-093601-1d3a75',
        cwd: '/tmp/agent-afk',
        hintLine: '/help  ·  /model',
      }));
      // Plain banner uses the legacy box, so the wordmark + box chars should
      // still be present (proves we took the legacy path).
      expect(out).toContain('Agent AFK');
      expect(out).toContain('╭');
      // And the extended identity signals must survive the projection.
      expect(out).toContain('sonnet');
      expect(out).toContain('v2.31.1');
      expect(out).toContain('Interactive Mode');
      expect(out).toContain('afk-20260520-093601-1d3a75');
      expect(out).toContain('/tmp/agent-afk');
      expect(out).toContain('/help');
    });

    it('preserves caller-supplied metaLine over synthesised cwd/worktree', () => {
      process.env['AFK_BANNER_PLAIN'] = '1';
      const out = strip(welcomeBanner({
        mode: 'Interactive Mode',
        model: 'sonnet',
        cwd: '/tmp/agent-afk',
        metaLine: 'Custom meta',
      }));
      expect(out).toContain('Custom meta');
      // synthesised cwd should not appear because caller supplied metaLine.
      expect(out).not.toContain('/tmp/agent-afk');
    });
  });

  describe('tildifyHome path-boundary handling', () => {
    const prevHome = process.env['HOME'];

    afterEach(() => {
      if (prevHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = prevHome;
      }
    });

    it('does not rewrite a sibling dir that merely shares the $HOME prefix', () => {
      Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
      process.env['HOME'] = '/Users/jane';
      const out = strip(welcomeBanner({
        mode: 'Interactive Mode',
        model: 'sonnet',
        cwd: '/Users/janeway/project',
      }));
      // The mangled rewrite the old code produced.
      expect(out).not.toContain('~way/project');
      // The literal sibling path should appear verbatim.
      expect(out).toContain('/Users/janeway/project');
    });

    it('tildifies exact $HOME match', () => {
      Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
      process.env['HOME'] = '/Users/jane';
      const out = strip(welcomeBanner({
        mode: 'Interactive Mode',
        model: 'sonnet',
        cwd: '/Users/jane',
      }));
      // The cwd row should render as a bare `~` (not, e.g., `~/`).
      expect(out).toMatch(/(^|\s)~(\s|$)/m);
    });

    it('tildifies real subpaths of $HOME', () => {
      Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
      process.env['HOME'] = '/Users/jane';
      const out = strip(welcomeBanner({
        mode: 'Interactive Mode',
        model: 'sonnet',
        cwd: '/Users/jane/Projects/foo',
      }));
      expect(out).toContain('~/Projects/foo');
    });
  });
});

// ─── helpTable ────────────────────────────────────────────────────────────────

describe('helpTable', () => {
  it('includes the section title', () => {
    const out = strip(helpTable([{ title: 'Commands', entries: [] }]));
    expect(out).toContain('Commands');
  });

  it('includes command text and description', () => {
    const out = strip(helpTable([
      {
        title: 'Commands',
        entries: [
          { cmd: '/exit', desc: 'Exit the session' },
          { cmd: '/help', desc: 'Show help' },
        ],
      },
    ]));
    expect(out).toContain('/exit');
    expect(out).toContain('Exit the session');
    expect(out).toContain('/help');
    expect(out).toContain('Show help');
  });

  it('renders all sections when multiple are given', () => {
    const out = strip(helpTable([
      { title: 'Section A', entries: [{ cmd: '/a', desc: 'A command' }] },
      { title: 'Section B', entries: [{ cmd: '/b', desc: 'B command' }] },
    ]));
    expect(out).toContain('Section A');
    expect(out).toContain('/a');
    expect(out).toContain('Section B');
    expect(out).toContain('/b');
  });

  it('aligns commands to a consistent column width', () => {
    const out = strip(helpTable([
      {
        title: 'Commands',
        entries: [
          { cmd: '/x',             desc: 'Short cmd' },
          { cmd: '/longer-cmd',    desc: 'Longer cmd' },
        ],
      },
    ]));
    const lines = out.split('\n').filter((l) => l.includes('Short cmd') || l.includes('Longer cmd'));
    // The description text should start at the same column in both lines.
    const col0 = lines[0]?.indexOf('Short cmd') ?? -1;
    const col1 = lines[1]?.indexOf('Longer cmd') ?? -1;
    expect(col0).toBeGreaterThan(0);
    expect(col0).toBe(col1);
  });

  it('handles an empty entries list without throwing', () => {
    expect(() => helpTable([{ title: 'Empty', entries: [] }])).not.toThrow();
  });
});

// ─── width-aware rendering (terminal columns) ────────────────────────────────

describe('width-aware boxes and divider', () => {
  const prevCols = process.stdout.columns;

  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', {
      value: prevCols,
      configurable: true,
    });
  });

  it('statusPanel fits within a 40-column terminal', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
    const out = strip(
      statusPanel('Status', [{ label: 'A', value: 'B', kind: 'ok' }]),
    );
    const maxLine = Math.max(...out.split('\n').map((l) => stringWidth(strip(l))));
    expect(maxLine).toBeLessThanOrEqual(40);
  });

  it('statusPanel inner width caps at 100 on very wide terminals', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
    const out = strip(statusPanel('S', [{ label: 'L', value: 'V', kind: 'ok' }]));
    const top = out.split('\n')[0] ?? '';
    expect(top.length).toBeLessThanOrEqual(106);
  });

  it('welcomeBanner caps at 120 on very wide terminals', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
    const out = strip(welcomeBanner({ mode: 'M' }));
    const top = out.split('\n')[0] ?? '';
    expect(top.length).toBeLessThanOrEqual(126);
  });

  it('hybrid welcomeBanner rows stay within terminal width', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 48, configurable: true });
    const out = strip(welcomeBanner({
      mode: 'Interactive Mode',
      model: 'claude-opus-4-very-long-model-name',
      version: '2.31.1',
      cwd: '/Users/example/projects/agent-afk',
      hintLine: '/help · /model · /resume · Esc to interrupt · /exit to quit',
    }));
    const maxLine = Math.max(...out.split('\n').map((l) => stringWidth(l)));
    expect(maxLine).toBeLessThanOrEqual(48);
  });

  it('errorBox caps inner width at 100 on very wide terminals', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
    const out = strip(errorBox('E', 'detail'));
    const top = out.split('\n')[0] ?? '';
    expect(top.length).toBeLessThanOrEqual(106);
  });

  it('divider uses at most 120 columns on wide terminals', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
    expect(strip(divider()).length).toBe(120);
  });

  it('divider respects narrow terminals', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 60, configurable: true });
    expect(strip(divider()).length).toBe(60);
  });

  it('errorBox wraps a very long title across multiple box rows', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 50, configurable: true });
    const longTitle = 'word '.repeat(20).trim();
    const out = strip(errorBox(longTitle));
    const rowCount = out.split('\n').filter((l) => l.includes('│')).length;
    expect(rowCount).toBeGreaterThan(1);
  });

  it('statusPanel stays within width for wide glyph content', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
    const out = strip(
      statusPanel('状态', [{ label: '名称', value: '東京🙂', kind: 'info' }]),
    );
    const maxLine = Math.max(...out.split('\n').map((l) => stringWidth(l)));
    expect(maxLine).toBeLessThanOrEqual(40);
  });
});

// ─── card ────────────────────────────────────────────────────────────────────

describe('card', () => {
  it('renders the plan kind with a PLAN title chip and bordered box', () => {
    const out = strip(card({ kind: 'plan', body: 'step 1' }));
    expect(out).toContain('PLAN');
    expect(out).toContain('step 1');
    expect(out).toContain('╭');
    expect(out).toContain('╰');
    expect(out).toContain('│');
  });

  it('resolves the bordered-card border color from `palette` at call time, not at module load (no theme-swap freeze)', () => {
    // Regression: the border-color lookup used to live in a module-level
    // const built from `palette.<role>` at import time, so a theme swap
    // (which mutates `palette`'s members in place — see applyTheme()) left
    // it frozen to whatever theme was active at module load. Swapping
    // `palette.plan` to two distinct sentinel renderers directly (the same
    // mechanism applyTheme uses) proves the border color is re-read on
    // every call rather than captured once. See PR #643 review.
    const savedPlan = palette.plan;
    try {
      palette.plan = sentinelChalk('SENTINEL-A');
      const a = card({ kind: 'plan', body: 'step 1' });
      expect(a).toContain('SENTINEL-A');

      palette.plan = sentinelChalk('SENTINEL-B');
      const b = card({ kind: 'plan', body: 'step 1' });
      expect(b).toContain('SENTINEL-B');
      expect(b).not.toContain('SENTINEL-A');
    } finally {
      palette.plan = savedPlan;
    }
  });

  it('renders status kind with default STATUS title', () => {
    const out = strip(card({ kind: 'status', body: 'ok' }));
    expect(out).toContain('STATUS');
    expect(out).toContain('ok');
  });

  it('renders checkpoint kind with ✅ CHECKPOINT chip', () => {
    const out = strip(card({ kind: 'checkpoint', body: 'done' }));
    expect(out).toContain('CHECKPOINT');
    expect(out).toContain('✅');
    expect(out).toContain('done');
  });

  it('renders diagnosis kind with default DIAGNOSIS title', () => {
    const out = strip(card({ kind: 'diagnosis', body: 'flaky test' }));
    expect(out).toContain('DIAGNOSIS');
    expect(out).toContain('flaky test');
  });

  it('user kind has only a right-edge bar — no top/bottom border or title', () => {
    const out = strip(card({ kind: 'user', body: 'hello world' }));
    expect(out).toContain('│');
    expect(out).not.toContain('╭');
    expect(out).not.toContain('╰');
    expect(out).toContain('hello world');
    // First row is separator (─); content rows end with ' │'.
    const rows = out.split('\n');
    expect(rows[0]).toContain('─');
    for (const line of rows.slice(1)) {
      expect(line.endsWith(' │')).toBe(true);
    }
  });

  it('respects a caller-provided title', () => {
    const out = strip(card({ kind: 'checkpoint', title: 'CHECKPOINT — build', body: 'ok' }));
    expect(out).toContain('CHECKPOINT — build');
    expect(out).not.toContain('✅'); // default chip suppressed when title is set
  });

  it('accepts body as an array of lines', () => {
    const out = strip(card({ kind: 'plan', body: ['line one', 'line two'] }));
    expect(out).toContain('line one');
    expect(out).toContain('line two');
  });

  it('accepts body string with embedded newlines', () => {
    const out = strip(card({ kind: 'status', body: 'first\nsecond' }));
    expect(out).toContain('first');
    expect(out).toContain('second');
  });

  it('wraps long body content across multiple rows on narrow terminals', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 50, configurable: true });
    const long = 'word '.repeat(20).trim();
    const out = strip(card({ kind: 'status', body: long }));
    const rowCount = out.split('\n').filter((l) => l.includes('│')).length;
    expect(rowCount).toBeGreaterThan(1);
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  it('caps inner width at 100 on very wide terminals', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
    const out = strip(card({ kind: 'plan', body: 'x' }));
    const top = out.split('\n')[0] ?? '';
    expect(top.length).toBeLessThanOrEqual(106);
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  it('user kind wraps long lines and terminates every row at the bar', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 30, configurable: true });
    const out = strip(card({ kind: 'user', body: 'word '.repeat(15).trim() }));
    const rows = out.split('\n');
    expect(rows.length).toBeGreaterThan(1);
    // First row is separator (─); content rows end with ' │'.
    for (const row of rows.slice(1)) {
      expect(row.endsWith(' │')).toBe(true);
    }
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  it('renders bold markdown in bordered card body', () => {
    const out = strip(card({ kind: 'checkpoint', body: '**PR #163 opened**: done' }));
    expect(out).not.toContain('**');
    expect(out).toContain('PR #163 opened');
    expect(out).toContain('done');
  });

  it('renders inline markdown in user card body', () => {
    const out = strip(card({ kind: 'user', body: 'run `pnpm test`' }));
    expect(out).not.toContain('`pnpm test`');
    expect(out).toContain('pnpm test');
  });

  it('projects heading markdown in card body and preserves box geometry', () => {
    const raw = card({ kind: 'plan', body: '## heading in body' });
    const out = strip(raw);
    // heading is now projected: ## sigil stripped, text retained
    expect(out).not.toContain('##');
    expect(out).toContain('heading in body');
    const topBorder = out.split('\n').find((l) => l.includes('╭'));
    const botBorder = out.split('\n').find((l) => l.includes('╰'));
    expect(topBorder).toBeDefined();
    expect(botBorder).toBeDefined();
  });

  // ── right-alignment tests (user-echo card layout) ──────────────────────────

  it('user kind: every content line ends with " │" at the right edge', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
    const out = strip(card({ kind: 'user', body: 'hello' }));
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    // First line is separator (─); remaining content lines match the bar pattern.
    expect(lines[0]).toContain('─');
    for (const line of lines.slice(1)) {
      // Right-aligned: leading spaces, then content, then ' │' at the far right.
      expect(line).toMatch(/^ +hello \u2502$/);
    }
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  it('user kind: leftPad is accepted but ignored (right-aligned regardless)', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
    const withPad = strip(card({ kind: 'user', body: 'hello', leftPad: 10 }));
    const withoutPad = strip(card({ kind: 'user', body: 'hello' }));
    expect(withPad).toBe(withoutPad);
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  it('user kind wrapped lines all end flush right at the bar', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
    // Body long enough to wrap. innerW = max(20, min(36, floor(40*0.75), 100)) = 30.
    const body = 'word '.repeat(10).trim(); // 49 visible chars → wraps
    const out = strip(card({ kind: 'user', body }));
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    // First line is separator (─); content lines end with ' │' and fit within 40 cols.
    const [sepLine, ...contentLines] = lines;
    expect(sepLine).toContain('─');
    expect((sepLine ?? '').length).toBeLessThanOrEqual(40);
    for (const line of contentLines) {
      expect(line.endsWith(' \u2502')).toBe(true);
      // Total width must not exceed the terminal width (40).
      expect(line.length).toBeLessThanOrEqual(40);
    }
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  // ── chat-bubble block tests (straight left edge, capped width) ─────────────

  it('user kind: wrapped rows share a straight left edge (block, not per-row right-align)', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    // Rows wrap at differing natural widths; per-row right-alignment would
    // produce ragged indents. The bubble pads every row to the widest one.
    const body = 'word '.repeat(30).trim();
    const out = strip(card({ kind: 'user', body }));
    const [, ...contentLines] = out.split('\n');
    expect(contentLines.length).toBeGreaterThan(1);
    const indents = contentLines.map((l) => l.length - l.trimStart().length);
    expect(new Set(indents).size).toBe(1);
    // A left gutter remains — the bubble must not span the full row.
    expect(indents[0]).toBeGreaterThan(0);
  });

  it('user kind: bubble width is capped at 75% of the terminal', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    const body = 'word '.repeat(40).trim();
    const out = strip(card({ kind: 'user', body }));
    const [, ...contentLines] = out.split('\n');
    // innerW = floor(80 * 0.75) = 60 → content + ' │' ≤ 62; rows are pinned
    // at rightEdge = 79, so the left gutter is at least 79 - 62 = 17 cols.
    for (const line of contentLines) {
      expect(line.length - line.trimStart().length).toBeGreaterThanOrEqual(17);
    }
  });

  it('user kind: separator spans the bubble and shares its left edge', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    const body = 'word '.repeat(30).trim();
    const out = strip(card({ kind: 'user', body }));
    const [sep, ...contentLines] = out.split('\n');
    const sepIndent = sep!.length - sep!.trimStart().length;
    const rowIndent = contentLines[0]!.length - contentLines[0]!.trimStart().length;
    // Top rule starts exactly above the bubble's left edge and reaches the
    // bar column — it reads as the bubble's top border.
    expect(sepIndent).toBe(rowIndent);
    expect(sep!.trimEnd().endsWith('─')).toBe(true);
    expect(sep!.trimEnd().length).toBe(contentLines[0]!.length);
  });
});

// ─── usageLimitBox ────────────────────────────────────────────────────────────

describe('usageLimitBox', () => {
  it('shows "Usage paused" chip in the header', () => {
    const out = strip(usageLimitBox({ reason: 'usage-limit' }));
    expect(out).toContain('Usage paused');
  });

  it('default (autoResume omitted) shows the auto-resume copy — no "send the message again"', () => {
    const out = strip(usageLimitBox({ reason: 'usage-limit' }));
    expect(out).toContain("I'll auto-resume when the limit resets");
    expect(out).toContain('no need to retype');
    expect(out).not.toContain('send the message again');
  });

  it('autoResume: true shows the auto-resume copy', () => {
    const out = strip(usageLimitBox({ reason: 'usage-limit', autoResume: true }));
    expect(out).toContain("I'll auto-resume when the limit resets");
    expect(out).toContain('no need to retype');
    expect(out).not.toContain('send the message again');
  });

  it('autoResume: false falls back to the legacy "send the message again" copy', () => {
    const out = strip(usageLimitBox({ reason: 'usage-limit', autoResume: false }));
    expect(out).toContain('Wait, then send the message again');
    expect(out).not.toContain("I'll auto-resume when the limit resets");
  });

  it('advertises mode-appropriate escape hatches (live auto-resume card vs manual)', () => {
    const autoOn = strip(usageLimitBox({ reason: 'usage-limit', autoResume: true }));
    const autoOff = strip(usageLimitBox({ reason: 'usage-limit', autoResume: false }));
    // `claude login` is picked up live by the keychain hot-swap in BOTH modes.
    expect(autoOn).toContain('claude login');
    expect(autoOff).toContain('claude login');
    // Live (auto-resume) card: actionable in-pause escapes; the misleading
    // env-var bullet is dropped because the running turn never re-reads env.
    expect(autoOn).toContain('/model');
    expect(autoOn).toContain('Press Esc to stop waiting');
    expect(autoOn).not.toContain('ANTHROPIC_API_KEY');
    // Manual (autoResume:false) card keeps the API-key billing hint — there the
    // user genuinely starts a fresh send after the reset, so a new env var applies.
    expect(autoOff).toContain('ANTHROPIC_API_KEY');
  });

  it('includes the reset time when resetsAt is provided', () => {
    const resetsAt = new Date(Date.now() + 30 * 60_000);
    const out = strip(usageLimitBox({ reason: 'usage-limit', resetsAt }));
    expect(out).toContain('Resets at');
  });

  it('credit-exhausted reason does not branch on autoResume (no Claude subscription copy)', () => {
    const out = strip(usageLimitBox({ reason: 'credit-exhausted', autoResume: true }));
    expect(out).toContain('credit balance is empty');
    expect(out).not.toContain("I'll auto-resume");
    expect(out).not.toContain('send the message again');
  });

  it('shows the hot-swap account line when hotSwapped + accountId are set', () => {
    const out = strip(usageLimitBox({
      reason: 'usage-limit',
      hotSwapped: true,
      accountId: 'token:abc123',
    }));
    expect(out).toContain('Resumed on token:abc123');
  });
});
