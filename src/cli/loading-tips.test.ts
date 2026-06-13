/**
 * Tests for the rotating loading-screen tip pool and selection algorithm.
 *
 * The selection logic has three properties worth locking down independently:
 *
 *   1. Warmup gate — no tip rendered before the warmup window elapses.
 *   2. Unseen-first preference — every tip in the pool surfaces at least
 *      once before any tip repeats.
 *   3. Time-stable rotation in the fallback round-robin — the same tip
 *      returns across every tick within a single rotation window.
 *
 * The harvesting half pulls from the live slash registry + skill registry;
 * those are populated by side-effect modules at production import time but
 * not in vitest (which loads modules lazily). Harvest tests therefore stub
 * the registries directly rather than relying on side-effect registration.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import stringWidth from 'string-width';
import {
  buildTipPool,
  selectTip,
  _resetSeenTipsForTesting,
  type LoadingTip,
} from './loading-tips.js';
import { formatTipRow } from './terminal-compositor.types.js';

// Harvest stubs — vi.mock has to be hoisted, so use the standard pattern.
vi.mock('./slash/registry.js', () => ({
  list: vi.fn(() => []),
  // Other exports the module is allowed to import; not used by loading-tips.
  aliasEntries: vi.fn(() => []),
}));
vi.mock('../skills/index.js', () => ({
  listSkills: vi.fn(() => []),
  getSkill: vi.fn(),
  // isSkillVisible is used by harvestSkillTips; provide real implementation.
  isSkillVisible: (skill: { audience?: string }, internalUnlocked: boolean) => {
    if (internalUnlocked) return true;
    return (skill.audience ?? 'public') === 'public';
  },
}));

import { list as listSlashCommands } from './slash/registry.js';
import { listSkills, getSkill } from '../skills/index.js';

const mockedList = listSlashCommands as unknown as ReturnType<typeof vi.fn>;
const mockedListSkills = listSkills as unknown as ReturnType<typeof vi.fn>;
const mockedGetSkill = getSkill as unknown as ReturnType<typeof vi.fn>;

describe('buildTipPool', () => {
  beforeEach(() => {
    mockedList.mockReset();
    mockedListSkills.mockReset();
    mockedGetSkill.mockReset();
    delete process.env['AFK_SPINNER_TIPS'];
  });

  afterEach(() => {
    // The audience-gate tests below stub AFK_INTERNAL via vi.stubEnv; clear it
    // so the tier state never leaks into sibling tests.
    vi.unstubAllEnvs();
  });

  it('returns the static pool when no commands or skills are registered', () => {
    mockedList.mockReturnValue([]);
    mockedListSkills.mockReturnValue([]);
    const pool = buildTipPool();
    // Every entry should be a static one (no command/skill sources mixed in).
    expect(pool.every((t) => t.source === 'static')).toBe(true);
    expect(pool.length).toBeGreaterThan(0);
  });

  it('returns an empty pool when AFK_SPINNER_TIPS=0', () => {
    process.env['AFK_SPINNER_TIPS'] = '0';
    mockedList.mockReturnValue([]);
    mockedListSkills.mockReturnValue([]);
    expect(buildTipPool()).toEqual([]);
  });

  it('harvests hints from registered slash commands', () => {
    mockedList.mockReturnValue([
      { name: '/foo', summary: 'sum', hint: 'When you need foo', async handler() { return 'continue'; } },
      { name: '/bar', summary: 'sum', async handler() { return 'continue'; } }, // no hint, skipped
    ]);
    mockedListSkills.mockReturnValue([]);
    const pool = buildTipPool();
    const cmdTip = pool.find((t) => t.id === 'cmd:/foo');
    expect(cmdTip).toBeDefined();
    expect(cmdTip!.text).toContain('/foo');
    expect(cmdTip!.text).toContain('When you need foo');
    expect(pool.find((t) => t.id === 'cmd:/bar')).toBeUndefined();
  });

  it('skips plugin-namespaced commands so the bare alias wins', () => {
    mockedList.mockReturnValue([
      { name: '/mint', summary: '', hint: 'When shipping a feature', async handler() { return 'continue'; } },
      { name: '/example-plugin:mint', summary: '', hint: 'Plugin form', async handler() { return 'continue'; } },
    ]);
    mockedListSkills.mockReturnValue([]);
    const pool = buildTipPool();
    expect(pool.find((t) => t.id === 'cmd:/mint')).toBeDefined();
    expect(pool.find((t) => t.id === 'cmd:/example-plugin:mint')).toBeUndefined();
  });

  it('harvests skill whenToUse fields when the slash form is missing', () => {
    mockedList.mockReturnValue([]);
    mockedListSkills.mockReturnValue(['diagnose']);
    mockedGetSkill.mockReturnValue({
      name: 'diagnose',
      description: '',
      whenToUse: 'When a test fails',
      handler: vi.fn(),
    });
    const pool = buildTipPool();
    const tip = pool.find((t) => t.id === 'skill:diagnose');
    expect(tip).toBeDefined();
    expect(tip!.text).toContain('/diagnose');
    expect(tip!.text).toContain('When a test fails');
  });

  it('lets the command hint win when both surfaces have one for the same name', () => {
    mockedList.mockReturnValue([
      { name: '/diagnose', summary: '', hint: 'CMD hint', async handler() { return 'continue'; } },
    ]);
    mockedListSkills.mockReturnValue(['diagnose']);
    mockedGetSkill.mockReturnValue({
      name: 'diagnose',
      description: '',
      whenToUse: 'SKILL hint',
      handler: vi.fn(),
    });
    const pool = buildTipPool();
    const cmd = pool.find((t) => t.source === 'command' && t.id === 'cmd:/diagnose');
    const skill = pool.find((t) => t.source === 'skill' && t.id === 'skill:diagnose');
    expect(cmd).toBeDefined();
    expect(skill).toBeUndefined();
  });

  it('omits skills with no whenToUse field', () => {
    mockedList.mockReturnValue([]);
    mockedListSkills.mockReturnValue(['no-meta']);
    mockedGetSkill.mockReturnValue({
      name: 'no-meta',
      description: 'just a description',
      handler: vi.fn(),
    });
    const pool = buildTipPool();
    expect(pool.find((t) => t.id === 'skill:no-meta')).toBeUndefined();
  });

  // Regression — `listSkills()` and `getSkill()` are two independent calls,
  // so a skill that vanishes between them (plugin unload, registry reset)
  // would surface as a `Skill not found` throw from `getSkill`. The
  // harvest must continue rather than break spinner arming.
  it('skips skills that throw on lookup without breaking the pool', () => {
    mockedList.mockReturnValue([]);
    mockedListSkills.mockReturnValue(['present', 'vanished']);
    mockedGetSkill.mockImplementation((name: string) => {
      if (name === 'vanished') {
        throw new Error('Skill not found: vanished');
      }
      return {
        name,
        description: 'still here',
        whenToUse: 'when needed',
        handler: vi.fn(),
      };
    });
    const pool = buildTipPool();
    expect(pool.find((t) => t.id === 'skill:present')).toBeDefined();
    expect(pool.find((t) => t.id === 'skill:vanished')).toBeUndefined();
  });

  // Audience tier gate — harvestSkillTips filters internal-audience skills out
  // of the tip pool unless AFK_INTERNAL=1. Without this an end user could see a
  // loading tip advertising /forge even though the skill is hidden from every
  // other surface. (The vi.mock above supplies the real isSkillVisible.)
  it('excludes internal-audience skill tips when AFK_INTERNAL is unset', () => {
    vi.stubEnv('AFK_INTERNAL', '');
    mockedList.mockReturnValue([]);
    mockedListSkills.mockReturnValue(['forge']);
    mockedGetSkill.mockReturnValue({
      name: 'forge',
      description: '',
      whenToUse: 'When growing the plugin with a new skill',
      audience: 'internal',
      handler: vi.fn(),
    });
    const pool = buildTipPool();
    expect(pool.find((t) => t.id === 'skill:forge')).toBeUndefined();
  });

  it('includes internal-audience skill tips when AFK_INTERNAL=1', () => {
    vi.stubEnv('AFK_INTERNAL', '1');
    mockedList.mockReturnValue([]);
    mockedListSkills.mockReturnValue(['forge']);
    mockedGetSkill.mockReturnValue({
      name: 'forge',
      description: '',
      whenToUse: 'When growing the plugin with a new skill',
      audience: 'internal',
      handler: vi.fn(),
    });
    const pool = buildTipPool();
    const tip = pool.find((t) => t.id === 'skill:forge');
    expect(tip).toBeDefined();
    expect(tip!.text).toContain('When growing the plugin');
  });
});

describe('selectTip', () => {
  beforeEach(() => {
    _resetSeenTipsForTesting();
  });
  afterEach(() => {
    _resetSeenTipsForTesting();
  });

  const pool: LoadingTip[] = [
    { id: 'a', text: 'A', source: 'static' },
    { id: 'b', text: 'B', source: 'static' },
    { id: 'c', text: 'C', source: 'static' },
  ];

  it('returns null for an empty pool', () => {
    expect(selectTip([], { startedAt: 0, now: 10_000 })).toBeNull();
  });

  it('returns null during the warmup window', () => {
    // Default warmup is 1500ms.
    expect(selectTip(pool, { startedAt: 0, now: 1000 })).toBeNull();
    expect(selectTip(pool, { startedAt: 0, now: 1499 })).toBeNull();
  });

  it('returns a tip once warmup has elapsed', () => {
    const tip = selectTip(pool, { startedAt: 0, now: 1500 });
    expect(tip).not.toBeNull();
    expect(['a', 'b', 'c']).toContain(tip!.id);
  });

  it('cycles through every unseen tip before any tip repeats', () => {
    // Three sequential rotation windows — each must yield a new tip.
    const a = selectTip(pool, { startedAt: 0, now: 2_000, rotateMs: 7_000 });
    const b = selectTip(pool, { startedAt: 0, now: 9_000, rotateMs: 7_000 });
    const c = selectTip(pool, { startedAt: 0, now: 16_000, rotateMs: 7_000 });
    expect(new Set([a!.id, b!.id, c!.id]).size).toBe(3);
  });

  it('is time-stable within one rotation window', () => {
    // Two `now` values inside the same 7s window must yield the same tip.
    const t1 = selectTip(pool, { startedAt: 0, now: 2_000, rotateMs: 7_000 });
    const t2 = selectTip(pool, { startedAt: 0, now: 3_500, rotateMs: 7_000 });
    expect(t1!.id).toBe(t2!.id);
  });

  it('falls back to deterministic round-robin for fresh windows once every tip is seen', () => {
    // Drain the pool — three windows mark all three tips as seen.
    selectTip(pool, { startedAt: 0, now: 2_000, rotateMs: 7_000 });
    selectTip(pool, { startedAt: 0, now: 9_000, rotateMs: 7_000 });
    selectTip(pool, { startedAt: 0, now: 16_000, rotateMs: 7_000 });

    // Fresh window (never served before) — must come from the round-robin
    // fallback, never null, and must hit a valid pool index.
    const window3 = selectTip(pool, { startedAt: 0, now: 23_000, rotateMs: 7_000 });
    expect(window3).not.toBeNull();
    expect(['a', 'b', 'c']).toContain(window3!.id);

    // Adjacent fresh window — must be deterministic per the index formula.
    const window4 = selectTip(pool, { startedAt: 0, now: 30_000, rotateMs: 7_000 });
    const window4Repeat = selectTip(pool, { startedAt: 0, now: 32_000, rotateMs: 7_000 });
    expect(window4!.id).toBe(window4Repeat!.id);

    // Wrapping: window N and window N+pool.length pick the same tip.
    const w5 = selectTip(pool, { startedAt: 0, now: 37_000, rotateMs: 7_000 });
    const w8 = selectTip(pool, { startedAt: 0, now: 58_000, rotateMs: 7_000 });
    expect(w5!.id).toBe(w8!.id);
  });

  it('re-serving a window returns the same tip it served the first time', () => {
    // A spinner that ticks every 80ms inside one rotation window must keep
    // returning the same tip — that's the load-bearing time-stability
    // invariant for the compositor's per-tick selectTip call.
    const first = selectTip(pool, { startedAt: 0, now: 2_000, rotateMs: 7_000 });
    const second = selectTip(pool, { startedAt: 0, now: 6_000, rotateMs: 7_000 });
    const third = selectTip(pool, { startedAt: 0, now: 6_999, rotateMs: 7_000 });
    expect(first!.id).toBe(second!.id);
    expect(second!.id).toBe(third!.id);
  });

  it('namespaces the cache by startedAt so a fresh spinner gets a fresh rotation', () => {
    // First spinner — serve some tips.
    selectTip(pool, { startedAt: 1000, now: 3000, rotateMs: 7_000 });
    selectTip(pool, { startedAt: 1000, now: 10_000, rotateMs: 7_000 });

    // Second spinner with different startedAt — must not inherit cache pins.
    // Reset seen so unseen-pass still applies for clarity.
    _resetSeenTipsForTesting();
    const second = selectTip(pool, { startedAt: 50_000, now: 52_000, rotateMs: 7_000 });
    expect(second).not.toBeNull();
  });

  it('respects the custom warmupMs override', () => {
    expect(selectTip(pool, { startedAt: 0, now: 2_000, warmupMs: 5_000 })).toBeNull();
    expect(selectTip(pool, { startedAt: 0, now: 6_000, warmupMs: 5_000 })).not.toBeNull();
  });
});

describe('formatTipRow', () => {
  const strip = (s: string): string => s.replace(/\x1B\[[0-9;]*m/g, '');

  it('labels the row with "Tip:" so skill hints are not misread as routing', () => {
    // A harvested skill tip looks like `/agentify — Use when…`. Without the
    // label, rendering it under the spinner right after the user typed a
    // DIFFERENT slash command reads as "the agent rerouted my command".
    const row = strip(formatTipRow('/agentify — Use when the user wants to delegate', 120));
    expect(row.startsWith('  💡 Tip: /agentify')).toBe(true);
  });

  it('truncates to one visual line with a trailing ellipsis', () => {
    const row = strip(formatTipRow('x'.repeat(500), 40));
    expect(row.endsWith('…')).toBe(true);
    expect(row.length).toBeLessThanOrEqual(40);
  });

  it('truncates by display width, not char count (wide CJK glyphs)', () => {
    // 30 CJK chars = 60 display columns but only 30 JS chars. Char-count
    // truncation would keep ~29 of them (≈58 cols) and overflow a 40-col
    // terminal; display-width truncation must keep the row ≤ cols.
    const row = strip(formatTipRow('漢'.repeat(30), 40));
    expect(row.endsWith('…')).toBe(true);
    expect(stringWidth(row)).toBeLessThanOrEqual(40);
  });
});
