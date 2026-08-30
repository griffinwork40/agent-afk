/**
 * Tests for the redesigned `/skills` listing + detail UX (Phase 1).
 *
 * Covers the behavior changes shipped in the listing redesign:
 *   - descriptions WRAP (via wrapToWidth) instead of clipping at 80 chars,
 *   - built-in skills render in their own top block,
 *   - a human-friendly source legend replaces raw `(user)`/`(plugin)` badges,
 *   - shadowed/alias forms surface inline as `↳ also:` lines (not hidden),
 *   - `/skills <name>` renders an enriched detail card with an Alternatives
 *     section,
 *   - `/skills --all` (a leading-dash token) renders the listing, not a 404,
 *   - narrow terminals don't throw.
 *
 * Assertions strip ANSI so they pin TEXT, not color codes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _resetRegistry, registerSkill } from '../../skills/index.js';
import { resetRegistry } from './registry.js';
import { initialSkillsCmd } from './plugin-skills.js';
import { makeDynamicSkillsCmd } from './plugin-skills/listing.js';
import { stripAnsi } from '../display.js';
import type { SlashContext } from './types.js';

function makeCtx(): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: { current: {} } as unknown as SlashContext['session'],
    stats: {
      totalTurns: 0,
      totalCostUsd: 0,
      totalTokens: 0,
      totalDurationMs: 0,
      sessionStartTime: Date.now(),
      turnCosts: [],
      turnTokens: [],
      turns: [],
      model: 'sonnet',
      permissionMode: 'default',
    },
    out: {
      line: (t = '') => lines.push(t),
      raw: (t) => lines.push(t),
      success: (t) => lines.push(`SUCCESS:${t}`),
      info: (t) => lines.push(`INFO:${t}`),
      warn: (t) => lines.push(`WARN:${t}`),
      error: (t) => lines.push(`ERROR:${t}`),
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  };
  return { ctx, lines };
}

/** Force a terminal width for width-dependent rendering. Restored in afterEach. */
function setColumns(n: number): void {
  Object.defineProperty(process.stdout, 'columns', {
    value: n,
    configurable: true,
    writable: true,
  });
}

const LONG_DESC =
  'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu ' +
  'xi omicron pi rho sigma tau upsilon phi chi psi omega final-sentinel-word';

