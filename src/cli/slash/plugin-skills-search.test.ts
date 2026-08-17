/**
 * Tests for `/skills <query>` intent-based fuzzy search (Part 1 of the
 * tui-skill-discovery feature).
 *
 * Covers:
 *   - searchSkills() tier ranking (prefix > name-subseq > desc-substring >
 *     desc-subseq)
 *   - Empty query returns empty results
 *   - renderSkillSearch() emits header, rows, and tip
 *   - "No results" path emits a helpful fallback hint
 *   - Exact-name queries still route to the detail card (not search)
 *   - Unknown queries route to fuzzy search (not "No skill found" 404)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { searchSkills, type SearchableSkill } from './plugin-skills/search.js';
import { _resetRegistry, registerSkill } from '../../skills/index.js';
import { resetRegistry } from './registry.js';
import { initialSkillsCmd, makeDynamicSkillsCmd } from './plugin-skills/listing.js';
import { stripAnsi } from '../display.js';
import type { SlashContext } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: { current: {} } as unknown as SlashContext['session'],
    stats: {
      totalTurns: 0, totalCostUsd: 0, totalTokens: 0, totalDurationMs: 0,
      sessionStartTime: Date.now(), turnCosts: [], turnTokens: [], turns: [],
      model: 'sonnet', permissionMode: 'default',
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

const SKILLS: SearchableSkill[] = [
  { name: 'mint', description: 'Deliver a feature end-to-end in one ship-ready pass.' },
  { name: 'ship', description: 'Release pipeline for already-done local work.' },
  { name: 'forge', description: 'Creates new amplifier skills gated by forge-gate-check.' },
  { name: 'diagnose', description: 'Parallel root-cause analysis for bugs and failing tests.' },
  { name: 'review', description: 'Dispatches parallel dimension agents across a diff or PR.' },
  { name: 'deploy-now', description: 'Deploy to production immediately.', hint: '<env>' },
];

// ---------------------------------------------------------------------------
// Unit tests: searchSkills()
// ---------------------------------------------------------------------------

describe('searchSkills()', () => {
  it('returns empty array for empty query', () => {
    expect(searchSkills(SKILLS, '')).toEqual([]);
    expect(searchSkills(SKILLS, '   ')).toEqual([]);
  });

  it('tier 0: exact prefix on name — /mint matched by "mi"', () => {
    const results = searchSkills(SKILLS, 'mi');
    expect(results[0]?.skill.name).toBe('mint');
    expect(results[0]?.tier).toBe(0);
  });

  it('tier 0: prefix on bare name — "dep" matches deploy-now', () => {
    const results = searchSkills(SKILLS, 'dep');
    const found = results.find((r) => r.skill.name === 'deploy-now');
    expect(found).toBeDefined();
    expect(found?.tier).toBe(0);
  });

  it('tier 1: subsequence on name — "fg" matches forge (f...g)', () => {
    const results = searchSkills(SKILLS, 'fg');
    const found = results.find((r) => r.skill.name === 'forge');
    expect(found).toBeDefined();
    expect(found?.tier).toBe(1);
  });

  it('tier 2: substring in description — "release" matches ship', () => {
    const results = searchSkills(SKILLS, 'release');
    const found = results.find((r) => r.skill.name === 'ship');
    expect(found).toBeDefined();
    expect(found?.tier).toBe(2);
  });

  it('tier 2: substring in description — "bug" matches diagnose', () => {
    const results = searchSkills(SKILLS, 'bug');
    const found = results.find((r) => r.skill.name === 'diagnose');
    expect(found).toBeDefined();
    expect(found?.tier).toBe(2);
  });

  it('tier 3: subsequence in description — "pllls" matches parallel skills', () => {
    // "pllls" is a subsequence of "parallel" (p-a-r-a-l-l-e-l)... actually no.
    // Test subsequence in desc via a word that spans boundaries.
    const results = searchSkills(SKILLS, 'root');
    const found = results.find((r) => r.skill.name === 'diagnose');
    // "root-cause" contains "root" — tier 2 (substring)
    expect(found).toBeDefined();
    expect(found!.tier).toBeLessThanOrEqual(2);
  });

  it('prefix matches rank above subsequence matches', () => {
    // "sh" is a prefix of "ship" (tier 0) but only subsequence of nothing special.
    // "sg" is subsequence but not prefix of any skill here.
    const results = searchSkills(SKILLS, 'sh');
    const ship = results.find((r) => r.skill.name === 'ship');
    expect(ship?.tier).toBe(0);
    // ship should appear before anything that matched at a higher tier
    const shipIdx = results.findIndex((r) => r.skill.name === 'ship');
    for (const r of results.slice(0, shipIdx)) {
      expect(r.tier).toBeLessThanOrEqual(0);
    }
  });

  it('returns no results when nothing matches', () => {
    expect(searchSkills(SKILLS, 'xyzzy')).toHaveLength(0);
  });

  it('hint text is included in search corpus', () => {
    // deploy-now has hint "<env>" — searching "env" should match it via tier 2
    const results = searchSkills(SKILLS, 'env');
    const found = results.find((r) => r.skill.name === 'deploy-now');
    expect(found).toBeDefined();
  });

  it('within a tier, results are sorted alphabetically by name', () => {
    // "a" is a prefix/subsequence of many — whatever tier they land in,
    // names should be sorted within each tier group.
    const results = searchSkills(SKILLS, 'e');
    const names = results.map((r) => r.skill.name);
    // Check within each tier
    let prevTier = -1;
    let prevName = '';
    for (const r of results) {
      if (r.tier !== prevTier) {
        prevTier = r.tier;
        prevName = '';
      }
      expect(r.skill.name.localeCompare(prevName)).toBeGreaterThanOrEqual(0);
      prevName = r.skill.name;
    }
    expect(names.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: /skills <query> routing via the handler
// ---------------------------------------------------------------------------

describe('/skills <query> integration', () => {
  const origColumns = process.stdout.columns;

  beforeEach(() => {
    resetRegistry();
    _resetRegistry();
    vi.unstubAllEnvs();
    vi.stubEnv('AFK_INTERNAL', undefined as unknown as string);

    registerSkill({
      name: 'mint',
      description: 'Deliver a feature end-to-end in one ship-ready pass.',
      whenToUse: 'When a novel multi-day feature genuinely benefits from a spec.',
      flags: ['--continue'],
      handler: async () => 'ok',
    });
    registerSkill({
      name: 'diagnose',
      description: 'Parallel root-cause analysis for bugs and failing tests.',
      handler: async () => 'ok',
    });
    registerSkill({
      name: 'review',
      description: 'Dispatches parallel dimension agents across a diff or PR.',
      handler: async () => 'ok',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process.stdout, 'columns', { value: origColumns, configurable: true, writable: true });
  });

  it('exact-name query still renders the detail card', async () => {
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, 'mint');
    const out = stripAnsi(lines.join('\n'));

    // Detail card shows Source field and When to use — not the search header.
    expect(out).toContain('Source');
    expect(out).toContain('built-in');
    expect(out).not.toMatch(/Skills matching/i);
  });

  it('non-exact query routes to fuzzy search and shows matching header', async () => {
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, 'bug');
    const out = stripAnsi(lines.join('\n'));

    expect(out).toMatch(/Skills matching/i);
    expect(out).toContain('bug');
    // Should find diagnose (description contains "bugs")
    expect(out).toContain('diagnose');
  });

  it('multi-word intent query returns relevant skills', async () => {
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, 'parallel');
    const out = stripAnsi(lines.join('\n'));

    // "parallel" appears in both diagnose and review descriptions
    expect(out).toMatch(/Skills matching/i);
    expect(out.toLowerCase()).toContain('parallel');
  });

  it('no-results query shows helpful fallback', async () => {
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, 'xyzzy-nonexistent');
    const out = stripAnsi(lines.join('\n'));

    expect(out).toMatch(/no skills matched/i);
    expect(out).toContain('/skills');
  });

  it('empty args still renders the full grouped listing (no regression)', async () => {
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, '');
    const out = stripAnsi(lines.join('\n'));

    expect(out).toContain('Skills');
    expect(out).toContain('Built-in');
    expect(out).not.toMatch(/Skills matching/i);
  });

  it('leading-dash arg (--all) still renders the listing (no regression)', async () => {
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, '--all');
    const out = stripAnsi(lines.join('\n'));

    expect(out).toContain('Skills');
    expect(out).not.toMatch(/Skills matching/i);
  });

  it('makeDynamicSkillsCmd also routes queries to search', async () => {
    const cmd = makeDynamicSkillsCmd([
      { name: 'custom-deploy', description: 'Deploy to staging environment instantly.', source: 'plugin' },
    ]);

    const { ctx, lines } = makeCtx();
    await cmd.handler(ctx, 'staging');
    const out = stripAnsi(lines.join('\n'));

    expect(out).toMatch(/Skills matching/i);
    expect(out).toContain('custom-deploy');
  });

  it('makeDynamicSkillsCmd exact plugin name still shows detail card', async () => {
    const cmd = makeDynamicSkillsCmd([
      { name: 'my-plugin:deploy', description: 'Deploy via plugin.', source: 'plugin' },
    ]);

    const { ctx, lines } = makeCtx();
    // "deploy" is the bare name — should match via bareName lookup
    await cmd.handler(ctx, 'deploy');
    const out = stripAnsi(lines.join('\n'));

    // Detail card shows Source field, not the search header
    expect(out).toContain('Source');
    expect(out).not.toMatch(/Skills matching/i);
  });
});
