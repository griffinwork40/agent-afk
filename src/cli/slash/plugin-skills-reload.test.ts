/**
 * Tests for the `/reload-plugins` summary formatters — the pure presentation
 * helpers that turn skill/plugin inventory into the richer reload report
 * (source breakdown, "since last reload" delta, per-plugin version rows).
 *
 * The handler itself scans real `~/.afk/plugins`, so it is not unit-tested
 * here; these cover the deterministic text-building seams it composes.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSourceBreakdown,
  computeSkillDelta,
  formatSkillDelta,
  buildPluginRows,
} from './plugin-skills.js';
import type { SkillManifestEntry } from '../../agent/tools/skill-bridge.js';
import type { InstalledPlugin } from '../../agent/plugins/inventory.js';

function entry(name: string, source: SkillManifestEntry['source']): SkillManifestEntry {
  return { name, description: `${name} desc`, source };
}

function plugin(name: string, version: string | null): InstalledPlugin {
  return { name, version, ref: null, commit: null, source: null, sourceType: null, dir: `/x/${name}` };
}

describe('buildSourceBreakdown', () => {
  it('counts by source in a fixed order, omitting zeros', () => {
    const entries = [
      entry('a', 'builtin'),
      entry('b', 'builtin'),
      entry('c', 'plugin'),
      entry('d', 'user'),
    ];
    expect(buildSourceBreakdown(entries)).toBe('2 built-in · 1 plugin · 1 user');
  });

  it('returns "" for no skills', () => {
    expect(buildSourceBreakdown([])).toBe('');
  });

  it('renders a single source alone', () => {
    expect(buildSourceBreakdown([entry('a', 'plugin'), entry('b', 'plugin')])).toBe('2 plugin');
  });
});

describe('computeSkillDelta', () => {
  it('returns null when there is no baseline', () => {
    expect(computeSkillDelta(new Set(), new Set(['a']))).toBeNull();
  });

  it('detects additions, removals, and sorts them', () => {
    const prev = new Set(['b', 'keep']);
    const next = new Set(['keep', 'a', 'c']);
    expect(computeSkillDelta(prev, next)).toEqual({ added: ['a', 'c'], removed: ['b'] });
  });

  it('reports no change as empty arrays (not null)', () => {
    const same = new Set(['x', 'y']);
    expect(computeSkillDelta(same, new Set(['x', 'y']))).toEqual({ added: [], removed: [] });
  });
});

describe('formatSkillDelta', () => {
  it('returns "" when nothing changed', () => {
    expect(formatSkillDelta({ added: [], removed: [] })).toBe('');
  });

  it('names a single addition', () => {
    expect(formatSkillDelta({ added: ['example-plugin:foo'], removed: [] })).toBe(
      '+1 since last reload (new: /example-plugin:foo)',
    );
  });

  it('names a single removal', () => {
    expect(formatSkillDelta({ added: [], removed: ['bar'] })).toBe(
      '−1 since last reload (gone: /bar)',
    );
  });

  it('combines additions and removals', () => {
    expect(formatSkillDelta({ added: ['a'], removed: ['b'] })).toBe(
      '+1 −1 since last reload (new: /a; gone: /b)',
    );
  });

  it('omits names when a side exceeds 3 changes but keeps the count', () => {
    const out = formatSkillDelta({ added: ['a', 'b', 'c', 'd'], removed: [] });
    expect(out).toBe('+4 since last reload');
  });
});

describe('buildPluginRows', () => {
  it('returns [] when no plugins are installed', () => {
    expect(buildPluginRows([])).toEqual([]);
  });

  it('renders one aligned row per plugin with its version', () => {
    const rows = buildPluginRows([plugin('example-plugin', '1.9.0'), plugin('sample-plugin', '2.4.3')]);
    expect(rows).toHaveLength(2);
    // ANSI dim wraps the whole string, so substring assertions are safe.
    expect(rows[0]).toContain('example-plugin');
    expect(rows[0]).toContain('v1.9.0');
    expect(rows[1]).toContain('sample-plugin');
    expect(rows[1]).toContain('v2.4.3');
  });

  it('caps at 8 rows and collapses the remainder', () => {
    const many = Array.from({ length: 11 }, (_, i) => plugin(`p${i}`, '1.0.0'));
    const rows = buildPluginRows(many);
    expect(rows).toHaveLength(9); // 8 shown + 1 summary
    expect(rows[8]).toContain('…and 3 more');
  });
});
