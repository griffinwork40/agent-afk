/**
 * Regression tests for the import-time palette-capture freeze.
 *
 * `palette` (palette.ts) is a LIVE view: `applyTheme()` rewrites its members
 * in place so every consumer picks up new tones on the next paint. That only
 * holds if consumers read `palette.<role>` at CALL time. A module-scope
 * capture — `const STYLES = { color: palette.success }` — is hoisted by ESM
 * above the first `applyTheme()` call and therefore freezes on the dark tones
 * for the life of the process, silently, with no type or lint error.
 *
 * That bug shipped three times (verdict card, verdict-ledger rail, /mint input
 * chip) and pinned exactly the four roles whose dark->umber delta is largest
 * (success/error/warning/meta are bare ANSI on dark but truecolor hex on
 * umber), so the umber theme looked far closer to dark than it actually is.
 *
 * Invariant: these tests must run with FORCE_COLOR=3 applied BEFORE chalk is
 * evaluated. `chalk.hex()` resolves the target color space at BUILDER-CREATION
 * time, not at call time — a builder created while `chalk.level === 1` emits
 * the 16-color approximation forever, even if `chalk.level` is later raised to
 * 3. Under vitest (non-TTY) chalk auto-detects level 0, which would collapse
 * distinct hexes onto the same escape and make these assertions vacuous. Hence
 * the resetModules + dynamic-import dance instead of static imports.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

type Mods = {
  chalk: typeof import('chalk').default;
  palette: typeof import('./palette.js').palette;
  applyTheme: typeof import('./theme.js').applyTheme;
  renderVerdictCard: typeof import('./commands/interactive/verdict-card.js').renderVerdictCard;
  createVerdictLedger: typeof import('./commands/interactive/verdict-ledger.js').createVerdictLedger;
  colorizeInputBuffer: typeof import('./input-highlight.js').colorizeInputBuffer;
};

let m: Mods;
let savedForceColor: string | undefined;

beforeAll(async () => {
  savedForceColor = process.env['FORCE_COLOR'];
  process.env['FORCE_COLOR'] = '3';
  vi.resetModules();
  m = {
    chalk: (await import('chalk')).default,
    palette: (await import('./palette.js')).palette,
    applyTheme: (await import('./theme.js')).applyTheme,
    renderVerdictCard: (await import('./commands/interactive/verdict-card.js')).renderVerdictCard,
    createVerdictLedger: (await import('./commands/interactive/verdict-ledger.js')).createVerdictLedger,
    colorizeInputBuffer: (await import('./input-highlight.js')).colorizeInputBuffer,
  };
});

afterAll(() => {
  if (savedForceColor === undefined) delete process.env['FORCE_COLOR'];
  else process.env['FORCE_COLOR'] = savedForceColor;
  vi.resetModules();
});

/** The first SGR sequence in a string, or '' when it carries none. */
function firstSgr(s: string): string {
  return /\u001b\[[0-9;]*m/.exec(s)?.[0] ?? '';
}

/**
 * Assert `render()` paints in the LIVE tone of `role` under every theme —
 * i.e. the renderer resolves the palette at call time rather than freezing a
 * captured chalk instance. Level-agnostic: it compares the renderer's escape
 * to the palette's own escape at that same moment.
 */
function expectsLiveTone(role: keyof typeof m.palette, render: () => string): void {
  const THEMES = ['dark', 'umber', 'light'] as const;
  const escapeOf = new Map<string, string>();
  for (const theme of THEMES) {
    m.applyTheme(theme);
    escapeOf.set(theme, firstSgr(m.palette[role]('x')));
  }
  // Guard against a vacuous pass: the themes must actually differ at this
  // color level, or the containment checks below prove nothing.
  expect(new Set(escapeOf.values()).size, `${role} is identical in all themes`).toBe(THEMES.length);

  for (const theme of THEMES) {
    m.applyTheme(theme);
    const out = render();
    expect(out, `${role} did not adopt the ${theme} tone`).toContain(escapeOf.get(theme));
    for (const other of THEMES) {
      if (other === theme) continue;
      expect(out, `${role} still carries the ${other} tone under ${theme}`).not.toContain(
        escapeOf.get(other),
      );
    }
  }
  m.applyTheme('dark');
}

describe('theme swap reaches module-scope renderers', () => {
  it('chalk resolves truecolor, so theme escapes are distinguishable', () => {
    expect(m.chalk.level).toBe(3);
  });

  it.each([
    ['done', 'success'],
    ['blocked', 'error'],
    ['asking', 'warning'],
    ['interrupted', 'meta'],
  ] as const)('verdict card (%s) paints the live %s tone', (kind, role) => {
    expectsLiveTone(role, () => m.renderVerdictCard({ kind, rawBody: 'body' }));
  });

  it('verdict-ledger rail paints the live success tone', () => {
    const ledger = m.createVerdictLedger();
    ledger.push({ kind: 'done', rawBody: 'ok' });
    expectsLiveTone('success', () => ledger.render() ?? '');
  });

  it('input-buffer /mint chip paints the live mint tone', () => {
    const registry = { has: (n: string) => n === 'mint' };
    expectsLiveTone('mint', () => {
      const out = m.colorizeInputBuffer('/mint ship it', registry);
      // The chip is the first colored token in the buffer.
      return out.slice(out.indexOf('\u001b'));
    });
  });
});