describe('/skills listing UX (Phase 1)', () => {
  const origColumns = process.stdout.columns;

  beforeEach(() => {
    resetRegistry();
    _resetRegistry();
    vi.unstubAllEnvs();
    vi.stubEnv('AFK_INTERNAL', undefined as unknown as string);

    // A vendored (built-in) skill + a colliding user-scope alias, plus a
    // second vendored skill with a long description for the wrapping test.
    registerSkill({
      name: 'mint',
      description: 'Deliver a feature end-to-end in one ship-ready pass.',
      whenToUse: 'When a novel multi-day feature genuinely benefits from a spec.',
      flags: ['--continue'],
      handler: async () => 'ok',
    });
    registerSkill({
      name: 'user:mint',
      description: 'A user-scope mint override.',
      origin: 'user',
      handler: async () => 'ok',
    });
    registerSkill({
      name: 'wrapme',
      description: LONG_DESC,
      handler: async () => 'ok',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setColumns(origColumns as number);
  });

  it('renders a built-in block header with built-in skills under it', async () => {
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, '');
    const out = stripAnsi(lines.join('\n'));

    expect(out).toContain('Skills');
    expect(out).toContain('Built-in');
    expect(out).toContain('/mint');
    expect(out).toContain('/wrapme');
  });

  it('shows a friendly source legend (no raw "(user)"/"(plugin)" badges)', async () => {
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, '');
    const out = stripAnsi(lines.join('\n'));

    expect(out).toContain('built-in');
    expect(out).toContain('user');
    expect(out).toContain('/skills <name> for details');
    // The old raw badge formatting must be gone.
    expect(out).not.toContain('(user)');
    expect(out).not.toContain('(plugin alt)');
  });

  it('labels a commands/*.md-origin skill "command", not "plugin"', async () => {
    // Regression lock for the `source` propagation chain:
    //   collectSkillEntries → ProviderCommandInfo → SlashCommand →
    //   DiscoveredSkill → buildListingGroups.
    // Before that chain carried `source`, listing.ts hard-coded `'plugin'`
    // for every plugin-origin row, so the `command` legend member was
    // unreachable at runtime even though the type union contained it.
    // `initialSkillsCmd` always renders with an empty plugin list; the live
    // listing is built by `makeDynamicSkillsCmd(discovered)` at
    // dispatch.ts:268, so drive that — it is the actual runtime path.
    const cmd = makeDynamicSkillsCmd([
      { name: 'demo-plugin:deploy', description: 'Deploy the thing.', source: 'command' },
    ]);

    const { ctx, lines } = makeCtx();
    await cmd.handler(ctx, '');
    const out = stripAnsi(lines.join('\n'));

    // The legend renders only sources actually present, so `command`
    // appearing there proves the row was tagged, not defaulted to `plugin`.
    const legendLine = out.split('\n').find((l) => l.includes('/skills <name> for details'));
    expect(legendLine).toBeDefined();
    expect(legendLine).toContain('command');

    // And the detail card reports the same source for that skill.
    const { ctx: detailCtx, lines: detailLines } = makeCtx();
    await cmd.handler(detailCtx, 'deploy');
    const detail = stripAnsi(detailLines.join('\n'));
    expect(detail).toMatch(/Source\s+command/);
  });

  it('wraps long descriptions instead of clipping them at 80 chars', async () => {
    setColumns(50);
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, '');
    const out = stripAnsi(lines.join('\n'));

    // The last word survives (clipping would have dropped it) and no ellipsis
    // truncation marker appears.
    expect(out).toContain('final-sentinel-word');
    expect(out).not.toContain('…');
  });

  it('surfaces shadowed/alias forms inline as "↳ also:" (not hidden)', async () => {
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, '');
    const out = stripAnsi(lines.join('\n'));

    expect(out).toContain('↳ also:');
    expect(out).toContain('/user:mint');
  });

  it('detail card shows description, when-to-use, flags, source, alternatives', async () => {
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, 'mint');
    const out = stripAnsi(lines.join('\n'));

    expect(out).toContain('/mint');
    expect(out).toContain('Deliver a feature end-to-end');
    expect(out).toContain('When to use');
    expect(out).toContain('novel multi-day feature');
    expect(out).toContain('Flags');
    expect(out).toContain('--continue');
    expect(out).toContain('Source');
    expect(out).toContain('built-in');
    expect(out).toContain('Alternatives');
    expect(out).toContain('/user:mint');
    expect(out).toContain('shadowed by /mint');
  });

  it('unknown query falls through to fuzzy search and suggests running /skills', async () => {
    // Previously the detail-card path rendered "No skill found" on miss.
    // Now, a non-exact-name query routes to the fuzzy-search path which
    // renders "No skills matched" plus a /skills hint — covering both the
    // "typo in a skill name" and "intent keyword" cases.
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, 'does-not-exist');
    const out = stripAnsi(lines.join('\n'));

    expect(out).toMatch(/no skills matched/i);
    expect(out).toContain('/skills');
  });

  it('treats a leading-dash arg (--all) as the listing, not a 404 lookup', async () => {
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, '--all');
    const out = stripAnsi(lines.join('\n'));

    expect(out).toContain('Skills');
    expect(out).not.toMatch(/no skill found/i);
  });

  it('does not throw in a very narrow terminal', async () => {
    setColumns(20);
    const { ctx } = makeCtx();
    await expect(initialSkillsCmd.handler(ctx, '')).resolves.toBe('continue');
  });

  it('detail card uses pluginSkill.whenToUse when registrySkill.whenToUse is absent', async () => {
    // A plugin-only skill (not in the registry) whose whenToUse comes from
    // SKILL.md frontmatter — verifies the pluginSkill?.whenToUse fallback
    // added in listing-detail.ts (issue #1373).
    const cmd = makeDynamicSkillsCmd([
      {
        name: 'fix-pr',
        description: 'Fix pull-request review comments automatically.',
        whenToUse: 'Use when a PR has blocking review comments you want resolved.',
        source: 'plugin',
      },
    ]);

    const { ctx, lines } = makeCtx();
    await cmd.handler(ctx, 'fix-pr');
    const out = stripAnsi(lines.join('\n'));

    expect(out).toContain('When to use');
    expect(out).toContain('blocking review comments');
  });
});
